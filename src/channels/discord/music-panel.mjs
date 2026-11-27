/**
 * Pure rendering for the Discord music card. Everything here is data-in /
 * data-out so the layout and the button wire format can be tested without a
 * gateway, a player or ffmpeg.
 *
 * Discord has no slider and no coloured embed text, so the transport line is
 * drawn from characters. It is not decorative: `renderPanel` is called again on
 * every refresh and the bar is recomputed from the position the transport reports,
 * which is the same number the seek console uses.
 */

export const PANEL_COLOR = 0x2b6cf6;
export const PANEL_BAR_WIDTH = 16;
export const PANEL_ACTIONS = Object.freeze(['pause', 'resume', 'next', 'prev', 'loop', 'queue', 'refresh', 'remove', 'link']);
// A link button carries `url` and no `custom_id`, so it never reaches the router.
const CUSTOM_ID_ACTIONS = new Set(['pause', 'resume', 'next', 'prev', 'loop', 'queue', 'refresh', 'remove']);

/** `music:<action>:<guildId>` — short enough for the 100-char custom_id limit. */
export function panelCustomId(action, guildId) {
  if (!CUSTOM_ID_ACTIONS.has(action)) throw new TypeError(`未知卡片動作：${action}`);
  const guild = String(guildId ?? '').trim();
  if (!guild) throw new TypeError('卡片動作需要 guildId');
  return `music:${action}:${guild}`;
}

export function parsePanelCustomId(value) {
  const parts = String(value ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== 'music' || !CUSTOM_ID_ACTIONS.has(parts[1]) || !parts[2]) return null;
  return { action: parts[1], guildId: parts[2] };
}

/**
 * `padMinutes` exists for the card: the two clocks sit either side of the bar,
 * so an unpadded "9:59" would move the bar every time a digit disappears.
 */
export function formatClock(ms, { padMinutes = false } = {}) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return padMinutes ? `${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// ▰/▱/🔘 render as tofu boxes in Discord's client font; these three do not.
// Heavy for the played part and light for the rest keeps the two ends readable
// without colour, and the knob marks the exact position between them.
const BAR_TRACK = '─';
const BAR_PLAYED = '━';
const BAR_KNOB = '●';

export function progressBar(positionMs, durationMs, width = PANEL_BAR_WIDTH) {
  const cells = Math.max(4, Math.min(30, Number(width) || PANEL_BAR_WIDTH));
  const total = Number(durationMs);
  const position = Math.max(0, Number(positionMs) || 0);
  // A live stream has no end, so the whole line stays unplayed instead of
  // claiming a ratio that does not exist.
  if (!Number.isFinite(total) || total <= 0) return BAR_TRACK.repeat(cells);
  const ratio = Math.max(0, Math.min(1, position / total));
  // The knob owns one cell, so the travelled distance is one cell shorter.
  const span = cells - 1;
  const knob = Math.max(0, Math.min(span, Math.round(ratio * span)));
  return `${BAR_PLAYED.repeat(knob)}${BAR_KNOB}${BAR_TRACK.repeat(span - knob)}`;
}

/**
 * Seek targets are clamped so the replacement encoder never starts past the end
 * (ffmpeg would exit immediately and the track would look finished).
 */
export function clampSeekTarget(positionMs, durationMs, { marginMs = 2000 } = {}) {
  const target = Math.max(0, Math.round(Number(positionMs) || 0));
  const total = Number(durationMs);
  if (!Number.isFinite(total) || total <= 0) return target;
  return Math.min(target, Math.max(0, Math.round(total - marginMs)));
}

/** A slider release 40ms from where playback already is must not rebuild ffmpeg. */
export function seekIsMeaningful(targetMs, currentMs, { floorMs = 1500 } = {}) {
  return Math.abs(Math.round(Number(targetMs) || 0) - Math.round(Number(currentMs) || 0)) >= floorMs;
}

const STATE_TEXT = Object.freeze({ idle: '未播放', preparing: '準備中', playing: '播放中', paused: '已暫停' });
const LOOP_TEXT = Object.freeze({ off: '關閉', single: '單曲', all: '全部' });
const PLATFORM_TEXT = Object.freeze({ youtube: 'YouTube', bilibili: 'Bilibili', 'audio-url': '音訊連結', file: '本機檔案' });

export function loopLabel(loop) { return LOOP_TEXT[loop] ?? LOOP_TEXT.off; }

/** `youtube.com` from a track URL, without `www.`; null when there is no URL. */
export function sourceHost(url) {
  try {
    const host = new URL(String(url ?? '')).hostname.toLowerCase().replace(/^www\./u, '');
    return host || null;
  } catch { return null; }
}

/**
 * YouTube's static thumbnail needs no extra request: the video id is already in the
 * resolved URL. Every other source has to bring its own `thumbnail`.
 */
export function thumbnailFor(source = {}) {
  const explicit = typeof source?.thumbnail === 'string' && /^https:\/\//iu.test(source.thumbnail) ? source.thumbnail : null;
  if (explicit) return explicit;
  const video = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/u.exec(String(source?.url ?? ''))?.[1];
  return video ? `https://i.ytimg.com/vi/${video}/hqdefault.jpg` : null;
}

