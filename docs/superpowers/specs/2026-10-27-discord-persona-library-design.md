# dsh-discord 多人格庫（persona library）設計

- 日期：2026-10-27
- 狀態：待實作（設計已與使用者確認）
- 相關程式：`src/channels/discord/persona.mjs`、`src/channels/discord/persona-store.mjs`、`src/channels/discord/persona-endpoints.mjs`、`src/channels/shared/text-harness-bridge.mjs`、`src/channels/shared/workspace-session.mjs`、`src/channels/shared/conversation-state-store.mjs`、`plugin-src/host/index.mjs`、`plugin-src/host/persona-rpc.mjs`、`plugin-src/host/channels/shared/rpc.mjs`、`plugin-src/client/persona-editor.js`

## 1. 背景

現在 Discord 的「自訂人格」是單一檔案 `<DSH_HOME>/integrations/dsh-discord/persona.md`，由 `DiscordPersonaStore` 讀寫，設定卡片只有一個文字框。兩個硬限制：

1. **不是實時的**：`plugin-src/host/index.mjs:123` 在插件載入時執行一次 `getDiscordPersonaStore(config).text()`，把字串傳給 `installDiscordPersona(ctx, { text })`（`src/channels/discord/persona.mjs`），`systemPrompt.context` 的 `text` 閉包捕獲的是這個值。改檔案或重啟之外的任何修改都要重啟 DSH 程序才生效。
2. **只有一份**：沒有庫、沒有名字、不能切換。

另外，人格不是靠提示詞活著的，是靠會話歷史裡模型自己幾百輪的輸出活著的。舊會話裡的人格痕跡（含舊的 runtime-context 區塊）會壓過新注入的幾百字人格。所以「切換人格」必然同時是一次「換後台會話」，除非使用者接受舊口吻繼續。

## 2. 目標與非目標

**目標**

- 多人格：新增、命名、編輯、排序、刪除。
- 切換即生效，不需要重啟 DSH。
- 切換不丟記憶：用一份中性第三人稱交接摘要把上一段對話的事實帶進新會話。
- Discord 端體驗不變：同一個群、同一個討論串、同一個 bot，只是後台 `group:<channelId> → sessionId` 的映射換了一條。

**非目標**

- 每個群／每個頻道各自綁不同人格（已與使用者確認不做）。
- 人格繼承、巢狀、變數插值、市場、匯入匯出。
- 跨 bot 共享人格或跨 bot 同步切換。
- 改動其他 IM 渠道的人格行為（飛書、QQ、企業微信等）。

## 3. 名詞

- **人格庫**：`personas/index.json` + `<id>.md` 的集合。
- **啟用中人格**：`personas/active.json` 的 `activeId` 指向的項目。
- **epoch**：`personas/active.json` 的 `epoch` 整數。每次切換 +1，用來讓每條會話知道「我的人格版本過期了」。
- **交接摘要**：切換時生成的第三人稱事實檔案 `handoffs/<key>.md`。

## 4. 資料模型

```
<DSH_HOME>/integrations/dsh-discord/
  personas/
    index.json                    # 清單
    active.json                   # { "activeId": "p_default", "epoch": 0 }
    p_default.md
    p_a3f91c.md
  handoffs/
    group-1562556899214499910.md
  persona.md                      # 遷移後改名 persona.md.migrated
```

> 修訂（實作 Task 1.2 時）：啟用指標與 epoch 放在 `personas/active.json`，不放 `config.json`。理由是 `config.json` 由控制器的設定寫入流程管理，RPC handler 拿不到那個寫入器；把兩者放進人格庫自己的目錄，`activate` 就能在 handler 內完成，不必改 `TokenBotController` 的介面。

`personas/index.json`：

```json
{
  "version": 1,
  "items": [
    { "id": "p_default", "name": "預設", "createdAt": "2026-10-27T12:00:00.000Z", "updatedAt": "2026-10-27T12:00:00.000Z" }
  ]
}
```

規則：

