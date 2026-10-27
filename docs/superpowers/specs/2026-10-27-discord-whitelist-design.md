# Discord 白名单成员面板 — 设计

状态：待用户 review
日期：2026-10-27
需求来源：Discord 群内用户消息（2026-10-27）——
「做好整個白名單系統,在接入伺服器時讀取所有人的ID和名字,頭像,列出列表,補全白名單系統」

## 1. 背景与目标

现状：白名单是「通用」设置 tab 里一个 textarea，只能手填用户 ID
（`plugin-src/client/bot-general-settings.js:245-265`），底层存
`<DSH_HOME>/integrations/dsh-discord/allowlist.json` 的 `{ ids }`
（`src/channels/discord/allowlist.mjs:16-97`，上限 50，`SNOWFLAKE = /^\d{5,30}$/`）。

目标：机器人连上 Discord 后，白名单面板直接把「机器人所在所有服务器」的成员
（ID、名字、昵称、头像）列出来，点选即可维护白名单，不用再手抄 snowflake。

非目标（本次不做）：
- 不做按服务器分组的多白名单、不做角色白名单；
- 不改 `allowlist.json` 格式（仍然只存 `{ ids }`，不落名字/头像）；
- 不动 Gateway 的 intents 常量（REST 拉成员只认 Developer Portal 的特权开关）；
- 不引入虚拟滚动库或前端依赖。

## 2. 前置条件（用户操作）

Discord 官方文档 *List Guild Members*（`GET /guilds/{guild.id}/members`）明确要求
**GUILD_MEMBERS Privileged Intent**。当前截图里 Developer Portal 的
「Server Members Intent」是关的，需要用户去后台打开（Message Content 已开）。
代码侧不需要改 Gateway intents —— REST 请求看的是门户开关。

## 3. 架构总览

方案 A：宿主聚合，一次返回全量合并列表（已确认采用；B=客户端分页、C=只搜索不预拉
被否决，理由：浏览器不可能直连 Discord API 拿 bot token）。

```
客户端 通用 tab
  └─ member-allowlist.js ── RPC bot.members.list {botId, force} ──▶ 宿主
                                                    │
                         DiscordController.listMembers({botId, force})
                                                    │
                                  DiscordRuntime.listMembers({force})   ← 已连接 bot
                                                    │
                                  member-directory.mjs list({force})
                                    ├─ GET /users/@me/guilds
                                    ├─ GET /guilds/{id}/members?limit=1000&after=…
                                    └─ 合并去重 + 5 分钟内存缓存
```

## 4. 宿主设计

### 4.1 `src/channels/discord/member-directory.mjs`（新）

```js
createMemberDirectory({ api, ttlMs = 5 * 60_000 })
  → { list({ force } = {}) }
```

`list` 返回：

```js
{
  members: [{
    id: "123456789012345678",        // snowflake 字符串
    username: "alice",               // @handle
    globalName: "Alice" | null,
    nickname: "小艾" | null,         // 该用户在某服的昵称，多服取第一个非空
    displayName: "小艾" | "Alice" | "alice",
    avatarUrl: "https://cdn.discordapp.com/avatars/{id}/{hash}.{ext}" | 默认头像,
    guildIds: ["111", "222"]         // 该用户出现在哪几个已加入服务器
  }],
  fetchedAt: 1730000000000,          // 缓存生成时间（毫秒）
  guilds: [{ id, name, memberCount }],
  partial: false,                    // 有服务器拉取失败时为 true
  errors: [{ guildId, code }]        // partial 时的失败明细
}
```

实现要点：
- 分页：`limit=1000` + `after=<最后一条 id>` 循环到返回不足 1000 条；
  逐服串行拉取（避免限流风暴），服务器之间也无并发。
- 限流：429 时读响应体 `retry_after`（秒，浮点）睡眠后重试，最多 3 次；
  仍失败则记录 `members-rate-limited`。
- 合并：按 `id` 去重，`guildIds` 累加；多服昵称取第一个非空。
- 排除机器人账号（`user.bot === true`）：给 bot 开白名单没有意义。
- 头像：有 `avatar` hash → CDN 直链；无 hash → 默认头像
  `https://cdn.discordapp.com/embed/avatars/{(BigInt(id) >> 22n) % 6n}.png`。
- 缓存：实例内保存 `{ result, expiresAt }`；`force: true` 绕过；过期重建。
- 单服失败不拖垮整体：记录到 `errors`，其余照常返回，`partial: true`。

### 4.2 `src/channels/discord/discord-api.mjs`（扩展）

