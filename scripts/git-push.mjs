// Push the fork to GitHub and explain *why* a push fails, instead of blindly
// re-authenticating.
//
// Two failure classes look similar in git's output but have different fixes:
//
// 1. Sandboxed shell (this tool's default file policy): git for Windows spawns
//    MSYS sh/GCM helpers and opens Schannel/DPAPI handles that the sandbox
//    denies, so the push dies with
//      "schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS"
//    or "couldn't create signal pipe, Win32 error 5". Stored credentials are
//    fine -- re-signing in cannot fix it. Re-run the push outside the sandbox
//    (full-access shell), which is what this script tells you to do.
//
// 2. Genuinely missing/expired GitHub credential: git says "could not read
//    Username", "terminal prompts disabled" or "Authentication failed". Only
//    then is the device-code sign-in the right move, once.
//
// Usage:
//   node scripts/git-push.mjs            # push origin main
//   node scripts/git-push.mjs origin dev # push a branch
//   node scripts/git-push.mjs --check    # report credential + sandbox state only

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SANDBOX_HINTS = [
  /SEC_E_NO_CREDENTIALS/iu,
  /AcquireCredentialsHandle/iu,
  /couldn't create signal pipe/iu,
  /Win32 error 5\b/iu,
  /spawn EPERM|spawn EACCES/iu,
  /操作被拒绝|access is denied/iu,
];

const CREDENTIAL_HINTS = [
  /could not read Username/iu,
  /terminal prompts disabled/iu,
  /Authentication failed/iu,
  /Invalid username or password/iu,
  /Repository not found/iu,
];

async function git(args, { timeout = 180_000 } = {}) {
  try {
    const { stdout, stderr } = await run('git', args, {
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
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

async function credentialState() {
  const version = await git(['credential-manager', '--version'], { timeout: 30_000 });
  if (!version.ok) return { available: false, detail: version.message ?? version.out };
  const accounts = await git(['credential-manager', 'github', 'list'], { timeout: 30_000 });
  if (!accounts.ok) return { available: true, accounts: [], detail: accounts.message ?? accounts.out };
  const list = accounts.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { available: true, accounts: list };
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

function explain(text) {
  if (matches(text, SANDBOX_HINTS)) {
    console.error([
      '推送失败：沙箱挡住了 Git 的凭据/TLS 访问（不是凭据失效）。',
      '仓库里存的 GitHub 账号没问题，重新登录也修不了。',
      '解决：在沙箱外（完整权限的终端）执行同一条命令，例如：',
      '  git push origin main',
      '本脚本在沙箱内只能到此为止。',
    ].join('\n'));
    return 'sandbox';
  }
  if (matches(text, CREDENTIAL_HINTS)) {
    console.error([
      '推送失败：GitHub 凭据确实不可用。',
      '已尝试一次设备码登录；若仍失败，请手动执行：',
      '  git credential-manager github login',
    ].join('\n'));
    return 'credential';
  }
  console.error(`推送失败（非认证问题）：\n${text}`);
  return 'other';
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const remote = positional[0] ?? 'origin';
  const branch = positional[1] ?? 'main';

  const state = await credentialState();
  const remoteUrl = await git(['remote', 'get-url', remote], { timeout: 30_000 });
  const url = remoteUrl.ok ? remoteUrl.out : '(unknown)';
  const linked = await git(['ls-remote', '--heads', remote], { timeout: 60_000 });

  console.log(`repository : ${process.cwd()}`);
  console.log(`remote     : ${remote} -> ${url}`);
  console.log(`gcm        : ${state.available ? `available (${state.accounts?.length ?? 0} account(s): ${(state.accounts ?? []).join(', ') || 'none'})` : 'missing'}`);
  console.log(`reachable  : ${linked.ok ? 'yes' : 'no'}`);

  if (checkOnly) {
    if (!linked.ok) explain(`${linked.message ?? ''}\n${linked.out}`);
    return;
  }

  const pushed = await git(['push', remote, branch]);
  if (pushed.ok) {
    console.log(`推送成功：${remote}/${branch}`);
    if (pushed.out) console.log(pushed.out);
    return;
  }

  const text = `${pushed.message ?? ''}\n${pushed.out}`;
  const kind = explain(text);
  if (kind !== 'credential' || !state.available) {
    process.exitCode = 1;
    return;
  }

  console.log('尝试一次设备码登录…');
  const signed = await signIn();
  if (!signed.ok && !/success|logged in|Authentication/i.test(signed.out)) {
    console.error(`登录未完成：${signed.out || signed.message}`);
    process.exitCode = 1;
    return;
  }
  const retried = await git(['push', remote, branch]);
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
