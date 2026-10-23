/** Passive, incremental observer. Never logs in, sends messages, or reads credentials. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveImLogFile } from '../src/channels/shared/im-log.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const COMMANDS = new Set(['play', 'music', 'join', 'next', 'pause', 'resume', 'queue', 'leave', 'stop', 'skip']);
const CAUSES = {
  'voice-permission': '語音頻道 Connect／Speak 權限或使用者所在頻道需檢查',
  'voice-connection': 'Discord 語音連線中斷或無法進入 Ready 狀態',
  'download': '音訊下載、來源擷取或完整性檢查失敗',
  'normalization': '音訊音量處理或編碼失敗',
  'timeout': '音樂處理超過等待期限',
  'selection-fallback': 'DSH 選歌暫不可用，目前改用搜尋首選',
  'command-registration': 'Discord 指令註冊失敗',
  'interaction-response': 'Discord 互動確認或回覆失敗，指令可能停留在思考狀態',
  'gateway': 'Discord Gateway 連線或 Intents 設定需檢查',
  'music-runtime': '音樂執行階段發生錯誤，需查看本機顯示的錯誤',
  'music-notification': '音樂提示訊息回覆失敗，不能據此判定語音串流或 UDP 中斷',
  'transport-quality': '播放鏈路出現音訊供應缺口、主程序延遲或 UDP 往返抖動；需對照統計定位，不能直接判定網際網路丟包',
};

export function classifyMusicLog(row) {
  if (!row || typeof row !== 'object' || !Number.isFinite(Date.parse(row.ts))) return null;
  let data = {};
  try { data = JSON.parse(row.message); } catch {}
  const text = typeof row.message === 'string' ? row.message : '';
  const event = row.event === 'log' ? text.match(/\bmusic\.[a-z.-]+\b/i)?.[0]?.toLowerCase() ?? 'log' : row.event;
  // Output only enumerated fields; raw messages, queries, URLs and IDs never escape.
  const result = { at: row.ts, event };
  if (['music.transport.stats', 'music.transport.degraded', 'music.transport.recovered', 'music.reconnect.recovered'].includes(event)) {
    let detail = {};
    try { detail = JSON.parse(text.slice(text.lastIndexOf('{'))); } catch {}
    const metrics = {};
    for (const key of ['udpPingMs', 'wsPingMs', 'udpJitterMs', 'eventLoopMaxMs', 'framesRead', 'sourceStarved', 'maxReadGapMs', 'bufferedMs', 'bitrate']) {
      metrics[key] = Number.isFinite(detail[key]) && detail[key] >= 0 ? detail[key] : null;
    }
    if (event === 'music.transport.degraded') return { ...result, kind: 'failure', cause: 'transport-quality', detail: CAUSES['transport-quality'], metrics };
    if (event.endsWith('.recovered')) return { ...result, kind: 'recovery', metrics };
    return { ...result, kind: 'transport', metrics };
  }
  if (event === 'commands.global-cleared') return { ...result, kind: 'reload' };
  if (event === 'commands.synced') return { ...result, kind: 'commands', scopeKey: digest(String(data.guildId ?? 'unknown')) };
  if (event === 'interaction.handled' && COMMANDS.has(data.command)) return { ...result, kind: 'interaction', command: data.command };
  if (event === 'music.playing') {
    const selection = /"selection"\s*:\s*"(dsh|direct|file|search-fallback)"/.exec(text)?.[1] ?? 'unknown';
    return { ...result, kind: 'source-submitted', selection };
  }
  const failure = ['warn', 'error'].includes(row.level);
  let cause;
  if (event === 'music.dsh.fallback') cause = 'selection-fallback';
  else if (failure && event === 'music.notice.failed') cause = 'music-notification';
  else if (failure && /interaction (?:acknowledgement|follow-up|handling|command) failed/i.test(text)) cause = 'interaction-response';
  else if (failure && /command.*(?:registration|cleanup).*failed|commands\..*fail/i.test(text)) cause = 'command-registration';
  else if (failure && /discord-gateway|connection\.(?:restore|monitor)|\b(?:4004|4013|4014)\b/i.test(text)) cause = 'gateway';
  else if (failure && event?.startsWith('music.')) {
    if (/permissions?|\bConnect\b|\bSpeak\b|權限|权限|語音頻道再操作/i.test(text)) cause = 'voice-permission';
    else if (/music\.(?:connection|reconnect)|UDP|語音連線|语音连接/i.test(text)) cause = 'voice-connection';
    else if (/逾時|超时|timed?\s*out/i.test(text)) cause = 'timeout';
    else if (/loudnorm|音量|normaliz|編碼|编码/i.test(text)) cause = 'normalization';
    else if (/yt-dlp|download|extract|下載|下载|不完整|no.audio|format/i.test(text)) cause = 'download';
    else cause = 'music-runtime';
  }
  return cause ? { ...result, kind: 'failure', cause, detail: CAUSES[cause] } : null;
}

export function consumeMusicLog(text, previous = null, now = Date.now()) {
  const lines = text.split('\n');
  lines.pop(); // Ignore an incomplete final JSONL record until the next check.
  const signature = digest(lines[0] ?? '');
  const reset = !previous || previous.signature !== signature || previous.cursor > lines.length;
  const state = { milestones: {}, errors: {}, guilds: [], interactions: 0, submittedSources: 0, ...structuredClone(previous ?? {}), missingLog: false };
  const notifications = [];
  const selected = reset ? lines : lines.slice(previous.cursor);
  const bootstrapFloor = previous?.signature ? 0 : now - 30 * 60_000;
  for (const line of selected) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (Date.parse(row.ts) < bootstrapFloor) continue;
    const event = classifyMusicLog(row);
    if (!event) continue;
    state.lastRelevantAt = event.at;
    if (event.kind === 'reload') {
      state.lastReloadAt = event.at;
      state.guilds = [];
      state.milestones = {};
      state.interactions = 0;
      state.submittedSources = 0;
      state.lastTransport = null;
    } else if (event.kind === 'commands') {
      if (!state.guilds.includes(event.scopeKey)) state.guilds.push(event.scopeKey);
      state.lastCommandSyncAt = event.at;
      if (!state.milestones.commands) {
        state.milestones.commands = event.at;
        notifications.push({ type: 'progress', at: event.at, code: 'guild-commands-synced', detail: '觀察到伺服器指令同步成功' });
      }
    } else if (event.kind === 'interaction' && ['play', 'music'].includes(event.command)) {
      state.interactions++;
      if (!state.milestones.interaction) {
        state.milestones.interaction = event.at;
        notifications.push({ type: 'progress', at: event.at, code: 'music-command-observed', detail: '觀察到真實音樂指令已處理' });
      }
    } else if (event.kind === 'source-submitted') {
      state.submittedSources++;
      if (!state.milestones.source) {
        state.milestones.source = event.at;
        notifications.push({ type: 'progress', at: event.at, code: 'normalized-source-submitted', detail: '正規化音訊已提交播放器；此紀錄不能單獨證明使用者已聽到聲音' });
      }
      if (event.selection === 'dsh' && !state.milestones.dsh) {
        state.milestones.dsh = event.at;
        notifications.push({ type: 'progress', at: event.at, code: 'dsh-selection-observed', detail: '觀察到真實 DSH 選歌結果進入音樂播放流程' });
      }
    } else if (event.kind === 'transport') {
      state.lastTransport = { at: event.at, ...event.metrics, rtpPacketLoss: null };
    } else if (event.kind === 'recovery') {
      notifications.push({ type: 'recovery', at: event.at, code: event.event, detail: '語音連線或播放鏈路已恢復；仍需實際收聽確認', metrics: event.metrics });
    } else if (event.kind === 'failure') {
      const failure = state.errors[event.cause] ?? { count: 0 };
      failure.count++; failure.lastAt = event.at; state.errors[event.cause] = failure;
      if (failure.count === 1 || failure.count === 3) notifications.push({ type: 'error', at: event.at, code: event.cause, count: failure.count, detail: event.detail,
        ...(event.metrics ? { metrics: event.metrics } : {}) });
    }
  }
  state.signature = signature;
  state.cursor = lines.length;
  state.checkedAt = new Date(now).toISOString();
  const summary = {
    checkedAt: state.checkedAt,
    lastReloadAt: state.lastReloadAt ?? null,
    lastCommandSyncAt: state.lastCommandSyncAt ?? null,
    observedGuildsSinceReload: state.guilds.length,
    observedMusicInteractions: state.interactions,
    observedSubmittedSources: state.submittedSources,
    dshSelectionObserved: Boolean(state.milestones.dsh),
    audiblePlaybackConfirmed: false,
    transport: state.lastTransport ?? null,
    pending: [
      ...(!state.guilds.length ? ['尚未觀察到這次重新載入後的伺服器指令同步'] : []),
      ...(!state.milestones.source ? ['尚未觀察到音訊提交播放器'] : []),
      '是否在語音頻道聽到音樂，仍需使用者確認',
    ],
  };
  return { state, report: { ...summary, notifications, changed: notifications.length > 0 } };
}

export async function monitorMusic({ logFile = resolveImLogFile('discord'), stateFile = resolve(import.meta.dirname, '..', '.dsh-im', 'music-monitor', 'state.json') } = {}) {
  let previous = null;
  try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch {}
  let text;
  try { text = await readFile(logFile, 'utf8'); }
  catch (error) {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ ...previous, missingLog: true }, null, 2));
    return { checkedAt: new Date().toISOString(), status: 'log-unavailable', changed: !previous?.missingLog,
      notifications: previous?.missingLog ? [] : [{ type: 'error', code: 'log-unavailable', detail: '目前無法讀取 Discord 本機紀錄；請確認 DSH 正在執行並啟用紀錄' }] };
  }
  const { state, report } = consumeMusicLog(text, previous);
  await mkdir(dirname(stateFile), { recursive: true });
  const pending = `${stateFile}.${process.pid}.tmp`;
  await writeFile(pending, JSON.stringify(state, null, 2)); await rename(pending, stateFile);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await monitorMusic(), null, 2));
}
