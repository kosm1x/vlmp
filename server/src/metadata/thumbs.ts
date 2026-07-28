import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isProcessAlive } from "../process-liveness.js";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";

// Frame-grab thumbnails for media TMDb can't match (personal recordings,
// home video). Generated lazily on first request, cached on disk forever.
// Fast-seek (-ss before -i) reads only a few MB, so this is safe against the
// scan-saturation problem that killed scan-time subtitle extraction.

const GRAB_TIMEOUT_MS = 30_000;
const THUMB_WIDTH = 500; // matches the TMDb w500 posters the UI already uses

function thumbDir(config: Config): string {
  return join(config.dataDir, "thumbs");
}

// Thumbs are keyed by the media FILE's path, never the row id: media_items.id
// is a plain rowid (no AUTOINCREMENT), so SQLite hands a deleted row's id to
// the next insert — an id-keyed cache re-attached a deleted category's frames
// to whatever new media inherited the id. A path key cannot dangle across
// rows, and re-adding the same folder later reuses its thumbs for free.
function thumbKey(mediaFilePath: string): string {
  return createHash("sha256").update(mediaFilePath).digest("hex").slice(0, 16);
}

export function thumbFile(config: Config, mediaFilePath: string): string {
  return join(thumbDir(config), `${thumbKey(mediaFilePath)}.jpg`);
}

// A media file ffmpeg can't grab a frame from (corrupt, audio-only) would
// otherwise re-run ffmpeg on every browse render. The marker makes failure
// cheap; deleting the thumbs dir retries everything.
function failMarker(config: Config, mediaFilePath: string): string {
  return join(thumbDir(config), `${thumbKey(mediaFilePath)}.fail`);
}

// Boot-time hygiene: pre-path-keying thumbs were `<rowid>.jpg`/`<rowid>.fail`.
// Under path keying they are unreachable — but they are exactly the poisoned
// artifacts of the id-reuse bug, so delete them rather than carry them
// forever. Best-effort; returns how many files went.
export async function sweepLegacyThumbs(config: Config): Promise<number> {
  let names: string[];
  try {
    names = await readdir(thumbDir(config));
  } catch {
    return 0; // no thumbs dir yet
  }
  let removed = 0;
  for (const name of names) {
    // 1-15 digits only: a 16-hex path key is all-decimal for ~1 in 1900
    // thumbs, and \d+ would delete those valid files on every boot.
    if (!/^\d{1,15}\.(jpg|fail)$/.test(name)) continue;
    try {
      await unlink(join(thumbDir(config), name));
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

// Concurrent browse renders request the same thumb in parallel — dedupe so
// each media id runs at most one ffmpeg at a time.
const inFlight = new Map<number, Promise<string | null>>();

// ...and a global cap on top: the category grid renders 60 cards at once, so
// a first browse of a poster-less library would otherwise fan out 60
// concurrent ffmpeg processes and peg every core. Grabs are ~1s each; a small
// pool drains the burst quickly without competing with playback transcodes.
const MAX_CONCURRENT_GRABS = 2;
let activeGrabs = 0;
const grabWaiters: Array<() => void> = [];

async function acquireGrabSlot(): Promise<void> {
  while (activeGrabs >= MAX_CONCURRENT_GRABS)
    await new Promise<void>((resolve) => grabWaiters.push(resolve));
  activeGrabs++;
}

function releaseGrabSlot(): void {
  activeGrabs--;
  grabWaiters.shift()?.();
}

export function getOrCreateThumb(
  db: Database.Database,
  mediaId: number,
  config: Config,
): Promise<string | null> {
  const existing = inFlight.get(mediaId);
  if (existing) return existing;
  const task = generate(db, mediaId, config).finally(() =>
    inFlight.delete(mediaId),
  );
  inFlight.set(mediaId, task);
  return task;
}

async function generate(
  db: Database.Database,
  mediaId: number,
  config: Config,
): Promise<string | null> {
  // Row FIRST: the cache key is derived from the row's file_path, so the
  // lookup must precede any disk check (this ordering is also what makes a
  // recycled row id incapable of serving another file's cached frame).
  const row = db
    .prepare("SELECT file_path, duration FROM media_items WHERE id = ?")
    .get(mediaId) as { file_path: string; duration: number | null } | undefined;
  if (!row) return null;

  const out = thumbFile(config, row.file_path);
  // Marker before content: on Windows a killed ffmpeg can hold the truncated
  // output file open (EBUSY, undeletable for a moment) — the marker must win
  // over any leftover partial, or a broken image gets served forever.
  if (existsSync(failMarker(config, row.file_path))) return null;
  if (fileHasContent(out)) return out;

  mkdirSync(thumbDir(config), { recursive: true });

  // 10% in avoids studio logos and black intro frames; clamp so very long
  // recordings don't seek an hour deep and shorts don't seek past the end.
  const duration = row.duration || 0;
  const seek = Math.max(1, Math.min(Math.floor(duration * 0.1), 600));

  await acquireGrabSlot();
  let ok: boolean;
  try {
    ok = await runFFmpeg(config.ffmpegPath, [
      "-nostdin",
      "-ss",
      String(seek),
      "-i",
      row.file_path,
      "-frames:v",
      "1",
      "-vf",
      `scale=${THUMB_WIDTH}:-2`,
      "-q:v",
      "4",
      "-y",
      out,
    ]);
  } finally {
    releaseGrabSlot();
  }
  // ffmpeg can exit 0 yet write nothing (e.g. seek past EOF on a short file),
  // and a killed ffmpeg can leave a truncated file — both count as failure.
  if (ok && fileHasContent(out)) return out;
  try {
    rmSync(out, { force: true });
  } catch {
    /* EBUSY on Windows while the killed ffmpeg's handle lingers — the fail
       marker below outranks the leftover partial, so serving stays correct */
  }
  try {
    writeFileSync(failMarker(config, row.file_path), "");
  } catch {
    /* marker is best-effort */
  }
  return null;
}

// Throw-safe "exists and non-empty" — the file can vanish between an exists
// check and a stat (TOCTOU), and stat itself can fail on a locked file.
function fileHasContent(p: string): boolean {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

function runFFmpeg(ffmpegPath: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { stdio: "ignore" });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        // Liveness, not the local flag — see streaming/transcoder.ts.
        if (isProcessAlive(proc)) proc.kill("SIGKILL");
        resolve(false);
      }
    }, GRAB_TIMEOUT_MS);
    timer.unref();
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        resolve(code === 0);
      }
    });
    proc.on("error", () => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        resolve(false);
      }
    });
  });
}
