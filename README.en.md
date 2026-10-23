# dsh-discord

A DeepSeek Harness (DSH) plugin for Discord chat and voice music playback, forked from [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im).

[繁體中文 and full setup guide](README.md) · [Music implementation and diagnostics](docs/discord-music.md) · [Client integration](docs/client-integration.md)

## Features

- Connect Discord conversations to DSH with existing workspace, session and access policies.
- Search YouTube from song keywords, let a separate DSH music session select a verified candidate, and queue it for voice playback.
- Download the full track and apply constant loudness gain toward −20 LUFS with a −3 dB true-peak target before playback. Default player volume is 60%.
- Prefetch the next track, share normalized caches, prebuffer Opus packets, cap bitrate to the voice channel and retry temporary voice disconnections.
- Show slash-command acknowledgements and results publicly in the invoking channel. Execution permissions remain in effect.
- Inspect connection and audio supply metrics with `/music status` and a passive local monitor.

Other upstream channels remain in the codebase. This fork's music development and verification focus on Discord.

## Install

Requires Node.js 22.19+, a DSH installation with the `dsh` command available, a Discord Bot, yt-dlp, FFmpeg and ffprobe. Package metadata declares DSH `0.2.0-rc.2` and `0.2.1-rc.2` compatibility. Local validation has been performed on Windows/PowerShell.

Prebuilt host and client bundles are included:

```powershell
git clone https://github.com/TINGOD2006/dsh-discord.git
Set-Location dsh-discord
npm install
node bin/dsh-im.mjs install --profile desktop --source .
```

Use `--profile web` for DSH Web. Keep `--source .`: the installer's default source still points to upstream. The installer changes the selected profile's plugin list. Reload the plugin or restart that host, then add the Discord Bot under Settings → IM bots and enter its token locally.

Configure tools in the environment that starts DSH:

```powershell
$env:DSK_DISCORD_YTDLP = 'D:\MediaTools\yt-dlp.exe'
$env:DSK_DISCORD_FFMPEG = 'D:\MediaTools\ffmpeg.exe'
$env:DSK_DISCORD_FFPROBE = 'D:\MediaTools\ffprobe.exe'
$env:DSK_DISCORD_NODE = 'D:\MediaTools\node.exe'
```

Alternatively, `DSK_DISCORD_AUDIOUSB_ROOT` can reference an existing AudioUsbStudio installation's tools read-only. AudioUsbStudio is not bundled or modified. See the Chinese setup guide for lookup order and environment details.

## Discord setup

Install the app to a guild with `bot` and `applications.commands` scopes. Enable **Message Content Intent** for this fork's text-chat gateway. Grant View Channel, Send Messages and Read Message History; thread interaction needs Send Messages in Threads and thread creation needs Create Public Threads. File replies need Attach Files. Voice playback needs View Channel, Connect and Speak in the voice channel.

The code requests `GuildVoiceStates`; it is not a privileged-intent toggle in the Developer Portal. Channel overrides still apply. References: [Discord app installation](https://github.com/discord/discord-api-docs/blob/main/developers/quick-start/getting-started.mdx), [Gateway Intents](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx).

## Music commands

Join a voice channel first, then use `/play` with a YouTube URL or song keywords in its `query` field.

| Command | Purpose |
| --- | --- |
| `/play`, `/music play` | Find a track and add it to the queue |
| `/music skip`, `/music stop` | Skip a track, or stop and clear the queue |
| `/music pause`, `/music resume` | Pause or resume |
| `/music queue`, `/music nowplaying` | Show queued or current tracks |
| `/music volume` | Set `percent` from 0–100; default 60 |
| `/music status` | Show ping, bitrate, buffering and host delay |
| `/music join`, `/music leave` | Join or leave voice |

**`/stop` and `/skip` remain AI task controls. Use the `/music` namespace for music.** Playback controls require the caller to be in the Bot's voice channel; queue and current-track queries do not.

DSH selection has a ten-second deadline with a verified search-result fallback. Non-YouTube webpages, including Bilibili/b23 links, are used to extract a title for YouTube search; this is **not direct playback of Bilibili's original audio**. Local audio files and recognizable public audio URLs are also supported. Live streams, tracks over thirty minutes and detected preview truncations are rejected. Each guild has its own volume and up to 25 waiting tracks.

## Development and diagnostics

```powershell
$env:DSH_BUILD_ESBUILD_DIR = Join-Path (Get-Location) 'node_modules'
npm run build
npm run test:music
npm run monitor:music
```

Additional build resolution roots can be supplied with `DSH_BUILD_NODE_MODULES`, separated by semicolons. Reload the plugin after rebuilding. The latest music regression run passed **44/44 tests**; this does not certify every inherited channel.

`node scripts/smoke-music-transport.mjs` checks the real codec/player clock with localhost UDP echo without contacting Discord. The separate audio smoke script downloads from YouTube; see the full guide before running it.

UDP ping is keepalive round-trip time, not receiver-side RTP loss. Local echo success cannot establish Internet voice quality, and `music.playing` only proves that audio was submitted to the player. Actual listening still requires a voice-channel check.

Music cache and monitor state live under `.dsh-im/`; diagnostic artifacts live under `work/`. These paths and logs are ignored by Git. The passive monitor returns sanitized JSON without raw messages, tokens or user/guild IDs. It never auto-plays tracks or restarts the plugin. Set `DSK_DISCORD_MUSIC=0` before the next load to disable music.

## License

[MIT](LICENSE), retaining the upstream copyright notice. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party licenses. This plugin requires a DSH host.
