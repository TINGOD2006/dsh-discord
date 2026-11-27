# 音樂播放卡片與網頁控制台

Discord 訊息本身沒有滑桿元件，所以「可拖動」的那一半放在本機網頁裡：卡片負責顯示與幾顆常用按鈕，拖動時間軸用卡片上的「網頁控制（可拖動）」按鈕開。

## 卡片長什麼樣

```
┌ 8個心靈成長與自我療癒法則（標題，連到歌曲網址）
│ 來自 youtube.com
│
│ 循環：關閉 · 音源：YouTube
│
│ `00:04` ━━━●────────── `10:40`
│ Deepseekv4.1 · 由 TINGOD 點播
└ [🔁 循環：關閉] [⏮ 上一首] [⏸ 暫停] [⏭ 下一首] [📋 播放佇列]
  [🔄 更新] [✖ 移除] [🔗 網頁控制]
```

- 標題是歌名本身，不再加 `🎵` 前綴；有 http(s) 來源網址時，標題本身就是連結。
- `來自 <網域>` 是歌曲頁面的網域（去掉 `www.`）。沒有網址的本機檔案或搜尋結果改顯示「音源」的標籤。
- 第二行是播放器**實際**持有的狀態：循環模式、音源、是否為未正規化的串流、佇列長度。
- 進度條不是裝飾：卡片每次刷新都用播放器回報的位置重畫，和拖動控制台用的是同一個數字。
  Discord 沒有原生滑桿，也沒有彩色內文，所以這一行是用字元畫的——`━` 已播放、`─` 未播放、`●` 是現在位置。
  左右兩個時間用行內程式碼包住，是為了讓它們寬度固定，指針才不會隨秒數跳動左右滑。
- 右側縮圖取自 YouTube 影片 ID，不需要額外請求；其他音源要自己帶 `thumbnail`，且只收 https。
- 頁尾是「機器人名稱 · 由 誰 點播」。

## 行為

- 有人點歌、歌曲開始播放時，bot 在該文字頻道貼一張卡片（embed）。
- 卡片按鈕：循環（關閉→單曲→全部）、上一首、暫停／繼續、下一首、播放佇列（只有按的人看得到）、更新、移除，以及網頁控制（只有控制台啟動後才有）。
- 暫停／繼續、下一首、上一首、循環要求按的人**自己也在 bot 所在的語音頻道**，規則和 `/music` 指令一致；不在頻道裡的人按了只會收到一則只有自己看得到的提示，不會影響播放。卡片貼在文字頻道，能看到卡片的人不一定在聽，先前任何讀者都能停掉音樂。
  - 判定由音樂 worker 自己的 discord.js client 快取回答（`guild.voiceStates.cache.get(userId).channelId`），和斜線指令同一個來源。**不要從 interaction 封包讀**：`INTERACTION_CREATE.member` 是 `APIGuildMember`，只有 `deaf`／`mute`，沒有 `voice.channel_id`，讀了永遠是 `undefined`（2026-11-07 就是這樣讓每一顆按鈕都被拒）。
  - 拒絕原因記在日誌的 `rule` 欄位（`not-in-voice`／`other-channel`），不是 `reason`——日誌管線會把 `reason` 欄位脫敏。
- 「移除」會停止播放並清空佇列，再刪卡片：暫停中的歌會讓 room 一直活著，之後每個 `/play` 都排在它後面。
- 播放狀態變化時卡片自動更新；播放中每 2.5 秒刷新一次時間軸；卡片被手動刪掉後，下一次狀態變化會重新貼一張。
- 播放停止或離開語音後，卡片停在「目前沒有播放中的歌曲」，不再刷新。

## 循環與上一首

- 循環模式由播放器持有（`room.loop`），卡片只是把它顯示出來，不再寫死。
- `單曲`：一首歌播完後把同一首歌重新排到佇列最前面，而不是換下一首。
- `全部`：播完的歌排到佇列尾端，佇列因此不會停。
- `上一首` 走的是**真的播過**的曲目（最多 25 首），跳過的歌也算；被中斷的那首會回到佇列最前面，所以按「下一首」可以反悔。
- 歌曲還在準備中時不給「上一首」：那首已經佔住佇列頭，重排會讓它被播兩次。

## 網頁控制台（可拖動）


- 第一次播放時啟動，預設綁 `127.0.0.1`、由作業系統配發埠，網址寫進卡片的 Link 按鈕。
- 網址含每次啟動重抽的 token（`/music/<token>/<guildId>/`），只在本機可達；頁面不含任何憑證，只能操作播放。
- 頁面 1 秒輪詢一次狀態；拖動時只更新畫面，放開才送出 `POST …/seek`（最小間隔 300ms）。
- seek 的做法是停掉目前的 FFmpeg、用 `-ss <秒>` 從新位置重開音訊；實測精度 <0.01 秒，代價是約 0.5–1 秒的換軌空檔。與目前位置差距小於 1.5 秒時直接視為「已經在那裡」，不重建。
- 手機在同一個 Wi-Fi 也打不開 `127.0.0.1`；要在手機上用，得把控制台綁到區網位址（尚未開放設定）。

## 開關

- `DSK_DISCORD_MUSIC_PANEL=0`：完全不貼卡片（文字與斜線音樂指令照常）。
- `DSK_DISCORD_MUSIC=0`：整個音樂功能關閉（原有行為）。

## 實作位置

- `src/channels/discord/music-panel.mjs`：純函式渲染（時間格式、進度條、按鈕與 `custom_id`）。
- `src/channels/discord/music-panel-manager.mjs`：卡片生命週期與刷新節流、404 重貼。
- `src/channels/discord/music-control-server.mjs`：`node:http` 控制台與單頁 HTML。
- `src/channels/discord/music.mjs`：`snapshot()`、`seek()`、`control()`；seek 重用 `#replacePlayback` 的 `offsetSeconds`。
- `src/channels/discord/music-worker.mjs` / `music-worker-server.mjs`：worker 透過 `playback` 事件通知主行程，新增 `snapshot` / `control` 兩個 RPC。
- `src/channels/discord/discord-runtime.mjs`：互動路由（`type 3` 且 `custom_id` 以 `music:` 開頭）、卡片同步、控制台啟動與關閉。

## 驗證

- `node --test test/music-panel.test.mjs test/music-panel-manager.test.mjs test/music-control-server.test.mjs`
- 全套：`node --test test/*.test.mjs`
- 建置：`node scripts/build-local.mjs`（`DSH_BUILD_ESBUILD_DIR`、`DSH_BUILD_NODE_MODULES` 指到專案 `node_modules`）
