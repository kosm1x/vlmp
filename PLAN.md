# VLMP - Very Light Media Player

## Vision

Personal media server with a robust backend and an ultra-light Netflix-like web client. Server handles all heavy lifting (transcoding, metadata, subtitles). Client is a thin responsive shell that streams HLS and renders a browsable grid. Federation allows linked servers to share libraries.

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Node.js 22 + TypeScript 5 | Proven, streaming APIs, FFmpeg interop |
| HTTP | Fastify 5 | Lightweight, fast, schema validation |
| Database | SQLite via better-sqlite3 | Zero-config, single-file, proven (crm-azteca) |
| Transcoding | FFmpeg (system binary) | Industry standard, HLS, adaptive bitrate |
| Client | Preact + HTM | 3KB, no build step, React-compatible |
| Video Player | HLS.js | Adaptive bitrate streaming in browser |
| Auth | JWT (jose) + bcrypt | Stateless, federation-compatible |
| Metadata | TMDb API | Movie/TV posters, descriptions, ratings |
| Subtitles | OpenSubtitles API | Web search for missing subtitles |
| Build | esbuild | Fast bundler for client assets |

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

### Phase 6: Hardening & Polish
Security audit, HTTPS, logging, config file, Windows service, docs.

### Phase 7: AI Assistant (post-MVP)
Library health agent, recommendations, chat interface.

---

## Key Design Decisions

1. HLS over DASH -- Broader device support, HLS.js is mature and small.
2. SQLite over Postgres -- Single-file, zero-config.
3. Preact over React/Svelte -- 3KB gzipped, React-compatible.
4. esbuild over Webpack/Vite -- 100x faster builds.
5. FFmpeg CLI over fluent-ffmpeg -- Direct spawn, full control.
6. On-the-fly transcode over pre-transcode -- No disk space explosion.
7. Folder-based classification -- User organizes by category, scanner parses within.
