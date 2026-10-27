# Discord 白名单成员面板 — 实施计划

依据 spec：`docs/superpowers/specs/2026-10-27-discord-whitelist-design.md`
日期：2026-10-27
执行方式：TDD（先写测试，跑失败，再实现），每阶段结束跑 `node --test` 并手查构建产物。
不推送（`npm run push` 等用户验收后再决定）。

## 阶段 0 — 现状核对（无代码）

- [ ] 确认 `git status` 已知的 3 处无关改动仍在（`src/channels/shared/injected-context.mjs`、
      未跟踪的 `test/injected-context-guard.test.mjs` 等），**不碰它们**。
- [ ] 向用户确认 Developer Portal 已开 **Server Members Intent**（开不了则本功能只能显示
      `members-intent-required` 引导）。
验收：用户回复确认（或明确说稍后再开）。

## 阶段 1 — 宿主：成员目录（纯数据层，TDD）

### 1.1 先写测试 `test/discord-member-directory.test.mjs`

导入 `import { createMemberDirectory } from '../src/channels/discord/member-directory.mjs';`
（模块不存在 → 先让测试红）。fake api 形态：

```js
api.listGuilds()                       // → [{ id, name, icon, approximate_member_count }]
api.listGuildMembers(guildId, { after, limit })  // → 原生 member 数组（可能不足一页）
```

用例（对应 spec §7）：
1. 分页拼接：某服 1000 + 20 两页，目录返回 1020 人（去掉 bot）。
2. 多服去重：同一 id 出现在两服 → 一条记录、`guildIds` 两个值。
3. 排除 bot：`user.bot === true` 不返回。
4. 头像：有 hash → `https://cdn.discordapp.com/avatars/{id}/{hash}.png`（`a_` 开头 gif hash 保持原 ext 规则，
   实现时按 hash 是否以 `a_` 判 gif，否则 png；文档未给 ext 时的既定做法）；
   无 hash → `https://cdn.discordapp.com/embed/avatars/{(BigInt(id)>>22n)%6n}.png`。
5. 昵称：`member.nick` 有值用该昵称，多服取第一个非空；`displayName = nickname ?? globalName ?? username`。
6. 429：fake 第一次抛 `{ status: 429, retry_after: 0.05 }`，第二次成功 → 目录重试后成功；
   连续 3 次 429 → 抛 `members-rate-limited`。
7. 缓存：TTL 内第二次 `list()` 不再调 api；`list({ force: true })` 重新拉。
8. 单服失败：某服抛 `{ status: 500 }` → `partial: true`、`errors` 含该 guildId，其余成员仍在。

运行：

```powershell
node --test test/discord-member-directory.test.mjs
```

验收：红（`Cannot find module ... member-directory.mjs`）。

### 1.2 实现 `src/channels/discord/member-directory.mjs`

接口按 spec §4.1。要点：
- `createMemberDirectory({ api, ttlMs = 5 * 60_000, now = Date.now })`（`now` 便于测 TTL）。
- 串行：逐服逐页 `limit=1000` + `after=最后一页最后一条 id`，直到返回 < 1000。
- 每页失败重试：仅对 429（`error.status === 429` 或 `error.code === 'discord-429'`），
  睡 `min(retry_after*1000, 5000)`，最多 2 次额外重试，再失败 → 记录到 `errors`。
- 非 429 失败 → 记录 `{ guildId, code }`（403 → `members-intent-required`，其它 → `members-fetch-failed`），
  继续下一服；最终 `partial: true`。
- 排除 bot；按 id 合并 `guildIds`；默认头像用 `(BigInt(id) >> 22n) % 6n`。
- `guilds`：来自 `/users/@me/guilds`（`with_counts=true`），`memberCount` 取 `approximate_member_count`。

验收：`node --test test/discord-member-directory.test.mjs` 全绿。

### 1.3 扩展 `src/channels/discord/discord-api.mjs`

在 `getCurrentApplication` 后加：

```js
listGuilds(options = {}) {
  return this.#request('users/@me/guilds?with_counts=true', { ...options, method: 'GET' });
}
listGuildMembers(guildId, { after, limit = 1000, signal } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (after) query.set('after', after);
  return this.#request(`guilds/${snowflake(guildId, 'guild id')}/members?${query}`, { method: 'GET', signal });
}
```

同文件测试（加在 1.1 的测试文件里，用 `fetchImpl` 假函数）：
- URL/authorization 头/查询参数正确；
- 403 + `{ code: 50001 }` 抛出的 error 保留 `status=403`、`providerCode=50001`。