- `id` 由系統產生，格式 `p_` + 6 位小寫十六進位；讀寫前必須以 `/^p_[a-z0-9]{6}$/` 校驗，杜絕路徑穿越。
- 正文是純文字 `.md`，上限沿用 `MAX_PERSONA_CHARS = 8000`（`src/channels/discord/persona-endpoints.mjs`）。模板仍在程式碼裡，正文只放人格本體 —— 這樣模板升級對所有人生效，檔案也能手改與 diff。
- 空檔案 = 不注入（沿用 2026-10-27 已定的 no-fallback 語義，見 commit `92304b6`、`58a0f80`）。
- 最多 50 個人格；超過拒絕新增。
- 排序即 `items` 陣列順序。

### 4.1 模組劃分

| 檔案 | 職責 |
| --- | --- |
| `src/channels/discord/persona-library.mjs` | 讀寫索引與正文、id 校驗、mtime 快取、`resolveActiveText()`、`snapshot()` |
| `src/channels/discord/persona-epoch.mjs` | 純函式：epoch 比對與清綁決策 |
| `src/channels/discord/persona-handoff.mjs` | 交接摘要的提示組裝、`handoffs/` 讀寫、注入用 session 映射 |
| `src/channels/discord/persona.mjs` | 既有；`text` 改為可解析函式，並新增 handoff 注入 |
| `src/channels/discord/persona-endpoints.mjs` | 端點常數（客戶端可 import，禁 `node:fs`） |
| `plugin-src/host/persona-rpc.mjs` | RPC 分派與參數校驗 |
| `plugin-src/client/persona-editor.js` | 清單 + 編輯器 UI |

前三者不 import 任何 harness/bridge，可用 fake 測；`persona.mjs` 只做組裝。

## 5. 注入路徑：改成每輪解析

`src/channels/discord/persona.mjs`：

```js
installDiscordPersona(ctx, { text = '' } = {})
```

`text` 接受 `string | (() => string)`。`systemPrompt.context` 仍為 `order: 120`，渲染時：

```js
text: (assembly) => sessionChannelOf(sessionIdOf(assembly)) === DISCORD_PERSONA_CHANNEL
  ? resolveText()
  : ''
```

`plugin-src/host/index.mjs:123` 從 `const personaText = store.text()` 改成傳入解析函式（`() => library.resolveActiveText()` 或等價）。快取以 `index.json` 與 `personas/<id>.md` 的 mtime 失效，避免每輪同步讀盤。

解析順序（單一函式，可單元測試）：

1. 無 `personaActiveId` → `''`
2. 指向的項目或檔案不存在 → `''`（不退回內建人格）
3. 檔案內容 trim 後為空 → `''`
4. 否則套 `DISCORD_PERSONA_PROMPT` 模板回傳

## 6. 切換語義：epoch + 惰性清綁

RPC 的 `activate` 只做兩件事：寫 `activeId`、`epoch += 1`（皆在 `personas/active.json`）、立刻回 `{ ok, epoch }`。**不動任何 session 映射，也不阻塞正在執行的回合**（當前回合照常結束，重置只影響後續訊息；比「先拒絕切換」少一套狀態機）。

每條入站訊息在 `TextHarnessBridge` 處理前比對：

```js
const seen = state.personaEpochSeen();           // bot state.json 內，缺省 0
if (library.epoch() !== seen) {
  const oldSessionId = state.sessionFor(key);    // conversation-state-store.mjs:172
  if (oldSessionId) enqueueHandoff({ key, oldSessionId });
  state.clearSession(key);                       // :181，只刪映射
  state.setPersonaEpochSeen(epoch);
}
```

下一條訊息落到 `workspace-session.mjs:123` 的惰性新建（`state.sessionFor(key)` 為 null → `createSession` → `state.setSession(key, sessionId)`），自動開新會話。

放在訊息路徑而不是 RPC 路徑，是因為 `TokenBotController`（`src/channels/shared/token-bot-controller.mjs`）沒有公開的 `state`／`harness` 存取器，RPC handler 拿不到綁定表；而 bridge 這層兩者都有。比對邏輯抽成純函式（輸入 `{ epoch, seen, sessionId }`，輸出 `{ clearSession, enqueueHandoff, nextSeen }`），照 `test/bot-model-sessions.test.mjs` 的風格用 fake state 測。

`state.json` 新增 `persona: { epochSeen: number }`，缺欄位視為 0，舊檔案直接相容。

