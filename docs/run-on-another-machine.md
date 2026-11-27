# 在另一台電腦上執行

這份文件說明如何把這個分支裝到第二台電腦（或新機器）並跑起來。只涵蓋「讓它動」的必要步驟；音樂功能的細節見[音樂功能與診斷](discord-music.md)。

## 先決條件

| 項目 | 需求 | 怎麼確認 |
| --- | --- | --- |
| Node.js | 22.19 或以上 | `node --version` |
| DSH | 已安裝，`dsh` 可由命令列執行 | `dsh --version` |
| DSH 版本 | 外掛宣告相容 `0.2.0-rc.2`、`0.2.1-rc.2` | `package.json` 的 `dsh.compatibility` |
| Discord | 自己建立的 Bot，以及可邀請它的伺服器 | [Discord Developer Portal](https://discord.com/developers/applications) |
| 音訊工具 | yt-dlp、FFmpeg、ffprobe | 見下方「音訊工具」 |
| 網路 | 可連 DSH 使用的模型、音訊來源與 Discord；語音需可使用 UDP | — |

目前的本機建置與音訊驗證在 Windows／PowerShell 完成。Linux／macOS 沒有做過同樣的驗收，需要自行指定工具路徑。

## 步驟

### 1. 取得程式碼

```powershell
git clone https://github.com/TINGOD2006/dsh-discord.git
Set-Location dsh-discord
npm install
```

`lib/index.js`、`lib/client.js` 是建置產物，已包含在倉庫裡，所以這一步不需要建置工具鏈。

### 2. 安裝到 DSH profile

```powershell
node bin/dsh-im.mjs install --profile desktop --source .
```

- `--profile` 填實際使用的 profile：DSH Desktop 是 `desktop`，DSH Web 是 `web`。
- `--source .` 不能省略。安裝器沒指定來源時會預設指向上游 `github:xmanrui/dsh-im`。
- 這一步實際執行 `dsh plugin --profile <profile> add --save-exact <路徑>`，在 profile 的 `package.json` 留下 `link:` 依賴，指向你 clone 的資料夾。外掛跑的就是這個資料夾，之後 `git pull` 就等於更新外掛。

### 3. 重啟 DSH

安裝器只改 profile 的外掛清單，不會熱載入。關掉 DSH 再開，或重新載入外掛。

### 4. 填入 Bot Token

DSH → 設定 → IM機器人 → 新增 Discord Bot，貼上 Bot Token。

Token 存在 DSH 的憑證存放區（`~/.dsh/.credentials.yaml`），不在這個倉庫裡，也不會跟著 clone 過去。**另一台電腦要重新填一次。**

### 5. 音訊工具

可唯讀引用既有的 AudioUsbStudio，啟動 DSH 前設定：

```powershell
$env:DSK_DISCORD_AUDIOUSB_ROOT = 'D:\AudioUsbStudio'
```

外掛會尋找該目錄下 `release/bin`、`tools/bin` 中的工具，以及 `tools/ytdlp-plugins`。

也可獨立安裝工具並指定路徑：

```powershell
$env:DSK_DISCORD_YTDLP = 'D:\MediaTools\yt-dlp.exe'
$env:DSK_DISCORD_FFMPEG = 'D:\MediaTools\ffmpeg.exe'
$env:DSK_DISCORD_FFPROBE = 'D:\MediaTools\ffprobe.exe'
$env:DSK_DISCORD_NODE = 'D:\MediaTools\node.exe'
```

未找到指定或預設位置時，yt-dlp、FFmpeg、ffprobe 會嘗試由 `PATH` 尋找，Node.js 使用當前程序的執行檔。`$env:` 只影響當前程序及其子程序，所以要從設定後的環境啟動 DSH。

### 用 USB 帶工具過去

另一台機器不能上網、或不想裝套件時，把三個執行檔複製到外掛目錄下的 `.dsh-im/tools/`：

```
dsh-discord\
  .dsh-im\
    tools\
      ffmpeg.exe
      ffprobe.exe
      yt-dlp.exe
```

外掛會優先使用這個目錄，不需要設 `DSK_DISCORD_FFMPEG` 等環境變數。`.dsh-im/` 在 `.gitignore` 裡，所以這些二進位不會被提交；環境變數仍然優先於這個目錄。複製後重啟 DSH 即可。

### 6. 驗證

在伺服器頻道依序確認：

1. `/status`：Bot 已連線、版本正確。
2. `/music status`：語音狀態與音訊管線。
3. 加入語音頻道後 `/play query:測試`：能搜尋、選歌、開播。

## 不會跟著搬過去的東西

| 項目 | 位置 | 新機器怎麼處理 |
| --- | --- | --- |
| Bot Token、憑證 | `~/.dsh/.credentials.yaml` | 重新在設定頁填入 |
| 對話綁定、Session 對應、自動回覆設定 | 外掛目錄下 `.dsh-im/` | 從空白開始；舊機器的狀態不會同步 |
| 音樂快取 | 外掛目錄下 `.dsh-im/music/` | 重新下載；快取本來就會重建 |
| 監測游標 | 外掛目錄下 `.dsh-im/music-monitor/` | 重新開始 |
| 環境變數 | 啟動 DSH 的 shell | 在新機器重設 |
| 斜線指令註冊 | Discord 應用程式 | 跟著 Bot 走，不用重做 |
| 已加入的伺服器 | Discord | 同一個 Bot 不用重加；新 Bot 要重新邀請 |

`.dsh-im/`、`work/`、日誌都在 `.gitignore` 裡，本來就不會進倉庫。

## 同一個 Bot Token 不要兩台同時跑

Discord 的 Gateway 對同一個 token 只維持一條 session。第二台連上時，第一台會收到關閉碼並斷線，兩台會互相搶線，看起來像「隨機掉線」。

要兩台同時跑，就在 Developer Portal 建第二個 Bot（第二個 token），各自邀請進伺服器。兩台各自有自己的 `.dsh-im/` 狀態，互不影響。

## 平台差異

- 目前只在 Windows／PowerShell 驗證。Linux／macOS 需要自行指定工具路徑，且沒有做過相同環境的音訊驗收。
- 語音播放需要 UDP 對外。公司或校園網路封 UDP 時，`/music status` 會顯示連線異常，換網路或換語音區域再試。
- 路徑含空白時，環境變數值要用引號包起來。

## 常見問題

| 症狀 | 原因與處理 |
| --- | --- |
| `找不到 dsh` | DSH 沒裝，或 `dsh` 不在 PATH。安裝後重開終端。 |
| 設定頁沒有 IM機器人 | profile 選錯，或安裝後沒重啟 DSH。 |
| Bot 上線但不回話 | Developer Portal 的 Message Content Intent 沒開。 |
| `/play` 說找不到工具 | 音訊工具路徑沒設，也不在 PATH。 |
| 語音連上但沒聲音 | 檢查 View Channel／Connect／Speak 權限、UDP 是否被封、碼率是否超過頻道。 |
| 點播抓不到要的歌 | 改寫詞要通過 YouTube 前三名標題佐證才採用；Harness 沒設定網頁搜尋後端時只有模型記憶可用（設定 → 網頁搜尋與擷取可補上佐證來源）。 |
| 年齡限制影片下載失敗 | 需要已驗證帳號匯出的 `cookies.txt`，路徑設到 `DSK_DISCORD_YTDLP_COOKIES`。 |

## 改過程式碼才需要建置

```powershell
$env:DSH_BUILD_ESBUILD_DIR = Join-Path (Get-Location) 'node_modules'
npm run build
npm test
```

若建置需引用其他依賴目錄，可設定 `DSH_BUILD_NODE_MODULES`，多個目錄以分號分隔。只安裝、不改程式碼時不需要這一步。
