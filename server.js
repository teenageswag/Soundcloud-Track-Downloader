const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const NodeID3 = require('node-id3');

const PORT = 3333;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const FALLBACK_YTDLP = path.join(BIN_DIR, 'yt-dlp.exe');
const FALLBACK_FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe');

const WINDOWS_ILLEGAL_RE = /[\\/:*?"<>|]/g;
const clients = new Set();
const queue = [];
let isProcessing = false;

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

function resolveFromPath(command) {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(lookupCommand, [command], { encoding: 'utf8', shell: false });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const [firstMatch] = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return firstMatch || null;
}

function resolveBinary(command, fallbackPath) {
  const fromPath = resolveFromPath(command);
  if (fromPath) {
    return fromPath;
  }

  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  return null;
}

const ytDlpPath = resolveBinary('yt-dlp', FALLBACK_YTDLP);
const ffmpegPath = resolveBinary('ffmpeg', FALLBACK_FFMPEG);
const ffmpegLocation = ffmpegPath ? path.dirname(ffmpegPath) : 'auto';

if (!ytDlpPath) {
  console.error('yt-dlp was not found. Install it with "winget install yt-dlp" or place yt-dlp.exe in the bin directory.');
  process.exit(1);
}

function sanitizeBaseName(value) {
  return String(value || 'track')
    .replace(WINDOWS_ILLEGAL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '') || 'track';
}

function safeDownloadsPath(fileName) {
  const baseName = path.basename(fileName);
  const fullPath = path.join(DOWNLOAD_DIR, baseName);
  const relative = path.relative(DOWNLOAD_DIR, fullPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return fullPath;
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  const minutes = Math.floor(value / 60);
  const remaining = Math.floor(value % 60).toString().padStart(2, '0');
  return `${minutes}:${remaining}`;
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readInfoJson(infoPath) {
  try {
    return JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch {
    return {};
  }
}

function getTags(filePath) {
  try {
    return NodeID3.read(filePath) || {};
  } catch {
    return {};
  }
}

function findByBase(baseName, extension) {
  const expected = `${baseName}${extension}`.toLowerCase();
  return fs.readdirSync(DOWNLOAD_DIR).find((file) => file.toLowerCase() === expected) || null;
}

function findInfoJsonForMp3(mp3File) {
  const baseName = path.basename(mp3File, path.extname(mp3File));
  const direct = findByBase(baseName, '.info.json');
  if (direct) {
    return path.join(DOWNLOAD_DIR, direct);
  }

  return null;
}

function findArtworkForBase(baseName) {
  const extensions = ['.jpg', '.jpeg', '.png', '.webp'];
  const files = fs.readdirSync(DOWNLOAD_DIR);

  return files.find((file) => {
    const ext = path.extname(file).toLowerCase();
    return extensions.includes(ext) && path.basename(file, path.extname(file)) === baseName;
  }) || null;
}

function renameIfNeeded(currentPath, targetPath) {
  if (!fs.existsSync(currentPath) || currentPath === targetPath) {
    return targetPath;
  }

  if (fs.existsSync(targetPath)) {
    const parsed = path.parse(targetPath);
    let counter = 2;
    let candidate = targetPath;
    while (fs.existsSync(candidate)) {
      candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
      counter += 1;
    }
    fs.renameSync(currentPath, candidate);
    return candidate;
  }

  fs.renameSync(currentPath, targetPath);
  return targetPath;
}

function filesAfterDownload(beforeFiles) {
  const current = fs.readdirSync(DOWNLOAD_DIR);
  return current.filter((file) => !beforeFiles.has(file));
}

function findDownloadedMp3(createdFiles, info) {
  const mp3Files = createdFiles.filter((file) => path.extname(file).toLowerCase() === '.mp3');
  if (mp3Files.length === 1) {
    return path.join(DOWNLOAD_DIR, mp3Files[0]);
  }

  const candidateBase = sanitizeBaseName(`${info.uploader || 'Unknown'} - ${info.title || 'track'}`);
  const direct = findByBase(candidateBase, '.mp3');
  return direct ? path.join(DOWNLOAD_DIR, direct) : null;
}

function findCreatedInfoJson(createdFiles) {
  const infoFile = createdFiles.find((file) => file.toLowerCase().endsWith('.info.json'));
  return infoFile ? path.join(DOWNLOAD_DIR, infoFile) : null;
}

function findCreatedArtwork(createdFiles, baseName) {
  const artwork = createdFiles.find((file) => {
    const ext = path.extname(file).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) && path.basename(file, path.extname(file)) === baseName;
  });

  return artwork ? path.join(DOWNLOAD_DIR, artwork) : null;
}

function buildId3Tags(info, artworkPath) {
  const tags = {
    title: info.title || '',
    artist: info.uploader || '',
    album: info.uploader || '',
    comment: {
      language: 'eng',
      text: info.description || ''
    },
    genre: info.genre || '',
    performerInfo: Array.isArray(info.tags) ? info.tags.join(', ') : '',
    date: info.upload_date || '',
    length: info.duration ? String(info.duration) : '',
    userDefinedUrl: [{
      description: 'SoundCloud',
      url: info.webpage_url || ''
    }]
  };

  if (artworkPath && fs.existsSync(artworkPath)) {
    tags.image = artworkPath;
  }

  return tags;
}

function writeMetadata(mp3Path, info, artworkPath) {
  const tags = buildId3Tags(info, artworkPath);
  NodeID3.write(tags, mp3Path);
}

function truncateError(message) {
  const text = String(message || 'Download failed').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function downloadUrl(url) {
  return new Promise((resolve) => {
    const beforeFiles = new Set(fs.readdirSync(DOWNLOAD_DIR));
    const outputTemplate = path.join(DOWNLOAD_DIR, '%(uploader)s - %(title)s.%(ext)s');
    const args = [
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-thumbnail',
      '--add-metadata',
      '--write-info-json',
      '--convert-thumbnails', 'jpg',
      '--ffmpeg-location', ffmpegLocation,
      '--output', outputTemplate,
      url
    ];

    broadcast({ type: 'start', url, message: 'Starting download' });

    const child = spawn(ytDlpPath, args, { shell: false });
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        broadcast({ type: 'progress', url, message });
      }
    });

    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      stderr += `${message}\n`;
      if (message) {
        broadcast({ type: 'progress', url, message });
      }
    });

    child.on('error', (error) => {
      broadcast({ type: 'error', url, message: truncateError(error.message) });
      resolve();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        broadcast({ type: 'error', url, message: truncateError(stderr) });
        resolve();
        return;
      }

      try {
        const createdFiles = filesAfterDownload(beforeFiles);
        const initialInfoPath = findCreatedInfoJson(createdFiles);
        const initialInfo = initialInfoPath ? readInfoJson(initialInfoPath) : {};
        const mp3Path = findDownloadedMp3(createdFiles, initialInfo);

        if (!mp3Path) {
          broadcast({ type: 'error', url, message: 'Downloaded MP3 file was not found' });
          resolve();
          return;
        }

        const baseName = sanitizeBaseName(`${initialInfo.uploader || 'Unknown'} - ${initialInfo.title || path.basename(mp3Path, path.extname(mp3Path))}`);
        const finalMp3Path = renameIfNeeded(mp3Path, path.join(DOWNLOAD_DIR, `${baseName}.mp3`));
        const finalBaseName = path.basename(finalMp3Path, path.extname(finalMp3Path));

        let infoPath = initialInfoPath;
        if (infoPath) {
          infoPath = renameIfNeeded(infoPath, path.join(DOWNLOAD_DIR, `${finalBaseName}.info.json`));
        }

        let artworkPath = findCreatedArtwork(createdFiles, path.basename(mp3Path, path.extname(mp3Path)));
        if (!artworkPath) {
          const existingArtwork = findArtworkForBase(path.basename(mp3Path, path.extname(mp3Path)));
          artworkPath = existingArtwork ? path.join(DOWNLOAD_DIR, existingArtwork) : null;
        }
        if (artworkPath) {
          artworkPath = renameIfNeeded(artworkPath, path.join(DOWNLOAD_DIR, `${finalBaseName}${path.extname(artworkPath).toLowerCase()}`));
        }

        const info = infoPath ? readInfoJson(infoPath) : initialInfo;
        writeMetadata(finalMp3Path, info, artworkPath);
        broadcast({ type: 'done', url, message: path.basename(finalMp3Path) });
      } catch (error) {
        broadcast({ type: 'error', url, message: truncateError(error.message) });
      }

      resolve();
    });
  });
}

