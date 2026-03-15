# VLMP - Very Light Media Player

Personal media server with a robust Node.js backend and an ultra-light Netflix-like web client. The server handles all heavy lifting — transcoding, metadata, library scanning — while the client is a thin Preact shell that streams HLS adaptive video.

## Features

- **Adaptive bitrate streaming** — On-the-fly HLS transcoding via FFmpeg (1080p/720p/480p/360p)
- **Direct play** — Zero-transcode for browser-compatible formats (H.264 MP4, WebM, etc.)
- **Smart library scanning** — Recursive discovery with automatic classification (movies, TV, documentaries, education)
- **TV show hierarchy** — Automatic season/episode detection from filenames (`S01E01`, `1x01`)
- **Watch progress** — Resume where you left off, "Continue Watching" row
- **Guest passes** — Share individual media items with time-limited, view-limited codes
- **JWT authentication** — Stateless auth with admin/user roles
- **TMDb metadata** — Automatic poster, backdrop, description, rating, genre enrichment via TMDb API
- **Subtitle extraction** — Automatic VTT extraction from embedded subtitle tracks (FFmpeg)
- **Playlists** — User-owned playlists with add/remove/reorder
- **Media detail view** — Full detail page with backdrop, metadata, play button, subtitle list, playlist picker
- **Server federation** — Link VLMP instances to browse and play remote media, all proxied (NAT-safe)
- **HMAC-SHA256 federation auth** — Shared secret signing with replay protection, invite-based linking
- **Security hardened** — CSP, rate limiting, input validation, HMAC subtitle tokens, session ID validation
- **Algorithmic recommendations** — 5-strategy engine (next episode, collaborative filtering, genre matching, similar items, popularity) with no external AI APIs
- **User preferences** — Like/dislike with recommendation cache invalidation
- **Library health dashboard** — 8 checks (missing files, zero-byte, metadata gaps, no subtitles, codec/resolution analysis, orphaned entries, duplicates) with admin cleanup
- **Ultra-light client** — Preact + HTM loaded from CDN (~3KB framework), no build step
- **Dark Netflix-like UI** — Responsive grid layout with category browsing, search, ARIA labels

## Requirements

- **Node.js** >= 22
- **FFmpeg** + **FFprobe** installed and available in `$PATH`

## Quick Start

