import { t } from './i18n.mjs';
import { DEFAULT_MUSIC_SELECTION_METHOD, MUSIC_SELECTION_METHODS, isMusicSelectionMethod } from './music-selection.mjs';

/**
 * Voice-channel music commands, shared by every text bridge.
 *
 * The chat bridges own no voice transport, so this stays a thin dispatcher: the
 * adapter supplies a `music` manager (see `src/channels/discord/music.mjs`) whose
 * methods take the channel id and answer with `{ message }`.
 */

export const MUSIC_COMMAND_NAMES = Object.freeze(['play', 'playmethod', 'music']);

const MUSIC_COMMAND = /^\/(playmethod|play|music)(?=$|\s)/iu;
const PLAY_METHOD = /^--method(?:=|\s+|$)(\S*)/iu;

// Spoken spellings people actually type for the four methods. The canonical
// value is what reaches the pipeline; these only make /playmethod forgiving.
const METHOD_ALIASES = Object.freeze({
  youtubefirst: 'youtube', 'youtube-first': 'youtube', first: 'youtube',
  'tf-idf': 'tfidf', cosine: 'tfidf',
  llm: 'dsh',
  dshweb: 'dsh-web', 'dsh_web': 'dsh-web', web: 'dsh-web',
});

function normalizeMethod(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(METHOD_ALIASES, key) ? METHOD_ALIASES[key] : key;
}

// Shortcut spellings that used to exist as top-level commands. They now resolve
// to `/music <name>`: one surface per action, and the retired spelling answers
// with the replacement instead of leaking into the chat as an ordinary message.
export const RETIRED_MUSIC_SHORTCUTS = Object.freeze(['join', 'next', 'pause', 'resume', 'queue', 'leave']);

const RETIRED_SHORTCUT = /^\/(join|next|pause|resume|queue|leave)(?=$|\s)/iu;

export const MUSIC_COMMAND_USAGE = '/play <链接|关键词>';

export function isMusicCommand(text) {
  return typeof text === 'string' && MUSIC_COMMAND.test(text.trim());
}

export function isRetiredMusicShortcut(text) {
  return typeof text === 'string' && RETIRED_SHORTCUT.test(text.trim());
}

/** Answer a retired shortcut by naming the `/music` subcommand that replaced it. */
export function runRetiredMusicShortcut(text) {
  const match = typeof text === 'string' ? RETIRED_SHORTCUT.exec(text.trim()) : null;
  if (!match) return null;
  return { message: t('/{name} 已合併到 /music：請改用 /music {name}。', { name: match[1].toLowerCase() }) };
}

export function parseMusicCommand(text) {
  const match = MUSIC_COMMAND.exec(String(text ?? '').trim());
  if (!match) return null;
  let name = match[1].toLowerCase();
  let argument = String(text).trim().slice(match[0].length).trim();
  if (name === 'music') {
    const command = /^(join|skip|stop|pause|resume|queue|nowplaying|status|volume|bitrate|channels|leave)(?=$|\s)/i.exec(argument);
    if (!command) return { name: 'help', argument };
    name = command[1].toLowerCase();
    argument = argument.slice(command[0].length).trim();
    if (name === 'skip') name = 'next';
  }
  if (name === 'play') {
    const method = PLAY_METHOD.exec(argument);
    if (method) return {
      name,
      argument: argument.slice(method[0].length).trim(),
      selectionMethod: method[1].toLowerCase(),
    };
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
  // `/music play` used to be an alias of `/play`; the slash group no longer lists
  // it, so a leftover habit gets an answer instead of the generic help wall.
  if (parsed.name === 'help' && /^play(?=$|\s)/i.test(parsed.argument)) {
    return { message: '點歌請直接用 /play <網址或關鍵詞>。' };
  }
  if (parsed.selectionMethod !== undefined && !Object.hasOwn(MUSIC_SELECTION_METHODS, parsed.selectionMethod)) {
    return { message: '請指定有效選歌方法：youtube、tfidf、dsh 或 dsh-web。' };
  }
  if (parsed.argument && !['play', 'playmethod', 'volume', 'bitrate', 'channels', 'help'].includes(parsed.name)) {
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
      case 'play': {
        // An explicit --method wins; otherwise the operator's saved default. With
        // neither, the pipeline keeps its own default, so an unset store changes
        // nothing. A stale saved value is ignored, not fatal.
        const saved = typeof state?.musicDefaultMethod === 'function' ? state.musicDefaultMethod() : null;
        const selectionMethod = parsed.selectionMethod
          ?? (isMusicSelectionMethod(saved) ? saved : undefined);
        // `/play` is the only way in for a fresh request; `/music play` stays gone.
        return await invoke('play', { ...request, query: parsed.argument,
          ...(selectionMethod ? { selectionMethod } : {}) });
      }
      case 'playmethod': {
        const requested = normalizeMethod(parsed.argument);
        const saved = typeof state?.musicDefaultMethod === 'function' ? state.musicDefaultMethod() : null;
        const current = isMusicSelectionMethod(saved) ? saved : DEFAULT_MUSIC_SELECTION_METHOD;
        const menu = Object.entries(MUSIC_SELECTION_METHODS)
          .map(([value, name]) => `${value}（${name}）`).join('、');
        if (!requested) {
          return { message: `目前預設選歌方法：${current}（${MUSIC_SELECTION_METHODS[current]}）\n可選：${menu}\n用法：/playmethod <方法>` };
        }
        if (!isMusicSelectionMethod(requested)) {
          return { message: `沒有這個選歌方法：${requested}\n可選：${menu}` };
        }
        if (typeof state?.setMusicDefaultMethod !== 'function') {
          return { message: '這個頻道不支援儲存預設選歌方法。' };
        }
        await state.setMusicDefaultMethod(requested);
        return { message: `已把預設選歌方法改為 ${requested}（${MUSIC_SELECTION_METHODS[requested]}）。之後的 /play 都用它，單次可用 --method 覆寫。` };
      }
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
        return { message: '/play 網址或關鍵詞\n/play --method=youtube|tfidf|dsh|dsh-web 關鍵詞（單次指定）\n/playmethod [youtube|tfidf|dsh|dsh-web]：查看或設定全域預設選歌方法\n/music skip、/music stop、/music pause、/music resume\n/music queue、/music nowplaying、/music status、/music volume 0–100、/music leave\n/music bitrate [16–384]：查看或設定 kbps（預設 192；頻道設定不限制輸出，只受聲道上限約束）\n/music channels [1|2]：單聲道／雙聲道（預設 2）；320 kbps 請選 2\n也可在聊天中 @機器人，明確要求點歌或控制音樂。\n/stop 與 /skip 仍然控制 AI 任務。' };
      default:
        return null;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return { message: '音樂指令已取消，未重新加入已取消的歌曲。' };
    const reason = error instanceof Error ? error.message : String(error);
    return { message: t('放歌失败了：{reason}', { reason }) };
  }
}