新增两个方法，复用现有 `#request`（token/baseUrl/fetchImpl 已就绪，
`DISCORD_PERMISSION_ERRORS = {50001, 50013}` 可继续用于 403 判定）：

- `listGuilds()` → `GET users/@me/guilds?with_counts=true`，返回
  `[{ id, name, icon, approximate_member_count }]`。
- `listGuildMembers(guildId, { after, limit = 1000 } = {})` →
  `GET guilds/{guildId}/members?limit=&after=`，返回原生数组并透出
  `retry_after`（429 时）。guildId 用现有 snowflake 校验。

### 4.3 `src/channels/discord/discord-runtime.mjs`（扩展）

- 懒创建 `memberDirectory`（复用 `#api`），`listMembers({ force })` 转发；
  bot 重连/换 token 时清空目录实例（缓存随 runtime 生命周期失效）。
- 未连接（无 `#api`）时抛 `members-unavailable`。

### 4.4 `src/channels/discord/member-endpoints.mjs`（新，浏览器安全）

```js
export const MEMBER_ENDPOINTS = Object.freeze({ list: 'bot.members.list' });
```

### 4.5 控制器（`src/channels/discord/discord-controller.mjs`）

新增 `listMembers({ botId, force })`：按 `botId` 找到对应 runtime，未连接抛
`members-unavailable`；成功返回 4.1 的结构。

### 4.6 RPC 接线

- `plugin-src/host/channels/shared/rpc.mjs`：`createTokenBotRpcHandler(controller,
  { channel, persona, allowlist, members })` 增加 `members` 能力；
  `TOKEN_BOT_ENDPOINTS.listMembers = MEMBER_ENDPOINTS.list`；`payloadFailure`
  对 `bot.members.list` 校验 `{ botId, force? }`（`force` 必须是布尔）。
- `plugin-src/host/channels/discord/rpc.mjs`：handler 分支调用
  `members.list({ botId: payload.botId, force: payload.force === true })`。
- `plugin-src/host/channels/discord/index.mjs`：`apply()` 里创建 `members`
  能力对象（委托 `controller.listMembers`），传入两条接线路径
  （`config.controller` 的手动注入路径与 `installProductionChannel`）。

错误码（写入 `operationError` 映射，客户端据此出文案）：

| code | 触发 | 客户端文案方向 |
| --- | --- | --- |
| `members-unavailable` | bot 未连接 | 先连接机器人 |
| `members-intent-required` | 403 / 50001 / 50013 | 去开发者后台开 Server Members Intent |
| `members-rate-limited` | 429 重试耗尽 | 稍后点刷新重试 |
| `members-fetch-failed` | 其它网络/解析错误 | 拉取失败，可手动填 ID |

## 5. 客户端设计

### 5.1 组件

新文件 `plugin-src/client/member-allowlist.js`，导出
`MemberAllowlistPanel({ account, rpcCall, allowlist, onSaved })`
（命名以实现时与 `bot-general-settings.js` 的现有 props 对齐为准）。
`bot-general-settings.js:245-265` 的 textarea 整段替换为 `<MemberAllowlistPanel>`，
外部保留「保存人格」等原有结构不动。

### 5.2 结构

```
白名单                                   已选 n / 50        [刷新] [保存白名单]
[搜索：名字 / @username / 昵称 / ID                    ]
┌─ 已选 (n) ──────────────────────────────┐
│ 头像  显示名  @username    ID    [×]     │   ← 仅当白名单非空
├─ 成员列表（限高 360px，滚动）────────────┤
│ [头像] 显示名  @username  123…  2服 [开关]│
│ … 过滤后最多渲染 300 行                   │
└──────────────────────────────────────────┘
还有 N 条，继续输入以缩小范围
▸ 手动添加用户 ID（折叠）
```

### 5.3 状态与交互

- 打开面板：先渲染已选（来自 `bot.allowlist.get` 快照），同时发起
  `bot.members.list`；请求中点状加载不阻塞卡片其它设置。
- 勾选：只改本地 `selectedIds`（Set），底栏「保存白名单」在 dirty 时可点；
  保存成功后 `onSaved` 刷新外部 allowlist 快照，并提示
  「白名单已保存，30 秒内生效」。
- 上限 50：勾到 50 后其余开关 `disabled`，提示「已达上限 50」；
  保存被宿主以 `allowlist-invalid` 拒绝时展示错误码文案。
- 搜索：前端大小写不敏感子串匹配 `displayName / username / id`；
  无输入按 `displayName` 排序（`localeCompare('zh-Hans-CN')`）。
