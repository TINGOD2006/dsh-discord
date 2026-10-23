# Discord 音樂 Bot

音樂功能屬於 `dsh-discord`。AudioUsbStudio 只提供唯讀的 yt-dlp、Node、FFmpeg、ffprobe 等工具引用，原始碼、設定、二進位檔均不修改，也不在該專案中寫入暫存或 Python bytecode。

## 使用

先加入 Discord 語音頻道，再使用：

| 指令 | 用途 |
|---|---|
| `/play query:網址或關鍵詞` | 點歌並加入佇列 |
| `/music play query:網址或關鍵詞` | 相同功能的音樂命名空間版本 |
| `/music skip` | 跳過目前歌曲，包括還在下載或音量處理的歌曲 |
| `/music stop` | 停止音樂、取消預處理、清空佇列 |
| `/music pause`、`/music resume` | 暫停／繼續 |
| `/music queue`、`/music nowplaying` | 查看佇列／目前歌曲 |
| `/music volume percent:0–100` | 調整播放音量；100 為正規化後的基準音量 |
| `/music join`、`/music leave` | 加入／離開語音頻道 |

原本的 `/stop`、`/skip` 完整保留為 AI 任務控制，不攔截、不改名。原有 `/join`、`/next`、`/pause`、`/resume`、`/queue`、`/leave` 音樂別名仍可用。原本聊天與 AI Session 綁定方式保持不變。

操作播放、跳歌、停止、暫停、音量與離開時，使用者須在機器人目前所在的語音頻道。查詢佇列與目前歌曲不需要加入語音。機器人需要 Connect、Speak、文字回覆及應用程式指令權限。

## 選歌與播放

- YouTube 單曲網址經主機名及影片 ID 驗證後直接使用。
- 關鍵詞先取得最多五個真實 YouTube 候選，再交由 DSH 選擇最符合的版本。其他網頁會先嘗試取得曲名，再走同一個搜尋及 DSH 流程。
- DSH 只接受候選清單中的影片 ID，不能回傳任意執行命令或自行捏造下載網址。選歌使用獨立 Session；停止音樂只取消音樂工作，不操作聊天的 AI 任務。
- 音樂選歌 Session 的工作目錄固定在本專案 `.dsh-im/music/dsh-workspace`。生產環境的 bot-scoped `createSession()` 會強制套用聊天工作區，因此此功能使用既有公開 `session.create` RPC 的 `cwd` 模式建立獨立工作區。沒有更動共用的聊天工作區邏輯。
- DSH 選歌逾時為十秒；無效結果或服務暫時不可用時，改用已驗證的搜尋首選，並在播放通知中說明。每個 Session 最多選歌八次，避免累積很長的提示歷史。
- 先完整下載，再以 FFmpeg 雙遍 `loudnorm` 處理至約 −16 LUFS，最後輸出 48 kHz、雙聲道 Opus。只有處理完成的本機音訊會送往 Discord。
- 網站僅回傳試聽或截短音訊時，會比較音訊時長並拒絕播放。直播與超過三十分鐘的音訊會回報限制。
- 支援既有本機音訊檔及公開音訊直連；同樣先處理音量。一般網頁不會直接當成音訊傳給播放器；受限、無法辨識或會重新導向的網頁可能需要改用歌曲關鍵詞。

## 效能與穩定性

- 每個 Discord 伺服器各自管理播放器、音量及最多 25 首待播歌曲。
- 預處理下一首；相同歌曲共用處理工作與正規化音訊，快取不會重複下載或轉檔。
- 正規化快取最多 64 首、512 MB、保留一天；正在使用的檔案不會被回收。檔案放在 `.dsh-im/music/`。
- 同時最多兩個下載／正規化工作。網路操作、子程序、DSH 選歌及語音 Ready 等待都有期限。
- 跳歌、停止、離開會取消相應工作；若另一個伺服器也在使用同一處理工作，單一使用者的取消不會中斷其他使用者。
- 語音斷線會嘗試恢復；失敗時清除佇列並通知。沒有待播歌曲三分鐘後自動離開。
- 使用套件原有的 `@discordjs/voice`、DAVE 與 Opus 支援；沒有新增外部 AI 服務或複製 API 金鑰／Discord Token。

