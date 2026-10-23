# dsh-discord — 本地 Discord 專用外掛（fork 自 @xmanrui/dsh-im 5.4.0）

這個資料夾是 **Discord 部分的自有副本**，以獨立外掛安裝進 DSH `desktop` profile。
原本的 `@xmanrui/dsh-im` 已從 profile 移除（舊檔留在
`dsh-im-patch\retired-dsh-im-5.4.0\`，可隨時還原）。

## 為什麼 fork

需求是「**@ 它時不要新開子討論串**、要在被 @ 的地方回答」＋「**設定要能在 DSH 設定頁改**」，
而這兩件事都不可能從外掛外部達成（外掛只匯出 `apply`，內部 `DiscordApi` 與
`resolveDiscordMessageRoute` 取不到；換掉 host 工廠等於自己重寫整個儀式）。因此改成
「保留全部功能、只改行為與身分」的自有副本。

## 改了什麼（相對上游 5.4.0）

| 檔案 | 改動 |
| --- | --- |
| `src/channels/discord/discord-runtime.mjs` | `resolveDiscordMessageRoute()` 在「被 @ 且來源不是討論串」時**提前返回**，直接回覆來源頻道，不再呼叫 `api.startThreadFromMessage`。討論串訊息本來就走原位回覆（原碼 `:371-373`）。 |
| `package.json` | name `dsh-discord`、version `1.0.0`、bin `dsh-discord`、移除 publishConfig/repository、`dsh.compatibility.profiles` 加 `desktop`。 |
| `cordis.patch.yml` | insert 的 id/name 改為 `dsh-discord`。 |
| `plugin-src/host/update-runtime.mjs` | `PACKAGE_NAME` 改為 `dsh-discord` → 官方 npm 更新通道失效，避免一鍵更新把 fork 覆蓋回上游。 |
| `bin/dsh-im.mjs` | 同上（CLI 用法提示）。 |
| `plugin-src/host/index.mjs` | **只註冊 Discord**：移除其餘通道的 import、`start*` 工廠與 `channels` 陣列項目。 |
| `plugin-src/client/index.js` | `CHANNELS` 只留 `{ id: 'discord' }`；`settings.section` id 改為 `dsh-discord`、標籤改為 `Discord`；面板 aria-label `Discord 设置`、品牌字 `DSH-Discord`。 |
| `plugin-src/client/plugin-page.js` | `IM_MAIN_PANEL_ID` → `dsh-discord`；側邊欄入口標籤 `IM机器人` → `Discord`；按鈕「打开 Discord」、action id `dsh-discord-open`。 |
| `scripts/build-local.mjs` | **新增**：用外部 esbuild 重建 `lib/index.js`（host）與 `lib/client.js`（web，loaderId `dsh-discord`）。 |

### 只剩 Discord（與 dsh-im 分開）

- 設定頁只有**一列** `Discord`（`settings.section` id `dsh-discord`），側邊欄入口也叫 `Discord`，面板標題 `DSH-Discord`，不再出現「IM 机器人」字樣。
- host 端只啟動 `discord` 通道；其餘通道原始碼仍留在磁碟，但不會被 import、不會載入、不會出現在 UI。
- 體積：`lib/index.js` 9.4 MB → **837 KB**（其餘通道被 tree-shake 掉）、`lib/client.js` 864 KB。


### 行為對照

| 情境 | 上游 5.4.0 | 本 fork |
| --- | --- | --- |
| 頻道裡 @ 它 | 新開一個 Thread，在 Thread 裡回 | **就在該頻道回**（必要時沿用同頻道最近的回覆） |
| 討論串裡 @ 它 | 在該討論串回 | 不變（在該討論串回） |
| 私訊 | 直接回 | 不變 |
| 想要上游行為 | — | 啟動前設 `DSK_DISCORD_THREAD_ON_MENTION=1` |

## 設定在哪裡改

DSH → 設定 → **IM 機器人** → 左側 `Discord`：Bot Token、模型、工作區、
存取策略（`open` / `allowlist`）、上下文增強、群組歷史保留天數、連線診斷。
資料目錄：`%USERPROFILE%\.dsh\integrations\dsh-discord\`（同一個 bot 設定、
`group-history.sqlite`、`interface-language.json`、`settings.json`、`sidebar-settings.json`、
`image-input-settings.json` 都集中在這裡；Token 憑證槽 `DSH_DISCORD_BOT_TOKEN_<BOT_ID>`，與套件名無關）。

## 重建（改完 `src/` 或 `plugin-src/` 之後必做）

外掛執行時只載入 `lib/index.js` / `lib/client.js`，改源碼不會自動生效。

```powershell
cd C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\dsh-discord
$env:DSH_BUILD_ESBUILD_DIR = "C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\dsh-im-patch\build\node_modules"
$env:DSH_BUILD_NODE_MODULES = "C:\Users\TINGOD\.dsh\profiles\desktop\node_modules"
$env:DSH_IM_CLIENT_ID = "dsh-discord"
node scripts/build-local.mjs
```

`DSH_BUILD_ESBUILD_DIR` 只要是一個含 `esbuild` 的 `node_modules`；
`DSH_BUILD_NODE_MODULES` 放其他建置期套件（`@matrix-org/olm`、`semver`、
`https-proxy-agent`、`@deepseek-ai/cordis` …），多個路徑用 `;` 分隔。

`node_modules/` 內是對 profile 既有套件的 junction（`undici`、`qrcode`、`sharp`、
`imapflow`、`mailparser`、`nodemailer`、`dingtalk-stream`、`@tencent-connect/*`、
`@wecom/aibot-node-sdk`、`@matrix-org/olm`），只為讓 bundle 的 external import 解析得到。

## 安裝方式（目前已裝）

1. `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-discord` → 指向本資料夾的 **junction**
2. `profiles\desktop\package.json`
   - `dependencies["dsh-discord"] = "link:C:/Users/TINGOD/Documents/deepseek-harness/default-workspace/dsh-discord"`
   - `dsh.profile.bundles` 內把 `@xmanrui/dsh-im` 換成 `dsh-discord`

## 還原成上游外掛

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Move-Item "$prof\node_modules\dsh-discord" "$env:USERPROFILE\.dsh\profiles\desktop\dsh-discord.junction"  # 或先 Remove-Item 該 junction
Move-Item "C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\dsh-im-patch\retired-dsh-im-5.4.0" "$prof\node_modules\@xmanrui\dsh-im"
# 再把 package.json 的 dependency 與 bundles 換回 @xmanrui/dsh-im
```

## 驗證

- `node -e "import('file:///C:/Users/TINGOD/.dsh/profiles/desktop/node_modules/dsh-discord/lib/index.js').then(m=>console.log(Object.keys(m)))"`
  → `[ 'apply', 'createImHostPlugin', 'inject', 'name' ]`
- 路由回歸（假 API，不連網）：頻道 @ → 回原頻道且 `startThreadFromMessage` 呼叫 0 次；
  討論串 @ → 回原討論串；私訊 → 免 @ 直回。三種情境全過。

## 已知限制

- 設定頁 UI 沿用上游（React 打包檔 `lib/client.js` 由本 fork 重建，但畫面結構與上游相同）；
  若要在 UI 新增自訂開關，需改 `plugin-src/client/` 後重建。
- 官方「檢查更新」功能對本 fork 停用（會顯示查不到版本，屬預期）。
- 上游 `README*.md` / `docs/` 仍保留原樣，僅供功能說明參考。

## 從 dsh-im-discord-threads 併入的兩項功能

原本 `dsh-im-discord-threads` 是旁掛的第二個外掛（包 fetch 攔截 + 獨立 digest 工具）。
2026-10-22 已把它整併進本 fork，`dsh-im-discord-threads` 不再註冊。

### 1. 討論串復用（整合進路由）

位置：`src/channels/discord/discord-runtime.mjs` 的 `resolveDiscordMessageRoute()`，
API：`src/channels/discord/discord-api.mjs` 的 `listActiveThreads()`。

在「`DSK_DISCORD_THREAD_ON_MENTION=1` 且頻道可開討論串」這條分支裡，先查
`GET channels/{channel_id}/threads/active`，用 `pickReusableThread()` 挑一個舊討論串直接沿用，
挑不到才 `startThreadFromMessage()` 新開。列表失敗一律退回新開，不影響正常回覆。

篩選與排序：

- 同一個 `parent_id`、型別 10/11、`thread_metadata.archived/locked` 皆為 false；
- `last_message_id` 的雪花時間必須落在窗口內；
- 策略順序 `author-then-bot`（預設）→ `bot-then-author` → `newest` → `off`。

| 環境變數 | 預設 | 說明 |
| --- | --- | --- |
| `DSK_DISCORD_THREAD_STRATEGY` | `author-then-bot` | `author-then-bot` / `bot-then-author` / `newest` / `off` |
| `DSK_DISCORD_THREAD_MAX_AGE_HOURS` | `168` | 復用窗口（1–720 小時），以討論串最後訊息時間計算 |
| `DSK_DISCORD_THREAD_REUSE` | 未設 | 設成 `0` 等於強制 `off`（kill switch） |

### 2. `dsh_im_thread_digest` 工具

位置：`src/channels/shared/thread-digest.mjs`，資料層多一個
`GroupHistoryStore.recentMessages()`（`src/channels/shared/group-history-store.mjs`）。

- 身分來源是 fork 自己的 `groupHistoryAccess.resolve()`，**不需要** `<dsh_im_source>` 前綴，
  也不要求開啟上下文增強；模型偽造不了群 id。
- SQL 一次撈「最新在前」的一片訊息，附帶附件數與被引用訊息（`reply_to_message_id` JOIN）。
- 整形：翻成正序 → 丟掉機器人狀態占位（正在處理/處理中/已取消…）、slash 指令、空訊息 →
  同人同文去重 → 同一人 90 秒內的連續發言合併 → 標註 `↩ 引用` → 按字元預算從最新往回截。
- 參數：`hours`（預設 48）、`limit`（預設 30）、`maxChars`（預設 4000）；
  可用外掛設定 `config.digest = { enabled, defaultHours, defaultLimit, maxChars }` 覆寫。
- 註冊點：`plugin-src/host/index.mjs` 與 `installGroupHistoryTools` 同一個 `ctx.inject(['tools','systemPrompt'])`；
  prompt 段落名 `dsh-im:thread-digest`、order 118，只在該 session 有已登記群組時注入。

### 卸載旁掛外掛的紀錄

- `C:\Users\TINGOD\.dsh\profiles\desktop\package.json`：已移除 `dependencies["dsh-im-discord-threads"]`
  與 `dsh.profile.bundles` 內的項目。
- `node_modules\dsh-im-discord-threads` junction 已刪（用 `cmd /c rmdir`，只斷連結不動原始碼）。
- 原始碼目錄 `C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\dsh-im-discord-threads`
  仍保留，要復活只要把 dependency 加回去即可。
- 資料目錄已於 2026-10-22 從 `C:\Users\TINGOD\.dsh\integrations\dsh-im\` 遷到
  `C:\Users\TINGOD\.dsh\integrations\dsh-discord\`；`group-history.sqlite` 用 `sqlite3 .backup`
  做一致快照（groups=7 / messages=309 / attachments=19 兩邊一致），`group-files/` 與
  `interface-language.json` 一併複製。源碼中 5 處寫死的資料路徑（群組歷史根目錄、
  `settings.json`、`interface-language.json`、`sidebar-settings.json`、`image-input-settings.json`）
  已同步改為 `dsh-discord`，重建後 `lib/index.js` 內 5 處新路徑、0 處舊資料路徑。

### 驗證紀錄（2026-10-22）

- `node --check`：`thread-digest.mjs`、`group-history-store.mjs`、`discord-api.mjs`、
  `discord-runtime.mjs`、`plugin-src/host/index.mjs` 全數通過。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`；
  `lib/index.js` 內含 `dsh_im_thread_digest`、`threads/active`、三個環境變數字樣。
- 對真實 `group-history.sqlite`（唯讀）跑 digest SQL，7 個已歸檔群組可用。
- 假 store 單元測試：占位/指令過濾、連續合併、引用標註、字元預算、四種復用策略與窗口邊界全過。

## 主人專用命令（owner-only，2026-10-22）

動機：只有使用者本人（Discord 主人帳號）能用的一組斜線命令，不對外開放；首例是
`/skip`（中止當前會話回合）。

### 權限模型

- 不新增權限層：沿用既有的 access-policy `canExecuteCommands` 門禁。live 設定
  （`integrations/dsh-discord/workspaces.json`）的 direct / group 兩個 scope 都是
  `mode: "open"`、`defaultCanExecuteCommands: false`、
  `commandPermissionOverrides: [{ id: "627504520112373761", canExecuteCommands: true }]`，
  所以只有主人跑得了斜線命令，其他人發 `/digest` 這類只會拿到「無法執行命令」。
- 新增命令只要是「已註冊的本地命令」就會走同一道門禁，無需另外寫白名單。

### 命令

- `/skip`：`/stop` 的快捷寫法（`control-command.mjs` 的 `STOP_COMMAND` 同時匹配兩者；
  `/skip` 帶參數會回用法提示）。
- `/digest [小時]`：讀當前頻道自己的群聊歸檔摘要，預設 24 小時。用頻道 id 直接查
  `group-history.sqlite`，不依賴會話綁定；新增 `GroupHistoryStore.findGroupId()` 做
  platform chat id → groups.id 的映射，複用 `digestForContext()` 的合併/過濾/預算邏輯。
- `/thread [標題]`：在當前頻道建立獨立討論串（無來源訊息）。新增
  `DiscordApi.createThread()`（POST `channels/{id}/threads`，`type: 11`）。
  原本 `/conv` 的 `thread` 別名已移除（`/conv`、`/conversation` 不受影響），把 `/thread`
  釋放出來。
- `/mute [分鐘]` / `/unmute`：暫停/恢復本頻道自動回覆，1–10080 分鐘（預設 60）。
  在 `TextHarnessBridge.accept()` 攔未 @ 的群訊息；主人自己的 `/mute`、`/unmute`、
  `/stop`、`/skip` 仍放行。**狀態只在進程記憶體，DSH 重啟即清空**；要永久生效需要寫進
  bot 設定。

### 相關檔案

`src/channels/shared/owner-commands.mjs`（新）、`control-command.mjs`、
`command-catalog.mjs`、`command-permission.mjs`、`text-harness-bridge.mjs`、
`group-history-store.mjs`、`i18n-en/shared-b.mjs`、`discord-api.mjs`、`discord-runtime.mjs`。

### 驗證紀錄（2026-10-22）

- `node --check`：上述 10 個檔案全過。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`；`lib/index.js` 內含
  `/skip`、`/digest`、`/thread`、`/mute`、`/unmute` 的目錄與 i18n 字串（zstd 前的
  `\uXXXX` 轉義形式）。
- 單元測試（假 harness / 假 ownerTools）：匹配器互斥、目錄每通道無重名別名、
  mute 窗口與 7 天上限、`/digest` 時長透傳與失敗退化、`/thread` 回填 `<#id>`、
  `/skip` 走 `stopActiveTurn` 並回 `停止當前任務`。

## Discord 原生斜線指令（Application Commands，2026-10-22）

動機：`/stop` 這類文字斜線命令在 Discord 只是普通訊息，輸入框沒有補全/說明。改成
真正的 Application Command 後，Discord 客戶端會把它們列進 `/` 選單，帶中文說明與參數
補全，跟 DC 內建應用一致。

### 實作

- `src/channels/discord/discord-commands.mjs`（新）：指令定義表（`stop`、`skip`、
  `digest`、`thread`、`mute`、`unmute`，含 `name_localizations` 中文名
  （停止/跳过/摘要/建串/静音/取消静音）與 `description_localizations['zh-CN']`、
  `hours`/`minutes`/`title` 三個選項）、`commandTextFromInteraction()`（把互動還原成
  `/digest 48` 這種文字）、`interactionConversationId()`（在討論串裡取父頻道）、
  `handleApplicationCommand()`（先回 type 5 deferred + ephemeral 佔位，跑完用
  `PATCH /webhooks/{app}/{token}/messages/@original` 回覆）、`syncApplicationCommands()`。
- `src/channels/discord/discord-api.mjs`：新增 `putGlobalApplicationCommands()`、
  `putGuildApplicationCommands()`、`createInteractionResponse()`、
  `updateInteractionOriginal()`。
- `src/channels/discord/discord-runtime.mjs`：連線階段多抓一次 `GET applications/@me`
  取得 application id；READY 時註冊全域指令，`GUILD_CREATE` 時再註冊一次 guild 指令
  （guild 指令立即出現在選單，全域要等 Discord 快取）。Gateway 多處理
  `INTERACTION_CREATE`，其餘類型（按鈕等）直接忽略。註冊失敗只記 log，不影響連線。
- `src/channels/shared/text-harness-bridge.mjs`：新增 `runNativeCommand()`，把互動還原
  的文字交給文字路徑同一組 runner（`runControlCommand` / `runOwnerCommand`），所以
  `/skip` 走同一段 `stopActiveTurn`，surface 不影響行為。
- 權限：互動一樣先過 `evaluateInboundAccess()`（`canExecuteCommands`），非主人會拿到
  拒絕訊息；回覆一律 ephemeral（`flags: 64`），不會把主人指令結果貼進頻道。

### 啟用條件

- DSH 需重啟以載入新 `lib/index.js`（已重建）。
- Bot 必須以含 `applications.commands` scope 的方式安裝到伺服器，選單才會出現；
  只有 `bot` scope 的邀請連結不會顯示斜線指令。
- 全域指令有 Discord 端快取（通常幾分鐘到一小時）；急用可看 guild 指令那條路徑。

### 驗證紀錄（2026-10-22）

- `node --check`：`discord-commands.mjs`、`discord-api.mjs`、`discord-runtime.mjs`、
  `text-harness-bridge.mjs`、`i18n-en/shared-b.mjs` 全過。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`；`lib/index.js`
  含 `INTERACTION_CREATE`、四個新 API 方法、`runNativeCommand`、`commands.synced`。
- 單元測試（假 api / 假 bridge / 假 accessPolicy）：六個指令 payload 名稱/描述/選項合法、
  互動→文字還原（`/digest 48`、`/thread 讨论一下这个`、`/skip`、討論串取父頻道）、
  deferred ephemeral ack → runner → follow-up 內容、非主人不執行且收到拒絕訊息、
  元件互動被忽略。


## 聊天限流（2026-10-22，按 dsh-discord.log 日志统计落地）

日志 307 条入站消息里只有 27% 被 @、单条最长 784 字、3 次 `HARNESS_TURN_FAILED`、2 次状态表情 429。

- **同人连发合并**：`discord-runtime.mjs` 建桥时传 `coalesceWindowMs: 3_000`，同一发送者 3 秒内的纯文本连发折成一次 turn（最多 8 条）。
- **长消息截断**：`text-harness-bridge.mjs` 的 `MAX_PROMPT_CHARS = 500`，非命令正文超 500 字就截断，并在正文里说明原长度（`原消息共 {total} 字，已截断为前 {kept} 字。`）。
- **队列上限**：`MAX_QUEUED_MESSAGES = 5`，单对话排队超过 5 条时直接回 `这个对话已经排了太多条，先等前面的处理完再发吧。`，不再堆积。
- **状态表情退避**：`status-reaction.mjs` 收到 429 后整条表情通道静默 60 秒（`RATE_LIMIT_COOLDOWN_MS`），避免每条消息继续放大爆发。
- **失败短提示**：`message-failure.mjs` 新增 `failureReplyText()`；`harness-turn-failed / INTERNAL_UNKNOWN` 只回一句 `这次执行卡住了，稍后重试。`，其余错误仍带错误码与参考号。

### 验证记录（2026-10-22）

- `node --check`：`text-harness-bridge.mjs`、`status-reaction.mjs`、`message-failure.mjs`、
  `busy-message-dispatcher.mjs`、`discord-runtime.mjs`、`i18n-en/shared-b.mjs` 6/6 通过。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`，`lib/index.js` 885636 字节。
- 单测（`run_script`）：`failureReplyText` 对 harness 崩溃回短句、其余错误保留参考号；
  假 adapter 第一次 addReaction 返回 429 后，第二次 `beginStatusReaction` 不再发起调用。

## 最近群聊上下文注入（2026-10-22）

桥接层在每个 group 回合把「机器人没收到过、但群里在聊」的消息作为上下文块拼在 prompt 前面，补齐群对话的上下文缺口（日志里 224 条入站有 170 条是「上面/刚才/他说的」这类需要前文的追问）。

- 实现位置：`src/channels/discord/discord-runtime.mjs` 的 `#createContextHooks()`，走
  `text-harness-bridge.mjs` 既有的 `contextHooks.collect / render / onConsumed` 契约
  （与 Matrix 渠道同一套挂点），只对纯文本普通消息生效，命令与失败路径不触发。
- 数据来源：群历史存档（`integrations/dsh-discord/group-history.sqlite`）的 `recentMessages`，
  按频道 `findGroupId` 解析；时间窗默认 15 分钟，最多 40 条、总预算 2000 字符，单行截 200 字。
- 去重：同一个 `conversationKey` 下已注入过的消息不再重复注入（`#historySeen`，上限 400 条），
  避免忙频道每回合把同样的行重复堆上去。
- 过滤：跳过机器人自己的 `正在处理…` 占位、空文本且无附件的行；纯附件消息渲染成「（只发了附件）」。
- 渲染格式：

  ```
  【最近群聊，仅供你了解上下文；不必逐条回应，也不代表都是对你说的】
  18:02 张三：晚上吃啥
  18:03 李四：火锅（带附件）
  ```

- 环境变量：`DSK_DISCORD_HISTORY_CONTEXT=0` 关闭；`DSK_DISCORD_HISTORY_MINUTES`（1-120，默认 15）；
  `DSK_DISCORD_HISTORY_LIMIT`（1-40，默认 15）。
- 风险：注入的是未 @ 机器人的第三方内容，属于不可信数据；块内已明示「仅供理解上下文」，
  模型侧仍按普通对话数据处理，不因此获得任何执行权限。

### 验证记录（2026-10-22）

- 纯函数单测（`run_script`）：当前消息/占位被过滤、附件消息保留、文本 trim、跨窗去重、
  200 字截断、条数上限与 2000 字预算、渲染头部与「（只发了附件）」格式，全部通过（`ALL PASS`）。
- `node --check src/channels/discord/discord-runtime.mjs` 通过。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`，`lib/index.js` 887822 字节，
  bundle 内含 `recent-chat`、`DSK_DISCORD_HISTORY_CONTEXT`、上下文块标题（`\u3010\u6700\u8FD1\u7FA4\u804A`）。
- 实际对话效果需重启 DSH 后在 Discord 群里验证。


## 多人并发与排序表（2026-10-22）

Discord 一个频道的消息过去靠一条 promise 链串行：先到先跑；积压超过 5 条就回
「排了太多条」并把消息丢掉。人多的时候这既会丢掉后来者的请求，也让刷屏的人占满整条链。
现在换成分级排序表（`src/channels/shared/turn-scheduler.mjs`）：

- 一个会话仍只有一个声音在跑（串行），但排队顺序由表决定：
  主人 > 当前回合的发起人 > 其他人；同优先级内按「最久没被服务的人优先」轮转，
  再按到达顺序，保证人多时不至于只有一个人被回复。
- 超过软上限（`MAX_QUEUED_MESSAGES`，5）不再拒绝：同一个人已有一条在排队时，
  新消息折叠进那条（正文用空行拼接，一轮回答），并在日志记
  `folded a burst message into a queued turn`；不同人的消息继续排队，不会互相覆盖。
- 命令不进这张表（`/stop`、`/skip`、`/digest`、`/thread`、`/mute`、`/unmute` 以及
  `/clear`、`/model` 等仍在进入队列之前直接执行），所以再吵也不会被降级或丢弃。
- 持久化时机不变：消息在入表前就写进 `pendingMessages`，重启后仍可恢复；
  折叠掉的那条在它并入的回合跑完后清理。
- `BusyMessageDispatcher`（忙时 steer / 排队回执）保留，只负责「这条该 steer 还是该排队」
  的判定串行；真正的排序都收敛到排序表，链路只剩一层。

### 验证记录（2026-10-22）

- 排序表单测（`run_script`，Node）：主人插队优先于普通消息（已在跑的回合不抢占）、
  刷屏者与另一人交替轮转（`a1,b1,a2,a3`）、超软上限时同一发送者的第 3/4 条折叠进前一条
  且四条都拿到结果、10 个不同发送者全部被处理（零丢弃）、`isBusy`/`idlePromises` 生命周期正确。
- `node --check`：`turn-scheduler.mjs`、`text-harness-bridge.mjs` 通过。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`，`lib/index.js` 889873 字节，
  bundle 内含 `softLimit`、`idlePromises`、`isBusy`、`folded a burst message`。
- 实际多人并发效果需重启 DSH 后在 Discord 群里验证。

## Discord 入站图片视觉（2026-10-23）

此前入站图片一律降级成文字占位（`promptContentForInboundMessage(... deferImages: true)`），模型从没收到过像素。
现在默认把图片作为真正的 `image` 内容块交给 Host，由 Host 按模型能力处理：

- `src/channels/shared/text-harness-bridge.mjs`：常量 `VISION_ENABLED = process.env.DSK_DISCORD_VISION !== '0'`，
  内容构建改为 `deferImages: !VISION_ENABLED`。
- 模型不支持图片时报错不给用户看：`harness-client.mjs` 已有兜底（`isImageAdmissionRejection` /
  `isModelImageRejection` → 图片暂存到会话工作区 + 文本清单 + `IMAGE_FILE_FALLBACK_PROMPT` 重投一次）。
- 上限沿用 `image-prompt.mjs`（单张 5 MB、最多 20 张、合计 20 MB），超限抛 `ImagePromptError`，中英文文案已存在。
- `DSK_DISCORD_VISION=0` 回到旧的纯文字占位行为。

### 排序表优先级老化（同批）

`src/channels/shared/turn-scheduler.mjs`：加入到达时间与老化，选择分数 =
`priority * AGING_WINDOW_MS + min(等待时长, AGING_MAX_MS)`，`AGING_WINDOW_MS = 60s`、`AGING_MAX_MS = 180s`。
效果：普通群友等满 2 分钟可以排到刚发话的主人的前面，主人刷屏也压不死别人；同优先级仍按
「最久没被服务的发送者优先」再按到达顺序。

### 验证记录（2026-10-23）

- `run_script`（Node）模拟时钟：`A-owner-first` 跑完后的顺序为 `A-owner-first, B-ordinary-old, C-owner-fresh`，
  老化生效；同一脚本用真实 `assets/logo-icon.png` 调 `promptContentForMessage`，
  `deferImages:false` 得到 `["text","image"]`（`mediaType: image/png`），`deferImages:true` 只有 `["text"]`。
- `node --check`：`text-harness-bridge.mjs`、`turn-scheduler.mjs` 通过。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`，`lib/index.js` 889991 字节，
  bundle 内含 `DSK_DISCORD_VISION`、`deferImages:!`、`arrivedAt` 与老化打分。需重启 DSH 后在群里发图实测。

### 上下文回溯 + 按用户暂停 + 原生命令扩展（2026-10-23）

**上下文回溯（默认收紧，显式放开）**

- 默认上下文窗口从「15 分钟 / 15 条 / 2000 字」收紧到「15 分钟 / 12 条 / 2000 字」，硬上限 2 小时。
- 显式要求才放开：`/recall [小时]`（原生斜线命令或文本 `/recall 12`）一次性授予下一轮回溯窗口，
  上限 72 小时、最多 60 条、4000 字；不带参数按 24 小时。
- 关键词自动触发（宁可不触发）：提示确实指向记录时（「上面」「刚才」「更早」「翻一下」「聊天记录」等）
  按一次性放开处理，默认 24 小时。
- 每次放开都写一条 `[dsh-im:discord] recent chat recalled` 日志（hours/limit/entries/chars/capped），
  用于事后核对有没有超预算。
- 实现：`src/channels/discord/discord-runtime.mjs` 的 `historyRecallRequested()`、`#collectHistory()`、
  `takeRecallGrant()`（一次性消费，进程内 Map，10 分钟过期）。

**按用户暂停回复（本频道粒度）**

- `/block <@用户> [分钟]`、`/unblock <@用户>`、`/blocklist`，默认 60 分钟，上限 7 天，仅主人可用。
- 暂停只作用于该频道 + 该发送者：桥接层在准入阶段直接丢弃，不占排序表、不触发状态表情，也不影响别人。
- 实现：`src/channels/shared/owner-commands.mjs` 的 `blockUser` / `unblockUser` / `isUserBlocked` /
  `listBlockedUsers`，准入判断在 `text-harness-bridge.mjs`。

**原生斜线命令扩充**

- 从 6 条扩到 10 条：新增 `/recall`、`/block`、`/unblock`、`/blocklist`
  （中文名：回溯 / 暂停某人 / 恢复某人 / 暂停名单）。
- `/block` 用 Discord 的 USER 选项（type 6），交互文本重建成 `<@id>`，仍由同一套文本解析器处理。
- 目录（`command-catalog.mjs`）与原生命令描述已对齐；改完需重启 DSH，全局命令最长约 1 小时同步。

**验证记录（2026-10-23）**

- `node --check` 6 个改动文件通过。
- `run_script`（Node）单测：命令识别（`/blocks` 不误判）、暂停/解除/名单/按频道隔离/7 天上限、
  回溯授予一次性消费与 72 小时上限、`/block` 参数缺失的用法提示、原生命令表 10 条与 zh 本地化、
  交互文本重建（`/block <@id> 30`）、走访问策略的交互路由（无权限不执行、defer 后回写）。全部 PASS。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`，`lib/index.js` 899959 字节，
  bundle 内含 `/blocklist`、`用户 ID 无效`、`recent chat recalled` 等新标记。需重启 DSH 生效。

## 语音频道音乐播放（2026-10-23）

- 新文件：`src/channels/discord/music.mjs`（`MusicManager`，语音连接/队列/播放）与
  `src/channels/shared/music-commands.mjs`（`/play /next /pause /resume /queue /leave` 的解析与调度）。
- 双入口：文本斜线命令（`runMusicCommand`）与 Discord 原生 Application Commands（命令表共 16 条）。
- 播放走独立的 voice-only `discord.js` 客户端（`Guilds` + `GuildVoiceStates` intent），
  不改动收发消息的原生网关客户端；`discord.js` 与 `@discordjs/voice` 均为懒加载，
  依赖缺失时只影响音乐命令，其余功能不受影响。
- 音源：`http(s)` 直链直接流式播放；其他链接或关键词交给 `yt-dlp` 下载到临时目录后再播。
  `yt-dlp` 候选路径优先取 AudioUsbStudio 的 `tools/bin/yt-dlp.exe`，可用 `DSK_DISCORD_YTDLP` 覆盖。
- 限制：队列上限 25 首（`MUSIC_MAX_QUEUE`）、同一用户 3 秒冷却、无人/播放结束自动离开语音频道。
- 构建：`scripts/build-local.mjs` 的 `externalRuntimePackages` 增加 `discord.js`、`@discordjs/voice`、
  `@discordjs/opus`、`opusscript`、`prism-media`，运行时从 workspace 的 `node_modules` 解析。
- 开关：`DSK_DISCORD_MUSIC=0` 可整体关闭音乐功能（不创建 voice 客户端）。
- 已知限制：面向用户的文案以中文为主；缺少 `yt-dlp` 时只有直链音源可播。

验证记录：
- `node --check`：`music.mjs`、`music-commands.mjs`、`discord-runtime.mjs`、`text-harness-bridge.mjs`、
  `command-catalog.mjs`、`discord-commands.mjs`、`i18n-en/shared-b.mjs` 全部通过。
- `run_script` 单测：解析 6 条命令、参数缺失提示、非语音频道/未开功能文案、队列去重与上限、
  命令表 16 条与 `/leave` 无参数、交互路由（`/play` 非主人可用）全部 PASS。
- `scripts/build-local.mjs`：host / client 皆 `errors=0 warnings=0`，`lib/index.js` 918808 字节，
  bundle 内含 `/play`、`/leave`、`joinVoiceChannel`、`DSK_DISCORD_MUSIC`、`dsh-discord-music-` 标记。
  需重启 DSH 生效。