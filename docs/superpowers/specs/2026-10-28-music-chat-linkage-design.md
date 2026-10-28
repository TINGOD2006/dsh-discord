# 聊天與音樂聯動：由對話決定歌單

狀態：草案（待使用者審閱）
日期：2026-10-28
決策紀錄：方案 2（意圖三態 + 待確認狀態機）；明確點歌直接放、氣氛類先問；問句由模型寄生在正常回覆裡；任何人回覆皆可同意。

## 1. 目標

讓 Discord 群裡的對話能自然地帶起音樂，不必每句都打 `/play`：

- 有人**明確想點歌**（「放一下 周杰倫 晴天」）→ 立刻放，不需要再問。
- 有人只是在**講氣氛**（「今天好累喔」）→ bot 順口問一句要不要放，有人回「好」才放。
- 其餘情況**什麼都不發生**。不插話、不主動放歌、不改變聊天節奏。

## 2. 非目標

- 不做「自動接歌／佇列空了自動補」（那是另一個方向，這次不做）。
- 不做「有人講話就降音量」。
- 不做小模型或大模型每輪判定要不要點歌（與 `docs/context-policy.md:23`「不另呼叫模型判定是否接話」的保守原則衝突）。
- 不做設定卡開關（先用環境變數 `DSH_DISCORD_MUSIC_CHAT=0` 全域關閉）。

## 3. 現況（已核實）

- 音樂意圖判定：`src/channels/shared/music-commands.mjs:17` 的 `isMusicCommand()` 只認 `/play`、`/music` 這類前綴指令；`musicIntentActions()`（`src/channels/shared/music-access.mjs:50` 一帶）判斷的是「這則訊息授權哪些動作」。
- 授權接縫：`src/channels/shared/music-access.mjs:59-72` 的 `createMusicRequestContext()`，條件不成立就回 `null`，工具（`dsh_im_music`）隨即拒絕（`:87`）。**本次不改這一段。**
- 工具與提示：`installMusicTools()`（`music-access.mjs:117-128`）註冊 `dsh_im_music`、掛 `systemPrompt.context`（order 119）與 session 事件。
- 音樂執行：`music.execute(action, { ...identity, signal })`（`music-access.mjs:68-71`），`play` 需帶 `query`（`:95-100`，允許關鍵詞或 HTTP(S) 連結，拒絕本機路徑與換行）。
- 既有慣例：音樂指令走獨立 lane（`src/channels/discord/discord-runtime.mjs:1000` 註解：音樂指令自己一條 lane，回合排程器看不到），所以「聊天順手點歌」不能走指令 lane。

## 4. 設計

### 4.1 意圖三態（純函式，無 I/O）

新檔 `src/channels/shared/music-chat-intent.mjs`：

```
classifyMusicIntent(text) -> { kind: 'explicit', query } | { kind: 'mood', mood } | { kind: 'none' }
matchMusicConsent(text)  -> 'yes' | 'no' | 'none'
```

`explicit` 的條件：句中同時有
1. **點歌動作**（放／播放／播／來一首／來點／點歌／點播／換一首／下一首請放…），且
2. **可當查詢的目標**（歌名片段、歌手名、或 `https://` 連結）。

`mood` 的條件：句中有情緒／場景詞（累／煩／難過／開心／嗨／深夜／下雨／加班／通勤／開車／想睡…）且**沒有**明確目標。情緒詞表獨立成常數，可增補。

`none`：其餘全部（包含「這首歌好難聽」——有歌名但沒有點歌動作；包含 `/play` 開頭的指令，交給既有 lane）。

`matchMusicConsent`：短訊息（≤ 12 字）且整句是同意詞（好／好啊／要／可以／放／來吧／ok／可以放）→ `yes`；整句是拒絕詞（不要／別放／不用／算了）→ `no`；其餘（含「好累」「好的我明天再看」）→ `none`。**只做整句匹配**，避免「好」出現在句子裡就誤判。

### 4.2 待確認狀態（每個頻道一個槽）

新檔 `src/channels/shared/music-suggestion.mjs`：

```
class MusicSuggestionStore({ now = Date.now, ttlMs = 60_000 })
  offer({ channelId, query, title, requestedBy }) -> void   // 先標 draft；同頻道覆蓋舊值
  activate(channelId, replyText) -> boolean                // 回覆含標題或問號才轉 active 並開始計時
  peek(channelId) -> suggestion | null                     // 只回 active；過期自動視為 null
  take(channelId) -> suggestion | null                     // 取出並清除
  drop(channelId) -> void
```

只存記憶體：程序重啟即失效（暫存承諾不該跨重啟）。每個頻道同時只有一個候選，新的覆蓋舊的。

### 4.3 候選怎麼產生

`mood` 命中後，背景組字串（情緒詞 + 最近幾則訊息的高頻詞）丟給既有 yt-dlp 解析路徑取第一條結果：

- 逾時 5 秒、解析失敗、或結果沒有標題 → 不建立 pending、記 `warn`、不重試。
- 成功 → `offer({ channelId, query, title, requestedBy })`。

