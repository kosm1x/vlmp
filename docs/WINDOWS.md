# Running VLMP on Windows

The server is cross-platform Node.js — no build-step differences. This is the
runbook for a Windows box, plus the Windows-specific behavior notes and the
smoke-test checklist that gates the port (iOS server work is deferred until
this checklist passes on real hardware).

## Installer (recommended)

Download `vlmp-setup-<version>-win-x64.exe` from
<https://github.com/kosm1x/vlmp/releases> (v0.1.1 published 2026-07-20;
SmartScreen warns on unsigned installers — "More info → Run anyway").
v0.1.0 had a launcher ACL bug that left `jwt.secret` with an empty DACL on
the second start (EPERM at boot) — upgrade, or repair in place with
`icacls C:\ProgramData\vlmp\* /reset /t /c` from an elevated prompt.
Or build it from Linux/macOS: `installer/build.sh` → `installer/dist/vlmp-setup-<version>-win-x64.exe` (needs `apt install nsis`). It bundles the compiled server, web client, a portable Node.js runtime, production `node_modules` with win32 native bindings, and NSSM — FFmpeg is NOT bundled (the installer offers a winget install; VLMP warns at boot while it's missing).

What the installed app does differently from a manual setup:

- Data lives in `%ProgramData%\vlmp`, **ACL-locked to SYSTEM + Administrators** (standard users can otherwise create `vlmp.env` there and redirect `VLMP_FFMPEG_PATH` for a privileged process — the scripts fail closed if the lockdown can't be applied, e.g. non-NTFS volumes). Edit `vlmp.env` as Administrator.
- The JWT secret is generated on first run into `%ProgramData%\vlmp\jwt.secret` and read via `VLMP_JWT_SECRET_FILE` — never placed on a command line or in the service registry key.
- `start-vlmp.cmd` (Start Menu → "VLMP Server") self-elevates; "Install VLMP service" / "Remove VLMP service" shortcuts manage the NSSM service.
- Uninstall keeps `%ProgramData%\vlmp` (library DB, settings, backups).

The manual path below is for running from source.

## Prerequisites (manual setup)

```powershell
winget install OpenJS.NodeJS.LTS      # Node 22+
winget install Gyan.FFmpeg            # ffmpeg + ffprobe on PATH
```

Open a NEW terminal after installing so PATH updates apply, then verify:

```powershell
node --version    # >= 22
ffmpeg -version
ffprobe -version
```

If FFmpeg is installed somewhere not on PATH, set `VLMP_FFMPEG_PATH` /
`VLMP_FFPROBE_PATH` to the full `.exe` paths instead. The server logs a
`[preflight]` warning at boot if it can't resolve either binary.

## Setup

```powershell
git clone https://github.com/kosm1x/vlmp.git
cd vlmp
npm install        # compiles better-sqlite3 (needs VS Build Tools only if no prebuilt binary matches)
npm run build
```

Configuration via environment variables (set them in the service definition,
or a `.env` loaded by your shell). Minimum:

```powershell
$env:VLMP_JWT_SECRET = "<long random string>"
$env:VLMP_DATA_DIR   = "$env:LOCALAPPDATA\vlmp"   # DB, transcode tmp, subtitles, backups
$env:VLMP_PORT       = "8080"
npm start
```

First user to register becomes the admin; registration closes after that.
Add library folders in Settings using Windows paths (`D:\Media\Movies`).

## Run as a service (NSSM, manual setup)

Installer users: just run the "Install VLMP service" Start Menu shortcut — it
uses the bundled NSSM, a locked-down data dir, and `VLMP_JWT_SECRET_FILE`.
Manual equivalent:

```powershell
winget install NSSM.NSSM
nssm install vlmp "C:\Program Files\nodejs\node.exe" "C:\path\to\vlmp\dist\server\src\index.js"
nssm set vlmp AppDirectory "C:\path\to\vlmp"
nssm set vlmp AppEnvironmentExtra VLMP_JWT_SECRET=<secret> "VLMP_DATA_DIR=C:\ProgramData\vlmp"
nssm set vlmp AppStdout "C:\ProgramData\vlmp\logs\out.log"
nssm set vlmp AppStderr "C:\ProgramData\vlmp\logs\err.log"
nssm start vlmp
```

NSSM stops the process with a console Ctrl event, which triggers the server's
graceful shutdown (`SIGINT`/`SIGBREAK` are both handled).

## Firewall

Allow inbound on the chosen port for LAN clients:

```powershell
netsh advfirewall firewall add rule name="VLMP" dir=in action=allow protocol=TCP localport=8080
```

## Remote access (Tailscale)

The supported way to stream over the internet is a Tailscale tailnet — no
router changes, no public exposure, traffic is WireGuard-encrypted end to end:

1. Install Tailscale on the server box (`winget install tailscale.tailscale`),
   sign in, and note the machine name (e.g. `lullabysong`).
2. Install the Tailscale app on each phone/laptop/TV device and sign in to the
   same tailnet (family members join via a shared account or Tailscale's
   invite flow).
3. From any tailnet device, VLMP is at `http://<machine-name>:8080` — the
   installer's firewall rule already admits TCP 8080.

Limitations by design: devices must be on your tailnet, so **guest passes
can't be handed to strangers** — sharing with people outside the household
needs the public-exposure track (port forward + domain + TLS), which stays
deferred until after the smoke checklist and hardware transcoding work.

## Metadata / posters (TMDb)

Poster fetching is OFF until a TMDb API key is configured — the boot log says
`VLMP_TMDB_API_KEY not set` while it's missing. Get a free key at
<https://www.themoviedb.org/settings/api>, then as Administrator add to
`C:\ProgramData\vlmp\vlmp.env`:

```
VLMP_TMDB_API_KEY=<your key>
```

Restart VLMP. New scans match automatically; for media added before the key
existed, use the metadata rescan in Settings (or re-scan the folder).
Media TMDb can't match (personal recordings) get a frame-grab thumbnail
generated on first view instead.

## Windows-specific behavior notes

- **Transcode teardown**: FFmpeg can hold segment-file handles for a moment
  after being killed, so session-directory deletion retries once after 2s and
  anything left over is swept at next boot. Occasional
  `[boot] transcode-dir sweep incomplete` warnings after a hard kill are
  expected and self-heal.
- **Antivirus**: exclude `VLMP_DATA_DIR` (especially `transcode\` and
  `backups\`) from real-time scanning — AV file locks are the usual cause of
  EBUSY noise and slow segment serving.
- **`server.key` permissions**: on POSIX the federation key is written mode
  0600; Windows ignores POSIX modes and uses inherited ACLs. The installer's
  scripts lock `%ProgramData%\vlmp` to SYSTEM + Administrators automatically;
  in a manual setup keep `VLMP_DATA_DIR` under a user profile or apply
  restricted ACLs yourself if the box is multi-user.
- **Case-insensitive paths**: NTFS ignores case. Library folder paths are
  normalized on add, but don't add the same folder twice with different
  casing — SQLite's uniqueness check is case-sensitive.
- **Long paths**: media paths >260 chars need Windows long-path support
  enabled (`LongPathsEnabled` registry key) — Node handles them once the OS
  allows it.

## Smoke-test checklist (gates the port)

Run on the Windows box, in order:

1. `npm run typecheck && npm test` — full suite green on Windows
2. Boot: no `[preflight]` warnings, `VLMP server running` logged
3. Register first user → becomes admin; second registration rejected
4. Add a library folder with a `D:\...` path → scan finds media, no
   duplicate rows after a second scan
5. Drop a new file into the library while running → watcher picks it up with
   a well-formed path (check Settings/DB: no mixed `/`+`\` paths)
6. Direct play + transcode play both work; seek works
7. Stop playback → after ~2s the session's transcode dir is gone
8. Kill the process mid-transcode (Task Manager) → restart boots clean and
   sweeps the orphaned transcode dir
9. Subtitles: extract + display; `/subtitles/:m/:s/file` serves; a forged
   path outside the subtitle dir is rejected (403)
10. Backup file appears in `backups\` with a valid filename; retention prunes
11. Ctrl+C and `nssm stop vlmp` both shut down gracefully (DB checkpoint logged)
12. Empty trash on scan: delete a media file, rescan → row pruned; unplug the
    drive entirely, rescan → rows kept (all-missing guard)

Installer-specific additions:

13. Run `vlmp-setup-*.exe` → "Start VLMP now" opens an elevated console,
    <http://localhost:8080> loads, first registration becomes admin
14. `icacls C:\ProgramData\vlmp` shows ONLY SYSTEM + Administrators;
    `type C:\ProgramData\vlmp\jwt.secret` is non-empty (96 hex chars)
15. "Install VLMP service" shortcut → service running, UI still up after
    reboot; "Remove VLMP service" cleans it
16. Uninstall → app dir + shortcuts + firewall rule gone, ProgramData data kept

Anything failing here gets fixed before hardware transcoding (NVENC/QSV/AMF),
mDNS discovery, or TLS-without-Caddy are started — see
`docs/PLEX-CONFIG-REVIEW.md` for that deferred queue.
