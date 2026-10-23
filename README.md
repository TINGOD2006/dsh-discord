# dsh-discord

將 Discord 聊天與音樂播放接入 DeepSeek Harness（DSH）的外掛。

這是以 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) 為基礎的獨立分支，主要維護 Discord 的聊天回覆、上下文與音樂功能。保留上游其他渠道程式，但本分支的音樂功能與驗證集中於 Discord。

[English](README.en.md) · [音樂功能與診斷](docs/discord-music.md) · [客戶端面板接入](docs/client-integration.md)

## 功能

- **DSH 聊天**：透過 Discord 私訊或提及機器人與 DSH 對話，沿用既有工作區、Session 與存取政策。
- **群聊上下文**：提供近期聊天摘要及回看指令；管理指令的執行權限由存取政策控制。
- **點歌播放**：輸入 YouTube 網址或歌曲關鍵詞，搜尋後交由獨立的 DSH 音樂 Session 選歌，再加入語音播放佇列。
- **音量處理**：完整下載後量測整首歌曲，以固定增益調整至約 −20 LUFS，峰值目標保留 3 dB 餘量；預設播放音量為 60%。
- **播放穩定性**：預處理下一首、共用音訊快取、開播前封包緩衝、依頻道上限調整碼率，以及有限次數的語音重連。
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

操作播放、跳歌、停止、暫停、音量與離開時，使用者須在 Bot 所在的語音頻道；查看佇列與目前歌曲不需要加入語音。公開回覆不會改變指令的執行權限。

### 選歌與來源限制

1. YouTube 單曲網址驗證後直接處理；關鍵詞先取得最多五個真實候選。
2. DSH 在獨立音樂 Session 中選擇候選；超過十秒或結果無效時，改用已驗證的搜尋首選並提示。
3. 完整下載、檢查時長、處理音量，輸出 48 kHz 雙聲道 Opus 後才提交播放器。

其他網頁（包括 Bilibili／b23 連結）目前先嘗試取得標題，再到 YouTube 搜尋。**這不是 Bilibili 原站音源直接播放功能。** 另外支援主機可讀的音訊檔及可辨識的公開音訊直連。

直播、超過三十分鐘的音訊及可辨識的試聽截短內容會被拒絕。無法讀取或受限的來源可能需要改用關鍵詞。每個伺服器最多 25 首待播歌曲，音量及佇列分開管理。

## 卡頓診斷

`/music status` 提供目前連線與音訊管線狀態。開播前約 240 ms 的緩衝可吸收短暫來源抖動；語音連線暫時中斷時會保留歌曲並有限次重試。主程序長時間阻塞或外部 UDP 網路不穩仍可能造成斷續。

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
npm run test:music
```

若建置需引用其他依賴目錄，可設定 `DSH_BUILD_NODE_MODULES`，多個目錄以分號分隔。最近一次音樂回歸測試為 **44/44 通過**，涵蓋公開回覆、AI／音樂指令分流、音量處理、取消、快取、語音恢復及監測分類；不代表所有繼承渠道均已實測。

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
