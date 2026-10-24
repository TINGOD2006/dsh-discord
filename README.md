# dsh-discord

將 Discord 聊天與音樂播放接入 DeepSeek Harness（DSH）的外掛。

這是以 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) 為基礎的獨立分支，主要維護 Discord 的聊天回覆、上下文與音樂功能。保留上游其他渠道程式，但本分支的音樂功能與驗證集中於 Discord。

[English](README.en.md) · [音樂功能與診斷](docs/discord-music.md) · [客戶端面板接入](docs/client-integration.md)

## 功能

- **DSH 聊天**：透過 Discord 私訊或提及機器人與 DSH 對話，沿用既有工作區、Session 與存取政策。
- **群聊上下文**：需要先前記錄時才讀取，過濾狀態提示、控制指令與短時間重複訊息；摘要、歷史與附件共用每回合 3 次／6000 字元額度，支援關鍵詞及時間範圍查詢。詳見 [上下文規則](docs/context-policy.md)。
- **點歌播放**：輸入 YouTube 網址或歌曲關鍵詞，搜尋後交由獨立的 DSH 音樂 Session 選歌，再加入語音播放佇列。
- **音量處理**：完整下載後量測整首歌曲，以固定增益調整至約 −20 LUFS，峰值目標保留 3 dB 餘量；預設播放音量為 60%。
- **聊天點歌**：在聊天中明確要求播放、暫停、跳歌等操作時，DSH 可調用音樂工具；操作綁定當前發話者及頻道，沿用語音權限檢查。
- **播放穩定性**：預設目標 128 kbps 雙聲道，可選雙聲道及 320／384 kbps；FFmpeg 子程序處理音量與編碼，搭配無損快取、下一首預處理、封包緩衝及有限次語音重連。
- **公開指令回覆**：斜線指令的處理中提示與結果顯示於使用指令的頻道，有閱覽權限的成員都能看到。
- **本機診斷**：`/music status` 查看語音狀態；被動監測器輸出去除敏感內容的 JSON 報告。

## 環境需求

| 項目 | 需求 |
| --- | --- |
| Node.js | 22.19 或以上 |
| DSH | 已安裝，且 `dsh` 可由命令列執行；套件相容性宣告為 `0.2.0-rc.2`、`0.2.1-rc.2` |
| Discord | 自己建立的 Bot，以及可邀請它加入的伺服器 |
| 音訊工具 | yt-dlp、FFmpeg、ffprobe；YouTube 擷取另使用 Node.js |
| 網路 | 主機可連接 DSH 使用的模型、音訊來源與 Discord；語音需可使用 UDP |

目前的本機建置與音訊驗證在 Windows／PowerShell 進行。其他系統需自行指定可用的工具路徑，尚未完成相同環境驗收。

## 安裝此分支

倉庫已包含 `lib/index.js` 與 `lib/client.js` 建置產物。以下以 DSH Desktop 的 `desktop` profile 為例：

```powershell
git clone https://github.com/TINGOD2006/dsh-discord.git
Set-Location dsh-discord
npm install
node bin/dsh-im.mjs install --profile desktop --source .
```

使用 DSH Web 時，將 `--profile desktop` 改為 `--profile web`。安裝器會修改指定 profile 的外掛清單；請選擇實際使用的 profile。`--source .` 必須保留，因為安裝器未指定來源時仍預設指向上游專案。

安裝後重新載入 DSH 外掛或重啟對應宿主，再開啟「設定 → IM機器人」，新增 Discord Bot 並在本機填入 Bot Token。設定音訊工具後，再開始點歌。

### 音訊工具

可唯讀引用既有 AudioUsbStudio 的工具，啟動 DSH 前設定：

```powershell
$env:DSK_DISCORD_AUDIOUSB_ROOT = 'D:\AudioUsbStudio'
```

外掛會尋找該目錄下 `release/bin`、`tools/bin` 中的工具，以及 `tools/ytdlp-plugins`。不需要修改 AudioUsbStudio 的原始碼或設定；音樂快取與暫存寫入 dsh-discord 自己的目錄。

也可獨立安裝工具並指定路徑：

