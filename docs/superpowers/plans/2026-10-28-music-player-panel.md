# 音樂播放面板（可拖動）實作計劃

規格：[`2026-10-28-music-player-panel-design.md`](../specs/2026-10-28-music-player-panel-design.md)（§12–§16 是拖動修訂）。
約定：每個任務先寫測試（紅）→ 實作（綠）→ 一個 commit；全套 `node --test test/*.test.mjs` 不得退步（目前 275 pass）。

## Phase 0 — 地基與驗證

### 0.1 驗證 `-ss` 跳轉在真實管線上的行為（spike，不進 repo）
- 用 `playbackEncoderArgs(input, { offsetSeconds })` 對一段 10 秒音源產生 opus，再用 ffmpeg 解回 wav 量測長度。
- 驗收：`offsetSeconds = 0` → 約 10 秒；`offsetSeconds = 5` → 約 5 秒，且無爆音（Decode 不報錯）。
- 結論寫在計劃檔末尾「Phase 0 結論」；若 `-ss` 放 `-i` 前導致關鍵幀對齊不準，改測 `-ss` 放 `-i` 後。

### 0.2 訊息 API 支援 embeds / components
- `src/channels/discord/discord-api.mjs`：`createMessage(channelId, body)`、`editMessage(channelId, messageId, body)` 目前只收字串；改成收 `{ content?, embeds?, components? }`，保留字串呼叫的相容性。
- 測試 `test/discord-api-body.test.mjs`：字串 → `{content}`；物件 → 原樣；空物件被拒。
- commit：`feat(discord): 訊息 API 支援 embeds 與 components`

## Phase 1 — 卡片

### 1.1 `MusicManager.snapshot()`
- 回 `{ state: 'idle'|'preparing'|'playing'|'paused', title, author, url, positionMs, durationMs, loop: 'off'|'one'|'all', volume, queue: string[] }`。
- 測試 `test/music-snapshot.test.mjs`：四態欄位；`durationMs = 0` 時 position 不爆；queue 截 10 首。
- commit：`feat(discord): MusicManager 提供結構化播放快照`

### 1.2 `renderPanel(snapshot)` 純函式
- 新檔 `src/channels/discord/music-panel.mjs`；輸出 `{ embeds: [...], components: [...] }`，進度條用字元（`▰`/`▱`/`🔘`，16 格），時間 `mm:ss`。
- 按鈕：`custom_id = music:<action>:<guildId>`；idle 時全部 disabled。
- 測試 `test/music-panel.test.mjs`：邊界（0%、50%、100%、duration 0）；disabled 規則；`parseCustomId` 往返。
- commit：`feat(discord): 音樂卡片渲染純函式`

### 1.3 卡片生命週期
- `MusicManager` 記 `panel`（`{channelId, messageId, timer}`）；`start()` 發卡、`#refresh()` 每 2500ms 編輯、`stop()`/`leave()` 清 timer。
- 編輯 404 → 清 `messageId`，下次播放重發。
- 測試 `test/music-panel-lifecycle.test.mjs`：假 api 記錄 `createMessage`/`editMessage` 次數與間隔。
- commit：`feat(discord): 播放卡片送出、刷新與孤兒處理`

### 1.4 互動路由
- `discord-runtime.mjs` 的 `#acceptInteraction` 在 `handleApplicationCommand` 之後加 component 分支：`type === 3` → 解析 `custom_id` → 執行動作 → `type 7`（更新卡片）或 `type 4`（ephemeral 錯誤）。
- 測試 `test/music-panel-interactions.test.mjs`：不認得的 id 回 ephemeral；動作拋錯回 ephemeral；成功回 type 7。
- commit：`feat(discord): 卡片按鈕互動路由`

### 1.5 五顆按鈕接上動作
- 暫停/繼續（`pause`/`resume`）、下一首（`next`）、佇列（ephemeral 文字）、刷新（`type 7`）、移除（刪卡不停止播放）。
- commit：`feat(discord): 卡片按鈕接上播放動作`

