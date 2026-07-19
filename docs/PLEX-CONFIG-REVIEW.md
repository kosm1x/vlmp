# Plex Server-Config Review — Adopt / Defer / Discard

Decision record (2026-07-19) ahead of the Windows server port (iOS-as-server
deferred until Windows is validated). Reviewed against Plex's live settings
taxonomy: General, Network, Library, Transcoder, Languages, Remote Access,
DLNA, Online Media Sources, Agents, Manage/Users, Scheduled Tasks, plus the
Plex-Pass extras. Grounding note: Plex's own doc pages block automated fetches
(Cloudflare 403), so option names come from the confirmed category list plus
working knowledge — exact current defaults not relied upon for these calls.

## Platform reality that shaped the calls

Plex assumes a host that can spawn processes. **iOS as a server cannot** —
the sandbox forbids `fork`/`exec` of arbitrary binaries, so the FFmpeg-CLI
transcoder and ffprobe scanner have no path there. Windows is a true server
port (ffmpeg.exe, a Windows Service, hardware encoders); iOS is treated as a
**client** for now (the web client is already OS-agnostic). An iOS-hosted
server later means rearchitecting the transcoder/scanner off `child_process`
onto an embedded libav framework — tracked, not attempted now.

## Adopted in this bundle (implemented)

| Plex option                                                         | vlmp implementation                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library viewability / searchability gate (simple, admin-controlled) | `is_visible` / `is_searchable` per library folder. Non-admins are limited to visible folders (browse, recent, TV, recommendations, continue-watching, search) and searchable ones (search only); detail + stream enforce it as a real 404 boundary. Admin sees/manages everything. Admin toggles in Settings → Library Folders → Access. `VLMP` env: none (per-folder DB flags). |
| Empty trash automatically after scan                                | `pruneMissingFiles` runs at end of each scan (renamed/deleted files no longer leave dead rows — closes the audit's add-only-scan gap). `VLMP_EMPTY_TRASH_ON_SCAN=false` disables.                                                                                                                                                                                                |
| Scheduled database backup                                           | `startBackupLoop` → online `db.backup()` (WAL-safe), retention-pruned. `VLMP_BACKUP_INTERVAL_HOURS` (default 24, 0 disables), `VLMP_BACKUP_RETENTION` (default 7). Closes the audit's no-backup gap.                                                                                                                                                                             |
| Transcoder quality / x264 preset                                    | `VLMP_TRANSCODE_PRESET` (default `veryfast`, validated against the x264 preset list).                                                                                                                                                                                                                                                                                            |
| Maximum simultaneous video transcodes                               | `VLMP_MAX_TRANSCODE_SESSIONS` (shipped earlier).                                                                                                                                                                                                                                                                                                                                 |
| Transcoder temporary directory                                      | `VLMP_DATA_DIR/transcode` (existing).                                                                                                                                                                                                                                                                                                                                            |
| Server friendly name                                                | `VLMP_SERVER_NAME` (existing).                                                                                                                                                                                                                                                                                                                                                   |

## Adopt — deferred (port-coupled or a discrete follow-up, each with a trigger)

| Plex option                                                                                                            | Verdict & trigger                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hardware-accelerated transcoding** (NVENC/QSV/AMF on Windows; VideoToolbox on Mac/iOS)                               | Highest-value port item. Needs platform encoders — **trigger: Windows port**. Software x264 until then.                                                                                          |
| **Transcoder throttle buffer** (pause encoder to stay ~N segments ahead of the playhead instead of racing to file-end) | Correct fix for the `-hls_list_size 0` disk-blowup finding. Mitigated for now by free-space floor + lazy per-profile start + boot sweep. **Trigger: its own bundle before general-use release.** |
| **Server discovery** (mDNS/Bonjour ≈ Plex GDM) so clients find the server on the LAN without typing an IP              | **Trigger: Windows port** (part of "general use").                                                                                                                                               |
| **Secure-connections story without a reverse proxy** (Plex auto-mints `*.plex.direct` certs)                           | Adopt the _concept_ (a "require HTTPS" setting); discard Plex's cert-minting mechanism. **Trigger: Windows port** (no Caddy there).                                                              |
| **Scan on change / periodic scan** (`watcher.ts` exists but isn't wired to auto-scan)                                  | **Trigger: next scanner bundle.**                                                                                                                                                                |
| **Scheduled-task maintenance window** (run heavy jobs only 2–6am)                                                      | Pairs with backup + any future thumbnail generation. **Trigger: when a second heavy scheduled task lands.**                                                                                      |
| **Per-user library restrictions** (Plex Home)                                                                          | The user chose a _simple global_ gate now, "nothing more complex." Per-user ACLs remain the most defensible richer feature to lift later. **Trigger: explicit request.**                         |
| **Preferred audio/subtitle language default**                                                                          | Cheap, low priority. **Trigger: languages/subtitle bundle.**                                                                                                                                     |
| BIF preview thumbnails / chapter thumbnails / intro-credits markers / loudness analysis                                | Nice for scrubbing but CPU/ML-heavy; would fight the transcode budget we just bounded. **Trigger: after hardware transcode lands.**                                                              |

## Discard — a different product than vlmp

- **Plex Relay / Remote-Access NAT traversal / port-mapping** — no relay infrastructure; self-host + reverse-proxy model covers reachability.
- **DLNA server** — second protocol surface for legacy TVs; out of scope for an HLS/web + native-app model.
- **Online Media Sources / Extras / Trailers / News** — vlmp is a private library, TMDb metadata only.
- **Camera Upload / Sync / Cloud / Optimized Versions** — mobile photo backup & pre-baked offline copies, out of scope.
- **Allow media deletion from disk** — keep DB-only folder removal; never delete users' actual files.
- **Legacy Agents/Scanners pluggability** — single TMDb path is sufficient (classifier accuracy is a separate bug track, not a config surface).
- **Send anonymous usage data** — against the self-hosted ethos.

## Windows-port checklist surfaced by this review (not config, but adjacent)

- FFmpeg/FFprobe as `.exe`; hardware-encoder detection.
- Windows Service wrapper; data dir under `%APPDATA%` conventions.
- Path handling: drive letters + backslashes in the scanner/classifier and the folder-path config (currently POSIX-assuming).
- TLS without Caddy (see deferred table).
- mDNS discovery (see deferred table).
