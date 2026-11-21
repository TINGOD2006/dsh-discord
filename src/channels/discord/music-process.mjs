import { spawn } from 'node:child_process';

export function abortError() {
  return Object.assign(new Error('音樂處理已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
let big5Decoder;

function big5() {
  if (big5Decoder === undefined) {
    try { big5Decoder = new TextDecoder('big5'); } catch { big5Decoder = null; }
  }
  return big5Decoder;
}

/**
 * yt-dlp ships as a PyInstaller build and writes its messages in the Windows
 * console code page, so a zh-TW host emits cp950 bytes even when the caller
 * asked for UTF-8. Decoding those as UTF-8 replaces every CJK character with
 * U+FFFD, which also breaks the age-gate and region-block detection in
 * music-audio.mjs: the fallback never recognises "滿限制年齡", so one
 * age-restricted upload fails the whole request instead of trying the next
 * candidate. Decode as UTF-8 when the bytes are valid UTF-8, otherwise Big5.
 */
export function decodeMusicOutput(chunks) {
  const buffer = Buffer.concat(chunks);
  try { return UTF8_STRICT.decode(buffer); } catch {}
  const decoder = big5();
  return decoder ? decoder.decode(buffer) : buffer.toString('utf8');
}

/** Bounded output, deadlines and process-tree cancellation, without a shell. */
export function runMusicProcess(file, args, { cwd, signal, env, timeoutMs = 120_000, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const outChunks = [], errChunks = [];
    let bytes = 0, failure, forceTimer, settled = false;
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
    // Keep the raw bytes: the encoding is only known once the stream ends.
    const consume = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return kill(new Error('音樂工具輸出超過上限'));
      (target === 'out' ? outChunks : errChunks).push(chunk);
    };
    child.stdout?.on('data', chunk => consume('out', chunk));
    child.stderr?.on('data', chunk => consume('err', chunk));
    child.once('error', error => finish(failure ?? error));
    child.once('close', code => {
      if (failure) return finish(failure);
      const stdout = decodeMusicOutput(outChunks);
      const stderr = decodeMusicOutput(errChunks);
      const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      finish(code === 0 ? null : new Error(`音樂工具執行失敗 (${code})：${detail.slice(0, 600)}`), { stdout, stderr });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
