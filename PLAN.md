# VLMP - Very Light Media Player

## Vision

Personal media server with a robust backend and an ultra-light Netflix-like web client. Server handles all heavy lifting (transcoding, metadata, subtitles). Client is a thin responsive shell that streams HLS and renders a browsable grid. Federation allows linked servers to share libraries.

---

## Tech Stack

| Layer        | Technology                | Rationale                                     |
| ------------ | ------------------------- | --------------------------------------------- |
| Runtime      | Node.js 22 + TypeScript 5 | Proven, streaming APIs, FFmpeg interop        |
| HTTP         | Fastify 5                 | Lightweight, fast, schema validation          |
| Database     | SQLite via better-sqlite3 | Zero-config, single-file, proven (crm-azteca) |
| Transcoding  | FFmpeg (system binary)    | Industry standard, HLS, adaptive bitrate      |
| Client       | Preact + HTM              | 3KB, no build step, React-compatible          |
| Video Player | HLS.js                    | Adaptive bitrate streaming in browser         |
| Auth         | JWT (jose) + bcrypt       | Stateless, federation-compatible              |
| Metadata     | TMDb API                  | Movie/TV posters, descriptions, ratings       |
| Subtitles    | OpenSubtitles API         | Web search for missing subtitles              |
| Build        | esbuild                   | Fast bundler for client assets                |

---

## Implementation Phases

### Phase 1: Foundation -- COMPLETE

Server scaffold, auth, scanner, classifier, probe, library CRUD, TV hierarchy.

### Phase 2: Core Playback -- COMPLETE

Direct play, HLS transcoding (1080p/720p/480p/360p), adaptive bitrate, session manager, client player with full controls.

### Phase 3: Client UI -- COMPLETE (merged into Phase 2)

Netflix-like browse, category rows, search, responsive layout, login/register.

### Phase 4: Media Management -- COMPLETE

TMDb metadata (auto-match on scan, manual match, batch scan, 30-day cache), subtitle extraction (FFmpeg VTT demux, bitmap codec skip), playlists (CRUD, ownership, reorder).

### Phase 5: Sharing & Federation -- COMPLETE

HMAC-SHA256 server auth, 2-step invite linking, remote library browsing (proxied), remote HLS playback with M3U8 rewriting, 5-min heartbeat health monitoring. Zero new dependencies.

### Phase 6: Hardening & Polish -- COMPLETE

Security headers (CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy), global rate limiting (120/min baseline), 1MB body limit, log redaction. Subtitle auth migrated from JWT-in-URL to short-lived HMAC tokens (5min TTL). Guest pass entropy doubled (64-bit), validation wrapped in transaction (TOCTOU fix), rate-limited. Fastify JSON schema validation on all POST/PUT routes. FFmpeg dash-prefix input validation. Federation browse routes restricted to admin. Startup config validation (port, publicUrl, TMDB key warning). Client: favicon, meta tags, ARIA labels, 404 route, error boundary, WCAG AA contrast fix.

### Phase 7: AI Assistant -- COMPLETE

Algorithmic recommendations (5-strategy engine: next episode, collaborative filtering, genre matching, similar items, popularity fallback). Viewing history tracking with 5-min dedup. User preferences (like/dislike) with recommendation cache invalidation. Library health dashboard (8 checks: missing files, zero-byte, metadata gaps, no subtitles, codec/resolution analysis, orphaned entries, duplicates) with admin cleanup. Zero external AI dependencies.

---

### QA Security Audit -- COMPLETE (2026-03-30)

Full codebase audit with 27 remediations across 4 severity levels. Key fixes: JWT guard bypass, federation session CSPRNG, server.key permissions, parseIntParam validation across all routes, orphan cleanup, FFprobe buffer cap, guest pass check/consume separation, federation TV path stripping, session user ownership, LIKE injection escape, federation body schemas, metadata scan mutex, CDN pinning, HSTS header. 173 tests passing.

---

### Adversarial Audit + Hardening -- COMPLETE (2026-07-19)

Five-dimension adversarial audit (performance, code, logic, resilience, usability), fixes shipped in five tiers: vendored client libs via import map (no CDN dependency), process-survival hardening (global handlers, transcoder lifecycle, awaited direct serve, guarded timers), transcode resource bounds (lazy profile start, session cap, free-space floor, boot sweep, client keepalive teardown), session-list authz, HLS resume timeline fix, federation stream/HMAC/heartbeat seam repairs with integration tests. 181 tests passing. Findings + deferred queue: `docs/AUDIT-2026-07-19.md`.

