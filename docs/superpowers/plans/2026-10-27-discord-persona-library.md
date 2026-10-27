# 實作計劃：dsh-discord 多人格庫

設計文件：`docs/superpowers/specs/2026-10-27-discord-persona-library-design.md`（commit `e9a6520`）

**目標**：把單一 `persona.md` 換成可命名、可切換、可編輯的人格庫；注入改為每輪解析；切換時換後台會話並用中性摘要帶走事實。

**技術棧**：Node ESM、`node --test`、既有 DSH 插件宿主 API（`ctx.systemPrompt.context`、`session.history`）、`scripts/build-local.mjs` + `npm run push` 建置。

**驗證哲學**：每個模組先寫失敗測試。純模組用 fake 測（照 `test/bot-model-sessions.test.mjs`），不碰檔案系統的用注入介面。需要真 DSH 才能驗的，集中在最後的人工驗收。

---

## Phase 0：確認可用原語（不改產品程式）

### Task 0.1：確認讀歷史與跑隔離會話的原語

**檔案**：只讀 `src/channels/shared/harness-client.mjs`、`src/channels/shared/workspace-session.mjs`

1. 讀 `harness-client.mjs` 的 `rpc('session.history', …)`（約 :1392、:1436）與 `readHistory`，記下回傳結構（messages 陣列？seq？role？）。
2. 讀 `createSession(...)` 的簽名：不傳 `conversationKey` 時是否會自動綁定；會不會寫入 bot state。
3. 讀 `ask`／`executeCommand('/compact')` 的回傳，確認「送出後如何取回最終文字」——是回傳值、事件，只能靠 `readHistory`。
4. 把三條結論寫進本檔末尾的「Phase 0 結論」小節，作為 Phase 2 的依據。

**驗收**：三條結論都有檔案:行號依據，沒有「應該可以」這種句子。若第 2 條結論是「會自動綁定」，Phase 2 改用「建 session 後立刻 `setSession` 前攔截」或改用 `session.prompt` 直呼，並在此記錄。

---

## Phase 1：人格庫、實時注入、清綁（無摘要）

### Task 1.1：epoch 決策純函式

**檔案**：新建 `src/channels/discord/persona-epoch.mjs`、`test/persona-epoch.test.mjs`

1. 測試先寫，定義介面：
   ```js
   planPersonaEpoch({ epoch, seenEpoch, sessionId }) // => { clearSession, enqueueHandoff, seenEpoch }
   ```
   案例：同值不動；`epoch > seen` 且有 `sessionId` → 清綁 + 排摘要；`epoch > seen` 且無 `sessionId` → 只更新 `seen`；`seenEpoch` 缺省視為 0；`epoch < seen`（回退）→ 只更新。
2. 跑 `node --test test/persona-epoch.test.mjs`，確認紅。
3. 實作到綠。

### Task 1.2：人格庫讀寫

**檔案**：新建 `src/channels/discord/persona-library.mjs`、`test/persona-library.test.mjs`

1. 測試（用 `node:fs/promises` 的 tmpdir）：
   - `createPersona(name)` 產生 `p_` + 6 位十六進位檔名，索引更新，回傳 id。
   - 不合法 id（`../x`、`p_zzzzzz`）→ 拋 `persona-invalid`，且不寫出任何檔案。
   - 超過 50 項 → 拋 `persona-limit`。
   - `deletePersona(activeId)` → 拋 `persona-active-undeletable`。
   - `resolveActiveText()`：無 activeId／檔案不存在／空白 → `''`；正常 → 套 `DISCORD_PERSONA_PROMPT`；超 `MAX_PERSONA_CHARS` → 截斷前先拋錯（save 時擋）。
   - `persona.md` 存在且無索引 → 遷移成 `p_default`、改名 `persona.md.migrated`，第二次呼叫不再遷移。
   - `index.json` 壞掉 → 視為空庫並 `logger.warn`，不拋。
2. 紅 → 實作 → 綠。

### Task 1.3：注入改為可解析

**檔案**：改 `src/channels/discord/persona.mjs`、`test/persona-injection.test.mjs`

1. 測試：`installDiscordPersona` 傳函式時，`systemPrompt.context` 的 `text` 每次呼叫都重新取值（fake `ctx` 收集註冊的 `text`，呼叫兩次、中間改變回傳值，斷言兩次結果不同）；傳字串時行為不變；非 `discord` 渠道回 `''`。
2. 紅 → 實作（`typeof text === 'function' ? text() : text`）→ 綠。

### Task 1.4：宿主接線

**檔案**：改 `plugin-src/host/index.mjs:123`、`plugin-src/host/channels/discord/index.mjs`

1. 改 `const personaText = …text()` 為解析函式：`() => library.resolveActiveText()`（`library` 由 `getDiscordPersonaStore(config)` 旁的工廠取得）。
2. 跑 `node --test test/*.test.mjs` 確認既有測試沒紅。
3. `node scripts/build-local.mjs` 能過（需 `DSH_BUILD_ESBUILD_DIR`、`DSH_BUILD_NODE_MODULES`）。

### Task 1.5：RPC 與端點

**檔案**：改 `src/channels/discord/persona-endpoints.mjs`、`plugin-src/host/persona-rpc.mjs`、`plugin-src/host/channels/shared/rpc.mjs:37`、`plugin-src/host/inbound-ttl-rpc.mjs:86`、`test/persona-rpc.test.mjs`