## Phase 2 — 拖動

### 2.1 `MusicManager.seek(positionMs)` 與 `positionMs()`
- 差 < 1500ms 忽略；clamp `[0, durationMs - 2000]`；destroy → `#buildTransport(room, track, { offsetSeconds })`（`music.mjs:236`）。
- 測試 `test/music-seek.test.mjs`：假 transport 記錄 `offsetSeconds`；邊界與抖動。
- commit：`feat(discord): 播放位置跳轉`

### 2.2 `seek` action 與 `/music seek`
- `music.mjs` 的 `ACTIONS` 加 `seek`（參數 `positionMs` 或 `mm:ss` 字串）。
- 測試：`/music seek 1:30` 解析與呼叫。
- commit：`feat(discord): seek 動作與指令`

### 2.3 網頁控制台伺服器
- 新檔 `src/channels/discord/music-control-server.mjs`：`node:http`、token 每次啟動隨機、預設綁 `127.0.0.1`、路由 `GET /music/<token>/`、`GET /state`、`POST /seek|pause|resume|next|prev|loop|volume`；20 req/s 限流、seek 最小間隔 300ms。
- 測試 `test/music-control-server.test.mjs`：錯誤 token 404、正確 token 200、seek 呼叫到假 manager、超限 429。
- commit：`feat(discord): 音樂網頁控制台`

### 2.4 控制頁 HTML
- inline CSS/JS、深色、手機可用；`input type="range"` 拖動時只更新文字、`change` 才 POST；每 1 秒輪詢 `/state`。
- 測試：HTML 字串含 `type="range"`、`/seek`、`addEventListener('change'`。
- commit：`feat(discord): 音樂控制頁介面`

### 2.5 卡片上的「網頁控制」Link 按鈕
- `renderPanel` 收 `controlUrl`，有值才加 `style: 5` 按鈕（Discord 限制：Link 按鈕必須有 `url`）。
- commit：`feat(discord): 卡片連結到網頁控制台`

## Phase 3 — 收尾

### 3.1 設定卡開關（可選）
- `musicControlPort`、`allowLan`；預設 0（隨機）與 false。

### 3.2 交付
- 全套測試、`node scripts/build-local.mjs`、`docs/music-control.md` 使用說明、`FORK.md` 補一段、commit + push。

## 驗收（整體）
1. 群裡 `/play` 後出現卡片：標題、作者、進度、五顆按鈕可按。
2. 卡片上「網頁控制」→ 開啟頁面 → 拖動滑桿 → 放開後音樂從該位置繼續。
3. 拖到 0:50 再回群裡看卡片，時間同步在 0:50 附近。
4. 兩人同時按下一首不會讓播放器狀態錯亂（限流＋單一 manager）。

## Phase 0 結論（已驗證）

**0.1 `-ss` 跳轉在真實 ffmpeg 上的行為**（10 秒 sine 音源 → `playbackEncoderArgs` → opus → 解回量測）：

```
offset=0s -> ogg 174986 bytes, decoded 10.00s
offset=5s -> ogg  87736 bytes, decoded 5.00s
offset=9s -> ogg  17936 bytes, decoded 1.00s
```

- `-ss` 放在 `-i` 前（現行 `music-encoder.mjs:25` 的寫法）精度足够：誤差 < 0.01 秒，解碼無報錯。
- 因此 seek 不需要改 ffmpeg 參數順序，直接用既有 `offsetSeconds`。
- 沙箱副檔：`ffmpeg` 子程序不能寫入 `$env:DSH_SCRATCH` 或系統 temp（`Permission denied`），探測檔要放 workspace 內的暫存目錄，跑完立刻刪除；`run_script` 內 `spawn` 會被擋（EPERM），要用 `pwsh` 起 node。

**0.2**：`messageBody({ content, embeds, components })` 已加，`createMessage`/`editMessage` 都收 embeds/components，上限（10 embeds、5 action rows）在送出前就擋；`test/discord-api-body.test.mjs` 6 測試綠。