- 已选区 × 移除只改本地勾选，仍需保存生效。
- 手动 ID 兜底（折叠）：一行一个 ID，`加入选中` 校验 snowflake + 去重 + 上限，
  通过后并入 `selectedIds`。
- 未保存离开：tab 切换直接丢弃未保存勾选（与现有 textarea 行为一致），
  保存前有 `dirty` 标记（不做弹窗拦截）。
- 空态/错误态：
  - 未连接 → 「先连接 Discord 机器人才能读取成员」
  - `members-intent-required` → 「请在开发者后台开启 Server Members Intent 后重启」
  - `partial` → 顶部黄色提示「N 个服务器读取失败，列表可能不全」

### 5.4 样式（`plugin-src/client/styles.js`）

新增 `.dim-memberPanel` 系列：已选区 chips、成员行（头像 28px 圆角、
名字/ID 两行、开关右对齐）、限高滚动容器、骨架行、提示条。沿用现有
`.dim-botGeneralStack` / `.dim-deliveryButton` / `.dim-accessFeedback` 的视觉语言，
不新增设计系统变量。

### 5.5 i18n（`plugin-src/client/i18n.js`）

新增中英文键：`whitelist.title`、`whitelist.selected`、`whitelist.refresh`、
`whitelist.save`、`whitelist.search`、`whitelist.manual`、`whitelist.limit`、
`whitelist.error.*`（四个错误码 + partial）、`whitelist.empty.*`。

## 6. 边界与降级

- **大服务器**：串行分页可能几秒（数千人级）；一次 RPC 返回，客户端骨架屏等待。
- **头像 CSP**：Web GUI 若禁止外域图片，降级为宿主转发
  （`bot.members.avatar` 返回 data URL）。实现第一步先验证直链可用，
  不可用再补端点，不改变本设计。
- **缓存**：5 分钟；「刷新」传 `force: true`；bot 重连时清空。
- **隐私**：只在内存里缓存成员数据，不写盘；白名单文件仍只有 ID。

## 7. 测试

新增 `test/discord-member-directory.test.mjs`（fake api，不联网）：
1. 分页拼接（1000+ 不足 1000 两页）。
2. 多服去重与 `guildIds` 合并、多服昵称取首个非空。
3. 排除 bot 账号。
4. 无头像走默认头像公式；有 hash 走 CDN。
5. 429 按 `retry_after` 重试，耗尽后 `members-rate-limited`。
6. 缓存命中（TTL 内不重复请求）、`force` 绕过。
7. 单服失败 → `partial: true` + `errors`。

RPC 层：仓库现有测试全部直接导入 `src/`（无测试引用 `plugin-src/`），
`plugin-src/host/channels/shared/rpc.mjs` 又依赖宿主 dsh 模块，不适合进单测。
因此 `bot.members.list` 的 payload 校验与错误映射靠构建后手工验证；
controller 的「未连接 → `members-unavailable`」分支用 stub 在上述测试文件里覆盖。

客户端无自动化测试（仓库现状），靠构建 + 手工验证。

## 8. 构建与验证

1. `node scripts/build-local.mjs`（需 `DSH_BUILD_ESBUILD_DIR`、
   `DSH_BUILD_NODE_MODULES`；esbuild spawn 在沙箱里会 EPERM，需要提权）。
2. `node --test test/*.test.mjs test/unit/*.test.mjs` 全绿。
3. 检查 `lib/client.js` 含 `member-allowlist` 新文案；`lib/index.js` 含
   `bot.members.list`。
4. 不 `npm run push`（等用户验收后再提交/推送）。

## 9. 文件清单

新增：
- `src/channels/discord/member-directory.mjs`
- `src/channels/discord/member-endpoints.mjs`
- `plugin-src/client/member-allowlist.js`
- `test/discord-member-directory.test.mjs`

修改：
- `src/channels/discord/discord-api.mjs`
- `src/channels/discord/discord-runtime.mjs`
- `src/channels/discord/discord-controller.mjs`
- `plugin-src/host/channels/shared/rpc.mjs`
- `plugin-src/host/channels/discord/rpc.mjs`
- `plugin-src/host/channels/discord/index.mjs`
- `plugin-src/client/bot-general-settings.js`
- `plugin-src/client/styles.js`
- `plugin-src/client/i18n.js`

## 10. 开放问题

- 无阻塞项。头像 CSP 在实现阶段验证，失败则按 §6 走转发降级。
