import { spawn } from 'node:child_process';

export function abortError() {
  return Object.assign(new Error('音樂處理已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/** Bounded output, deadlines and process-tree cancellation, without a shell. */
export function runMusicProcess(file, args, { cwd, signal, env, timeoutMs = 120_000, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '', stderr = '', bytes = 0, failure, forceTimer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve(value);
    };
    const kill = error => {
      if (failure || settled) return;
      failure = error;
      if (process.platform === 'win32' && child.pid) {
        // Tree termination must not block the DSH/Discord event loop.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const killTimer = setTimeout(() => killer.kill(), 3000);
        killTimer.unref?.();
        killer.once('close', () => clearTimeout(killTimer));
        killer.once('error', () => { clearTimeout(killTimer); child.kill(); });
      } else { child.kill('SIGTERM'); }
      forceTimer = setTimeout(() => { child.kill('SIGKILL'); finish(failure); }, 2000);
      forceTimer.unref?.();
    };
    const cancel = () => kill(abortError());
    const timer = setTimeout(() => kill(Object.assign(new Error('音樂處理逾時，請重試'), { code: 'MUSIC_TIMEOUT' })), timeoutMs);
    const consume = (target, chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) return kill(new Error('音樂工具輸出超過上限'));
      if (target === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    // Keep UTF-8 characters intact across stream chunks.
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => consume('out', chunk));
    child.stderr?.on('data', chunk => consume('err', chunk));
    child.once('error', error => finish(failure ?? error));
    child.once('close', code => {
      if (failure) return finish(failure);
      const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      finish(code === 0 ? null : new Error(`音樂工具執行失敗 (${code})：${detail.slice(0, 600)}`), { stdout, stderr });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