### 1.4 `src/channels/discord/discord-runtime.mjs`

- 字段区（`#api = null;` 附近）加 `#memberDirectory = null;`。
- `#api = api;`（第 1379 行）下一行加 `this.#memberDirectory = null;`。
- 新增方法（放 `allowlist` 相关代码附近）：

```js
async listMembers({ force = false } = {}) {
  if (!this.#api) {
    const error = new Error('Discord bot is not connected');
    error.code = 'members-unavailable';
    throw error;
  }
  const { createMemberDirectory } = await import('./member-directory.mjs');
  this.#memberDirectory ??= createMemberDirectory({ api: this.#api });
  return this.#memberDirectory.list({ force });
}
```

  （静态 import 更好，直接文件顶部 import；避免动态 import 增加复杂度。）
- `stop()` 里 `this.#api = null;` 旁加 `this.#memberDirectory = null;`。

验收：`node --test test/*.test.mjs` 仍全绿；`grep listMembers src/channels/discord/discord-runtime.mjs` 有命中。

## 阶段 2 — 控制器与 RPC 接线

### 2.1 `src/channels/discord/member-endpoints.mjs`（新）

```js
export const MEMBER_ENDPOINTS = Object.freeze({ list: 'bot.members.list' });
```

### 2.2 `src/channels/shared/token-bot-controller.mjs`

加一个不做 transition 的只读调用入口（成员拉取可能几秒，不能占住 per-bot 生命周期锁）：

