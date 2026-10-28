/**
 * Pure rendering for the Discord music card. Everything here is data-in /
 * data-out so the layout and the button wire format can be tested without a
 * gateway, a player or ffmpeg.
 */

export const PANEL_COLOR = 0x2b6cf6;
export const PANEL_BAR_WIDTH = 16;
export const PANEL_ACTIONS = Object.freeze(['pause', 'resume', 'next', 'queue', 'refresh', 'remove', 'link']);
const ACTION_SET = new Set(PANEL_ACTIONS);

/** `music:<action>:<guildId>` — short enough for the 100-char custom_id limit. */
export function panelCustomId(action, guildId) {
  if (!ACTION_SET.has(action)) throw new TypeError(`未知卡片動作：${action}`);
  const guild = String(guildId ?? '').trim();
  if (!guild) throw new TypeError('卡片動作需要 guildId');
  return `music:${action}:${guild}`;
}

export function parsePanelCustomId(value) {
  const parts = String(value ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== 'music' || !ACTION_SET.has(parts[1]) || !parts[2]) return null;
  return { action: parts[1], guildId: parts[2] };
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// ▰/▱/🔘 render as tofu boxes in Discord's client font; these two do not.
const BAR_FULL = '█';
const BAR_EMPTY = '░';

export function progressBar(positionMs, durationMs, width = PANEL_BAR_WIDTH) {
  const cells = Math.max(4, Math.min(30, Number(width) || PANEL_BAR_WIDTH));
  const total = Number(durationMs);
  const position = Math.max(0, Number(positionMs) || 0);
  if (!Number.isFinite(total) || total <= 0) return BAR_EMPTY.repeat(cells);
  const ratio = Math.max(0, Math.min(1, position / total));
  const filled = Math.min(cells, Math.round(ratio * cells));
  return `${BAR_FULL.repeat(filled)}${BAR_EMPTY.repeat(cells - filled)}`;
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

function buttonRow(buttons) {
  return { type: 1, components: buttons };
}

// Discord's REST validator only accepts a partial-emoji *object* here, even though
// the docs also show a bare string. A string fails with MODEL_TYPE_CONVERT.
function button({ action, guildId, label, emoji, style = 2, disabled = false }) {
  return { type: 2, style, label, emoji: { name: emoji }, custom_id: panelCustomId(action, guildId), disabled };
}

/**
 * @param {object} snapshot from `MusicManager.snapshot()`
 * @param {{ guildId: string, controlUrl?: string | null }} options
 */
export function renderPanel(snapshot = {}, { guildId = '', controlUrl = null } = {}) {
  const guild = String(guildId ?? '').trim();
  if (!guild) throw new TypeError('卡片需要 guildId');
  const state = ['idle', 'preparing', 'playing', 'paused'].includes(snapshot.state) ? snapshot.state : 'idle';
  const idle = state === 'idle';
  const durationMs = Number(snapshot.durationMs) || 0;
  const positionMs = idle ? 0 : Number(snapshot.positionMs) || 0;
  const title = snapshot.title ? `🎵 ${snapshot.title}` : '🎵 音樂播放';
  const lines = [];
  if (idle) lines.push('目前沒有播放中的歌曲。用 `/play` 點一首，卡片會自動出現。');
  else {
    lines.push(progressBar(positionMs, durationMs));
    lines.push(`\`${formatClock(positionMs)} / ${durationMs > 0 ? formatClock(durationMs) : '--:--'}\``);
  }
  const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
  const meta = [STATE_TEXT[state], `循環：${snapshot.loop === 'one' ? '單曲' : snapshot.loop === 'all' ? '全部' : '關閉'}`,
    `音量：${Number.isInteger(snapshot.volume) ? snapshot.volume : 60}%`];
  if (queue.length) meta.push(`佇列：${queue.length} 首`);
  lines.push(meta.join(' · '));

  const pauseAction = state === 'paused' ? 'resume' : 'pause';
  const pauseLabel = state === 'paused' ? '繼續' : '暫停';
  const primary = [
    button({ action: pauseAction, guildId: guild, label: pauseLabel, emoji: state === 'paused' ? '▶️' : '⏸️', style: 1, disabled: idle || state === 'preparing' }),
    button({ action: 'next', guildId: guild, label: '下一首', emoji: '⏭️', disabled: idle }),
    button({ action: 'queue', guildId: guild, label: '佇列', emoji: '📋', disabled: idle && !queue.length }),
    button({ action: 'refresh', guildId: guild, label: '刷新', emoji: '🔄' }),
    button({ action: 'remove', guildId: guild, label: '移除', emoji: '🗑️' }),
  ];
  const components = [buttonRow(primary)];
  // Opt-in via DSK_DISCORD_MUSIC_CONSOLE=1: the card is the product, the console is a debug extra.
  if (controlUrl) {
    components.push(buttonRow([{ type: 2, style: 5, label: '網頁控制（可拖動）', url: String(controlUrl) }]));
  }

  const embed = {
    color: PANEL_COLOR,
    title,
    description: lines.join('\n'),
    footer: { text: snapshot.requester ? `點播：${snapshot.requester}` : 'dsh-discord 音樂' },
  };
  // A local file or a bare search term is not a URL, and Discord rejects the whole
  // embed when `url` is not http(s).
  if (typeof snapshot.url === 'string' && /^https?:\/\//iu.test(snapshot.url.trim())) {
    embed.url = snapshot.url.trim();
  }
  return { embeds: [embed], components };
}
