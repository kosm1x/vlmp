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
| `server/src/ai/health.ts` | Library health checks + cleanup (async) |
| `server/src/db/cleanup.ts` | Periodic expired row cleanup (sessions, invites, cache) |
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
- Database: WAL mode, `synchronous=NORMAL`, 8MB page cache, `PRAGMA optimize` on close
- Expired row cleanup runs hourly (sessions, guest passes, invites, ai_cache)
- JWT secret cached via WeakMap (one encode per config lifetime)
- Health report and file checks are async (batched `fs.access`, not `existsSync`)
- Federation `last_seen` writes debounced to 1/min to avoid write amplification
- Recommender: batch genre lookups, SQL-level pre-filtering, no full table scans
- Subtitle inserts and library folder deletes wrapped in transactions
- Direct play uses async `stat()` to avoid blocking event loop on range requests