```js
async callRuntimeRead(botId, method, args = []) {
  const config = this.#configStore.get(botId);
  if (!config) throw new Error(`Unknown ${this.#descriptor.label} bot`);
  const runtime = this.#runtimes.get(botId);
  if (!runtime?.status?.ready || typeof runtime[method] !== 'function') {
    const error = new Error(t('{label}机器人尚未连接', { label: this.#descriptor.label }));
    error.code = 'bot-not-connected';
    throw error;
  }
  return runtime[method](...args);
}
```

### 2.3 `src/channels/discord/discord-controller.mjs`

```js
async listMembers(botId, { force = false } = {}) {
  try {
    return await this.callRuntimeRead(botId, 'listMembers', [{ force }]);
  } catch (error) {
    if (error?.code === 'bot-not-connected') error.code = 'members-unavailable';
    throw error;
  }
}
```

### 2.4 `plugin-src/host/channels/shared/rpc.mjs`

- import `MEMBER_ENDPOINTS`（`../../../../src/channels/discord/member-endpoints.mjs`）。
- `TOKEN_BOT_ENDPOINTS` 加 `listMembers: MEMBER_ENDPOINTS.list`。
- `payloadFailure` 加分支：`exactKeys(payload, ['botId', 'force']) && validId(payload.botId)`
  `&& (payload.force === undefined || typeof payload.force === 'boolean')`，否则
  `'bot.members.list requires a botId (force optional boolean).'`。
- handler 分支（放 setAllowlist 之前）：

```js
} else if (endpoint === TOKEN_BOT_ENDPOINTS.listMembers) {
  if (!members || typeof members.list !== 'function') throw new Error('Member directory is unavailable');
  value = await members.list({ botId: payload.botId, force: payload.force === true });
}
```

  签名改为 `createTokenBotRpcHandler(controller, { channel, persona = null, allowlist = null, members = null })`，
  `installTokenBotRpc` 同步透传。
- `operationError` 加映射：`members-unavailable` / `members-intent-required` / `members-rate-limited` /
  `members-fetch-failed` → 各自中文文案（见 spec §4.6 表）。

### 2.5 `plugin-src/host/channels/discord/rpc.mjs`

`createDiscordRpcHandler` / `installDiscordRpc` 增加 `members = null` 参数并透传。

### 2.6 `plugin-src/host/channels/discord/index.mjs`

```js
const membersCapability = (controller) => ({
  list: ({ botId, force } = {}) => controller.listMembers(botId, { force }),
});
```

- `config.controller` 路径：`members: membersCapability(config.controller)`。
- production 路径：`createHandler: controller => createDiscordRpcHandler(controller, { persona, allowlist, members: membersCapability(controller) })`。

验收：`node --test test/*.test.mjs` 全绿；构建后 `grep "bot.members.list" lib/index.js` 有命中。

## 阶段 3 — 客户端成员面板

### 3.1 新组件 `plugin-src/client/member-allowlist.js`

`export function MemberAllowlistPanel({ account, rpcCall, initialIds, onSaved })`：

- 挂载：`useEffect` → `Promise.all([rpcCall(ALLOWLIST_ENDPOINTS.get, {}), rpcCall(MEMBER_ENDPOINTS.list, { botId: account.botId })])`
  （目录失败不阻塞已选区渲染，只显示错误条）。
- 状态：`members`、`loading`、`error`（code+message）、`selected`（Set，从 initialIds + 服务器返回初始化）、
  `search`、`saving`、`feedback`、`manualOpen`、`manualDraft`、`dirty`。
- 渲染结构按 spec §5.2：标题行（`已选 n/50`、刷新、保存）、搜索框、已选区 chips、
  限高滚动成员列表（过滤后最多 300 行 + 「还有 N 条」）、折叠手动 ID。
- 保存：`rpcCall(ALLOWLIST_ENDPOINTS.set, { ids: [...selected] })`，成功后 `onSaved(result.value)`
  并显示「白名单已保存，30 秒内生效」。
- 上限 50 的禁用逻辑、错误码文案、partial 提示条按 spec §5.3。
- 头像 `<img src={avatarUrl} loading="lazy" alt="">`，`onError` 时退化为首字母色块。

### 3.2 接入 `plugin-src/client/bot-general-settings.js`

- 删除 `allowlist` / `allowlistDraft` / `allowlistBusy` / `allowlistFeedback` 状态与
  `allowlistFromResult`、`parseAllowlistDraft`、`saveAllowlist`、`resetAllowlist`。
- 保留 `load()` 里 `connection.status` 与人格加载；allowlist 相关 fetch 移除。
- 第 245-265 行的 allowlist 块替换为：

```js
isDiscord ? h(MemberAllowlistPanel, {
  account, rpcCall, onSaved: () => void load(),
}) : null,
```

- 面板自身负责读白名单做初始选中，父组件不重复请求。

### 3.3 样式 `plugin-src/client/styles.js`

在 botGeneral 样式后追加 `.dim-memberPanel`、`.dim-memberToolbar`、`.dim-memberSearch`、
`.dim-memberSelected`、`.dim-memberChip`、`.dim-memberList`（max-height:360px; overflow:auto）、
`.dim-memberRow`、`.dim-memberAvatar`、`.dim-memberId`、`.dim-memberBadge`、`.dim-memberMessage`
（info/warn/error 三种色调）。沿用现有颜色变量与圆角，不新增设计 token。

### 3.4 i18n 偏差说明

spec §5.5 写的「i18n.js 加键」不适用：这些设置卡片当前一律内联中文字面量
（如 `保存人格`），仓库没有卡片级 i18n 键表。按现状内联中文，不新增 i18n 机制。

验收：`node --test test/*.test.mjs` 全绿；构建后 `grep "手动添加用户 ID" lib/client.js` 有命中。

## 阶段 4 — 构建与整体验证

1. `node scripts/build-local.mjs`（env：`DSH_BUILD_ESBUILD_DIR`、`DSH_BUILD_NODE_MODULES`；
   esbuild spawn 在沙箱里 EPERM → 申请提权，一次成功即可）。
2. `node --test test/*.test.mjs test/unit/*.test.mjs` 全绿。
3. `grep` 构建产物：`lib/client.js` 含新面板文案与 `bot.members.list`；`lib/index.js` 含 `listMembers`。
4. 请用户硬刷新 http://127.0.0.1:1657 → 设置 → Discord 机器人 → 通用：
   - 有 Server Members Intent 时：成员列表出现头像/名字，勾选→保存→白名单生效；
   - 未开时：显示「去开发者后台开启 Server Members Intent」错误条；
   - 「刷新」按钮、搜索、手动 ID 折叠各验证一次。
5. 不执行 `npm run push`；等用户验收后按需提交。

## 阶段 5 — 收尾（可选）

- 若用户要求提交：只 `git add` 本计划涉及的新增/修改文件，提交信息
  `feat(discord): 白名单成员列表面板（头像/昵称/搜索/批量勾选）`。
- 把「已知限制：需开启 Server Members Intent」补进 `FORK.md`（用户同意再动文档）。

## 风险与回滚

- 头像被 CSP 拦截 → 按 spec §6 增加宿主转发端点；不改已有代码路径。
- 大服拉取慢（>10s）→ 前端已有加载态；若用户抱怨再改分页（方案 B，需新 spec）。
- 回滚：成员面板是独立新组件，删掉 `member-allowlist.js`、还原 `bot-general-settings.js`
  的 textarea 块即可；宿主端点留着不影响旧行为。