function buttonRow(buttons) {
  return { type: 1, components: buttons };
}

// Discord's REST validator only accepts a partial-emoji *object* here, even though
// the docs also show a bare string. A string fails with MODEL_TYPE_CONVERT.
function button({ action, guildId, label, emoji, style = 2, disabled = false }) {
  return { type: 2, style, label, emoji: { name: emoji }, custom_id: panelCustomId(action, guildId), disabled };
}

function linkButton({ url, label, emoji }) {
  // Style 5 opens a URL and rejects `custom_id` outright.
  return { type: 2, style: 5, label, emoji: { name: emoji }, url };
}

/**
 * @param {object} snapshot from `MusicManager.snapshot()`
 * @param {{ guildId: string, controlUrl?: string | null, botName?: string | null }} options
 */
export function renderPanel(snapshot = {}, { guildId = '', controlUrl = null, botName = null } = {}) {
  const guild = String(guildId ?? '').trim();
  if (!guild) throw new TypeError('卡片需要 guildId');
  const state = ['idle', 'preparing', 'playing', 'paused'].includes(snapshot.state) ? snapshot.state : 'idle';
  const idle = state === 'idle';
  const durationMs = Number(snapshot.durationMs) || 0;
  const positionMs = idle ? 0 : Number(snapshot.positionMs) || 0;
  const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
  const loop = LOOP_TEXT[snapshot.loop] ? snapshot.loop : 'off';
  const title = String(snapshot.title ?? '').trim().slice(0, 240) || '音樂播放';

  const lines = [];
  if (idle) {
    lines.push('目前沒有播放中的歌曲。用 `/play` 點一首，卡片會自動出現。');
  } else {
    const host = sourceHost(snapshot.url);
    const platform = PLATFORM_TEXT[snapshot.kind] ?? null;
    // A track still being resolved has no source yet: naming a host here would
    // claim something the player does not know.
    lines.push(host ? `來自 ${host}` : platform ? `來自 ${platform}` : '正在準備歌曲…');
    lines.push('');
    const meta = [`循環：${loopLabel(loop)}`];
    if (platform) meta.push(`音源：${platform}`);
    if (snapshot.stream) meta.push('串流（未正規化）');
    if (queue.length) meta.push(`佇列：${queue.length} 首`);
    lines.push(meta.join(' · '));
    lines.push('');
    // Both clocks sit on the same line as the bar so the knob reads against them.
    // Inline code keeps the two labels the same width, which stops the bar from
    // sliding sideways every time a digit changes.
    lines.push(`\`${formatClock(positionMs, { padMinutes: true })}\` ${progressBar(positionMs, durationMs)} \`${durationMs > 0 ? formatClock(durationMs, { padMinutes: true }) : '--:--'}\``);
  }

  const pauseAction = state === 'paused' ? 'resume' : 'pause';
  const pauseLabel = state === 'paused' ? '繼續' : '暫停';
  const transport = [
    button({ action: 'loop', guildId: guild, label: `循環：${loopLabel(loop)}`, emoji: '🔁', style: 3, disabled: idle }),
    button({ action: 'prev', guildId: guild, label: '上一首', emoji: '⏮️', style: 1, disabled: idle || snapshot.canPrev !== true }),
    button({ action: pauseAction, guildId: guild, label: pauseLabel, emoji: state === 'paused' ? '▶️' : '⏸️', style: 1, disabled: idle || state === 'preparing' }),
    button({ action: 'next', guildId: guild, label: '下一首', emoji: '⏭️', style: 1, disabled: idle }),
    button({ action: 'queue', guildId: guild, label: '播放佇列', emoji: '📋', style: 2, disabled: idle && !queue.length }),
  ];
  const tools = [
    button({ action: 'refresh', guildId: guild, label: '更新', emoji: '🔄', style: 2 }),
    button({ action: 'remove', guildId: guild, label: '移除', emoji: '✖️', style: 2 }),
  ];
  // A loopback console URL is not reachable from another machine, and Discord
  // rejects the whole message when the link button carries a non-http URL.
  if (typeof controlUrl === 'string' && /^https?:\/\//iu.test(controlUrl.trim())) {
    tools.push(linkButton({ url: controlUrl.trim(), label: '網頁控制', emoji: '🔗' }));
  }
  const components = [buttonRow(transport), buttonRow(tools)];

  const embed = {
    color: PANEL_COLOR,
    title,
    description: lines.join('\n'),
    footer: { text: snapshot.requester ? `${botName ?? 'dsh-discord'} · 由 ${snapshot.requester} 點播` : `${botName ?? 'dsh-discord'} 音樂` },
  };
  const thumbnail = thumbnailFor({ url: snapshot.url, thumbnail: snapshot.thumbnail });
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  // A local file or a bare search term is not a URL, and Discord rejects the
  // whole embed when `url` is not http(s).
  if (typeof snapshot.url === 'string' && /^https?:\/\//iu.test(snapshot.url.trim())) {
    embed.url = snapshot.url.trim();
  }
  return { embeds: [embed], components };
}