## 7. 交接摘要

### 7.1 生成

1. `harness.rpc('session.history', { sessionId: oldSessionId, maxMessages: 40 })`（`src/channels/shared/harness-client.mjs:1392`，`/history` 命令同源），取最近 40 條使用者與助理的文字。
2. 新建一條**不綁 conversationKey** 的隔離 session，把歷史與固定指令送進去；指令要求：只用第三人稱、只寫可驗證事實（誰是誰、在做什麼、未完成事項、約定的規則）、不含情緒與自稱、不含舊人格的語氣、上限 800 字。
3. 讀回該回合的最終助理文本（`readHistory`，同 `/history` 用的通道），寫入 `handoffs/<safeKey>.md`。
4. 隔離 session 不刪除、永不綁定，使用者看不到；不經 bridge 的傳送路徑，所以不會出現在 Discord。

舊會話少於 4 輪直接跳過（沒有可交接的內容）。

### 7.2 注入

新模組照 `persona.mjs` 的形狀：維護 `sessionId → conversationKey` 映射，在 `agent/disposed` 清理；`systemPrompt.context({ name: 'dsh-im:discord-handoff', order: 121, text })`，只有映射存在且 `handoffs/<key>.md` 存在時注入，標題寫明「上一段對話的檔案（第三人稱，非本人發言，用來保持事實連續）」。

### 7.3 降級

| 情況 | 行為 |
| --- | --- |
| 隔離 session 或讀歷史失敗 | 記 log、卡片標「摘要失敗」，新會話照開（等於乾淨重置） |
| 摘要還沒生成完，使用者已發下一條 | 本輪不注入；摘要完成後對**當下的新會話**補注入（映射已存在的話） |
| 舊會話找不到（已被刪） | 跳過，直接清綁 |

不必「重寫歷史」：摘要在新會話有效，舊會話原封不動。

## 8. RPC 介面

`plugin-src/host/persona-rpc.mjs` 的 `createPersonaRpcHandler(store)` 擴成接受人格庫；端點在 `src/channels/discord/persona-endpoints.mjs` 集中宣告（客戶端可 import，該檔已禁止 `node:fs`）。

| 端點 | 參數 | 回傳 |
| --- | --- | --- |
| `settings.discord-persona.list` | `{}` | `{ activeId, epoch, items: [{ id, name, chars, updatedAt }] }` |
| `settings.discord-persona.get` | `{ id }` | `{ id, name, text }` |
| `settings.discord-persona.create` | `{ name, text? }` | `{ id }` |
| `settings.discord-persona.save` | `{ id, name?, text }` | `{ ok }` |
| `settings.discord-persona.delete` | `{ id }` | `{ ok }` |
| `settings.discord-persona.activate` | `{ id }` | `{ ok, epoch }` |

錯誤碼沿用既有風格：`persona-invalid`、`persona-unavailable`、`persona-not-found`、`persona-active-undeletable`、`persona-too-large`、`persona-limit`。

相容層：`get` 依參數分派 —— 帶 `id` 走新語義；不帶參數回舊形狀 `{ text, defaultText, customized, empty }`（映射到啟用中人格）。`set` 無 `id` 時寫入啟用中人格。保留一個版本後移除。

## 9. 設定卡片

`plugin-src/client/persona-editor.js` 從單文字框改成兩欄：

- 左：人格清單（名稱、字數、`目前` 標記）、`新增`、拖曳排序、刪除。
- 右：選中項的名稱輸入與正文編輯、`儲存`。
- 頂：`啟用這個` 按鈕；狀態列顯示 `已切換 · 摘要生成中／已就緒／失敗`。

`plugin-src/client/bot-general-settings.js` 的摘要文字同步改為「目前人格：<name>」。

> 修訂（實作 Task 1.8 時）：兩欄編輯器做成**彈窗**（卡片上的「目前人格」列點開），而不是把兩欄直接鋪在設定卡片裡——卡片右欄本來就是一列一列的窄行，兩欄塞進去在手機上會只剩一條縫。拖曳排序不做：RPC 沒有排序端點，`index.json` 的順序就是建立順序，夠用；要排序得先加端點，屬後續增強。

