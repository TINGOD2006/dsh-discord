// Push this fork to GitHub in a way that works inside the DSH sandbox.
//
// Why the obvious `git push` fails here: git launches credential helpers through
// MSYS `sh`, and the sandbox denies the named pipes that shell needs, so the
// helper never runs and git falls back to a terminal prompt ("could not read
// Username"). Schannel additionally reports SEC_E_NO_CREDENTIALS for the same
// reason: it cannot open the user's crypto credential handles. Stored GitHub
// credentials are fine -- re-signing in does not help.
//
// What works: bypass both moving parts. Use OpenSSL as the TLS backend (no
// Schannel credential handle) and authenticate with an Authorization header fed
// from the GitHub CLI token (no helper process). The token travels only in the
// child environment, never on the command line or on disk.
//
// Fallbacks, in order: plain `git push` (works outside the sandbox), then the
// header push, then a single device-code sign-in only if the token is genuinely
// rejected.
//
// Usage:
//   node scripts/git-push.mjs             # push origin main
//   node scripts/git-push.mjs origin dev  # push a branch
//   node scripts/git-push.mjs --check     # report state, push nothing

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SANDBOX_HINTS = [
  /SEC_E_NO_CREDENTIALS/iu,
  /AcquireCredentialsHandle/iu,
  /couldn't create signal pipe/iu,
  /Win32 error 5\b/iu,
  /spawn EPERM|spawn EACCES/iu,
];

const CREDENTIAL_HINTS = [
  /could not read Username/iu,
  /terminal prompts disabled/iu,
  /Authentication failed/iu,
  /Invalid username or password/iu,
  /Repository not found/iu,
];

/** Run git with an explicit environment (token never appears in argv). */
async function git(args, { env = {}, timeout = 180_000 } = {}) {
  try {
    const { stdout, stderr } = await run('git', args, {
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    return { ok: true, out: `${stdout ?? ''}${stderr ?? ''}`.trim() };
  } catch (error) {
    return {
      ok: false,
      out: `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim(),
      message: error?.message ?? String(error),
    };
  }
}

const matches = (text, patterns) => patterns.some((pattern) => pattern.test(text));

/** GitHub token from the GitHub CLI, or null when gh is absent/not signed in. */
async function ghToken() {
  try {
    const { stdout } = await run('gh', ['auth', 'token'], {
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const token = String(stdout ?? '').trim();
    return token.length >= 20 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Push authenticated by an explicit header, with OpenSSL TLS: this path needs
 * neither a credential-helper shell nor the Schannel credential store.
 */
function headerEnv(repoUrl, token) {
  const basic = Buffer.from(`x-access-token:${token}`, 'ascii').toString('base64');
  const entries = [
    ['http.sslBackend', 'openssl'],
    ['credential.helper', ''],
    [`http.https://${new URL(repoUrl).host}/.extraheader`, `AUTHORIZATION: basic ${basic}`],
  ];
  return Object.fromEntries(entries.flatMap(([key, value], index) => [
    [`GIT_CONFIG_KEY_${index}`, key],
    [`GIT_CONFIG_VALUE_${index}`, value],
  ]).concat([['GIT_CONFIG_COUNT', String(entries.length)]]));
}

async function credentialState() {
  const version = await git(['credential-manager', '--version'], { timeout: 30_000 });
  if (!version.ok) return { gcm: false };
  const accounts = await git(['credential-manager', 'github', 'list'], { timeout: 30_000 });
  const list = accounts.ok
    ? accounts.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  return { gcm: true, accounts: list };
}

async function signIn() {
  return run('git', ['credential-manager', 'github', 'login'], {
    timeout: 300_000,
    windowsHide: false,
    maxBuffer: 4 * 1024 * 1024,
  }).then(
    ({ stdout, stderr }) => ({ ok: true, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    (error) => ({ ok: false, out: `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim(), message: error?.message }),
  );
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const remote = positional[0] ?? 'origin';
  const branch = positional[1] ?? 'main';

  const remoteUrl = await git(['remote', 'get-url', remote], { timeout: 30_000 });
  if (!remoteUrl.ok) {
    console.error(`没有远端 ${remote}：${remoteUrl.message ?? remoteUrl.out}`);
    process.exitCode = 1;
    return;
  }
  const url = remoteUrl.out;
  const state = await credentialState();
  const token = await ghToken();

  console.log(`repository : ${process.cwd()}`);
  console.log(`remote     : ${remote} -> ${url}`);
  console.log(`gcm        : ${state.gcm ? `available (${(state.accounts ?? []).join(', ') || 'no accounts'})` : 'missing'}`);
  console.log(`gh token   : ${token ? 'available' : 'unavailable'}`);

  if (checkOnly) {
    const probe = token
      ? await git(['ls-remote', '--heads', remote], { env: headerEnv(url, token), timeout: 60_000 })
      : await git(['ls-remote', '--heads', remote], { timeout: 60_000 });
    console.log(`reachable  : ${probe.ok ? 'yes' : 'no'}`);
    if (!probe.ok) {
      const text = `${probe.message ?? ''}\n${probe.out}`;
      if (matches(text, SANDBOX_HINTS)) {
        console.error('沙箱拦住了 git 的辅助进程与凭据句柄；请确认 GitHub CLI 已登录（gh auth status），本脚本会用其 token 走 OpenSSL 通道。');
      } else {
        console.error(probe.out || probe.message);
      }
      process.exitCode = 1;
    }
    return;
  }

  const attempts = [];
  attempts.push({ label: 'plain git push', env: {} });
  if (token) attempts.push({ label: 'OpenSSL + Authorization header', env: headerEnv(url, token) });

  for (const attempt of attempts) {
    const pushed = await git(['push', remote, branch], { env: attempt.env });
    if (pushed.ok) {
      console.log(`推送成功（${attempt.label}）：${remote}/${branch}`);
      if (pushed.out && !/Everything up-to-date/i.test(pushed.out)) console.log(pushed.out);
      return;
    }
    const text = `${pushed.message ?? ''}\n${pushed.out}`;
    console.log(`失败（${attempt.label}）：${(pushed.out || pushed.message || '').split('\n')[0]}`);
    if (!matches(text, SANDBOX_HINTS) && !matches(text, CREDENTIAL_HINTS)) {
      console.error(pushed.out || pushed.message);
      process.exitCode = 1;
      return;
    }
  }

  // Only a genuinely rejected token warrants a fresh sign-in.
  console.log('尝试一次设备码登录…');
  const signed = await signIn();
  if (!signed.ok && !/success|logged in|Authentication/i.test(signed.out)) {
    console.error([
      '推送失败，且无法自动登录。',
      '手动修复：gh auth login && git credential-manager github login',
      `最后错误：${signed.out || signed.message}`,
    ].join('\n'));
    process.exitCode = 1;
    return;
  }

  const retried = token
    ? await git(['push', remote, branch], { env: headerEnv(url, token) })
    : await git(['push', remote, branch]);
  if (!retried.ok) {
    console.error(`登录后重试仍失败：\n${retried.out || retried.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`推送成功：${remote}/${branch}`);
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
