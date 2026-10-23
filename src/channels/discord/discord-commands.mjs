// Discord application commands (the native "/" menu with descriptions and
// autocomplete) for the owner-only command set. Registration is one PUT per
// scope: global commands propagate slowly, guild commands appear immediately,
// so the adapter registers globally on ready and per guild when it knows one.
//
// Everything here stays transport-only: the command text is rebuilt from the
// interaction payload and handed to the same runners the text path uses, so the
// behaviour of `/skip` never depends on which surface invoked it.

import { COMMAND_PERMISSION_DENIED_MESSAGE, evaluateInboundAccess } from '../shared/inbound-access.mjs';
import { t } from '../shared/i18n.mjs';
import { isMusicCommand } from '../shared/music-commands.mjs';

const APPLICATION_COMMAND = 1;
const STRING_OPTION = 3;
const INTEGER_OPTION = 4;
const USER_OPTION = 6;
const SUB_COMMAND = 1;

export const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
export const INTERACTION_TYPE_AUTOCOMPLETE = 4;
export const INTERACTION_RESPONSE_DEFERRED = 5;
export const INTERACTION_RESPONSE_AUTOCOMPLETE = 8;
export const MESSAGE_FLAG_EPHEMERAL = 64;

const zh = (text) => ({ 'zh-CN': text });

const HOURS_OPTION = Object.freeze({
  type: INTEGER_OPTION,
  name: 'hours',
  description: 'How many hours of history to include (default 24)',
  description_localizations: zh('要包含最近多少小时的记录（默认 24）'),
  required: false,
  min_value: 1,
  max_value: 720,
});

const MINUTES_OPTION = Object.freeze({
  type: INTEGER_OPTION,
  name: 'minutes',
  description: 'How long to pause automatic replies (default 60)',
  description_localizations: zh('暂停多少分钟（默认 60）'),
  required: false,
  min_value: 1,
  max_value: 10080,
});

const TITLE_OPTION = Object.freeze({
  type: STRING_OPTION,
  name: 'title',
  description: 'Thread title (default: 新讨论串)',
  description_localizations: zh('讨论串标题（默认：新讨论串）'),
  required: false,
  min_length: 1,
  max_length: 100,
});

const RECALL_HOURS_OPTION = Object.freeze({
  type: INTEGER_OPTION,
  name: 'hours',
  description: 'How far back the next turn may look (default 24)',
  description_localizations: zh('下一轮最多回溯多少小时（默认 24）'),
  required: false,
  min_value: 1,
  max_value: 72,
});

const USER_OPTION_DEF = Object.freeze({
  type: USER_OPTION,
  name: 'user',
  description: 'The member to target',
  description_localizations: zh('要操作的对象'),
  required: true,
});

const BLOCK_MINUTES_OPTION = Object.freeze({
  type: INTEGER_OPTION,
  name: 'minutes',
  description: 'How long to pause that person (default 60)',
  description_localizations: zh('暂停该用户多少分钟（默认 60）'),
  required: false,
  min_value: 1,
  max_value: 10080,
});

/** Free-text music query: a URL, search words, or an attachment/file name. */
const QUERY_OPTION = Object.freeze({
  type: STRING_OPTION,
  name: 'query',
  description: 'URL, search words, or a file name in this channel',
  description_localizations: zh('链接、关键词，或频道里的文件名'),
  required: false,
  max_length: 500,
});

/**
 * The native command metadata. Discord only renders these in the picker, so the
 * descriptions here must match the Chinese help lines in command-catalog.mjs.
 */