async function processQueue() {
  if (isProcessing) {
    return;
  }

  isProcessing = true;
  while (queue.length > 0) {
    const url = queue.shift();
    await downloadUrl(url);
  }
  isProcessing = false;
}

function trackFromFile(file) {
  const filePath = path.join(DOWNLOAD_DIR, file);
  const baseName = path.basename(file, path.extname(file));
  const infoPath = findInfoJsonForMp3(file);
  const info = infoPath ? readInfoJson(infoPath) : {};
  const tags = getTags(filePath);
  const artwork = findArtworkForBase(baseName);

  return {
    file,
    title: info.title || tags.title || baseName,
    uploader: info.uploader || tags.artist || '',
    description: info.description || '',
    genre: info.genre || tags.genre || '',
    tags: Array.isArray(info.tags) ? info.tags : [],
    upload_date: info.upload_date || tags.date || '',
    duration: info.duration || '',
    durationText: formatDuration(info.duration),
    webpage_url: info.webpage_url || '',
    size: getFileSize(filePath),
    artwork: artwork ? `/artwork/${encodeURIComponent(artwork)}` : ''
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

app.post('/download', (req, res) => {
  const urls = Array.isArray(req.body && req.body.urls) ? req.body.urls : [];
  const cleanUrls = urls.map((url) => String(url || '').trim()).filter(Boolean);

  if (cleanUrls.length === 0) {
    res.status(400).json({ error: 'urls must contain at least one URL' });
    return;
  }

  queue.push(...cleanUrls);
  processQueue();
  res.json({ queued: cleanUrls.length });
});

app.get('/tracks', (req, res) => {
  const tracks = fs.readdirSync(DOWNLOAD_DIR)
    .filter((file) => path.extname(file).toLowerCase() === '.mp3')
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(DOWNLOAD_DIR, a)).mtimeMs;
      const bTime = fs.statSync(path.join(DOWNLOAD_DIR, b)).mtimeMs;
      return bTime - aTime;
    })
    .map(trackFromFile);

  res.json({ tracks });
});

app.get('/artwork/:file', (req, res) => {
  const artworkPath = safeDownloadsPath(req.params.file);
  if (!artworkPath || !fs.existsSync(artworkPath)) {
    res.sendStatus(404);
    return;
  }

  res.sendFile(artworkPath);
});

app.delete('/tracks/:file', (req, res) => {
  const targetPath = safeDownloadsPath(req.params.file);
  if (!targetPath || !fs.existsSync(targetPath) || path.extname(targetPath).toLowerCase() !== '.mp3') {
    res.sendStatus(404);
    return;
  }

  const baseName = path.basename(targetPath, path.extname(targetPath));
  fs.unlinkSync(targetPath);

  for (const ext of ['.info.json', '.jpg', '.jpeg', '.png', '.webp']) {
    const relatedFile = findByBase(baseName, ext);
    if (relatedFile) {
      fs.unlinkSync(path.join(DOWNLOAD_DIR, relatedFile));
    }
  }

  res.json({ deleted: path.basename(targetPath) });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"ready","message":"Connected"}\n\n');

  clients.add(res);
  req.on('close', () => {
    clients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(`Sound downloader is running at http://localhost:${PORT}`);
});