## 工具位置

預設讀取 `C:/Users/TINGOD/Desktop/CodeHome/AudioUsbStudio/release/bin` 或 `tools/bin`。搬移專案後可在啟動 DSH 前設定：

```powershell
$env:DSK_DISCORD_AUDIOUSB_ROOT = 'D:\AudioUsbStudio'
```

亦可個別指定 `DSK_DISCORD_YTDLP`、`DSK_DISCORD_FFMPEG`、`DSK_DISCORD_FFPROBE`、`DSK_DISCORD_NODE`。`DSK_DISCORD_MUSIC=0` 沿用既有停用音樂功能的開關。

## 驗證與載入

```powershell
npm run test:music
node scripts/smoke-music-audio.mjs 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
```

手動音訊檢查會實際下載、處理、量測音量，並產生 Discord 可用的 Opus 封包；不會登入 Discord、不會發送訊息，也不會呼叫真正的 DSH 模型。DSH 選歌及語音狀態測試使用可控的測試介面，不能代替真實伺服器中的語音驗收。

本機外掛已透過 `scripts/build-local.mjs` 重建 `lib/index.js`、`lib/client.js`。既有 DSH 程序仍持有舊模組時，請重新載入此外掛或重新啟動 DSH；Discord READY 流程會沿用原機制註冊指令，不會另外建立重複的全域指令。實際伺服器中應再驗證 `/play`、`/music skip`、`/music stop`，並確認原 `/skip`、`/stop` 仍控制 AI。

參考：[FFmpeg loudnorm](https://ffmpeg.org/ffmpeg-filters.html#loudnorm)、[discord.js voice](https://discord.js.org/docs/packages/voice/0.19.2)、[yt-dlp](https://github.com/yt-dlp/yt-dlp)。

## 本機驗證紀錄（2026-10-24）

### 被動監測

`npm run monitor:music` 會增量讀取本機 `.dsh/logs/dsh-discord.log`，在本專案 `.dsh-im/music-monitor/` 儲存游標及已回報事件。輸出僅含時間、事件分類、計數及驗證狀態，不輸出原始訊息、網址、Token 或使用者／伺服器 ID。重複檢查沒有新事件時不產生通知。

監測涵蓋指令同步、實際指令處理、DSH 選歌是否進入播放流程、音訊提交播放器，以及下載、音量處理、語音／Gateway 錯誤。`music.playing` 日誌代表音訊已交給播放器，不能單獨證明語音頻道中的使用者已經聽見音樂。監測不登入 Discord、不發送訊息，也不改動運行中的外掛或 AudioUsbStudio。

- 音樂測試 **19/19 通過**，含真正的 Discord 橋接分流、獨立選歌 Session、下載中跳歌／停止、預處理取消、語音 Ready 失敗、舊播放器事件、快取共用與音量處理。
- 兩個不同原始音量的測試訊號，轉換後均接近 −16 LUFS，彼此音量差小於 0.3 LU。
- 真實 YouTube `jNQXAC9IVRw` 完整下載及音量處理通過：19.1065 秒、−15.74 LUFS、950 個可解碼及重編碼的 Discord Opus 封包。首次音訊檢查約 4.6 秒；這是單次本機量測，不是延遲保證。
- 關鍵詞搜尋能取得該影片，並重用已正規化音訊；此線上測試的候選選擇介面使用固定測試回覆，沒有冒稱呼叫真正的 DSH 模型。
- AudioUsbStudio 的 Git 狀態、既有未提交差異與唯讀引用工具 SHA-256 均和實作前快照相同。原 AI `control-command.mjs` 沒有改動。
- `lib/index.js`、`lib/client.js` 已重建。真正的 DSH 模型選歌、Discord 指令同步及語音頻道播音仍須在重新載入外掛後驗收；本次沒有讀取或輸出 Token，也沒有自動向真實頻道發送測試訊息。