export const DISCORD_APP_COMMANDS = Object.freeze([
  {
    type: APPLICATION_COMMAND,
    name: 'stop',
    name_localizations: zh('停止'),
    description: 'Stop the task running in this chat',
    description_localizations: zh('停止当前聊天里正在运行的任务'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'skip',
    name_localizations: zh('跳过'),
    description: 'Skip the current thinking (short spelling of /stop)',
    description_localizations: zh('跳过当前思考（/stop 的快捷写法）'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'digest',
    name_localizations: zh('摘要'),
    description: 'Summarize the recent conversation of this chat',
    description_localizations: zh('查看本频道最近的群聊摘要'),
    options: [HOURS_OPTION],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'thread',
    name_localizations: zh('建串'),
    description: 'Create a thread under the current channel',
    description_localizations: zh('在当前频道创建一个讨论串'),
    options: [TITLE_OPTION],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'mute',
    name_localizations: zh('静音'),
    description: 'Pause automatic replies in this channel',
    description_localizations: zh('暂停本频道的自动回复'),
    options: [MINUTES_OPTION],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'unmute',
    name_localizations: zh('取消静音'),
    description: 'Resume automatic replies in this channel',
    description_localizations: zh('恢复本频道的自动回复'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'recall',
    name_localizations: zh('回溯'),
    description: 'Widen the next turn to older chat history',
    description_localizations: zh('放宽下一轮可读取的早期群聊记录'),
    options: [RECALL_HOURS_OPTION],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'block',
    name_localizations: zh('暂停某人'),
    description: 'Pause one member’s replies in this channel',
    description_localizations: zh('在本频道暂停某个成员的回复'),
    options: [USER_OPTION_DEF, BLOCK_MINUTES_OPTION],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'unblock',
    name_localizations: zh('恢复某人'),
    description: 'Lift a pause on one member in this channel',
    description_localizations: zh('解除对某个成员的暂停'),
    options: [USER_OPTION_DEF],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'blocklist',
    name_localizations: zh('暂停名单'),
    description: 'List members paused in this channel',
    description_localizations: zh('查看本频道的暂停名单'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'play',
    name_localizations: zh('播放'),
    description: 'Join your voice channel and play a URL, search, or attached audio',
    description_localizations: zh('加入你的语音频道，播放链接、搜索结果或附件音频'),
    options: [QUERY_OPTION],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'music',
    description: 'Music controls (separate from AI /stop and /skip)',
    description_localizations: zh('音乐控制（不影响 AI 的 /stop 与 /skip）'),
    options: [
      { type: SUB_COMMAND, name: 'play', description: 'Play a URL or search for a song', options: [{ ...QUERY_OPTION, required: true }] },
      { type: SUB_COMMAND, name: 'join', description: 'Join your voice channel' },
      { type: SUB_COMMAND, name: 'skip', description: 'Skip the current song, including pending preparation' },
      { type: SUB_COMMAND, name: 'stop', description: 'Stop music and clear the queue' },
      { type: SUB_COMMAND, name: 'pause', description: 'Pause music' },
      { type: SUB_COMMAND, name: 'resume', description: 'Resume music' },
      { type: SUB_COMMAND, name: 'queue', description: 'Show the music queue' },
      { type: SUB_COMMAND, name: 'nowplaying', description: 'Show the current song' },
      { type: SUB_COMMAND, name: 'status', description: 'Show voice UDP delay, packet buffer and playback health' },
      { type: SUB_COMMAND, name: 'volume', description: 'Set playback volume', options: [
        { type: INTEGER_OPTION, name: 'percent', description: 'Volume from 0 to 100', required: true, min_value: 0, max_value: 100 },
      ] },
      { type: SUB_COMMAND, name: 'leave', description: 'Stop music and leave voice' },
    ],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'join',
    name_localizations: zh('进语音'),
    description: 'Join the voice channel the sender is currently in',
    description_localizations: zh('进入使用命令的人所在的语音频道'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'next',
    name_localizations: zh('下一首'),
    description: 'Skip to the next track',
    description_localizations: zh('跳到下一首'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'pause',
    name_localizations: zh('暂停播放'),
    description: 'Pause playback',
    description_localizations: zh('暂停播放'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'resume',
    name_localizations: zh('继续播放'),
    description: 'Resume playback',
    description_localizations: zh('继续播放'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'queue',
    name_localizations: zh('歌单'),
    description: 'Show the current queue',
    description_localizations: zh('查看当前歌单'),
    options: [],
  },
  {
    type: APPLICATION_COMMAND,
    name: 'leave',
    name_localizations: zh('离开语音'),
    description: 'Disconnect from the voice channel and clear the queue',
    description_localizations: zh('断开语音频道并清空歌单'),
    options: [],
  },
]);

/** Command objects for a Discord PUT, cloned so callers cannot mutate the source. */
export function applicationCommandPayloads() {
  return DISCORD_APP_COMMANDS.map((command) => JSON.parse(JSON.stringify(command)));
}

/**
 * Rebuild the plain command text a runner expects from an interaction payload.
 * Any option value is appended verbatim; the runners re-parse the text, so this
 * keeps exactly one parser in the codebase.
 */
export function commandTextFromInteraction(interaction) {
  const data = interaction?.data;
  if (!data || typeof data.name !== 'string' || !data.name) return null;
  const options = Array.isArray(data.options) ? data.options : [];
  if (data.name === 'music') {
    const sub = options.find(option => option.type === SUB_COMMAND);
    if (!sub) return '/music';
    const values = (sub.options ?? []).map(option => option.value).filter(value => typeof value === 'string' || typeof value === 'number');
    return ['/music', sub.name, ...values].join(' ');
  }
  const values = [];
  for (const option of options) {
    if (!option || option.type === SUB_COMMAND) continue;
    // A user option arrives as a bare snowflake; the text runners accept the
    // `<@id>` form, so render it here and keep their parser unchanged.
    if (option.type === USER_OPTION) {
      const userId = typeof option.value === 'string' ? option.value.trim() : '';
      if (userId) values.push(`<@${userId}>`);
      continue;
    }
    const value = typeof option.value === 'string' || typeof option.value === 'number'
      ? String(option.value).trim()
      : '';
    if (value) values.push(value);
  }
  return [`/${data.name}`, ...values].join(' ');
}

/** The channel a command belongs to: a thread command targets its parent. */
export function interactionConversationId(interaction) {
  const channelId = String(interaction?.channel_id ?? '').trim();
  const parentId = String(interaction?.channel?.parent_id ?? '').trim();
  return parentId || channelId || null;
}

/**
 * Acknowledge and then answer one native application-command interaction.
 *
 * Deferring first is what keeps the 3-second acknowledgement window safe: the
 * digest query and the stop RPC are not bounded by it, and a visible "thinking"
 * placeholder is better than a failed interaction. Acknowledgements and answers
 * are public in the invoking channel; execution still follows the access policy.
 */
export async function handleApplicationCommand(interaction, {
  api, bridge, accessPolicy, applicationId, logger,
} = {}) {
  const data = interaction?.data;
  if (interaction?.type !== INTERACTION_TYPE_APPLICATION_COMMAND
    || !data || !interaction.id || !interaction.token) return false;
  const text = commandTextFromInteraction(interaction);
  if (!text) return false;
  const conversationId = interactionConversationId(interaction);
  if (!conversationId) return false;
  const senderId = String(interaction.member?.user?.id ?? interaction.user?.id ?? '');

  const decision = evaluateInboundAccess(accessPolicy, {
    conversationType: interaction.guild_id ? 'group' : 'direct',
    senderIds: senderId ? [senderId] : [],
    text,
    hasImages: false,
    hasFiles: false,
  });

  const respond = (content) => api.updateInteractionOriginal(applicationId, interaction.token, {
    content,
    allowed_mentions: { parse: [] },
  }).catch((error) => {
    logger?.error?.('[dsh-im:discord] interaction follow-up failed:', {
      interactionId: String(interaction.id),
      message: error?.message ?? String(error),
    });
  });

  try {
    await api.createInteractionResponse(interaction.id, interaction.token, {
      type: INTERACTION_RESPONSE_DEFERRED,
      data: { flags: 0 },
    });
  } catch (error) {
    logger?.error?.('[dsh-im:discord] interaction acknowledgement failed:', {
      interactionId: String(interaction.id),
      message: error?.message ?? String(error),
      status: error?.status,
      providerCode: error?.providerCode,
    });
    return false;
  }

  // Music commands are open to every member; the rest stays behind the
  // owner-only execution permission the access policy already enforces.
  if (!decision.allowed && !isMusicCommand(text)) {
    await respond(t(COMMAND_PERMISSION_DENIED_MESSAGE));
    return true;
  }

  let reply = null;
  try {
    reply = await bridge.runNativeCommand(text, {
      conversationId,
      senderId,
    });
  } catch (error) {
    if (error?.code === 'turn-stopped') return true;
    logger?.error?.('[dsh-im:discord] interaction command failed:', {
      command: text,
      message: error?.message ?? String(error),
    });
    await respond(t('命令执行失败，请稍后重试。'));
    return true;
  }
  await respond(reply || t('命令已完成。'));
  return true;
}

/**
 * Register the owner command set. Guild registration is the one that shows up
 * immediately in the picker; `commands: []` clears a scope, which is how the
 * global duplicate set from an earlier build gets removed.
 */
export async function syncApplicationCommands(api, {
  applicationId, guildId = null, signal, commands = null,
} = {}) {
  const payload = commands ?? applicationCommandPayloads();
  if (!applicationId) throw new Error('Discord application id is required to register commands');
  if (guildId) {
    return api.putGuildApplicationCommands(applicationId, guildId, payload, { signal });
  }
  return api.putGlobalApplicationCommands(applicationId, payload, { signal });
}
