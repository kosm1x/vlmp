import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
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

export function thumbFile(config: Config, mediaId: number): string {
  return join(thumbDir(config), `${mediaId}.jpg`);
}

// A media file ffmpeg can't grab a frame from (corrupt, audio-only) would
// otherwise re-run ffmpeg on every browse render. The marker makes failure
// cheap; deleting the thumbs dir retries everything.
function failMarker(config: Config, mediaId: number): string {
  return join(thumbDir(config), `${mediaId}.fail`);
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
  const out = thumbFile(config, mediaId);
  // Marker FIRST: on Windows a killed ffmpeg can hold the truncated output
  // file open (EBUSY, undeletable for a moment) — the marker must win over
  // any leftover partial, or a broken image gets served forever.
  if (existsSync(failMarker(config, mediaId))) return null;
  if (fileHasContent(out)) return out;

  const row = db
    .prepare("SELECT file_path, duration FROM media_items WHERE id = ?")
    .get(mediaId) as { file_path: string; duration: number | null } | undefined;
  if (!row) return null;

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
    writeFileSync(failMarker(config, mediaId), "");
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
        proc.kill("SIGKILL");
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