```powershell
$env:DSK_DISCORD_YTDLP = 'D:\MediaTools\yt-dlp.exe'
$env:DSK_DISCORD_FFMPEG = 'D:\MediaTools\ffmpeg.exe'
$env:DSK_DISCORD_FFPROBE = 'D:\MediaTools\ffprobe.exe'
$env:DSK_DISCORD_NODE = 'D:\MediaTools\node.exe'
```

未找到指定或預設位置的工具時，yt-dlp、FFmpeg、ffprobe 會嘗試由 `PATH` 尋找，Node.js 使用當前程序的執行檔。PowerShell 的 `$env:` 設定僅影響當前程序及其子程序；請從設定後的環境啟動 DSH，或在宿主的啟動環境中設定。

## Discord 設定

在 [Discord Developer Portal](https://discord.com/developers/applications) 建立應用程式與 Bot，依下列用途授權：

| 用途 | 設定或權限 |
| --- | --- |
| 邀請 Bot 與使用斜線指令 | Guild Install，`bot`、`applications.commands` scopes |
| 接收此分支的文字聊天內容 | Bot → Privileged Gateway Intents → **Message Content Intent** |
| 文字回覆與聊天紀錄 | View Channel、Send Messages、Read Message History |
| 在討論串內互動 | Send Messages in Threads；啟用建立討論串的流程時需 Create Public Threads |
| 回傳檔案 | Attach Files |
| 音樂播放 | 語音頻道的 View Channel、Connect、Speak |

語音狀態事件由程式訂閱 `GuildVoiceStates`，不是 Developer Portal 內需要另外開啟的 privileged intent。伺服器及個別頻道的權限覆寫仍會影響實際操作。

參考：[Discord 安裝與 scopes](https://github.com/discord/discord-api-docs/blob/main/developers/quick-start/getting-started.mdx)、[Gateway Intents](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx)。

## 音樂指令

先加入語音頻道，再使用 `/play`。網址或關鍵詞填入指令的 `query` 欄位。

| 指令 | 用途 |
| --- | --- |
| `/play query:歌曲關鍵詞或YouTube網址` | 搜尋或直接點歌，加入佇列 |
| `/music play query:歌曲關鍵詞或網址` | 音樂命名空間中的點歌指令 |
| `/music skip` | 跳過目前歌曲，也可取消準備中的歌曲 |
| `/music stop` | 停止音樂、取消預處理並清空佇列 |
| `/music pause`、`/music resume` | 暫停、繼續 |
| `/music queue`、`/music nowplaying` | 查看佇列、目前歌曲 |
| `/music volume percent:0–100` | 調整音量，預設 60% |
| `/music status` | 查看 UDP／WebSocket ping、碼率、緩衝及主程序延遲 |
| `/music join`、`/music leave` | 加入、離開語音頻道 |

**`/stop` 與 `/skip` 保留為 AI 任務控制；控制音樂請使用 `/music stop` 與 `/music skip`。**

音樂指令使用獨立分流，不會被 @ 對話合併或當成模型插話。同一伺服器跨文字頻道共用播放器操作佇列；停止／離開會取消較早未完成的操作。詳細規則見[指令處理順序表](docs/discord-music.md#指令處理順序與隔離)。

一般 @ 對話改為每個對話逐則先進先出，停用自動合併與自動插話；擁有者的普通訊息也按到達順序處理。音樂與 AI 控制指令仍有獨立入口。

操作播放、跳歌、停止、暫停、音量與離開時，使用者須在 Bot 所在的語音頻道；查看佇列與目前歌曲不需要加入語音。公開回覆不會改變指令的執行權限。

### 選歌與來源限制

先用 `/music channels count:2` 選雙聲道立體聲，再用 `/music bitrate kbps:320` 測試 320 kbps Opus。碼率選項為 16、32、48、64、96、128、192、256、320、384 kbps；單聲道最多 256，雙聲道最多 384，實際輸出仍受頻道設定限制。`/music channels`、`/music bitrate` 可查詢設定；`/music channels count:2` 加 `/music bitrate kbps:128` 恢復預設。設定沿用至離開語音或外掛重載，切換會短暫重建串流並保留播放位置、音量及暫停狀態。

1. YouTube 單曲網址驗證後直接處理；關鍵詞先取得最多五個真實候選。
2. DSH 在獨立音樂 Session 中選擇候選；超過十秒或結果無效時，改用已驗證的搜尋首選並提示。
3. 完整下載、檢查時長並建立 48 kHz、24-bit 雙聲道無損 FLAC 正規化快取；播放時由 FFmpeg 子程序按所選聲道與碼率輸出 Opus，再直接提交播放器。320 kbps 是實際編碼輸出，仍會經過音量處理與轉碼，不代表原檔免轉碼直通或提升原音源品質。

Bilibili BV／av 影片、au 音訊及 b23 分享連結直接使用原站音源；移除追蹤參數，保留 `p` 分 P 選擇，未指定時播放第一 P。Bilibili 解析或下載失敗會直接回報來源錯誤。其他網頁先嘗試取得標題，再到 YouTube 搜尋。另外支援主機可讀的音訊檔及可辨識的公開音訊直連。

直播、超過三十分鐘的音訊及可辨識的試聽截短內容會被拒絕。無法讀取或受限的來源可能需要改用關鍵詞。每個伺服器最多 25 首待播歌曲，音量及佇列分開管理。

## 卡頓診斷

`/music status` 提供目前連線與音訊管線狀態。語音連線、播放器與發送時鐘在獨立 worker 執行，主程序阻塞時已開始的播放仍可繼續；音量與編碼由 FFmpeg 子程序處理。開播前預備約 480 ms 的音訊內容，狀態中的「音訊預讀」代表備妥音訊量，不是實際等待或端到端延遲。音量指令會從目前位置重建串流，可能短暫停頓。語音斷線會保留歌曲並有限次重試；整機負載或外部 UDP 網路不穩仍可能造成斷續。

**UDP ping 是保活往返時間，不是接收端 RTP 丟包率。** 本機回送成功也不能證明 Discord 外部線路穩定。`music.playing` 僅表示音訊已提交播放器，實際聽感需在語音頻道確認。

被動監測：

```powershell
npm run monitor:music
```

監測器增量讀取本機 `.dsh/logs/dsh-discord.log`，游標與去重狀態寫入本專案 `.dsh-im/music-monitor/`；JSON 報告不輸出原始訊息、Token 或使用者／伺服器 ID。它不會登入 Discord、自動點歌或重啟外掛。設定 `DSK_DISCORD_MUSIC=0` 可在下次載入時停用音樂功能。

## 開發與驗證

修改原始碼後，重新建置宿主與客戶端產物，再重新載入外掛：

```powershell
$env:DSH_BUILD_ESBUILD_DIR = Join-Path (Get-Location) 'node_modules'
npm run build
npm test
```

若建置需引用其他依賴目錄，可設定 `DSH_BUILD_NODE_MODULES`，多個目錄以分號分隔。音樂與對話排序回歸測試使用 `npm run test:music`，涵蓋 Bilibili 原站路由與分 P 快取、獨立 worker 在主程序阻塞 500 ms 時持續播放、跨執行緒取消及重建、真實低碼率單聲道編碼、音量接續、指令分流、對話 FIFO、重載、快取與語音恢復；不代表所有繼承渠道均已實測。

可選的手動檢查：

```powershell
# 真正的編碼、播放器時鐘與 localhost UDP 回送；不連接 Discord
node scripts/smoke-music-transport.mjs

# 會連線 YouTube 並下載音訊；不登入 Discord，不呼叫真實 DSH 選歌
node scripts/smoke-music-audio.mjs 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
```

一般音樂快取位於 `.dsh-im/music/`，診斷產物位於 `work/`。兩者及日誌均由 `.gitignore` 排除；請勿提交 Bot Token 或其他私人設定。

## 授權與來源

本專案以 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) 為基礎，沿用 [MIT License](LICENSE)，保留原作者版權聲明。第三方套件與衍生實作的授權詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

此外掛需要 DSH 宿主才能運作；AudioUsbStudio 僅為可選的外部工具來源，並未包含於本倉庫。
