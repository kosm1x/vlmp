<div align="center">

# VLMP — Very Light Media Player

**A featherweight, self-hosted media server.** One process, one SQLite file, a ~3KB web client with no build step, and HLS adaptive streaming. Runs on a Raspberry Pi, a $5 VPS, or an old laptop — and stays out of your way.

[![CI](https://github.com/kosm1x/vlmp/actions/workflows/ci.yml/badge.svg)](https://github.com/kosm1x/vlmp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

</div>

---

## Why another media server?

I got tired of Plex's constant "improvements" pulling my own library further behind a cloud account, and Jellyfin never clicked for me. My library is several terabytes and I just wanted to reach _my_ catalog, anywhere, anytime — without a heavy .NET stack, without a build pipeline, without an account gateway between me and my own files.

So VLMP is deliberately small. The server does the heavy lifting (transcoding, metadata, scanning); the client is a thin Preact shell served straight from disk with its dependencies vendored locally — no CDN, works offline, auditable in an afternoon. If your homelab philosophy is "fewer moving parts," this is built for you.

## What this is — and isn't

**It is:**

- A single-process Node.js server + browser client for streaming your own media
- Lightweight enough to run comfortably on modest hardware
- Web-first: you watch in any modern browser, on any device with one
- Security-conscious: multiple adversarial audit passes, closed-membership auth, HMAC-signed federation (see [Security](#security))
- Federated: link your instance to a friend's and browse/play their library, NAT-safe and proxied

**It is not** (yet, and maybe not ever — set your expectations):

- A replacement for native TV apps. There is **no** Roku / Apple TV / Android TV / smart-TV client. You watch in a browser. If your primary need is a polished app _on the television_, Jellyfin or Plex will serve you better today.
- A hardware-transcode powerhouse. Software x264 transcoding works; GPU transcoding is roadmap, not reality.
- A commercial product with a support desk. This is a personal project shared in case it's useful. Best-effort support, no promises.

If that scope fits how you actually watch, welcome.

## Features

- **Adaptive bitrate streaming** — On-the-fly HLS transcoding via FFmpeg (1080p/720p/480p/360p); playback recovers from a transient segment hiccup instead of erroring out
- **Continuous playback** — Start a series or playlist and it plays through to the end, auto-advancing episode to episode (or a manual ⏭ to skip)
- **Direct play** — Zero-transcode for browser-compatible formats (H.264 MP4, WebM, etc.)
- **Smart library scanning** — Recursive discovery with automatic classification (movies, TV, documentaries, education); sample/trailer video clips shorter than 2 minutes are ignored (`VLMP_MIN_DURATION_SECONDS`, 0 disables; audio is never filtered)
- **Incremental metadata** — A metadata fetch only touches new/unmatched titles, not the whole library; unmatchable files are remembered so they aren't re-queried every run (`{"full": true}` forces a complete re-fetch)
- **Custom categories** — Create, rename, or delete your own nav categories (defaults included); each is "single titles" or "series". The category bar scrolls, so any number of them stays reachable
- **Playback has priority** — Streaming (HLS segments, direct play) is never rate-limited, so background work — a metadata fetch, browsing, a busy household — can't 429 what's playing (`VLMP_RATE_LIMIT_MAX` tunes the control-plane ceiling, default 600/min)
- **Series everywhere** — Season/episode detection from filenames (`S01E01`, `1x01`) and `Season N`/`Series N`/`Temporada N` folders, in ANY category — a Docs library can mix single documentaries with doc series; episodes group into show pages with per-season episode lists. Even episodes with no parseable number (bare titles, `E01`) still bundle under their show rather than scattering across the grid
- **Full category, your way** — A category page loads its entire library at once (cached for instant re-browsing, no paging) and sorts on demand by title, recently added, random, or liked-first
- **OpenSubtitles integration** — Subtitle availability shown on every detail page; search and apply subtitles from opensubtitles.com in two clicks (free API key required)
- **Watch progress** — Resume where you left off, "Continue Watching" row
- **Guest passes** — Share a single item with time-limited, view-limited codes
- **Closed-membership auth** — First registration bootstraps the admin, then registration closes; admin provisions accounts; per-request role re-check for instant revocation
- **TMDb metadata** — Posters, backdrops, descriptions, ratings, genres
- **Thumbnails for personal media** — Anything TMDb can't match gets an FFmpeg frame-grab thumbnail, generated on first view
- **Subtitle extraction** — On-demand VTT extraction from embedded tracks (scan-time pre-extraction opt-in)
- **Playlists** — User-owned, add/remove/reorder
- **Server federation** — Link instances to browse and play remote media, all proxied (NAT-safe), HMAC-SHA256 signed with replay protection
- **Algorithmic recommendations** — 5-strategy engine (next episode, collaborative filtering, genre matching, similar items, popularity) with **no external AI APIs**
- **Library health dashboard** — 8 checks (missing files, zero-byte, metadata gaps, no subtitles, codec/resolution analysis, orphans, duplicates) with admin cleanup
- **Ultra-light client** — Preact + HTM vendored locally (~3KB framework, no build step, works offline)

## Quick start

### Docker (recommended)

```bash
# 1. Get the repo (the compose file builds the image from source)
git clone https://github.com/kosm1x/vlmp.git
cd vlmp

# 2. Set a real JWT secret and point it at your media
export VLMP_JWT_SECRET="$(openssl rand -hex 32)"
#    edit docker-compose.yml: mount your media folder at /media (read-only)

# 3. Up — builds the image on first run
docker compose up -d --build

# 4. Open http://localhost:8080 — the first account you register becomes admin
```

**Updating:** once release images are published to GHCR, `docker compose pull && docker compose up -d` switches you to them. The explicit `pull` matters — a local build is tagged with that same `ghcr.io/kosm1x/vlmp:latest` name, so a plain `up -d` would keep reusing your own image instead.

**Pinning a version.** VLMP uses a 4-part `MAJOR.MINOR.PATCH.BUILD` scheme ([why](CONTRIBUTING.md#versioning)). Each release publishes its own exact tags and advances the shorter ones, so you choose how much drift you accept. **How many dot-parts a tag has tells you whether it moves:**

| Tag          | Example    | Moves?                                   |
| ------------ | ---------- | ---------------------------------------- |
| `v<version>` | `v0.1.9.4` | Never — the git tag verbatim             |
| Four parts   | `0.1.9.4`  | Never — a pointer is never four parts    |
| Three parts  | `0.1.9`    | To the newest build on that patch line   |
| Two parts    | `0.1`      | To the newest release on that minor line |
| `latest`     | —          | To the newest release overall            |

For a fully immutable pin use `v0.1.9.4` or the four-part `0.1.9.4`. Note the overlap: a release tagged with only three parts (`v0.2.0`) publishes `0.2.0`, and that same name later becomes the patch-line pointer when `v0.2.0.1` ships — so prefer the `v`-prefixed tag if you want a name that can never be reused.

Pointers only ever move forward, and pre-releases (`-rc.N`) never take one.

**Verifying a release image.** Once release images are published to GHCR they will carry a SLSA provenance attestation and an SBOM, so you won't have to take the tag's word for what you're running:

```bash
# Which commit and workflow built it, and what's inside
docker buildx imagetools inspect ghcr.io/kosm1x/vlmp:latest --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/kosm1x/vlmp:latest --format '{{ json .SBOM }}'
```

Images are multi-arch, so both fields come back keyed by platform. For one architecture: `--format '{{ json (index .SBOM "linux/amd64").SPDX }}'`.

The provenance names the source repository, commit SHA and the workflow run that produced the image. Only tags built by [`release.yml`](.github/workflows/release.yml) carry it, and `:latest` is only ever moved to the newest non-pre-release tag.

### From source

```bash
git clone https://github.com/kosm1x/vlmp.git
cd vlmp
npm install
npm run dev          # dev server with auto-reload
# open http://localhost:8080 and register the first (admin) user
```

Requires **Node.js >= 22** and **FFmpeg + FFprobe** in your `$PATH`.

### Windows

Grab `vlmp-setup-<version>-win-x64.exe` from the [releases page](https://github.com/kosm1x/vlmp/releases) — self-contained (bundles the Node runtime + a service helper, offers to install FFmpeg). Details in [docs/WINDOWS.md](docs/WINDOWS.md).

## Reaching it from anywhere (safely)

VLMP binds to your LAN by default. To get "anywhere, anytime" **do not port-forward it raw to the internet** — put it behind something:

- **Easiest & safest:** a mesh VPN like [Tailscale](https://tailscale.com) or [WireGuard](https://www.wireguard.com). Your devices join a private network; the server is never publicly exposed.
- **Public with TLS:** a reverse proxy that terminates HTTPS — [Caddy](https://caddyserver.com) (automatic Let's Encrypt) or nginx — in front of VLMP. Or a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to avoid opening any inbound port.

Native TLS inside VLMP is on the roadmap but not shipped; today, terminate TLS at the proxy.

**If you use a reverse proxy, set `VLMP_TRUST_PROXY`.** Without it every request appears to come from the proxy's address, so all your users share one rate-limit bucket — a busy household can 429 itself, and the per-route login limits stop distinguishing between clients. With it, `X-Forwarded-For` is used and limits apply per real client:

```bash
# Proxy and VLMP both on the host:
VLMP_TRUST_PROXY=loopback
# Proxy on the host, VLMP in Docker: requests arrive from the bridge gateway
# (e.g. 172.17.0.1), NOT 127.0.0.1 — so loopback would match nothing. Name the
# gateway exactly; `docker network inspect bridge` prints it.
VLMP_TRUST_PROXY=172.17.0.1
```

Accepts `loopback`, `linklocal`, `uniquelocal`, an address or CIDR list, or a hop count. A value it can't parse is **ignored with an error** — it will never fall back to trusting.

**Name the proxy as narrowly as you can, and make sure it really is the only route in.** Two ways to get this wrong:

- **Too broad.** `uniquelocal` covers `10/8`, `172.16/12` and `192.168/16` — on a home network that is _every client_, not just your proxy. Likewise `VLMP_TRUST_PROXY=true` trusts any upstream whatsoever.
- **Not actually behind the proxy.** The compose file publishes `8080` on all interfaces, so anything on your LAN can also reach VLMP directly, skipping the proxy. If a host proxy fronts it, bind the port to loopback so it can't: `ports: - "127.0.0.1:8080:8080"`.

Either mistake hands rate limiting to the client. `X-Forwarded-For` is just a header a client can write, so a request that reaches VLMP from a trusted address can claim any identity it likes — forging a fresh one per request defeats the global limiter and the login brute-force caps alike. Leave it **unset** if VLMP is reachable directly; unset is strictly safer than wrong.

## Configuration

All configuration is via environment variables. The important ones:

| Variable                     | Default                     | Description                                           |
| ---------------------------- | --------------------------- | ----------------------------------------------------- |
| `VLMP_PORT`                  | `8080`                      | HTTP server port                                      |
| `VLMP_DATA_DIR`              | `./data`                    | Database + transcode cache                            |
| `VLMP_JWT_SECRET`            | `vlmp-dev-secret-change-me` | **Change this in production** (or use `_SECRET_FILE`) |
| `VLMP_TMDB_API_KEY`          | _(empty)_                   | TMDb key for metadata enrichment                      |
| `VLMP_OPENSUBTITLES_API_KEY` | _(empty)_                   | opensubtitles.com key for subtitle search/download    |
| `VLMP_SERVER_NAME`           | `VLMP`                      | Display name in federation                            |
| `VLMP_PUBLIC_URL`            | _(empty)_                   | Public URL for federation linking                     |
| `VLMP_TRUST_PROXY`           | _(off)_                     | Trust `X-Forwarded-For` — set only behind a proxy     |

The full list (transcode limits, free-disk floor, sample-duration floor, scheduled backups, x264 preset, empty-trash-on-scan) is documented in [`.env.example`](.env.example).

## Device discovery (`GET /api/info`)

VLMP exposes a **public, no-auth** endpoint for clients and TV apps to identify the server before login:

```
GET /api/info
```

```json
{
  "name": "My VLMP",
  "version": "0.1.9.8",
  "publicUrl": "https://vlmp.example.com",
  "fingerprint": "vlmp-a3f2b1",
  "capabilities": ["hls", "subtitles", "playlists", "federation"]
}
```

This is the preferred handshake for future native clients — scan the local network for `/api/info`, get a fingerprint, then prompt for credentials. No credentials are exposed: `fingerprint` is a SHA-256-derived public ID, not the private federation key. `capabilities` reflect live config — `subtitle-search` is added when an OpenSubtitles key is set.

---

## Resource footprint

VLMP is built to run on modest hardware — a Raspberry Pi 4, a spare laptop, a $5 VPS. Representative numbers running v0.1.9 on a 2-core / 2 GB VPS serving a ~1 TB library:

| State                     | RSS         | Notes                                      |
| ------------------------- | ----------- | ------------------------------------------ |
| Idle (no active playback) | ~60–80 MB   | Server + SQLite in WAL mode                |
| 1 HLS transcode session   | ~120–160 MB | FFmpeg child process included              |
| 4 concurrent HLS sessions | ~300–400 MB | At `VLMP_MAX_TRANSCODE_SESSIONS=4` default |

For comparison: Jellyfin (non-hardware transcode) typically idles at 200–400 MB and scales steeply with sessions. Plex Media Server (free tier, software transcode) idles at ~300–500 MB. VLMP has no background agents, no analytics, no daemon processes — one Node process and the FFmpeg children it spawns on demand.

> **Note:** Transcoding is CPU-bound. A single x264 session at `veryfast` preset fits comfortably on a Raspberry Pi 4 at 720p. 1080p on a Pi 4 may stutter; tune `VLMP_TRANSCODE_PRESET` to `ultrafast` or use direct play where possible.

---

## Architecture

Node.js 22 + TypeScript + Fastify 5 on the server; SQLite (WAL) for state; FFmpeg for transcoding; Preact + HTM + HLS.js on the client. Federation is HMAC-SHA256 signed with a 300s replay window and proxies all remote traffic through the local server, so clients never talk to peers directly.

The full module map and REST API reference live in the source tree under [`server/src/`](server/src) — each subsystem (auth, scanner, streaming, federation, metadata, subtitles, recommendations) is its own directory with routes under `server/src/routes/`.

## Roadmap

### v0.2 — In progress

| Feature                                                                | Status                   |
| ---------------------------------------------------------------------- | ------------------------ |
| **Lumiere Dark** — polished dark-mode reskin (home, library, player)   | 🔧 In progress           |
| **Native TV client scaffold** — groundwork for Android TV / Apple TV   | 🔲 Planned               |
| **GPU transcoding** — NVENC / VAAPI / VideoToolbox                     | 🔲 Planned               |
| **Native TLS** — terminate HTTPS inside VLMP (no reverse proxy needed) | 🔲 Planned               |
| **`/api/info` device discovery** ✅                                    | Shipped in v0.1.9 branch |

### Shipped in v0.1.x

- v0.1.9.8 — Security: fast-uri 3.1.4 + brace-expansion 5.0.8 (npm audit now clean)
- v0.1.9.7 — Security: fastify 5.10 / @fastify/static 10 (closes the high-severity advisories); kill guards use real liveness
- v0.1.9.6 — Startup failures exit non-zero; ffmpeg 7.1 (transcode pacing now applies); no signalling of reaped PIDs
- v0.1.9.5 — CI hang made diagnosable: bounded test step, logs survive the failure
- v0.1.9.4 — Auto-fallback direct-play → transcode + sub-360p fix
- v0.1.9.3 — Re-probe null-codec files on first play
- v0.1.9.2 — Rate-limit fix: data plane (HLS, thumbnails) exempt; control-plane 600/min
- v0.1.9.1 — Incremental metadata, HLS retry, continuous play (auto-advance)
- v0.1.9 — Bundle unnumbered series, sortable full-library grids
- v0.1.8 — Server federation, algorithmic recommendations, library health dashboard

---

## Contributing

This is primarily a personal project, but issues and PRs are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first — it sets honest expectations on scope and response times.

## Security

Found a vulnerability? Please **do not** open a public issue. See [SECURITY.md](SECURITY.md) for the private disclosure process. VLMP has been through multiple adversarial audit passes; findings and the deferred queue live in `docs/`.

## License

[Apache License 2.0](LICENSE). You can use, modify, and redistribute it freely, including commercially, with attribution and the patent grant intact. See [NOTICE](NOTICE) for attribution details.

---

<div align="center">
<sub>Built as an exercise in doing more with less. If it's useful to you, that's a bonus.</sub>
</div>
