import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { MusicWorkerRpc } from './music-worker-rpc.mjs';
import { createDshMusicSelector } from './music-dsh.mjs';

// Resolve from the installed package, including when this client is bundled in lib/index.js.
export const musicWorkerEntry = join(dirname(createRequire(import.meta.url).resolve('dsh-discord/package.json')),
  'src', 'channels', 'discord', 'music-worker-entry.mjs');

/** Lazy worker facade: only commands, selection and notifications touch the host. */
export class MusicWorkerManager {
  #options; #factory; #worker; #rpc; #notify; #logger; #select; #privilegedIds; #destroyed = false; #destroyTask;
  constructor({ token, harness, logger, notify, ytDlpPath, idleMs, cooldownMs, loginTimeoutMs, healthIntervalMs,
    workerFactory = (file, options) => new Worker(file, options), selectCandidate, privilegedIds = null } = {}) {
    this.#options = { token, ytDlpPath, idleMs, cooldownMs, loginTimeoutMs, healthIntervalMs };
    this.#privilegedIds = typeof privilegedIds === 'function' ? privilegedIds : () => [];
    this.#factory = workerFactory; this.#logger = logger; this.#notify = notify;
    this.#select = selectCandidate ?? createDshMusicSelector(harness, { logger });
  }
  get available() { return !this.#destroyed && typeof this.#options.token === 'string' && this.#options.token.length > 0; }
  #log(level, event, detail) { try { this.#logger?.(level, event, detail); } catch {} }
  #start() {
    if (this.#rpc) return this.#rpc;
    if (!this.available) throw new Error('音樂功能未啟用');
    const worker = this.#factory(musicWorkerEntry, {
      workerData: { ...this.#options, privilegedIds: this.#privilegedIds() },
      name: 'discord-music', execArgv: [],
    });
    const rpc = new MusicWorkerRpc(worker, (method, params, { signal }) => {
      if (method !== 'select') throw new Error('未知音樂 worker 請求');
      return this.#select({ ...params, signal });
    });
    this.#worker = worker; this.#rpc = rpc;
    worker.on('message', message => {
      if (this.#destroyed || this.#worker !== worker) return;
      if (message?.event === 'log') this.#log(message.level, message.name, message.detail);
      if (message?.event === 'notice') Promise.resolve().then(() => this.#notify?.(message.channelId, message.message))
        .catch(() => this.#log('warn', 'music.notice.failed', '音樂通知傳送失敗'));
    });
    let failed = false;
    const failure = () => {
      rpc.close(new Error('音樂 worker 已中斷；請重新點歌'));
      if (this.#worker === worker) { this.#worker = null; this.#rpc = null; }
      if (!failed && !this.#destroyed) this.#log('warn', 'music.worker.failed', '播放 worker 中斷，下一次指令會重新建立');
      failed = true;
    };
    worker.on('error', failure);
    worker.once('exit', failure);
    return rpc;
  }
  async execute(command, { signal, ready, ...args } = {}) {
    signal?.throwIfAborted();
    if (this.#destroyed) throw new Error('音樂服務已關閉');
    return this.#start().request('execute', { command, args }, { signal, ready });
  }
  destroy() {
    if (this.#destroyTask) return this.#destroyTask;
    this.#destroyed = true;
    this.#destroyTask = (async () => {
      const worker = this.#worker, rpc = this.#rpc;
      if (!worker) return;
      let timer;
      try {
        // Give FFmpeg and the voice client time to close before forced termination.
        await Promise.race([rpc.request('destroy'), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      } catch {} finally {
        clearTimeout(timer); rpc.close(); await worker.terminate();
        if (this.#worker === worker) { this.#worker = null; this.#rpc = null; }
      }
    })();
    return this.#destroyTask;
  }
}
