# 音樂播放卡片（按鈕面板）設計

狀態：草案，等使用者確認
日期：2026-10-28
範圍：`dsh-discord` 的 Discord 音樂功能，把「一排文字指令」換成「一張會自己更新的卡片」

## 1. 目標與不做

**目標**：`/play`（或聊天裡點歌）成功後，bot 在頻道裡留一張卡片：歌名、來源、時長、進度條、以及一排按鈕。之後所有操作都按按鈕，不用記指令。

**不做**：

- 不做拖動進度條（Discord 沒有 slider 元件，這是規格限制，不是偷懶）。
- 不做網頁播放器／自訂 UI，一切都在 Discord 訊息裡。
- 不刪掉文字指令。指令是備援：手機上按鈕偶爾延遲、卡片被洗掉、或有人就是習慣打 `/skip`。

## 2. 現況接縫（已核實）

| 位置 | 現狀 |
|---|---|
| `src/channels/discord/discord-runtime.mjs:1636` | `INTERACTION_CREATE` 已進 gateway 分派 |
| `src/channels/discord/discord-runtime.mjs:1698` | `#acceptInteraction()` 去重後交給 `handleApplicationCommand` |
| `src/channels/discord/discord-commands.mjs:344` | 只認 `INTERACTION_TYPE_APPLICATION_COMMAND`，**按鈕（type 3）目前直接被忽略** |
| `src/channels/discord/discord-api.mjs:167` | `createInteractionResponse(interactionId, token, body)` 已有 |
| `src/channels/discord/discord-api.mjs:177` | `updateInteractionOriginal(applicationId, token, body)` 已有 |
| `src/channels/discord/discord-api.mjs:247` / `:313` | `createMessage({channelId, content, replyToMessageId})` / `editMessage({channelId, messageId, content})` 已有，但**只收 content 字串並自行組 body**（`:251-262`、`:319`），沒有 embeds / components 通道 |
| `src/channels/discord/music.mjs:57` | `MusicManager.execute(command, args)` 白名單：`play join next stop pause resume queue nowplaying status volume bitrate channels leave` |
| `src/channels/discord/music.mjs:318-325` | `queue` / `nowplaying` / `status` 都只回 `{message}` 字串，沒有結構化狀態 |

**三個真正的缺口**（不是包裝工作，需要寫程式）：

1. `discord-api.mjs` 的訊息 API 要能帶 `embeds` 與 `components`，並回傳 `message_id`（卡片要靠 id 更新）。
2. `MusicManager` 沒有結構化快照，也沒有 `loop` / `remove` / `previous`。
3. `handleApplicationCommand` 之外要有一條 `MESSAGE_COMPONENT` 分支。

## 3. 卡片長相

沿用截圖的資訊層級，但用 Discord 原生 embed（比 components v2 的 container 相容性高，舊客戶端也看得到）：

```
┌───────────────────────────────────────┐
│ 標題：老人與海.wav                    │
│ 描述：來自 BENNY HÀN                  │
│ 縮圖：專輯封面（source.thumbnail）    │
│ 進度：01:12 ●───────── 03:03          │
│ 頁腳：Qigi Bot · 由 TINGOD 點播       │
└───────────────────────────────────────┘
[循環：關閉] [上一首] [暫停] [下一首] [佇列]
[更新] [移除]
```

- 進度條用字元畫：`▬▬▬▬▬▬▬🔘▬▬▬▬` 或 `01:12 ●───────── 03:03`，每幀重算，不做動畫。
- 按鈕樣式：播放/暫停用 `1`（Primary），其餘 `2`（Secondary），「移除」用 `4`（Danger）。
- 暫停、停止、無歌可播時：把不適用的按鈕 `disabled`，不只是改文字。

## 4. `custom_id` 協議

格式：`music:<action>:<guildId>`，全部小寫，長度遠低於 100 字上限。

| action | 對應 `MusicManager` | 備註 |
|---|---|---|
| `loop` | `loop(channelId, mode)` | **新功能**，見 §6 |
| `prev` | `previous(channelId)` | **新功能**（需要播放歷史） |
| `pause` | `pause` / `resume` | 依目前 state 二選一 |
| `skip` | `next` | |
| `queue` | `queue` | 回覆用 ephemeral |
| `refresh` | — | 只重畫卡片 |
| `remove` | `stop` + `leave`? | 見 §6 的取捨 |

`guildId` 放進 id 的理由：互動回來時只有 `channel_id`，但 handler 需要 guild 才能判斷語音頻道；帶著就不用查表。

## 5. 互動流程

`#acceptInteraction` 在呼叫 `handleApplicationCommand` 之後，若它回 `false` 且 `interaction.type === 3`，交給新的 `handleMusicComponent(interaction, ctx)`：

1. 解析 `data.custom_id`，不認得的直接回 `type 4`（ephemeral 錯誤），不讓互動掛到 3 秒超時。
2. 先回 `type 6`（deferred update）保命，再執行 `MusicManager` 動作——`next` 要重新解析下一首，可能超過 3 秒。
3. 動作完成後回 `type 7`（UPDATE_MESSAGE）重畫卡片；若動作產生「已暫停」「已停止」這類訊息，塞進卡片的頁腳或一次性 ephemeral，不另外發訊息。
4. 動作失敗（例如沒在語音頻道）→ `type 4` ephemeral 錯誤，卡片不動。

