<div align="center">

# VLMP — Very Light Media Player

**A featherweight, self-hosted media server.** One process, one SQLite file, a ~3KB web client with no build step, and HLS adaptive streaming. Runs on a Raspberry Pi, a $5 VPS, or an old laptop — and stays out of your way.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![Tests](https://img.shields.io/badge/tests-276%20passing-brightgreen.svg)

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

- **Adaptive bitrate streaming** — On-the-fly HLS transcoding via FFmpeg (1080p/720p/480p/360p)
- **Direct play** — Zero-transcode for browser-compatible formats (H.264 MP4, WebM, etc.)
- **Smart library scanning** — Recursive discovery with automatic classification (movies, TV, documentaries, education)
- **TV show hierarchy** — Automatic season/episode detection from filenames (`S01E01`, `1x01`)
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
# 1. Grab the compose file
curl -fsSL https://raw.githubusercontent.com/kosm1x/vlmp/master/docker-compose.yml -o docker-compose.yml

# 2. Set a real JWT secret and point it at your media
export VLMP_JWT_SECRET="$(openssl rand -hex 32)"
#    edit docker-compose.yml: mount your media folder at /media (read-only)

# 3. Up
docker compose up -d

# 4. Open http://localhost:8080 — the first account you register becomes admin
```

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

## Configuration

All configuration is via environment variables. The important ones:

| Variable            | Default                     | Description                                           |
| ------------------- | --------------------------- | ----------------------------------------------------- |
| `VLMP_PORT`         | `8080`                      | HTTP server port                                      |
| `VLMP_DATA_DIR`     | `./data`                    | Database + transcode cache                            |
| `VLMP_JWT_SECRET`   | `vlmp-dev-secret-change-me` | **Change this in production** (or use `_SECRET_FILE`) |
| `VLMP_TMDB_API_KEY` | _(empty)_                   | TMDb key for metadata enrichment                      |
| `VLMP_SERVER_NAME`  | `VLMP`                      | Display name in federation                            |
| `VLMP_PUBLIC_URL`   | _(empty)_                   | Public URL for federation linking                     |

The full list (transcode limits, free-disk floor, scheduled backups, x264 preset, empty-trash-on-scan) is documented in [`.env.example`](.env.example).

## Architecture

Node.js 22 + TypeScript + Fastify 5 on the server; SQLite (WAL) for state; FFmpeg for transcoding; Preact + HTM + HLS.js on the client. Federation is HMAC-SHA256 signed with a 300s replay window and proxies all remote traffic through the local server, so clients never talk to peers directly.

The full module map and REST API reference live in the source tree under [`server/src/`](server/src) — each subsystem (auth, scanner, streaming, federation, metadata, subtitles, recommendations) is its own directory with routes under `server/src/routes/`.

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
