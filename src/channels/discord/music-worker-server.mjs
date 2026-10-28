import { MusicWorkerRpc } from './music-worker-rpc.mjs';
import { MusicManager } from './music.mjs';

/** Own the complete voice lifecycle on the worker's event loop. */
export function serveMusicWorker(port, options, createManager = options => new MusicManager(options)) {
  let manager, closing = false;
  const post = message => { try { port.postMessage(message); } catch {} };
  const rpc = new MusicWorkerRpc(port, async (method, params, { signal, ready }) => {
    if (method === 'destroy') {
      closing = true; await manager.destroy(); return null;
    }
    if (closing) throw new Error('音樂 worker 已關閉或指令無效');
    if (method === 'snapshot') return manager.snapshot(params.guildId);
    if (method === 'control') return manager.control(params.guildId, params.action, params.params ?? {});
    if (method !== 'execute') throw new Error('音樂 worker 已關閉或指令無效');
    return manager.execute(params.command, { ...params.args, signal, ready });
  });
  manager = createManager({ ...options,
    selectCandidate: ({ signal, ...params }) => rpc.request('select', params, { signal }),
    // Notices never hold up playback or shutdown while the parent is busy.
    notify: async (channelId, message) => post({ event: 'notice', channelId, message }),
    logger: (level, event, detail) => post({ event: 'log', level, name: event, detail }),
    // The card lives in the host process; the worker only says "this guild changed".
    onPlaybackChange: guildId => post({ event: 'playback', guildId: String(guildId ?? '') }),
  });
  port.once('close', () => { closing = true; rpc.close(); void manager.destroy(); });
  return { manager, rpc };
}