```bash
# Clone and install
git clone https://github.com/kosm1x/vlmp.git
cd vlmp
npm install

# Start in development mode (auto-reload)
npm run dev

# Open http://localhost:8080
# Register the first user (automatically becomes admin)
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `VLMP_PORT` | `8080` | HTTP server port |
| `VLMP_HOST` | `0.0.0.0` | Bind address |
| `VLMP_DATA_DIR` | `./data` | Data directory (database, transcode cache) |
| `VLMP_JWT_SECRET` | `vlmp-dev-secret-change-me` | JWT signing secret (**change in production**) |
| `VLMP_JWT_EXPIRES_IN` | `24h` | JWT token lifetime |
| `VLMP_FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg binary |
| `VLMP_FFPROBE_PATH` | `ffprobe` | Path to FFprobe binary |
| `VLMP_TMDB_API_KEY` | *(empty)* | TMDb API key for metadata enrichment |
| `VLMP_SERVER_NAME` | `VLMP` | Display name for this server in federation |
| `VLMP_PUBLIC_URL` | *(empty)* | Public URL of this server (for federation linking) |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with auto-reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server |
| `npm test` | Run test suite (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check without emitting |

## Architecture

```
vlmp/
├── server/src/
│   ├── index.ts              # Fastify entry point, CORS, static files, graceful shutdown
│   ├── config.ts             # Environment variable loading
│   ├── auth/
│   │   ├── jwt.ts            # JWT issue/verify (jose, HS256)
│   │   ├── passwords.ts      # bcrypt hash/verify (12 rounds)
│   │   ├── middleware.ts      # Fastify preHandler auth guard
│   │   └── guest.ts          # Guest pass creation/validation
│   ├── db/
│   │   ├── index.ts          # SQLite singleton (WAL, sync=NORMAL, 8MB cache)
│   │   ├── schema.ts         # 21 tables, 17 indexes
│   │   └── cleanup.ts        # Hourly expired row cleanup (sessions, invites, cache)
│   ├── scanner/
│   │   ├── discover.ts       # Recursive file walker (22 video/audio formats)
│   │   ├── classify.ts       # Folder-based categorization + filename parsing
│   │   ├── probe.ts          # FFprobe wrapper (duration, codecs, resolution)
│   │   └── watcher.ts        # fs.watch for library changes
│   ├── media/
│   │   ├── library.ts        # Library CRUD, scanning, browse/search/filter
│   │   └── playlists.ts      # Playlist CRUD, ownership, reorder
│   ├── metadata/
│   │   ├── tmdb.ts           # TMDb API client (search, detail, v3/v4 key)
│   │   └── matcher.ts        # Auto-match + manual match with cache
│   ├── subtitles/
│   │   ├── extract.ts        # FFmpeg subtitle demuxing to VTT
│   │   └── service.ts        # Subtitle DB operations
│   ├── streaming/
│   │   ├── direct.ts         # Byte-range serving for compatible formats
│   │   ├── adaptive.ts       # 4 transcode profiles, bandwidth selection
│   │   ├── transcoder.ts     # FFmpeg HLS pipeline (segments + playlists)
│   │   └── session.ts        # In-memory session manager, idle timeout cleanup
│   ├── federation/
│   │   ├── crypto.ts         # HMAC-SHA256 signing, fingerprint, secrets
│   │   ├── middleware.ts     # Federation auth preHandler (HMAC verification)
│   │   ├── linking.ts        # Invite flow, server CRUD
│   │   ├── client.ts         # Outbound signed fetch to peer servers
│   │   ├── proxy.ts          # Library/stream proxy, M3U8 URL rewriting
│   │   └── health.ts         # Heartbeat loop (5min, auto-offline after 3 failures)
│   ├── ai/
│   │   ├── viewing-log.ts    # Viewing history tracking with 5-min dedup
│   │   ├── preferences.ts    # Like/dislike user preference CRUD
│   │   ├── cache.ts          # TTL-based recommendation cache
│   │   ├── recommender.ts    # 5-strategy recommendation engine
│   │   └── health.ts         # Library health checks + orphan cleanup
│   └── routes/
│       ├── auth.ts           # Register, login, guest pass endpoints
│       ├── library.ts        # Browse, search, TV shows, admin folder management
│       ├── metadata.ts       # TMDb search proxy, match, batch scan
│       ├── subtitles.ts      # Subtitle list, file serving, manual extraction
│       ├── playlists.ts      # Playlist CRUD, item management, reorder
│       ├── playback.ts       # Stream start, HLS manifests/segments, direct play
│       ├── progress.ts       # Watch progress save/resume, viewing log integration
│       ├── recommendations.ts # Personalized recs, similar items, preferences
│       ├── health.ts         # Admin library health report + cleanup
│       ├── federation.ts     # Federation admin + proxy routes (JWT auth)
│       └── federation-api.ts # Peer-facing federation API (HMAC auth)
├── client/public/
│   ├── index.html            # Entry point (CDN imports: Preact, HTM, HLS.js)
│   ├── styles/main.css       # Dark theme, responsive layout
│   └── src/
│       ├── app.js            # Preact root, route handling
│       ├── api.js            # Fetch wrapper with JWT management
│       ├── router.js         # Hash-based SPA router
│       └── components/
│           ├── Login.js      # Register/sign-in form
│           ├── Shell.js      # Navigation bar, search
│           ├── Browse.js     # Category rows (Continue Watching, Recently Added, etc.)
│           ├── MediaRow.js   # Horizontal scrollable card row
│           ├── MediaCard.js  # Poster card with progress overlay, detail-first navigation
│           ├── MediaDetail.js # Detail page (backdrop, metadata, play, playlist picker)
│           ├── Search.js     # Search results grid
│           ├── Player.js     # Video player (HLS.js, subtitles, seek, volume, speed, fullscreen)
│           ├── Playlists.js  # Playlist list + create
│           ├── PlaylistDetail.js # Single playlist view with items
│           ├── Servers.js    # Federated server list, invite/link admin
│           ├── ServerBrowse.js # Remote library browser
│           └── HealthDashboard.js # Admin library health dashboard
└── server/tests/             # 176 tests across 23 files (vitest)
```

## API Overview

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | Register (first user becomes admin) |
| POST | `/auth/login` | Login, returns JWT |
| POST | `/auth/guest` | Create guest pass for a media item |
| GET | `/auth/guest/:code` | Validate guest pass |

### Library
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/library/browse` | Browse media (filter by type, category, search) |
| GET | `/library/recent` | Recently added items |
| GET | `/library/:id` | Single media item |
| GET | `/library/tv/shows` | All TV shows |
| GET | `/library/tv/shows/:id` | Show detail with seasons/episodes |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/folders` | List library folders |
| POST | `/admin/folders` | Add library folder (path + category) |
| DELETE | `/admin/folders/:id` | Remove library folder |
| POST | `/admin/folders/:id/scan` | Trigger folder scan |
| POST | `/admin/metadata/:id/match` | Auto or manual TMDb match |
| POST | `/admin/metadata/scan` | Batch match all unmatched items |
| POST | `/admin/metadata/tv/:showId/match` | Match a TV show |
| POST | `/admin/subtitles/:mediaId/extract` | Manually trigger subtitle extraction |

### Metadata
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/metadata/search` | Proxy TMDb search (query: `q`, `type`, `year`) |

### Subtitles
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/subtitles/:mediaId` | List subtitles for media item |
| GET | `/subtitles/:mediaId/:subtitleId/token` | Get short-lived HMAC token for file access |
| GET | `/subtitles/:mediaId/:subtitleId/file` | Serve VTT file (HMAC token in query) |

### Playlists
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/playlists` | List user's playlists |
| POST | `/playlists` | Create playlist |
| GET | `/playlists/:id` | Get playlist with items |
| PUT | `/playlists/:id` | Rename playlist |
| DELETE | `/playlists/:id` | Delete playlist |
| POST | `/playlists/:id/items` | Add item to playlist |
| DELETE | `/playlists/:id/items/:itemId` | Remove item |
| PUT | `/playlists/:id/reorder` | Reorder items |

### Playback
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/stream/:id/start` | Start stream session (direct or transcode) |
| GET | `/stream/:sessionId/direct` | Direct file stream (byte-range) |
| GET | `/stream/:sessionId/master.m3u8` | HLS master playlist |
| GET | `/stream/:sessionId/:profile/playlist.m3u8` | HLS variant playlist |
| GET | `/stream/:sessionId/:profile/:segment` | HLS video segment |
| DELETE | `/stream/:sessionId` | End stream session |

### Progress
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/progress/:mediaId` | Get watch progress |
| PUT | `/progress/:mediaId` | Update watch position |
| GET | `/progress/continue` | "Continue watching" list |

### Recommendations & Preferences
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/recommendations` | Personalized recommendations (cached 1hr) |
| POST | `/recommendations/refresh` | Force recompute recommendations |
| GET | `/recommendations/similar/:mediaId` | Similar items |
| POST | `/preferences/:mediaId` | Set like/dislike preference |
| DELETE | `/preferences/:mediaId` | Remove preference |
| GET | `/preferences` | List user preferences |

### Library Health (Admin)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/health` | Full library health report |
| GET | `/admin/health/missing` | Missing files list |
| POST | `/admin/health/cleanup` | Remove orphaned database entries |

### Federation (Admin / Proxy)
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/federation/servers` | JWT+admin | List linked servers |
| POST | `/federation/invite` | JWT+admin | Generate invite token (1hr expiry) |
| DELETE | `/federation/servers/:id` | JWT+admin | Remove a linked server |
| POST | `/federation/link` | invite token | Receive link request from remote |
| POST | `/federation/link-remote` | JWT+admin | Initiate link to another server |
| GET | `/federation/servers/:id/library` | JWT+admin | Browse remote library (proxied) |
| GET | `/federation/servers/:id/media/:mediaId` | JWT+admin | Remote media detail (proxied) |
| GET | `/federation/servers/:id/tv/shows` | JWT+admin | Remote TV shows (proxied) |
| POST | `/federation/servers/:id/stream/:mediaId/start` | JWT | Start remote playback |
| GET | `/federation/servers/:id/stream/:sessionId/*` | JWT | Proxy HLS content |
| DELETE | `/federation/servers/:id/stream/:sessionId` | JWT | Stop remote playback |

### Federation API (Peer-to-Peer, HMAC auth)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/federation/api/library` | Browse library (stripped) |
| GET | `/federation/api/media/:id` | Media detail (stripped) |
| GET | `/federation/api/tv/shows` | TV show list |
| GET | `/federation/api/tv/shows/:id` | Show detail |
| POST | `/federation/heartbeat` | Health ping |
| POST | `/federation/api/stream/:id/start` | Start stream |
| GET | `/federation/api/stream/:sessionId/*` | Serve HLS content |
| DELETE | `/federation/api/stream/:sessionId` | Stop stream |

## Federation

Two VLMP instances can link up so users on Server A can browse and play media from Server B, all proxied through Server A (NAT-safe — the client never talks directly to remote servers).

### How to Link Servers

1. **Server B admin** goes to Servers page and clicks "Generate Invite Token"
2. **Server A admin** enters Server B's URL + invite token in the "Link to Server" form
3. Both servers now show as `active` — Server A's users can browse and play Server B's library

### Architecture

- **HMAC-SHA256 auth** — Every cross-server request signed with 3 headers (`X-VLMP-Server-Id`, `X-VLMP-Timestamp`, `X-VLMP-Signature`), with 300s replay window
- **Proxy pattern** — All federation traffic proxied through local server; HLS playlist URLs rewritten to local proxy paths
- **Sensitive field stripping** — `file_path`, `file_size`, `library_folder_id` removed from all remote responses
- **Health monitoring** — 5-minute heartbeat loop; server marked offline after 3 consecutive failures, auto-recovers on next success
- **Config** — Set `VLMP_SERVER_NAME` and `VLMP_PUBLIC_URL` env vars for federation

## Supported Formats

**Video:** MKV, MP4, AVI, MOV, WMV, FLV, WebM, M4V, MPG, MPEG, TS, VOB, 3GP, OGV

**Audio:** MP3, M4A, FLAC, AAC, OGG, WMA, WAV, OPUS

**Direct play** (no transcode) requires: H.264/VP8/VP9/AV1 video + AAC/MP3/Opus/Vorbis/FLAC audio in MP4/WebM/M4V containers. Everything else is transcoded to HLS on-the-fly.

## Media Organization

VLMP classifies media by folder category. When adding a library folder, assign a category:

| Category | What it expects |
|----------|----------------|
| `movies` | `Title (Year).ext` or any standalone video |
| `tv` | Files with `S01E01`, `1x01` patterns; folders like `Season 1/` |
| `documentaries` | Single documentary files |
| `doc_series` | Documentary series with episode patterns |
| `education` | Numbered lessons (e.g., `01 - Introduction.mp4`) |
| `other` | Anything else |

## Database

SQLite with WAL journal mode for concurrent read/write. Tables include:

`users`, `sessions`, `library_folders`, `media_items`, `tv_shows`, `seasons`, `episodes`, `doc_series`, `doc_series_episodes`, `guest_passes`, `watch_progress`, `playlists`, `playlist_items`, `subtitles`, `metadata_cache`, `federated_servers`, `federation_invites`, `viewing_log`, `user_preferences`, `ai_cache`, `schema_version`

Database file: `data/vlmp.db`

## Roadmap

- [x] Phase 1 — Foundation (server, auth, scanner, library)
- [x] Phase 2 — Core Playback (direct play, HLS transcoding, player)
- [x] Phase 3 — Client UI (Netflix-like browse, search, responsive)
- [x] Phase 4 — Media Management (TMDb metadata, subtitles, playlists)
- [x] Phase 5 — Federation (HMAC auth, server linking, remote browse/play, heartbeat)
- [x] Phase 6 — Hardening (security headers, rate limiting, input validation, subtitle auth, a11y)
- [x] Phase 7 — AI Assistant (algorithmic recommendations, library health dashboard)

## License

Private project.