---

### Access Control + Library Gate + Plex Hygiene -- COMPLETE (2026-07-19)

Closed-membership auth: registration bootstraps the first admin then closes; admin provisions accounts via `/admin/users`; per-request account/role re-check gives immediate revocation. Admin library gate: per-folder `is_visible`/`is_searchable` limiting non-admins across browse/search/detail/stream/recommendations (real 404 boundary), toggled in Settings. Adopted Plex options after an explicit config review (`docs/PLEX-CONFIG-REVIEW.md`): empty-trash on scan, scheduled SQLite backup, configurable x264 preset. First Lumiere Dark UI surface (Settings page). Audited R1+R2+R3 on the access-control surface. 205 tests passing.

### Windows Port Prep -- COMPLETE (2026-07-20)

Cross-platform correctness pass ahead of running the server on Windows (iOS server deferred until Windows is validated). Fixed the sweep-identified hazards: separator/case-robust `isPathInside` helper replacing three `startsWith` path-containment guards (subtitle serve + both segment routes — also closes the sibling-prefix-dir bypass on all OSes), `join()` in the folder watcher (mixed-separator paths), guarded boot-time transcode sweep (EBUSY must not block startup), `SIGBREAK` graceful shutdown, FFmpeg/FFprobe boot preflight warning, per-entry stat guard in backup prune (AV locks), delayed retry on session-dir deletion (ffmpeg handle lag), and `resolve()` normalization on library-folder ingestion (exact-string UNIQUE dedupe). Runbook + smoke-test checklist: `docs/WINDOWS.md`. Audited R1+R2 (both PASS, adjacent-surface sweep clean). 213 tests passing. Port-gated features (hardware transcoding, mDNS, TLS) start only after the checklist passes on real hardware.

### Windows Installer -- COMPLETE (2026-07-20)

`installer/build.sh` (Linux/macOS) produces `vlmp-setup-<version>-win-x64.exe` via NSIS: compiled server + web client + portable Node 22 runtime + production `node_modules` (win32 better-sqlite3 prebuilt swapped in, bcrypt's bundled win32 prebuild kept) + NSSM, all payloads checksum-pinned. Server gained `VLMP_JWT_SECRET_FILE` and an optional `<dataDir>/vlmp.env` config file (VLMP_-keys only, real env wins) so console/service/docker share one config surface; fixed compiled-mode client-dir resolution (`npm start` served no client). Installer flow: locked-down `%ProgramData%\vlmp` (SYSTEM+Administrators, fail-closed icacls — audit R1 caught a real EoP via user-plantable `vlmp.env` feeding `VLMP_FFMPEG_PATH` to the SYSTEM service), self-elevating launcher, first-run JWT secret file, Start Menu/service/firewall/winget-FFmpeg options, guarded uninstall that keeps data. Audited R1 (FAIL→fixed) + R2 (PASS w/ warnings→fixed). 220 tests.

### UI Design Direction -- IN PROGRESS

Evaluated 6 concepts (Projectionist, Signal, Lumiere, Broadcast, Acetate, Oxide). Two approved:

- **Lumiere Dark** -- Warm dark (#0c0b0a), Libre Bodoni + Public Sans, 3-card masonry feature strip, spring-lift cards (8px radius), frosted glass nav
- **Oxide** -- Hi-Fi faceplate metaphor, Cormorant Garamond + Space Grotesk + Space Mono, amber accent (#d4951a), cassette corner-notch cards (clip-path), VU meters, 7-segment time counter
  Preview files: `client/public/previews/`

---

## Key Design Decisions

1. HLS over DASH -- Broader device support, HLS.js is mature and small.
2. SQLite over Postgres -- Single-file, zero-config.
3. Preact over React/Svelte -- 3KB gzipped, React-compatible.
4. esbuild over Webpack/Vite -- 100x faster builds.
5. FFmpeg CLI over fluent-ffmpeg -- Direct spawn, full control.
6. On-the-fly transcode over pre-transcode -- No disk space explosion.
7. Folder-based classification -- User organizes by category, scanner parses within.
