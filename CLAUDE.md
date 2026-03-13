# CLAUDE.md

Personal media server (robust backend) + ultra-light Netflix-like web client.

## Quick Context

Server handles transcoding, metadata, subtitles. Client is a thin Preact shell streaming HLS. SQLite for all persistence. FFmpeg for media processing.

## Key Files

| File | Purpose |
|------|---------|
| `server/src/index.ts` | Fastify entry point |
| `server/src/config.ts` | Environment + defaults |
| `server/src/db/schema.ts` | SQLite table definitions |
| `server/src/auth/jwt.ts` | JWT issue/verify |
| `server/src/scanner/classify.ts` | Media categorization |
| `server/src/scanner/probe.ts` | FFprobe wrapper |
| `server/src/streaming/transcoder.ts` | FFmpeg HLS pipeline |
| `server/src/streaming/session.ts` | Stream session manager |
| `server/src/metadata/tmdb.ts` | TMDb API client |
| `server/src/metadata/matcher.ts` | Metadata auto-match + cache |
| `server/src/subtitles/extract.ts` | FFmpeg subtitle extraction |
| `server/src/media/playlists.ts` | Playlist CRUD + ownership |
| `server/src/federation/crypto.ts` | HMAC-SHA256 signing + fingerprint |
| `server/src/federation/middleware.ts` | Federation HMAC auth preHandler |
| `server/src/federation/linking.ts` | Server linking (invite flow) |
| `server/src/federation/client.ts` | Outbound signed fetch to peers |
| `server/src/federation/proxy.ts` | Library/stream proxy + HLS rewriting |
| `server/src/federation/health.ts` | Heartbeat loop (5min interval) |
| `server/src/ai/viewing-log.ts` | Viewing history tracking + dedup |
| `server/src/ai/preferences.ts` | Like/dislike preference CRUD |
| `server/src/ai/cache.ts` | TTL-based recommendation cache |
| `server/src/ai/recommender.ts` | 5-strategy recommendation engine |
| `server/src/ai/health.ts` | Library health checks + cleanup |
| `server/src/routes/*.ts` | API route handlers |

## Development

```bash
npm run dev          # tsx watch
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
```

## Patterns

- Config loaded at startup via `loadConfig()`, passed to modules
- All JSON parsing wrapped in try/catch
- FFmpeg/FFprobe via child_process.spawn
- Database uses WAL mode
