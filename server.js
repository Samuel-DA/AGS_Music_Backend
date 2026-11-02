import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const CEENAIJA_API = 'https://www.ceenaija.com/wp-json/wp/v2';
const requestBuckets = new Map();

export function isYouTubeVideoId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
}

export function parseISO8601Duration(value) {
  if (typeof value !== 'string') return 0;
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 +
      Number(match[2] || 0) * 60 +
      Number(match[3] || 0);
}

function decodeHtml(value = '') {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    '#038': '&',
    '#039': "'",
    '#8211': '–',
    '#8212': '—',
    '#8217': '’',
  };
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
      if (entity[0] === '#') {
        const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
        const number = Number.parseInt(entity.replace(/^#x?/i, ''), radix);
        return Number.isFinite(number) ? String.fromCodePoint(number) : '';
      }
      return named[entity.toLowerCase()] ?? `&${entity};`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePostTitle(rawTitle) {
  const cleaned = decodeHtml(rawTitle)
    .replace(/^download\s+(?:song|mp3)\s*:\s*/i, '')
    .trim();
  const parts = cleaned.split(/\s+[–—-]\s+/);
  if (parts.length < 2) {
    return { title: cleaned || 'Untitled', artist: 'Unknown artist' };
  }

  const left = parts.shift().trim();
  const right = parts.join(' – ').trim();
  if (/mp3\s+download/i.test(left)) {
    return {
      title: left.replace(/\s*mp3\s+download.*$/i, '').trim(),
      artist: right.replace(/\s*[([](?:song|mp3|lyrics|video).*$/i, '').trim(),
    };
  }
  return {
    title: right.replace(/\s*[([](?:song|mp3|lyrics|video).*$/i, '').trim(),
    artist: left,
  };
}

function extractDirectTrack(post) {
  const html = post.content?.rendered || '';
  const audioMatch = html.match(/<audio[^>]+src=["']([^"']+)["']/i);
  const mp3Match = html.match(/https?:\/\/[^"'<>\s]+\.mp3(?:\?[^"'<>\s]*)?/i);
  const encodedUrl = audioMatch?.[1] || mp3Match?.[0];
  if (!encodedUrl) return null;

  const { title, artist } = parsePostTitle(
    post.title?.rendered || 'Untitled',
  );
  const imageMatch = html.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/i);
  const audioUrl = decodeHtml(encodedUrl);

  try {
    const media = new URL(audioUrl);
    if (!['https:', 'http:'].includes(media.protocol)) return null;
  } catch {
    return null;
  }

  return {
    id: `ceenaija-${post.id}`,
    title,
    artist,
    cover: post.jetpack_featured_media_url || decodeHtml(imageMatch?.[1] || ''),
    duration: 0,
    source: 'direct',
    audioUrl,
    sourcePageUrl: post.link,
    canDownload: true,
  };
}

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AGSStackMusic/1.0' },
    });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.search = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10',
    maxResults: '15',
    q: query,
    key: apiKey,
  });
  const searchPayload = await fetchJson(searchUrl);
  const items = (searchPayload.items || []).filter((item) =>
    isYouTubeVideoId(item.id?.videoId),
  );
  if (items.length === 0) return [];

  const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsUrl.search = new URLSearchParams({
    part: 'contentDetails',
    id: items.map((item) => item.id.videoId).join(','),
    key: apiKey,
  });
  const details = await fetchJson(detailsUrl);
  const durations = new Map(
    (details.items || []).map((item) => [
      item.id,
      parseISO8601Duration(item.contentDetails?.duration),
    ]),
  );

  return items.map((item) => ({
    id: item.id.videoId,
    title: decodeHtml(item.snippet.title),
    artist: decodeHtml(item.snippet.channelTitle),
    cover: item.snippet.thumbnails?.high?.url ||
      item.snippet.thumbnails?.medium?.url || '',
    duration: durations.get(item.id.videoId) || 0,
    source: 'youtube',
    audioUrl: null,
    sourcePageUrl: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    canDownload: false,
  }));
}

export async function searchCeeNaija(query) {
  const searchUrl = new URL(`${CEENAIJA_API}/search`);
  searchUrl.search = new URLSearchParams({
    search: query,
    per_page: '8',
    subtype: 'post',
  });
  const results = await fetchJson(searchUrl);
  const posts = await Promise.allSettled(
    results.map(async (result) => {
      const postUrl = new URL(result._links?.self?.[0]?.href ||
        `${CEENAIJA_API}/posts/${result.id}`);
      postUrl.searchParams.set(
        '_fields',
        'id,link,title,content,jetpack_featured_media_url',
      );
      return fetchJson(postUrl);
    }),
  );

  return posts
    .filter((result) => result.status === 'fulfilled')
    .map((result) => extractDirectTrack(result.value))
    .filter(Boolean);
}

function rateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const previous = requestBuckets.get(key);
  const bucket = !previous || now - previous.startedAt >= 60_000
    ? { startedAt: now, count: 0 }
    : previous;
  bucket.count += 1;
  requestBuckets.set(key, bucket);
  if (bucket.count > 60) {
    return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  }
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(rateLimit);
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => res.json({
    status: 'ok',
    youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY),
  }));

  app.get('/api/search', async (req, res) => {
    const query = String(req.query.q || '').trim().slice(0, 120);
    if (!query) return res.status(400).json({ error: 'Enter a search term.' });

    const [direct, youtube] = await Promise.allSettled([
      searchCeeNaija(query),
      searchYouTube(query),
    ]);
    const results = [
      ...(direct.status === 'fulfilled' ? direct.value : []),
      ...(youtube.status === 'fulfilled' ? youtube.value : []),
    ];

    if (results.length === 0 && direct.status === 'rejected' &&
        youtube.status === 'rejected') {
      return res.status(502).json({ error: 'Music sources are unavailable.' });
    }
    return res.json(results);
  });

  app.get('/api/search/direct', async (req, res, next) => {
    const query = String(req.query.q || '').trim().slice(0, 120);
    if (!query) return res.status(400).json({ error: 'Enter a search term.' });
    try {
      return res.json(await searchCeeNaija(query));
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/search/youtube', async (req, res, next) => {
    const query = String(req.query.q || '').trim().slice(0, 120);
    if (!query) return res.status(400).json({ error: 'Enter a search term.' });
    try {
      return res.json(await searchYouTube(query));
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, req, res, next) => {
    console.error('[API Error]', error.message);
    if (res.headersSent) return next(error);
    return res.status(502).json({ error: 'A music source could not be reached.' });
  });

  return app;
}

if (process.argv[1] === __filename) {
  createApp().listen(PORT, '0.0.0.0', () => {
    console.log(`AGSStack Music server running on port ${PORT}`);
  });
}
