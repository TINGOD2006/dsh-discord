import { t } from './i18n.mjs';

/**
 * Voice-channel music commands, shared by every text bridge.
 *
 * The chat bridges own no voice transport, so this stays a thin dispatcher: the
 * adapter supplies a `music` manager (see `src/channels/discord/music.mjs`) whose
 * methods take the channel id and answer with `{ message }`.
 */

export const MUSIC_COMMAND_NAMES = Object.freeze(['play', 'join', 'next', 'pause', 'resume', 'queue', 'leave', 'music']);

const MUSIC_COMMAND = /^\/(play|join|next|pause|resume|queue|leave|music)(?=$|\s)/iu;

export const MUSIC_COMMAND_USAGE = '/play <链接|关键词>';

export function isMusicCommand(text) {
  return typeof text === 'string' && MUSIC_COMMAND.test(text.trim());
}

export function parseMusicCommand(text) {
  const match = MUSIC_COMMAND.exec(String(text ?? '').trim());
  if (!match) return null;
  let name = match[1].toLowerCase();
  let argument = String(text).trim().slice(match[0].length).trim();
  if (name === 'music') {
    const command = /^(play|join|skip|stop|pause|resume|queue|nowplaying|volume|leave)(?=$|\s)/i.exec(argument);
    if (!command) return { name: 'help', argument: '' };
    name = command[1].toLowerCase();
    argument = argument.slice(command[0].length).trim();
    if (name === 'skip') name = 'next';
  }
  return { name, argument };
}

export async function runMusicCommand(
  text,
  harness,
  state,
  key,
  {
    signal,
    music = null,
    conversationId = null,
    enhancement = null,
    senderId = null,
  } = {},
) {
  const parsed = parseMusicCommand(text);
  if (!parsed) return null;
  if (signal?.aborted) return null;
  if (!music) return { message: t('音乐功能没开嘛。') };
  const source = typeof enhancement?.source === 'function' ? enhancement.source() : null;
  const channelId = conversationId ?? source?.chatId ?? null;
  if (!channelId) return { message: t('要在一个服务器频道里用嘛。') };
  const actorId = senderId ?? source?.senderId ?? null;
  const request = { channelId, senderId: actorId };
  try {
    switch (parsed.name) {
      case 'play':
        return await music.play({ ...request, query: parsed.argument });
      case 'join':
        return await music.join(request);
      case 'next':
        return await music.next(request);
      case 'stop':
        return await music.stop(request);
      case 'nowplaying':
        return await music.nowplaying(request);
      case 'volume':
        return await music.volume({ ...request, percent: /^\d{1,3}$/.test(parsed.argument) ? Number(parsed.argument) : NaN });
      case 'pause':
        return await music.pause(request);
      case 'resume':
        return await music.resume(request);
      case 'queue':
        return await music.queue(request);
      case 'leave':
        return await music.leave(request);
      case 'help':
        return { message: '/play 網址或關鍵詞\n/music skip、/music stop、/music pause、/music resume\n/music queue、/music nowplaying、/music volume 0–100、/music leave\n/stop 與 /skip 仍然控制 AI 任務。' };
      default:
        return null;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { message: t('放歌失败了：{reason}', { reason }) };
  }
}