**權限**：按鈕不等於指令授權。所有音樂動作走 `accessDecision`（`evaluateInboundAccess`）同一條路，非白名單的訪客按「跳過」不會被擋（音樂本來就是低權限），但按「移除」（停播＋離開）要記 owner 或白名單——這條在 §6 決定。

## 6. `MusicManager` 要長出來的部分

**6.1 `snapshot(channelId)`**：回結構化狀態，卡片只依賴它。

```js
{ state: 'idle' | 'preparing' | 'playing' | 'paused',
  title, url, source, thumbnail,
  durationMs, positionMs,        // positionMs 由 transport 的時間基準推算
  volume, loop: 'off' | 'track' | 'queue', queueCount, requestedBy }
```

`positionMs` 目前**沒有現成欄位**：`room.transport` 只有 `resetTiming()` 與 `snapshot()`（回 encoder/bufferedMs）。實作時要確認 transport 是否保有播放起點時間；若沒有，就用 `startedAt + (Date.now() - startedAt)` 減去暫停累計，並在設計審查時標成「估算值，允許 ±1 秒誤差」。

**6.2 `loop(channelId, mode)`**：目前完全沒有循環功能（`execute` 白名單裡沒有）。要新增 `room.loop`，並在 `#finished()`（`music.mjs:225`）決定下一首時依模式處理：`track` 重播同一首、`queue` 把剛播完的推回隊尾、`off` 照舊。這是本設計裡**唯一會動到播放核心**的改動。

**6.3 `previous(channelId)`**：需要 `room.played` 歷史（上限 20），`next` 時 push 當前曲目。

**6.4 `remove(channelId)`**：截圖那顆「移除」語義不明，兩個選項：**(a)** 只把卡片從頻道刪掉（音樂繼續）；**(b)** 停止播放並離開語音。建議 **(a)**，危險動作用「循環」旁邊不該有；真要停就用 `/stop` 或讓「暫停」長按——Discord 沒有長按，所以移除＝刪卡片。

## 7. 刷新策略

- 播放中每 **2.5 秒** edit 一次（Discord 對單條訊息約 5 秒 5 次，2.5 秒安全）。
- 暫停、閒置、停止：停止輪詢，只在使用者按鈕時重畫。
- 每次 edit 前比對 `snapshot()` 的摘要字串，沒變就不發請求（省配額，也避免卡片閃）。
- 429 時依 `retry_after` 退避，連續失敗 3 次就停刷並在卡片頁腳標「更新暫停」。
- 時間軸跟真實播放會有 1 秒內誤差，這是輪詢的必然，不追求對齊。

## 8. 生命週期

| 事件 | 行為 |
|---|---|
| `/play` 成功 | 發卡片，記 `messageId`（每頻道一張，`Map<channelId, messageId>`） |
| 收歌／自然結束 | 同一張卡片 edit 成新歌；佇列空了就 edit 成「已結束」並 disable 按鈕 |
| `stop` / `leave` | edit 成「已停止」並 disable；卡片保留（刪掉會讓歷史失去上下文） |
| 卡片被手動刪除 | 下次 edit 收到 404 → 清掉 `messageId`，下次播放重新發一張 |
| bot 重啟 | `messageId` 只在記憶體，重啟後舊卡片變孤兒（按鈕會回「這張卡片已失效」）；新的播放重新發卡。**不持久化**，避免狀態與真實播放不同步 |

## 9. 測試

- `music-panel.test.mjs`（純函式）：`renderPanel(snapshot)` → embed/components 結構；進度條邊界（0、中間、滿、duration=0）；按鈕 disabled 規則；`custom_id` 往返解析。
- `music-panel-interactions.test.mjs`：假 api 記錄呼叫，驗證 type 6 → 動作 → type 7 的順序；不認得的 custom_id 回 ephemeral；動作拋錯回 ephemeral 且不改卡片。
- `music-snapshot.test.mjs`：`MusicManager.snapshot()` 在 idle / preparing / playing / paused 四態的欄位；`loop` 三態對 `#finished` 的影響（用假 transport）。
- 全套 `node --test test/*.test.mjs` 不得退步（目前 275 pass）。

## 10. 分期

**P1（可獨立上線）**：訊息 API 支援 embeds/components → `snapshot()` → 卡片渲染 → 暫停/繼續、下一首、佇列、更新、移除五顆按鈕 → 2.5 秒刷新。循環與上一首先 disable。

**P2**：`loop`（動 `#finished`）＋ `previous`（播放歷史）＋ 對應按鈕解鎖。

**P3**（可選）：`queue` 按鈕改成開一張 ephemeral 清單（最多 20 首）而不是 edit 主卡片；「−30s / +30s」跳時間。

## 11. 風險與取捨

- **動到播放核心**（`#finished`）：loop 有機會讓「播完」事件重入，P2 必須補時序測試。
- **速率限制**：多人同頻道時按鈕連點會撞 429；用「最後一次請求時間」節流，而不是排隊。
- **卡片孤兒**：重啟後舊卡片按鈕會失效，這是刻意的取捨（不做持久化）。
- **文字指令與按鈕雙軌**：兩邊都改同一個 `MusicManager`，狀態只有一份，所以不會不同步——這是保留指令的前提，也是它比「兩套播放器」安全的地方。
