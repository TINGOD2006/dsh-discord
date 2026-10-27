# Discord 人格庫

一個 Discord bot 可以保存多份人格，隨時切換；切換不會讓 bot 忘記上一段對話。

## 怎麼用

1. DSH 設定頁 → Discord → 「目前人格」那一列 → 點開。
2. 左欄是清單：新增、選取、刪除（使用中的那份不能刪）。
3. 右欄編輯名稱與人格文本（上限 8000 字），`保存` 寫入庫，`切換到這個人` 讓它生效。
4. 生效時間是**下一則訊息**，不是按下按鈕的瞬間。

## 切換之後發生什麼

1. 舊的 Discord 會話被解除綁定（同一個群、同一個討論串、同一個 bot）。
2. 舊會話的最後一段內容被摘要成第三人稱的「上一段對話的檔案」，存到
   `<DSH_HOME>/integrations/dsh-discord/handoffs/<key>.md`。
3. 新的人格從一條新訊息開始回答，並在人格段之後讀到那份摘要——它知道剛才聊過什麼，
   但不會模仿上一個人格的語氣。

摘要失敗（歷史讀不到、模型沒回話、寫檔失敗）只是少一份摘要，切換照樣成功、回覆照樣正常。

## 檔案在哪

| 路徑 | 內容 |
| --- | --- |
| `<DSH_HOME>/integrations/dsh-discord/personas/index.json` | 清單（id、名稱、字數、更新時間） |
| `<DSH_HOME>/integrations/dsh-discord/personas/active.json` | 使用中的 id 與 epoch |
| `<DSH_HOME>/integrations/dsh-discord/personas/<id>.md` | 人格正文 |
| `<DSH_HOME>/integrations/dsh-discord/handoffs/<key>.md` | 交接摘要（`group-123.md` 這種檔名） |

`persona.md`（舊版單人格）在第一次開啟時自動遷移成 `p_default`，原檔改名 `persona.md.migrated`。

## 驗證

```powershell
node scripts/verify-persona-library.mjs
```

在暫存目錄裡跑一次完整生命週期（新增／保存／切換／刪除／遷移／上限），全部 PASS 才算過；
它不碰真的 `DSH_HOME`。

## 已知限制

- 摘要狀態不做即時回報：切換當下一定還在「待生成」。
- 生成摘要用的隔離會話會留在工作區會話清單裡（標題「[人格交接] 临时」），本 fork 沒有刪除會話的 RPC。
- 舊的 `settings.discord-persona.get/set` 端點仍在（`get` 不帶 id 時回舊形狀），留給舊客戶端。
