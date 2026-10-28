import { t } from './i18n.mjs';

const TEXT_CHANNELS = Object.freeze(['telegram', 'slack', 'discord', 'whatsapp', 'matrix']);

function defineCatalogCommand(name, description, help, { aliases = [], ...options } = {}) {
  return Object.freeze({
    name,
    description,
    channels: TEXT_CHANNELS,
    menuVisible: true,
    ...options,
    aliases: Object.freeze(aliases.map((alias) => Object.freeze({
      menuVisible: true,
      ...(typeof alias === 'string' ? { name: alias } : alias),
    }))),
    help: Object.freeze(help),
  });
}

// Presentation metadata for TextHarnessBridge commands, in help order.
// Keep each command's aliases, short description and full usage together here.
// Handlers still own parsing and authorization; privateOnly is descriptive.
// enabled: false removes a definition from both consumers; menuVisible: false
// hides a command (or alias) only from the native menu, leaving help available.
export const SHARED_COMMAND_CATALOG = Object.freeze([
  defineCatalogCommand('new', '开启一个全新会话', [
    '/new  开启一个全新会话',
  ]),
  defineCatalogCommand('compact', '压缩当前会话的较早上下文', [
    '/compact  压缩当前会话的较早上下文',
  ]),
  defineCatalogCommand('clear', '清空当前会话上下文并保留会话绑定', [
    '/clear  清空当前会话上下文（保留 Session 绑定和历史记录）',
  ]),
  defineCatalogCommand('history', '查看最近历史消息（仅私聊）', [
    '/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）',
  ], { privateOnly: true }),
  defineCatalogCommand('workspace', '切换工作区', [
    '/workspace 工作区序号或绝对路径  切换工作区',
  ], { aliases: ['ws'] }),
  defineCatalogCommand('conv', '设置当前对话专属工作区', [
    '/conv 或 /conversation  查看当前对话工作区',
    '/conv 工作区绝对路径或序号  设置当前对话专属工作区',
    '/conv clear  清除专属工作区，回到 bot 默认工作区',
  ], { aliases: ['conversation'] }),
  defineCatalogCommand('workspacelist', '列出工作区绝对路径', [
    '/workspacelist  列出工作区绝对路径',
    '/ws、/wsl、/workspaces  工作区命令别名',
  ], { aliases: ['workspaces', 'wsl'] }),
  defineCatalogCommand('sessionlist', '列出会话 ID 和标题', [
    '/sessionlist 或 /sessions [工作区序号或绝对路径]  列出会话 ID 和标题',
    '/sessionlist --limit N  仅列出当前工作区前 N 个会话',
  ], { aliases: ['sessions'] }),
  defineCatalogCommand('session', '将当前聊天绑定到指定会话', [
    '/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话',
  ]),
  defineCatalogCommand('models', '按序号列出所有可用模型', [
    '/models  按序号列出所有可用模型',
  ]),
  defineCatalogCommand('reasoninglist', '按序号列出当前模型可用推理等级', [
    '/reasoninglist 或 /reasonings  按序号列出当前模型可用推理等级',
  ], { aliases: ['reasonings'] }),
  defineCatalogCommand('reasoning', '查看或切换当前推理等级', [
    '/reasoning [序号、等级ID或 --default]  查看或切换当前推理等级',
  ]),
  defineCatalogCommand('model', '查看或切换当前会话模型', [
    '/model [序号或完整模型ID] [推理等级ID]  查看或切换当前会话模型',
    '示例：先发 /models，再发 /model 2 [推理等级ID]',
  ]),
  defineCatalogCommand('presetlist', '列出可用 Agent Preset', [
    '/presetlist 或 /presets  按序号列出可用 Agent Preset',
  ], { aliases: ['presets'] }),
  defineCatalogCommand('preset', '查看或设置新会话 Agent Preset', [
    '/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset',
    '纯数字 ID：/preset id:<ID>',
    '/preset --default  跟随 Host 默认',
  ]),
  defineCatalogCommand('stop', '停止当前任务', [
    '/stop  停止当前任务（跳歌用 /music skip，不要用 /stop）',
  ]),
  defineCatalogCommand('skip', '停止当前任务（等同 /stop，不是跳歌）', [
    '/skip  停止当前任务（等同 /stop；要跳歌请用 /music skip 或 /next）',
  ]),
  defineCatalogCommand('digest', '查看最近一段时间的群聊摘要（仅主人）', [
    '/digest [小时]  查看最近群聊摘要（默认 24 小时，最多 720 小时）',
  ], { privateOnly: true }),
  defineCatalogCommand('thread', '为当前频道创建讨论串（仅主人）', [
    '/thread [标题]  在当前频道创建讨论串',
  ], { privateOnly: true }),
  defineCatalogCommand('autoreply', '设置当前对话自动回复（仅主人）', [
    '/autoreply smart、on、off 或 status  智能接话、逐条回复、关闭或查询（重启后保留）',
  ], { privateOnly: true, channels: ['discord'] }),
  defineCatalogCommand('recall', '开放一次更早的群聊回溯（仅主人）', [
    '/recall [小时]  开放一次更早的群聊回溯（默认 24 小时；72 小时内直接生效，更长需再确认）',
    '/recall 批准  确认更长的回溯请求（最多 720 小时）',
  ], { privateOnly: true }),
  defineCatalogCommand('block', '在本频道暂停某人的回复（仅主人）', [
    '/block @某人 [分钟]  在本频道暂停某人的回复（默认 60 分钟，最多 7 天）',
  ], { privateOnly: true }),
  defineCatalogCommand('unblock', '解除对某人的暂停（仅主人）', [
    '/unblock @某人  解除对某人的暂停',
  ], { privateOnly: true }),
  defineCatalogCommand('blocklist', '查看本频道的暂停名单（仅主人）', [
    '/blocklist  查看本频道的暂停名单',
  ], { privateOnly: true }),
  defineCatalogCommand('mute', '暂停本频道自动回复（仅主人）', [
    '/mute [分钟]  暂停本频道自动回复（默认 60 分钟，最多 7 天）',
  ], { privateOnly: true }),
  defineCatalogCommand('unmute', '恢复本频道自动回复（仅主人）', [
    '/unmute  恢复本频道自动回复',
  ], { privateOnly: true }),
  defineCatalogCommand('play', '加入语音频道播放音乐', [
    '/play [链接或关键词]  加入你所在的语音频道并播放；不带参数时播放你刚发的音频附件',
  ]),
  defineCatalogCommand('music', '音樂專用控制指令', [
    '/music skip /music stop  跳歌或停止音樂；原 /skip /stop 仍控制 AI 任務',
    '/music pause /music resume /music queue /music nowplaying /music volume 0–100 /music leave',
    '/music bitrate [16–384]  查看或設定播放碼率（kbps，受聲道及語音頻道上限限制）',
    '/music channels [1|2]  查看或設定單聲道／雙聲道；320 kbps 請選 2',
    '/music status  查看 UDP 往返、封包緩衝與播放健康狀態',
  ]),
  defineCatalogCommand('join', '让机器人进入你所在的语音频道', [
    '/join  让机器人进入你所在的语音频道（需要 Connect + Speak 权限）',
  ]),
  defineCatalogCommand('next', '跳到下一首', [
    '/next  跳到下一首',
  ]),
  defineCatalogCommand('pause', '暂停播放', [
    '/pause  暂停播放',
  ]),
  defineCatalogCommand('resume', '继续播放', [
    '/resume  继续播放',
  ]),
  defineCatalogCommand('queue', '查看当前歌单', [
    '/queue  查看当前歌单',
  ]),
  defineCatalogCommand('leave', '离开语音频道', [
    '/leave  断开语音频道并清空歌单',
  ]),
  defineCatalogCommand('steer', '纠偏当前任务', [
    '/steer 补充指令  纠偏当前任务',
  ]),
  defineCatalogCommand('batch', '开始批量输入（仅私聊）', [
    '/batch  开始批量输入（仅私聊，最多 10 条文字）',
  ], { privateOnly: true }),
  defineCatalogCommand('send', '提交当前批次', [
    '/send  提交当前批次',
  ], { privateOnly: true }),
  defineCatalogCommand('cancel', '取消当前批次', [
    '/cancel  取消当前批次',
  ], { privateOnly: true }),
  defineCatalogCommand('status', '检查连接状态', [
    '/status  检查连接状态',
  ]),
  defineCatalogCommand('version', '查看插件版本', [
    '/version  查看插件版本',
  ]),
  defineCatalogCommand('help', '显示帮助', [
    '/help  显示本帮助',
  ]),
]);

