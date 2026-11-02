# AGSStack Music API

The companion discovery API combines two kinds of search results:

- Direct audio exposed by a source page, currently CeeNaija. These results include the original page, direct media URL, and permission for in-app download.
- YouTube metadata from YouTube Data API v3. These results are streaming-only and must be played through the visible official YouTube player.

The service does not run `yt-dlp`, extract YouTube audio, proxy media, or provide a YouTube download endpoint.

## Setup

Requires Node.js 20 or newer.

```sh
npm ci
YOUTUBE_API_KEY=your_key npm start
```

Without `YOUTUBE_API_KEY`, direct-audio searches still work and YouTube results are omitted.

## Endpoints

- `GET /health`
- `GET /api/search?q=...`
- `GET /api/search/direct?q=...`
- `GET /api/search/youtube?q=...`

## Verification

```sh
npm test
npm audit --omit=dev
```
