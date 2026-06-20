process.env.PATH = `${process.env.PATH}:/usr/local/bin:/home/render/.local/bin`;

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import 'dotenv/config';

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// COOKIES_PATH must come AFTER __dirname is defined
const COOKIES_PATH = process.env.COOKIES_PATH || path.join(__dirname, 'cookies.txt');

app.use(express.static(path.join(__dirname, 'public')));

process.on('uncaughtException', (err) => {
  console.error('[Exception]:', err.message);
});
// ─── File Cache ───────────────────────────────────────────────────────────────
const fileCache = new Map();
const FILE_TTL_MS = 8 * 60 * 1000;

async function resolveToFile(videoId) {
  const cached = fileCache.get(videoId);
  if (cached && Date.now() < cached.expiresAt && fs.existsSync(cached.filePath)) {
    const stat = fs.statSync(cached.filePath);
    if (stat.size > 0) return cached.filePath;
    fs.unlinkSync(cached.filePath);
    fileCache.delete(videoId);
  }

  const tempBase = path.join(os.tmpdir(), `agsstack_${videoId}_${Date.now()}`);

  const cookiesFlag = fs.existsSync(COOKIES_PATH)
    ? `--cookies "${COOKIES_PATH}"`
    : '';

  try {
    await execAsync(
      `yt-dlp -f "ba[ext=m4a]/ba/bestaudio" --no-playlist --socket-timeout 15 ${cookiesFlag} -o "${tempBase}.%(ext)s" "https://www.youtube.com/watch?v=${videoId}"`,
      { timeout: 90000 }
    );
  } catch (e) {
    try {
      fs.readdirSync(os.tmpdir())
        .filter(f => f.includes(`agsstack_${videoId}_`))
        .forEach(f => fs.unlinkSync(path.join(os.tmpdir(), f)));
    } catch (_) {}
    throw new Error(`yt-dlp failed for ${videoId}: ${e.message}`);
  }

  const savedFiles = fs.readdirSync(os.tmpdir()).filter(f =>
    f.includes(`agsstack_${videoId}_`) && !f.endsWith('.part')
  );

  if (savedFiles.length === 0) throw new Error(`No output file found for ${videoId}`);

  const actualPath = path.join(os.tmpdir(), savedFiles[0]);
  const stat = fs.statSync(actualPath);
  if (stat.size === 0) {
    fs.unlinkSync(actualPath);
    throw new Error(`Empty file for ${videoId}`);
  }

  const ext = path.extname(savedFiles[0]);
  const filePath = path.join(os.tmpdir(), `agsstack_${videoId}${ext}`);
  fs.renameSync(actualPath, filePath);

  fileCache.set(videoId, { filePath, expiresAt: Date.now() + FILE_TTL_MS });
  return filePath;
}

// ─── Prewarm Batch ────────────────────────────────────────────────────────────
async function prewarmBatch(videoIds) {
  const CONCURRENCY = 4;
  const queue = [...videoIds];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) return;
      try {
        await resolveToFile(id);
      } catch (e) {
        console.warn(`[Prewarm Failed] ${id}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// ─── Cleanup Job ──────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [videoId, entry] of fileCache.entries()) {
    if (now >= entry.expiresAt) {
      try {
        fs.unlinkSync(entry.filePath);
        fileCache.delete(videoId);
      } catch (_) {}
    }
  }
}, 10 * 60 * 1000);

// ─── ISO Duration Parser ──────────────────────────────────────────────────────
function parseISO8601Duration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');
  return hours * 3600 + minutes * 60 + seconds;
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Keepalive ────────────────────────────────────────────────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/health`);
    } catch (_) {}
  }, 14 * 60 * 1000);
}

// ─── Search Endpoint ──────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY not set' });
  }

  try {
    const searchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=15&q=${encodeURIComponent(q)}&key=${process.env.YOUTUBE_API_KEY}`
    );
    const searchPayload = await searchRes.json();

    if (!searchPayload.items) {
      return res.status(500).json({ error: searchPayload.error?.message || 'No results' });
    }

    const validItems = searchPayload.items.filter(
      item => item.id?.kind === 'youtube#video' && item.id?.videoId
    );

    const ids = validItems.map(item => item.id.videoId).join(',');
    const detailRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${process.env.YOUTUBE_API_KEY}`
    );
    const detailPayload = await detailRes.json();

    const durationMap = {};
    for (const video of detailPayload.items || []) {
      durationMap[video.id] = parseISO8601Duration(video.contentDetails.duration);
    }

    const tracks = validItems.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      artist: item.snippet.channelTitle,
      cover: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
      duration: durationMap[item.id.videoId] ?? 0,
    }));

    res.json(tracks);
  } catch (error) {
    console.error('[Search Error]:', error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── Stream Endpoint ──────────────────────────────────────────────────────────
app.get('/api/stream/:id', async (req, res) => {
  const videoId = req.params.id;
  try {
    const filePath = await resolveToFile(videoId);
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      fileCache.delete(videoId);
      return res.status(500).json({ error: 'Empty audio file' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = {
      '.m4a': 'audio/mp4',
      '.webm': 'audio/webm',
      '.opus': 'audio/ogg',
      '.mp3': 'audio/mpeg',
    }[ext] || 'audio/mp4';

    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    console.error('[Stream Error]:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
  }
});

// ─── Prewarm Endpoint ─────────────────────────────────────────────────────────
app.get('/api/prewarm', async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: 'Missing ids' });
  const videoIds = ids.split(',').filter(Boolean).slice(0, 15);
  res.json({ ok: true, queued: videoIds.length });
  prewarmBatch(videoIds).catch(e => console.error('[Prewarm Error]:', e.message));
});

// ─── Server Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AGSStack Music Server running on port ${PORT}`);
});