1. 測試：六個端點的分派與參數校驗（`list/get/create/save/delete/activate`），錯誤碼逐條；`get` 不帶 `id` 仍回舊形狀。
2. 紅 → 實作 → 綠。

### Task 1.6：bot state 記 epoch

**檔案**：改 `src/channels/shared/conversation-state-store.mjs`、`test/persona-epoch-state.test.mjs`

1. 測試：`personaEpochSeen()` 缺省 0；`setPersonaEpochSeen(n)` 後重讀一致；舊 `state.json` 沒有 `persona` 欄位時不炸。
2. 紅 → 實作 → 綠。

### Task 1.7：訊息路徑清綁

**檔案**：改 `src/channels/shared/text-harness-bridge.mjs`、`test/persona-switch-binding.test.mjs`

1. 測試（fake state + fake library）：epoch 一致時不呼叫 `clearSession`；不一致且有綁定時清綁、寫回 `seen`；不一致且無綁定只寫回。
2. 紅 → 接 `planPersonaEpoch`（Task 1.1）→ 綠。
3. 確認不影響其他渠道：`options.persona` 未提供時整段跳過。

### Task 1.8：設定卡片列表編輯

**檔案**：改 `plugin-src/client/persona-editor.js`、`plugin-src/client/bot-general-settings.js`

1. 兩欄：清單（名稱、字數、`目前` 標記、新增、刪除）+ 編輯區（名稱、正文、儲存）+ `啟用這個`。
2. 啟用後狀態列顯示 `已切換（epoch N）`。
3. 手動在 Web 設定頁載入卡片，確認沒有 console 錯誤。

### Task 1.9：整合驗證腳本

**檔案**：新建 `scripts/verify-persona-library.mjs`

照 `scripts/verify-injected-context.mjs` 的斷言風格：建臨時 `DSH_HOME` → 建兩個人生 → 切換 → 斷言 `resolveActiveText()` 變了、`planPersonaEpoch` 產生清綁、舊 `persona.md` 已遷移。

**Phase 1 完成標準**：`node --test test/*.test.mjs` 全綠、`node scripts/verify-persona-library.mjs` 通過、`npm run push` 後卡片可用。

---

## Phase 2：交接摘要（依 Phase 0 結論）

### Task 2.1：摘要提示組裝

**檔案**：新建 `src/channels/discord/persona-handoff.mjs`、`test/persona-handoff.test.mjs`

1. 測試：`buildHandoffPrompt(messages)` 在少於 4 輪時回 `null`；輸出不超過 800 字要求；包含「第三人稱」「不要自稱」「不要模仿語氣」三條硬約束；`sanitizeHandoff(text)` 截斷到 800 且去掉第一人稱開頭。
2. 紅 → 實作 → 綠。

### Task 2.2：摘要產生器（介面注入）

**檔案**：同 `persona-handoff.mjs`、`test/persona-handoff-run.test.mjs`

1. 介面：`generateHandoff({ readHistory, runIsolated, write }, { sessionId, key })`。
2. 測試（fake）：正常流程寫入 `handoffs/<key>.md`；`readHistory` 拋錯 → 回 `{ ok: false, reason }` 且不寫檔；`runIsolated` 回空字串 → 視為失敗。
3. 紅 → 實作 → 綠。

### Task 2.3：接上真實 adapter

**檔案**：改 `persona-handoff.mjs` 的 adapter 實作、`src/channels/shared/text-harness-bridge.mjs`

1. 依 Phase 0 結論實作 `readHistory` 與 `runIsolated`。
2. `runIsolated` 必須：建 session、不 `setSession`、prompt、取最終文字、失敗不拋到訊息路徑。
3. 在切換路徑呼叫 `generateHandoff`，失敗只記 warn。

### Task 2.4：摘要注入

**檔案**：改 `src/channels/discord/persona.mjs`

1. 照樣式新增 `installDiscordHandoff`：`sessionId → conversationKey` 映射、`order: 121`、`agent/disposed` 清理。
2. 測試：有 `handoffs/<key>.md` 才注入；同一 session 只讀一次；檔案不存在回 `''`。
3. 標題固定為「上一段對話的檔案（第三人稱，非本人發言）」。

### Task 2.5：狀態回饋與降級

**檔案**：改 `plugin-src/host/persona-rpc.mjs`、`plugin-src/client/persona-editor.js`

1. `list` 回傳每個 session key 的摘要狀態（`pending/ready/failed`）——若跨行程取不到，改用 `handoffs/` 檔案存在性 + `lastError` 檔。
2. 測試降級：摘要失敗時 `activate` 仍回 `ok`，卡片顯示「已切換 · 摘要失敗」。

---

## Phase 3：收尾

- 移除 `settings.discord-persona.set/get` 舊形狀（下一個版本）。
- `docs/` 增加使用說明一節，`FORK.md` 補一行指向設計文件。
- `package.json` 的 `files` 加入新 `docs/superpowers/`（若發佈需要）。

---

## 交付方式

按 Phase 1 → 2 順序寫，驗收通過後一次性交付；中間不推 `npm run push` 給使用者試。

## Phase 0 結論

（執行 Task 0.1 後填寫）
