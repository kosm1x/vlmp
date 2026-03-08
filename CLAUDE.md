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
