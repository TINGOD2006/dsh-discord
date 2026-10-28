# 群聊即時上下文：相關性補充設計

狀態：草案（待使用者確認）
日期：2026-10-27
關聯：`docs/context-policy.md:32`（篩選與額度）、`docs/context-policy.md:46`（回放格式）

## 1. 問題

明確回顧時補進來的群聊內容是「先截窗、再按時間排」：最近 6 小時、最多 60 則、約 4000 字元，取最新的一段。過程裡沒有任何一則訊息是因為「跟這句有關」而被留下，所以話題一換，真正該知道的那幾則就被閒聊擠掉，回答看起來像不知道剛剛聊了什麼。

使用者確認的痛點只有一個：**漏掉該知道的發言**。不是太吵、不是太慢、也不是接話笨。

## 2. 目標與非目標

目標
- 同一份字元預算下，讓「與本輪有關」的訊息更容易被留下。
- 不從中間切斷對話：回覆鏈與同一人的連續發言要整段帶。

非目標
- 不改 6 小時上限（`docs/context-policy.md:32`）。
- 不改工具額度（每回合 3 次 / 6000 字元 / 單次 4000 字元，`src/channels/shared/group-history-access.mjs:4` 的 `HISTORY_READ_LIMITS`）。
- 不加入小模型重排：那會與「不另呼叫模型判定是否接話」的既有原則衝突（`docs/context-policy.md:23`）。
- 不動權限：guest guard、白名單、來源隔離一律照舊。

## 3. 現況（已核實）

- 資料層：`src/channels/shared/group-history-store.mjs:371` 的 `recentMessages(groupId, { since, before, keyword, limit })`，`limit` 上限 200（`:376`），回傳每則含 `messageId`、`senderId`、`senderName`、`sentAt`、`text`、`replyToMessageId`、`replySenderName`、`replyText`、`imagePaths`（`:394-413`）。也就是說回覆關係、發話者、時間全都已經在資料裡，只是沒有被用來做選擇。
- 讀取狀態：`src/channels/shared/history-read-state.mjs:18` 的 `recent()` 帶快取與去重，`missing()` 處理同訊息被編輯／分段的增量。
- 額度與回放：`src/channels/shared/history-context.mjs` 負責 `cleanHistoryText`、單行化、`[hN]`／`#mXXXX` 編號與字元預算。
- 目前的「留哪些」決策：只由時間與筆數決定，沒有任何相關性訊號。

## 4. 設計

### 4.1 候選池（先取寬，再選窄）

- 候選池：`recentMessages(groupId, { since: now - 6h, limit: 200 })`（`limit` 在 `:376` 被夾在 200 以內，這裡取滿）。SQLite 在本機，放寬筆數不改延遲也不花模型 token，只是可選集合變大。
- 排除規則照舊（`docs/context-policy.md:33`）：當前訊息、空訊息、機器人狀態提示、已知控制指令、同一人 90 秒內同內容同引用的重複。

### 4.2 三段式選取

以「15 則保底 + 回覆鏈補齊 + 相關性補位」構成，總字元預算仍是 4000：

1. **保底窗**：最新 15 則，不論內容一律保留。保證接得上眼前的話。
2. **回覆鏈閉包**：對已入選的每一則，若 `replyToMessageId` 指向的被引用訊息不在入選集合內，就把那條拉進來；對拉進來的再遞迴一次，最多 8 跳、總共最多 8 則。被引用訊息只保留「發話者 + 前 200 字」的引文形態，避免一條長文吃掉預算。
3. **相關性補位**：剩餘預算按分數由高到低補，直到字元用完。

### 4.3 分數（可調常數，先把權重寫成具名常數）

| 訊號 | 分數 | 理由 |
| --- | --- | --- |
| 與本輪訊息有詞重疊（CJK 二字組 + 拉丁詞） | +2.0 | 直接同話題 |
| 由本輪發話者發的（同一個人） | +1.0 | 追問多半是同一人在延續 |
| 在本輪訊息裡被 @ 到，或這則是 bot 的發言 | +2.0 | 對話對象 |
| 距離本輪 15 分鐘內 | +1.0 | 近因 |
| 與候選池的高頻詞（前 20 個詞）重疊 | +0.5 | 弱話題訊號 |

同分時新的優先。分數只決定「誰先被選」，不決定輸出順序——輸出永遠按時間正序，`[hN]` 編號不變。

### 4.4 缺口標記（誠實性要求）

若選取過程中跳過了中間的訊息（保底窗之外有斷層），在斷層處插入一行 `… 略過 N 則 …`，讓模型知道這不是連續轉錄，避免把跳過的部分當成沒發生。這一行不計入 `[hN]` 編號。

### 4.5 除錯開關（先量測再調參）

`DSH_DISCORD_GROUP_CONTEXT_DUMP=1` 時，把每次選取的統計寫成 `logger.event('context.group-context-selection', {...})`：候選數、保底數、鏈補數、補位數、被丟棄的前 5 則（含分數），以及實際輸出字元數。預設關閉，不產生檔案。

### 4.6 純函式邊界

選取邏輯寫成 `selectGroupContext({ candidates, current, budgetChars, windowSize, chainHops })` 純函式（新檔 `src/channels/shared/group-context-selection.mjs`），回傳 `{ items, gaps, stats }`；字元計算與 `[hN]` 編號仍由 `history-context.mjs` 負責。這樣選取可以在測試裡用固定 transcript 驗證，不必碰 SQLite 與網路。

## 5. 失敗與邊界

| 情況 | 行為 |
| --- | --- |
| 候選池不足 15 則 | 全部保留，不補位，不報錯 |
| 完全沒有詞重疊（中文短句、玩梗） | 保底窗 + 回覆鏈仍然生效；不因為分數低而整段消失 |
| 回覆鏈超過 8 跳 | 停在第 8 跳，並標 `… 更早的回覆已略過 …` |
| 被引用訊息早已超出 6 小時 | 不拉進來，退化成既有的「名字 + 摘要」引用形態（`docs/context-policy.md:46`） |
| 字元預算不足以放完保底窗 | 保底窗優先，補位放棄，`stats.budgetExhausted=true` |
| 多個群／討論串 | 只在當前 `groupId` 內選，不跨群 |

## 6. 測試與驗收

單元測試（`test/group-context-selection.test.mjs`）
1. 話題漂移：中間插 40 則閒聊，早先那則與本輪同詞的發言仍入選。
2. 回覆鏈：本輪回覆一則舊訊息，該訊息與它的被引用訊息一起入選。
3. 保底窗：最新 15 則即使全部零分也都在。
4. 斷層標記：跳過中間訊息時出現 `… 略過 N 則 …`。
5. 預算：超額時保底窗優先，`budgetExhausted` 為真。
6. 邊界：候選為 0 / 1 / 15 / 250 則都能回傳合法結構。

驗收（實機）
- 開 `DSH_DISCORD_GROUP_CONTEXT_DUMP=1`，在 Discord 群裡重現一次「話題被閒聊擠掉」的情境，dump 顯示原本會被丟掉的那則已入選。
- `npm test` 全綠；`node scripts/build-local.mjs` host/client errors=0。

## 7. 待確認

- 保底窗 15 則、鏈上限 8 跳、權重表是否就按此定案。
- 輸出裡的 `… 略過 N 則 …` 是否要顯示（有人會覺得吵；但藏起來等於騙模型它是連續的）。