### 4.4 問句怎麼出現（不另發訊息）

`installMusicTools()` 多註冊一個 `systemPrompt.context`（name `dsh-im:music-suggestion`、order 122）：有 pending 時注入一段指示，內容要點：

- 本回合有一個音樂候選「<title>」，來源是剛剛的聊天氣氛（不是有人點歌）。
- 若你覺得合適，**在這次回覆的最後**用一句話問要不要放；不要自己放進佇列，不要另開一段，不要重複問。
- 若你覺得不合適，就不要提。

模型沒問 → 回覆送出時候選仍停在 `draft`，直接 `drop`（見 §4.5），不補發罐頭問句。這是刻意的取捨：寧可漏，不要硬塞。

### 4.5 同意與執行

`discord-runtime.mjs` 的訊息入口，在音樂指令 lane 判斷**之前**插入：

1. `pending = store.peek(channelId)`（**先看不取**，否則「好累」這種非同意回覆會把候選吃掉）
2. `pending` 存在且 `matchMusicConsent(text) === 'yes'` → `store.take(channelId)` 後執行 `music.execute('play', { query: pending.query, channelId, guildId, senderId })`；成功回「放上了：<title>」，失敗回「沒放上：<原因>」。
3. `pending` 存在且 `'no'` → `store.take(channelId)` 丟棄，不回應。
4. `pending` 存在但 `'none'` → **不動它**，照常走原本流程（一般聊天不該吃掉待確認的候選）。
5. 沒有 `active` pending → 走原本流程（`explicit` 交給既有 lane；`mood` 建新 pending）。

**只有「模型真的問出口」的候選才算數**：`offer` 後候選停在 `draft`；本回合回覆送出時，若回覆文字包含候選標題或問號，才 `activate` 並開始計 60 秒，否則在回覆送出後直接 `drop`。這樣「模型沒問、有人卻回好」不會誤放。

`explicit` 訊息照原樣走 `createMusicRequestContext`，新路徑不介入——明確點歌的行為完全不變。

### 4.6 防騷擾

- 同一頻道 5 分鐘內最多問 2 次（`offer` 時檢查計數器，視窗內已達上限就不 offer）。
- 佇列已有 ≥ 3 首時不 offer。
- bot 不在該伺服器語音頻道時不 offer（`explicit` 例外，照舊讓使用者得到「沒連上語音」的實際錯誤）。

## 5. 失敗與邊界

| 情況 | 行為 |
| --- | --- |
| yt-dlp 超時／失敗／無標題 | 不 offer、記 warn、不重試 |
| 同意後執行失敗 | 回一句實話（原因取自錯誤），不重試、不清佇列 |
| 過期後才回「好」 | 當普通聊天，不放 |
| 同頻道又一個 mood | 新的覆蓋舊的 |
| 不同頻道各有 pending | 各自獨立（key = channelId） |
| bot 重啟 | pending 全失，等於沒問過 |
| 模型沒問，有人卻回「好」 | 候選停在 `draft`，回覆送出後即 `drop`，不會放 |
| 同時打了 `/play` | 指令 lane 優先，pending 清掉 |
| 訊息同時含 mood 與 explicit | 以 `explicit` 為準，不 offer |

## 6. 測試與驗收

單元測試 `test/music-chat-intent.test.mjs`
1. `放一下 周杰倫 晴天`、`來一首 X`、`點播 X`、貼 YouTube 連結 → `explicit` 且帶 query。
2. `這首歌好難聽` → `none`；`/play x` → `none`；`今天好累喔` → `mood`。
3. 同意詞 `好／好啊／要／可以／放／來吧／ok` → `yes`；`不要／別放／不用` → `no`；`好累`、`好的我明天再看` → `none`。

單元測試 `test/music-suggestion.test.mjs`
4. `offer → take` 後 `peek` 為 `null`；過期後 `take` 為 `null`；同頻道覆蓋；不同頻道互不干擾。
5. 提示組裝與啟用：有 `active` pending 注入非空文字，沒有注入空字串；`draft` 在回覆未含標題／問號時被 `drop`，含標題時轉 `active`。

整合測試 `test/music-chat-suggestion.test.mjs`
6. fake `music.execute` + 可注入時鐘：`mood → offer → 回「好」` → `execute('play')` 恰好一次。
7. `offer → 超時 → 回「好」` → `execute` 零次。

實機驗收
- 群裡說「今天好累」→ bot 順口問一句；沒人回 → 60 秒後無聲。
- 有人回「好」→ 佇列多一首，bot 回「放上了：<title>」。
- 說「放一下 周杰倫 晴天」→ 直接放，不問。
- 說「這首歌好難聽」→ 不動。
- `npm test` 全綠；`node scripts/build-local.mjs` host/client errors=0。

## 7. 待決（實作前確認）

- 情緒詞表初版涵蓋範圍（先以中文常用語為主，之後可增補）。
- 5 分鐘 2 次的節流數字是否合適，實機跑一週再調。
