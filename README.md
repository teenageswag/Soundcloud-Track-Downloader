# Sound Downloader

Local Windows SoundCloud track downloader. It runs as a Node.js Express server and serves a small web UI at `http://localhost:3333`.

## Prerequisites

- Node.js 18+ from `nodejs.org`
- `yt-dlp`
  - Put `yt-dlp.exe` in the `bin` directory, or
  - Install with `winget install yt-dlp`
- `ffmpeg`
  - Put `ffmpeg.exe` and `ffprobe.exe` in the `bin` directory, or
  - Install with `winget install ffmpeg`

The server checks `PATH` first, then falls back to the local `bin` directory.

## Setup

```powershell
npm install
node server.js
```

Open:

```text
http://localhost:3333
```

Paste SoundCloud URLs, one per line, and click Download. MP3 files and matching `.info.json` metadata files are saved in the `downloads` directory.

# TODO

- [ ] Добавь проверку на повтор ссылки
- [ ] Добавь возможность скачивать треки параллельно, чтобы увеличить скорость загрузки
