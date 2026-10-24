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
    const command = /^(play|join|skip|stop|pause|resume|queue|nowplaying|status|volume|bitrate|channels|leave)(?=$|\s)/i.exec(argument);
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
    guildId = null,
    hasImages = false,
    hasFiles = false,
    ready,
    isDirect = false,
  } = {},
) {
  const parsed = parseMusicCommand(text);
  if (!parsed) return null;
  if (signal?.aborted) return null;
  if (hasImages || hasFiles) return { message: '音樂指令請使用純文字網址或關鍵詞，移除附件後重試。' };
  if (isDirect) return { message: '請在伺服器頻道使用音樂指令。' };
  if (parsed.argument && !['play', 'volume', 'bitrate', 'channels', 'help'].includes(parsed.name)) {
    return { message: '這個音樂控制指令不接受額外文字；請單獨使用 /music stop、/music skip 等指令。' };
  }
  if (!music) return { message: t('音乐功能没开嘛。') };
  const source = typeof enhancement?.source === 'function' ? enhancement.source() : null;
  const channelId = conversationId ?? source?.chatId ?? null;
  if (!channelId) return { message: t('要在一个服务器频道里用嘛。') };
  const actorId = senderId ?? source?.senderId ?? null;
  const request = { channelId, senderId: actorId, ...(guildId ? { guildId } : {}) };
  const invoke = (name, args = request) => typeof music.execute === 'function'
    ? music.execute(name, { ...args, ...(signal ? { signal } : {}), ...(ready ? { ready } : {}) })
    : Promise.resolve(ready).then(() => music[name](args));
  try {
    switch (parsed.name) {
      case 'play':
        return await invoke('play', { ...request, query: parsed.argument });
      case 'join':
        return await invoke('join');
      case 'next':
        return await invoke('next');
      case 'stop':
        return await invoke('stop');
      case 'nowplaying':
        return await invoke('nowplaying');
      case 'status':
        return await invoke('status');
      case 'volume':
        return await invoke('volume', { ...request, percent: /^\d{1,3}$/.test(parsed.argument) ? Number(parsed.argument) : NaN });
      case 'bitrate':
        return await invoke('bitrate', { ...request, ...(parsed.argument ? { kbps: /^\d{1,3}$/.test(parsed.argument) ? Number(parsed.argument) : NaN } : {}) });
      case 'channels':
        return await invoke('channels', { ...request, ...(parsed.argument ? { count: /^[12]$/.test(parsed.argument) ? Number(parsed.argument) : NaN } : {}) });
      case 'pause':
        return await invoke('pause');
      case 'resume':
        return await invoke('resume');
      case 'queue':
        return await invoke('queue');
      case 'leave':
        return await invoke('leave');
      case 'help':
        return { message: '/play 網址或關鍵詞\n/music skip、/music stop、/music pause、/music resume\n/music queue、/music nowplaying、/music status、/music volume 0–100、/music leave\n/music bitrate [16–384]：查看或設定 kbps（預設 128，受聲道及語音頻道上限限制）\n/music channels [1|2]：單聲道／雙聲道（預設 2）；320 kbps 請選 2\n也可在聊天中 @機器人，明確要求點歌或控制音樂。\n/stop 與 /skip 仍然控制 AI 任務。' };
      default:
        return null;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return { message: '音樂指令已取消，未重新加入已取消的歌曲。' };
    const reason = error instanceof Error ? error.message : String(error);
    return { message: t('放歌失败了：{reason}', { reason }) };
  }
}
