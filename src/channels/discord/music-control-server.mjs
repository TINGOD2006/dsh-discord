import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Local web console for the music card. Discord messages cannot carry a slider,
 * so the "drag" half of the player lives here: a tiny page on 127.0.0.1 that the
 * card links to with a per-boot token.
 *
 * The server holds no credentials and only talks to the registry, so a browser
 * cannot reach anything except player controls.
 */

const MAX_BODY_BYTES = 4096;
const ACTIONS = new Set(['pause', 'resume', 'next', 'seek']);
const SEEK_MIN_INTERVAL_MS = 300;

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function html(response, body) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid-json'); }
}

/**
 * @param {{ registry: { snapshot: Function, control: Function }, token: string, logger?: Function, now?: Function }} options
 */
export function createMusicControlHandler({ registry, token, logger = null, now = () => Date.now() } = {}) {
  if (!registry) throw new TypeError('控制台需要播放狀態來源');
  if (!token) throw new TypeError('控制台需要存取 token');
  const log = (event, detail) => { try { logger?.(event, detail); } catch {} };
  let windowStart = 0, windowCount = 0, lastSeekAt = 0;

  return async function handle(request, response) {
    const started = now();
    const url = new URL(String(request.url ?? '/'), 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter((part) => part.length > 0);
    if (parts[0] !== 'music' || !safeEqual(parts[1], token) || !parts[2]) {
      json(response, 404, { error: 'not-found' });
      return;
    }
    const guildId = decodeURIComponent(parts[2]);
    const tail = parts[3] ?? '';

    // Two pools: the page polls 1/s, dragging can post a release burst.
    if (started - windowStart >= 1000) { windowStart = started; windowCount = 0; }
    windowCount += 1;
    if (windowCount > 30) {
      log('music.control.rate-limited', { guildId });
      json(response, 429, { error: 'too-many-requests' });
      return;
    }

    const base = `/music/${encodeURIComponent(token)}/${encodeURIComponent(guildId)}`;
    if (request.method === 'GET' && tail === '') { html(response, controlPage({ base, guildId })); return; }
    if (request.method === 'GET' && tail === 'state') {
      try { json(response, 200, { ok: true, snapshot: await registry.snapshot(guildId) }); } catch (error) {
        json(response, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (request.method === 'POST' && ACTIONS.has(tail)) {
      let body = {};
      try { body = await readBody(request); } catch (error) {
        json(response, 400, { ok: false, error: String(error.message) });
        return;
      }
      if (tail === 'seek') {
        if (started - lastSeekAt < SEEK_MIN_INTERVAL_MS) { json(response, 429, { ok: false, error: 'seek-throttled' }); return; }
        lastSeekAt = started;
      }
      try {
        const result = await registry.control(guildId, tail, { positionMs: Number(body?.positionMs) || 0 });
        json(response, 200, { ok: result?.ok !== false, message: String(result?.message ?? '') });
      } catch (error) {
        log('music.control.failed', { guildId, action: tail, error: String(error?.message ?? error) });
        json(response, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    json(response, 404, { error: 'not-found' });
  };
}

/**
 * Starts the console on a loopback port. `port: 0` lets the OS pick one, which
 * is what the card's Link button ends up showing.
 */
export function createMusicControlServer({ registry, host = '127.0.0.1', port = 0, token = randomBytes(16).toString('base64url'), logger = null } = {}) {
  const handler = createMusicControlHandler({ registry, token, logger });
  const server = createServer((request, response) => { void handler(request, response).catch(() => { try { json(response, 500, { error: 'failed' }); } catch {} }); });
  let url = null;
  return {
    token,
    get url() { return url; },
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
      });
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      url = `http://${host}:${actualPort}/music/${encodeURIComponent(token)}/`;
      return url;
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      url = null;
    },
  };
}

export function controlPage({ base, guildId }) {
  const scope = JSON.stringify({ base, guildId }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>音樂控制</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111318;color:#e6e8ee;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:min(560px,92vw);padding:20px;border-radius:16px;background:#1a1e26;box-shadow:0 10px 40px #0008}
h1{margin:0 0 4px;font-size:18px;font-weight:600;word-break:break-all}
.meta{color:#98a2b3;font-size:13px;margin-bottom:14px}
input[type=range]{width:100%;accent-color:#2b6cf6;height:28px}
.times{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums;color:#c7ccd8;font-size:13px;margin:2px 0 14px}
.buttons{display:flex;gap:8px;flex-wrap:wrap}
button{flex:1 1 auto;min-width:96px;padding:10px 14px;border:0;border-radius:10px;background:#2b6cf6;color:#fff;font-size:15px;cursor:pointer}
button.secondary{background:#2a303c}
button:disabled{opacity:.45;cursor:default}
#flash{min-height:20px;color:#7ee0a3;font-size:13px;margin-top:10px}
</style></head>
<body><main class="card">
<h1 id="title">—</h1>
<div class="meta" id="meta"></div>
<input id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="播放位置">
<div class="times"><span id="pos">0:00</span><span id="dur">--:--</span></div>
<div class="buttons">
<button id="pause" class="secondary">⏸ 暫停</button>
<button id="resume" class="secondary">▶ 繼續</button>
<button id="next" class="secondary">⏭ 下一首</button>
</div>
<div id="flash" role="status"></div>
</main>
<script>
(() => {
  const scope = ${scope};
  const base = scope.base + '/' + encodeURIComponent(scope.guildId);
  const $ = (id) => document.getElementById(id);
  let snapshot = null, dragging = false, flashTimer = null;

  const clock = (ms) => {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const pad = (v) => String(v).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  };
  const flash = (text) => { $('flash').textContent = text; clearTimeout(flashTimer); flashTimer = setTimeout(() => { $('flash').textContent = ''; }, 2200); };
  const apply = (next) => {
    snapshot = next || {};
    $('title').textContent = snapshot.title ? '🎵 ' + snapshot.title : '🎵 音樂播放';
    const stateText = { idle: '未播放', preparing: '準備中', playing: '播放中', paused: '已暫停' }[snapshot.state] || '—';
    const queue = Array.isArray(snapshot.queue) ? snapshot.queue.length : 0;
    $('meta').textContent = stateText + (queue ? ' · 佇列 ' + queue + ' 首' : '');
    $('dur').textContent = snapshot.durationMs > 0 ? clock(snapshot.durationMs) : '--:--';
    $('pause').disabled = snapshot.state !== 'playing';
    $('resume').disabled = snapshot.state !== 'paused';
    $('next').disabled = snapshot.state === 'idle';
    if (!dragging) {
      const duration = Number(snapshot.durationMs) || 0;
      const position = Math.min(Number(snapshot.positionMs) || 0, duration || 0);
      $('seek').value = duration > 0 ? String(Math.round(position / duration * 1000)) : '0';
      $('pos').textContent = clock(position);
    }
  };
  const poll = async () => {
    try { const r = await fetch(base + '/state', { cache: 'no-store' }); const body = await r.json(); if (body.ok) apply(body.snapshot); }
    catch {}
  };
  const post = async (action, extra) => {
    try {
      const r = await fetch(base + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(extra || {}) });
      const body = await r.json();
      if (!body.ok) { flash(body.error || '失敗'); return; }
      if (body.message) flash(body.message);
      await poll();
    } catch { flash('連不上 bot'); }
  };
  $('seek').addEventListener('pointerdown', () => { dragging = true; });
  $('seek').addEventListener('input', () => {
    dragging = true;
    const duration = Number(snapshot?.durationMs) || 0;
    $('pos').textContent = clock(duration * (Number($('seek').value) / 1000));
  });
  $('seek').addEventListener('change', async () => {
    const duration = Number(snapshot?.durationMs) || 0;
    const target = Math.round(duration * (Number($('seek').value) / 1000));
    await post('seek', { positionMs: target });
    dragging = false;
  });
  $('pause').addEventListener('click', () => post('pause'));
  $('resume').addEventListener('click', () => post('resume'));
  $('next').addEventListener('click', () => post('next'));
  void poll();
  setInterval(() => { void poll(); }, 1000);
})();
</script></body></html>`;
}