export function commandsForChannel(channel, catalog = SHARED_COMMAND_CATALOG) {
  return catalog.filter((item) => item.enabled !== false && item.channels.includes(channel));
}

// Help order and headings. A flat list of forty lines is unreadable in chat, and
// it hides which commands a non-owner may actually use.
export const COMMAND_HELP_SECTIONS = Object.freeze([
  Object.freeze({ id: 'session', title: '会话' }),
  Object.freeze({ id: 'workspace', title: '工作区与会话绑定' }),
  Object.freeze({ id: 'model', title: '模型与推理' }),
  Object.freeze({ id: 'music', title: '音乐' }),
  Object.freeze({ id: 'owner', title: '群聊管理（仅主人）' }),
  Object.freeze({ id: 'misc', title: '其他' }),
]);

const MUSIC_NAMES = new Set(['play', 'music', 'join', 'next', 'pause', 'resume', 'queue', 'leave']);
const WORKSPACE_NAMES = new Set(['workspace', 'conv', 'workspacelist', 'sessionlist', 'session']);
const MODEL_NAMES = new Set(['models', 'model', 'reasoninglist', 'reasoning', 'presetlist', 'preset']);
const SESSION_NAMES = new Set(['new', 'compact', 'clear', 'history', 'stop', 'skip', 'steer', 'batch', 'send', 'cancel']);

/** Which help section a command belongs to; explicit lists win over privateOnly. */
export function commandSectionName(item) {
  if (MUSIC_NAMES.has(item.name)) return 'music';
  if (WORKSPACE_NAMES.has(item.name)) return 'workspace';
  if (MODEL_NAMES.has(item.name)) return 'model';
  if (SESSION_NAMES.has(item.name)) return 'session';
  if (item.privateOnly === true) return 'owner';
  return 'misc';
}

/**
 * Help grouped by section, in `COMMAND_HELP_SECTIONS` order.
 *
 * Empty sections disappear, so a channel without music commands never prints a
 * heading for them.
 */
export function commandHelpSections(channel, catalog = SHARED_COMMAND_CATALOG) {
  const buckets = new Map(COMMAND_HELP_SECTIONS.map((section) => [section.id, []]));
  for (const item of commandsForChannel(channel, catalog)) {
    const bucket = buckets.get(commandSectionName(item));
    if (bucket) bucket.push(...item.help.map((line) => t(line)));
  }
  return COMMAND_HELP_SECTIONS
    .map((section) => ({ id: section.id, title: t(section.title), lines: buckets.get(section.id) ?? [] }))
    .filter((section) => section.lines.length > 0);
}

export function commandHelpLines(channel, catalog = SHARED_COMMAND_CATALOG) {
  return commandsForChannel(channel, catalog).flatMap((item) => item.help.map((line) => t(line)));
}
