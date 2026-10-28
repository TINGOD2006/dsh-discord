# 音樂播放卡片與網頁控制台

Discord 訊息本身沒有滑桿元件，所以「可拖動」的那一半放在本機網頁裡：卡片負責顯示與幾顆常用按鈕，拖動時間軸用卡片上的「網頁控制（可拖動）」按鈕開。

## 行為

- 有人點歌、歌曲開始播放時，bot 在該文字頻道貼一張卡片（embed）：曲名、時間軸、播放狀態、佇列數量。
- 卡片按鈕（`music:<action>:<guildId>`）：暫停／繼續、下一首、佇列（只有按的人看得到）、刷新、移除。
- 「移除」只刪卡片，不會停止播放。
- 播放狀態變化時卡片自動更新；播放中每 2.5 秒刷新一次時間軸；卡片被手動刪掉後，下一次狀態變化會重新貼一張。
- 播放停止或離開語音後，卡片停在「目前沒有播放中的歌曲」，不再刷新。

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
