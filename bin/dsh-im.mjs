#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE_NAME = 'dsh-discord';
const DEFAULT_SOURCE = 'github:xmanrui/dsh-im';
const LEGACY_PACKAGES = [
  '@xmanrui/dsh-feishu',
  '@xmanrui/dsh-weixin',
  '@xmanrui/dsh-dingtalk',
];

function usage() {
  console.log(`Usage:
  dsh-im install [--profile web] [--source <package-spec>]
  dsh-im uninstall [--profile web]
  dsh-im send --bot <botId> --target <targetId> "<text>" [--url <delivery-url>]
  dsh-im send --bot <botId> --channel <channelId> "<text>" [--record]

Examples:
  npx -y github:xmanrui/dsh-im install
  dsh-im install --source .
  dsh-im send --bot bot_xxx --target whale "鲸鱼分享了一条视频"
  dsh-im send --bot bot_xxx --channel 1562556899214499910 "鲸鱼分享了一条视频" --record`);
}

/**
 * 本机 DSH Web 的基地址。
 *
 * 端口每次重启都会变，所以优先用宿主注入的 DSH_WEB_URL；DSH_IM_BASE_URL 可显式覆盖。
 */
function webBaseUrl() {
  const explicit = process.env.DSH_IM_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const webUrl = process.env.DSH_WEB_URL;
  if (webUrl) return webUrl.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.DSH_WEB_PORT || 2136}`;
}

/**
 * 把已经发出去的一段正文补记进频道绑定的会话。
 *
 * 直发 Discord REST 绕过了投递服务，所以消息不会进会话 transcript；
 * 这个调用让同一段正文成为模型下一轮能读到的上下文。失败只警告，不回滚发送。
 */
async function recordSession({ botId, channelId, text }) {
  const endpoint = `${webBaseUrl()}/api/dsh-im/session-record`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId, conversationKey: `group:${channelId}`, text }),
    });
  } catch (error) {
    console.warn(`会话记录接口不可达（${endpoint}）：${error.message}`);
    return;
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    console.warn(`会话记录失败 HTTP ${response.status}：${body.slice(0, 300)}`);
    return;
  }
  console.log(`已记入会话 ✓ ${body.slice(0, 300)}`);
}

/**
 * 主动投递：把一段文字交给已配置的投递目标。
 * 外部插件（如 dsh-bili-whale）只负责把正文交过来，格式化 / 重试 / 频道选择都在这里。
 * 默认打本机 DSH Web 的投递接口；端口可用 DSH_WEB_PORT 或 --url 覆盖。
 */
async function sendDelivery(args) {
  const botId = takeOption(args, '--bot', '');
  const targetId = takeOption(args, '--target', '');
  const explicitUrl = takeOption(args, '--url', '');
  const text = args.join(' ').trim();
  if (!botId) throw new Error('send 需要 --bot <botId>');
  if (!targetId) throw new Error('send 需要 --target <targetId>');
  if (!text) throw new Error('send 需要正文（最后一个参数）');
  const endpoint = explicitUrl || process.env.DSH_IM_DELIVERY_URL
    || `http://127.0.0.1:${process.env.DSH_WEB_PORT || 2136}/api/dsh-im/delivery/messages`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId, targetId, text }),
    });
  } catch (error) {
    throw new Error(`投递接口不可达（${endpoint}）：${error.message}`);
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`投递失败 HTTP ${response.status}：${body.slice(0, 300)}`);
  console.log(`已投递 ✓ ${body.slice(0, 300)}`);
}

/** 从 DSH 凭据文件里取 bot token（tokenRef 指向的键）。 */
async function readBotToken(tokenRef) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const file = join(dshHome, '.credentials.yaml');
  const text = await readFile(file, 'utf8');
  const escaped = tokenRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}:\\s*(.+)$`, 'm').exec(text);
  if (!match) throw new Error(`凭据文件里找不到 ${tokenRef}`);
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

/**
 * 直发频道：不依赖「投递目标」，直接走 Discord REST。
 * 适合外部插件只想「把一段文字丢进某个频道」的场景（目标还没建时也能用）。
 */
async function sendChannel(args) {
  const botId = takeOption(args, '--bot', '');
  const channelId = takeOption(args, '--channel', '');
  const record = args.includes('--record');
  if (record) args.splice(args.indexOf('--record'), 1);
  const text = args.join(' ').trim();
  if (!channelId) throw new Error('send --channel 需要频道 ID');
  if (!text) throw new Error('send 需要正文（最后一个参数）');
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const configPath = join(dshHome, 'integrations', 'dsh-discord', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const bots = Array.isArray(config.bots) ? config.bots : [];
  const bot = botId ? bots.find((item) => item.botId === botId) : bots[0];
  if (!bot) throw new Error(botId ? `找不到 bot ${botId}` : '没有已配置的 Discord bot');
  const token = await readBotToken(bot.tokenRef);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}：${body.slice(0, 300)}`);
  console.log(`已发送到 Discord 频道 ${channelId} ✓`);
  if (record) await recordSession({ botId: bot.botId, channelId, text });
}

function takeOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function runDsh(args) {
  const result = spawnSync('dsh', args, {
    cwd: tmpdir(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error('找不到 dsh，请先安装 DeepSeek Harness 并确保 dsh 在 PATH 中。');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`dsh 退出，状态码 ${result.status ?? 1}`);
}

async function directProfilePackages(profile) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profilePackage = join(dshHome, 'profiles', profile, 'package.json');
  try {
    const manifest = JSON.parse(await readFile(profilePackage, 'utf8'));
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
    const dependencies = manifest.dependencies ?? {};
    return new Set(LEGACY_PACKAGES.filter((name) => dependencies[name] || bundles.has(name)));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw new Error(`无法读取 Harness 配置 ${profilePackage}：${error.message}`);
  }
}

const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

try {
  const profile = takeOption(args, '--profile', 'web');
  if (command === 'install') {
    const requested = takeOption(args, '--source', DEFAULT_SOURCE);
    const source = requested === '.' || requested === '..'
      || requested.startsWith('./') || requested.startsWith('../')
      ? resolve(process.cwd(), requested)
      : (isAbsolute(requested) ? requested : requested);
    if (args.length > 0) throw new Error(`无法识别的参数：${args.join(' ')}`);

    const legacy = await directProfilePackages(profile);
    runDsh(['plugin', '--profile', profile, 'add', '--save-exact', source]);
    for (const packageName of legacy) {
      runDsh(['plugin', '--profile', profile, 'remove', packageName]);
    }
    console.log('\nIM 机器人插件已安装。请重启 dsh web、刷新浏览器，然后打开「设置 → IM机器人」。');
    if (legacy.size > 0) {
      console.log('已用 dsh-im 替换独立飞书/微信/钉钉插件；原有凭据和扫码绑定保持不变。');
    }
  } else if (command === 'uninstall') {
    if (args.length > 0) throw new Error(`无法识别的参数：${args.join(' ')}`);
    runDsh(['plugin', '--profile', profile, 'remove', PACKAGE_NAME]);
    console.log('\nIM 机器人插件已卸载。请重启 dsh web。');
  } else if (command === 'send') {
    if (args.includes('--channel')) await sendChannel(args);
    else await sendDelivery(args);
  } else {
    throw new Error(`无法识别的命令：${command}`);
  }
} catch (error) {
  console.error(`dsh-im: ${error.message}`);
  process.exit(1);
}