## 10. 一次切換的時序

1. 卡片按「啟用這個」→ `activate({ id })` → 寫 `activeId`、`epoch+1` → 立刻回 `{ ok, epoch }`，卡片顯示「已切換」。
2. 背後起交接摘要任務（隔離 session，Phase 2）。
3. 使用者在 Discord 發下一條 → bridge 發現 `epoch !== seen` → 抓 `oldSessionId` → 排入摘要 → `clearSession(key)` → 記錄 `seen`。
4. 該條訊息建立新 session；若摘要已就緒則注入，否則先不注入。
5. 摘要完成 → 寫 `handoffs/<key>.md` → 若新 session 已存在則下一輪起注入。

## 11. 邊界與錯誤

- 切換時有回合在跑：允許，當前回合照常結束。
- 刪除啟用中的人格：拒絕（`persona-active-undeletable`），要求先切到別的。
- 正文超限：拒絕並保留原內容；空正文合法（= 不注入）。
- 併發切換：`personaEpoch` 單調遞增，RPC 請求在主進程序列處理，後寫入者生效；先到的清綁任務若發現 `seen` 已被改到更新值則放棄。
- 人格檔案被外部手改成無效 JSON 的 `index.json`：讀取時視為空庫並記 warn，不讓插件崩。
- `handoffs/` 只增不刪；切換時覆寫同 key 的檔案。

## 12. 遷移

首次讀人格庫時，若 `personas/index.json` 不存在且 `persona.md` 存在：

1. 建 `p_default`，`name: "預設"`，正文 = `persona.md` 原內容；
2. `personaActiveId = "p_default"`；
3. `persona.md` 改名 `persona.md.migrated`（不刪，留著回溯）。

若兩者都不存在：只建空索引，`personaActiveId` 留空 → 不注入，與現況一致。

## 13. 測試策略

單元（`node --test test/*.test.mjs`，照 `test/bot-model-sessions.test.mjs` 用 fake state/harness）：

- 索引讀寫、id 校驗、上限、刪除保護。
- `resolveActiveText` 的優先序與回退（空檔案、檔案缺失、無 activeId）。
- epoch 比對純函式：同 epoch 不動、不同 epoch 清綁並排摘要、無綁定時只記 epoch。
- 交接摘要的提示組裝（輪數不足跳過、字數上限）。
- 舊 `persona.md` 遷移一次且只一次。

整合（`scripts/verify-persona-library.mjs`，照 `scripts/verify-injected-context.mjs` 的斷言風格）：

- 建庫 → 注入文字確實出現在 `systemPrompt` 組裝結果。
- 切換後首條訊息落在新 session（比對新舊 sessionId），舊 session 檔案未被改寫。

人工驗收：

1. 卡片建三個抽象人格 → Discord 切換 → 下一條回覆語氣改變，不需要重啟。
2. 切換後問「我們剛才在做什麼」→ 能答出事實（Phase 2）。
3. 卡片重新整理後狀態一致；`persona.md.migrated` 存在。

## 14. 分期與風險

**Phase 0（spike，先做）**：驗證交接摘要的技術路徑 —— bridge 側能否 (a) 用 `session.history` 讀到舊會話文字、(b) 在未綁定的新 session 裡跑一輪並用 `readHistory` 取回最終文本、(c) 整個過程不觸發任何 Discord 傳送。若 (b) 走不通，降級設計改為「切換 = 乾淨新會話 + 一句提示」，並回頭改本文件第 7 節。

**Phase 1**：人格庫、實時注入、列表 UI、epoch 清綁（無摘要）。
**Phase 2**：交接摘要接入（依 Phase 0 結論）。
**Phase 3**：相容層清理、`docs/` 使用者說明。

交付方式：程式按 Phase 1→2 順序寫，但**驗收後一次性交給使用者**，避免中間版本「切了就失憶」。

## 15. 已決事項

- 方案 A：全域人格庫 + 單一啟用指標（不做每群獨立）。
- 記憶不清空，摘要與清綁同期做，不排到第二階段。
- 摘要在切換時立刻生成（不延到首條訊息）。
- 遷移後的預設人格名稱：`預設`。
