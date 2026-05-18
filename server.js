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
const MAX_CONCURRENT_DOWNLOADS = 3;
const clients = new Set();
const jobs = new Map();
const pendingQueue = [];
let activeCount = 0;
let nextJobId = 1;

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
  const payload = `data: ${JSON.stringify({ ...event, summary: getJobSummary() })}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return raw.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function getJobSummary() {
  const summary = {
    total: jobs.size,
    done: 0,
    error: 0,
    pending: 0,
    downloading: 0,
    skipped: 0
  };

  for (const job of jobs.values()) {
    if (Object.prototype.hasOwnProperty.call(summary, job.status)) {
      summary[job.status] += 1;
    }
  }

  return summary;
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    normalizedUrl: job.normalizedUrl,
    status: job.status,
    message: job.message,
    file: job.file,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function getJobsPayload() {
  return {
    jobs: Array.from(jobs.values()).map(publicJob),
    summary: getJobSummary()
  };
}

function setJobStatus(job, status, message, file) {
  job.status = status;
  job.message = message || '';
  if (file) {
    job.file = file;
  }
  job.updatedAt = new Date().toISOString();

  broadcast({ type: status, jobId: job.id, ...publicJob(job) });
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

function findExistingDownloadByUrl(normalizedUrl) {
  const files = fs.readdirSync(DOWNLOAD_DIR);

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.info.json')) {
      continue;
    }

    const infoPath = path.join(DOWNLOAD_DIR, file);
    const info = readInfoJson(infoPath);
    if (normalizeUrl(info.webpage_url) !== normalizedUrl) {
      continue;
    }

    const baseName = file.slice(0, -'.info.json'.length);
    const mp3File = findByBase(baseName, '.mp3');
    if (mp3File) {
      return {
        file: mp3File,
        infoPath,
        mp3Path: path.join(DOWNLOAD_DIR, mp3File)
      };
    }
  }

  return null;
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

function downloadUrl(job) {
  return new Promise((resolve) => {
    const { url } = job;
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

    setJobStatus(job, 'downloading', 'Starting download');

    const child = spawn(ytDlpPath, args, { shell: false });
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        setJobStatus(job, 'downloading', message);
      }
    });

    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      stderr += `${message}\n`;
      if (message) {
        setJobStatus(job, 'downloading', message);
      }
    });

    child.on('error', (error) => {
      setJobStatus(job, 'error', truncateError(error.message));
      resolve();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        setJobStatus(job, 'error', truncateError(stderr));
        resolve();
        return;
      }

      try {
        const createdFiles = filesAfterDownload(beforeFiles);
        const existing = findExistingDownloadByUrl(job.normalizedUrl);
        const initialInfoPath = existing ? existing.infoPath : findCreatedInfoJson(createdFiles);
        const initialInfo = initialInfoPath ? readInfoJson(initialInfoPath) : {};
        const mp3Path = existing ? existing.mp3Path : findDownloadedMp3(createdFiles, initialInfo);

        if (!mp3Path) {
          setJobStatus(job, 'error', 'Downloaded MP3 file was not found');
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
        setJobStatus(job, 'done', path.basename(finalMp3Path), path.basename(finalMp3Path));
      } catch (error) {
        setJobStatus(job, 'error', truncateError(error.message));
      }

      resolve();
    });
  });
}

function runNextJobs() {
  while (activeCount < MAX_CONCURRENT_DOWNLOADS && pendingQueue.length > 0) {
    const job = pendingQueue.shift();
    activeCount += 1;

    downloadUrl(job)
      .catch((error) => {
        setJobStatus(job, 'error', truncateError(error.message));
      })
      .finally(() => {
        activeCount -= 1;
        runNextJobs();
      });
  }
}

function createJob(url, normalizedUrl, status, message, file) {
  const now = new Date().toISOString();
  const job = {
    id: String(nextJobId),
    url,
    normalizedUrl,
    status,
    message: message || '',
    file: file || '',
    createdAt: now,
    updatedAt: now
  };

  nextJobId += 1;
  jobs.set(job.id, job);
  return job;
}

function findActiveOrPendingJob(normalizedUrl) {
  return Array.from(jobs.values()).find((job) => (
    job.normalizedUrl === normalizedUrl &&
    (job.status === 'pending' || job.status === 'downloading')
  )) || null;
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

  const seen = new Set();
  const responseJobs = [];
  let queued = 0;
  let skipped = 0;
  let duplicates = 0;

  for (const url of cleanUrls) {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      duplicates += 1;
      continue;
    }

    seen.add(normalizedUrl);

    const runningJob = findActiveOrPendingJob(normalizedUrl);
    if (runningJob) {
      duplicates += 1;
      responseJobs.push(publicJob(runningJob));
      continue;
    }

    const existingDownload = findExistingDownloadByUrl(normalizedUrl);
    if (existingDownload) {
      const job = createJob(url, normalizedUrl, 'skipped', existingDownload.file, existingDownload.file);
      skipped += 1;
      responseJobs.push(publicJob(job));
      broadcast({ type: 'skipped', jobId: job.id, ...publicJob(job) });
      continue;
    }

    const job = createJob(url, normalizedUrl, 'pending', 'Waiting');
    pendingQueue.push(job);
    queued += 1;
    responseJobs.push(publicJob(job));
    broadcast({ type: 'pending', jobId: job.id, ...publicJob(job) });
  }

  runNextJobs();
  res.json({ queued, skipped, duplicates, jobs: responseJobs });
});

app.get('/jobs', (req, res) => {
  res.json(getJobsPayload());
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
  res.write(`data: ${JSON.stringify({ type: 'snapshot', ...getJobsPayload() })}\n\n`);

  clients.add(res);
  req.on('close', () => {
    clients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(`Sound downloader is running at http://localhost:${PORT}`);
});
