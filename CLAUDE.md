# CLAUDE.md

Personal media server (robust backend) + ultra-light Netflix-like web client.

## Quick Context

Server handles transcoding, metadata, subtitles. Client is a thin Preact shell streaming HLS. SQLite for all persistence. FFmpeg for media processing.

## Key Files

| File                                        | Purpose                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `server/src/index.ts`                       | Fastify entry point                                                  |
| `server/src/config.ts`                      | Environment + defaults                                               |
| `server/src/rate-limit.ts`                  | Data-plane (streaming) exemption for the global limiter              |
| `server/src/db/schema.ts`                   | SQLite table definitions                                             |
| `server/src/auth/jwt.ts`                    | JWT issue/verify                                                     |
| `server/src/scanner/classify.ts`            | Media classification (category kind + series detection)              |
| `server/src/media/categories.ts`            | User-managed categories (slug/kind CRUD, rename, delete guard)       |
| `server/src/subtitles/opensubtitles.ts`     | OpenSubtitles search/download + SRT→VTT                              |
| `server/src/scanner/probe.ts`               | FFprobe wrapper                                                      |
| `server/src/process-liveness.ts`            | `isProcessAlive` — the only safe guard before signalling a child     |
| `server/src/streaming/transcoder.ts`        | FFmpeg HLS pipeline (paced via -readrate)                            |
| `server/src/streaming/session.ts`           | Stream session manager + on-demand segment encode                    |
| `server/src/streaming/playback-decision.ts` | Direct-vs-transcode decision + play-time re-probe of null-codec rows |
| `server/src/streaming/ffmpeg-caps.ts`       | ffmpeg version/feature detection (pacing flags)                      |
| `server/src/streaming/hw-encoders.ts`       | Hardware encoder probe (VLMP_HW_TRANSCODE)                           |
| `server/src/metadata/tmdb.ts`               | TMDb API client                                                      |
| `server/src/metadata/matcher.ts`            | Metadata auto-match + cache                                          |
| `server/src/subtitles/extract.ts`           | FFmpeg subtitle extraction                                           |
| `server/src/media/playlists.ts`             | Playlist CRUD + ownership                                            |
| `server/src/federation/crypto.ts`           | HMAC-SHA256 signing + fingerprint                                    |
| `server/src/federation/middleware.ts`       | Federation HMAC auth preHandler                                      |
| `server/src/federation/linking.ts`          | Server linking (invite flow)                                         |
| `server/src/federation/client.ts`           | Outbound signed fetch to peers                                       |
| `server/src/federation/proxy.ts`            | Library/stream proxy + HLS rewriting                                 |
| `server/src/federation/health.ts`           | Heartbeat loop (5min interval)                                       |
| `server/src/ai/viewing-log.ts`              | Viewing history tracking + dedup                                     |
| `server/src/ai/preferences.ts`              | Like/dislike preference CRUD                                         |
| `server/src/ai/cache.ts`                    | TTL-based recommendation cache                                       |
| `server/src/ai/recommender.ts`              | 5-strategy recommendation engine                                     |
| `server/src/ai/health.ts`                   | Library health checks + cleanup (async)                              |
| `server/src/metadata/thumbs.ts`             | Frame-grab thumbnail fallback (lazy, fail-marker cached)             |
| `server/src/routes/fs.ts`                   | Admin directory browser backing the Settings folder picker           |
| `server/src/routes/params.ts`               | Shared parseInt route param validation                               |
| `server/src/db/cleanup.ts`                  | Periodic expired row cleanup (invites, cache, viewing_log)           |
| `server/src/routes/*.ts`                    | API route handlers                                                   |

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
- **Every ffmpeg/ffprobe spawn is time-bounded** — timeout + `isProcessAlive`-gated
  kill, `probe.ts` is the reference shape. The scan pipeline awaits these
  in-line, so one unbounded child strands a folder at `scan_status='scanning'`
  forever. The last gap (`subtitles/extract.ts`) was closed in v0.1.9.9; a new
  spawn site without a bound reopens the class.
- **`file_path` is the library's identity key** (thumbs, rescan lookup,
  empty-trash prune all key on it), so discovery must be deterministic:
  `discover.ts` walks real paths as canonical and follows symlinks ONLY when
  they point outside the library root. A global visited-set here once made an
  alias race its real directory by readdir order — the loser's rows were
  pruned, cascading watch progress/likes/playlists. Cycle guards on a walk
  whose path is identity must be ancestor-chain, never global.
- **Thumbnails are keyed by sha256(file_path) prefix, never by row id** —
  `media_items.id` is a plain rowid and SQLite recycles it after DELETE; an
  id-keyed disk cache re-attaches a deleted item's frame to new media. The
  `/media/:id/thumb` route revalidates (no-cache + ETag) for the same reason.
- **`group_title`/`group_sort_title`/`group_position`** carry folder grouping
  for non-episode rows; `group_sort_title` must stay in lockstep with the
  `sort_title` normalization (`normalizeSortTitle`) or the browse COALESCE
  interleave breaks.
- **Destructive branches get their own, more lenient gate**: the short-sample
  filter is strict on INSERT (grouped/episode files only are exempt) but
  lenient on the rescan DELETE branch (any numbered file is spared) — a
  shared predicate tightened for insert quality once turned the delete branch
  into automatic data loss.
- **View-triggered rescan** (`/library/categories/:slug/refresh`): per-folder
  cooldown is in-process on purpose (error folders must honor it too); a
  category's folders scan SEQUENTIALLY; the client poll is time-boxed, not
  attempt-capped, and its settle refetch always runs when polling ends.
- **Never signal a child without `isProcessAlive()`** (`process-liveness.ts`, a
  dependency-free module so scanner/metadata/streaming can all use it without
  import cycles; re-exported from `streaming/transcoder.ts`).
  `ChildProcess.killed` only records that a signal was _sent_, so it is false for
  a reaped child too — killing on `!killed` targets a PID the kernel may have
  reassigned to an unrelated process. This applies in **tests as well**; the
  version of this bug that reached CI lived in a test helper, not the server.
- Startup failures must be fatal: `index.ts` flips `listening` after
  `app.listen`, and the uncaught-exception guards exit 1 while it is false.
  Without that a boot failure logs and then exits **0**, which every supervisor
  reads as a clean stop
- Database: WAL mode, `synchronous=NORMAL`, 8MB page cache, `PRAGMA optimize` on close
- Expired row cleanup runs hourly (sessions, guest passes, invites, ai_cache)
- JWT secret cached via WeakMap (one encode per config lifetime)
- Health report and file checks are async (batched `fs.access`, not `existsSync`)
- Federation `last_seen` writes debounced to 1/min to avoid write amplification
- Recommender: batch genre lookups, SQL-level pre-filtering, no full table scans
- Subtitle inserts and library folder deletes wrapped in transactions
- Direct play uses async `stat()` to avoid blocking event loop on range requests
