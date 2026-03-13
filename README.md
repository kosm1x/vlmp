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
- **Ultra-light client** — Preact + HTM loaded from CDN (~3KB framework), no build step
- **Dark Netflix-like UI** — Responsive grid layout with category browsing and search

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
│   │   ├── index.ts          # SQLite singleton (WAL mode, FK enforcement)
│   │   └── schema.ts         # 17 tables, 8 indexes
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
│   └── routes/
│       ├── auth.ts           # Register, login, guest pass endpoints
│       ├── library.ts        # Browse, search, TV shows, admin folder management
│       ├── metadata.ts       # TMDb search proxy, match, batch scan
│       ├── subtitles.ts      # Subtitle list, file serving, manual extraction
│       ├── playlists.ts      # Playlist CRUD, item management, reorder
│       ├── playback.ts       # Stream start, HLS manifests/segments, direct play
│       └── progress.ts       # Watch progress save/resume
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
│           └── PlaylistDetail.js # Single playlist view with items
└── server/tests/             # 86 unit tests (vitest)
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
| GET | `/subtitles/:mediaId/:subtitleId/file` | Serve VTT file |

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

`users`, `sessions`, `library_folders`, `media_items`, `tv_shows`, `seasons`, `episodes`, `doc_series`, `doc_series_episodes`, `guest_passes`, `watch_progress`, `playlists`, `playlist_items`, `subtitles`, `metadata_cache`, `federated_servers`, `schema_version`

Database file: `data/vlmp.db`

## Roadmap

- [x] Phase 1 — Foundation (server, auth, scanner, library)
- [x] Phase 2 — Core Playback (direct play, HLS transcoding, player)
- [x] Phase 3 — Client UI (Netflix-like browse, search, responsive)
- [x] Phase 4 — Media Management (TMDb metadata, subtitles, playlists)
- [ ] Phase 5 — Sharing & Federation (server linking, remote play)
- [ ] Phase 6 — Hardening (HTTPS, logging, security audit)
- [ ] Phase 7 — AI Assistant (library health, recommendations)

## License

Private project.
