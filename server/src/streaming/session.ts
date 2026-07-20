import { existsSync, readdirSync, rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { TranscodeProfile } from "./adaptive.js";
import {
  startTranscode,
  waitForSegment,
  SEGMENT_SECONDS,
  type TranscodeJob,
} from "./transcoder.js";

export interface TranscodeOptions {
  startTime?: number;
  audioTrack?: number;
}

export interface StreamSession {
  id: string;
  mediaId: number;
  filePath: string;
  userId: string;
  profiles: TranscodeProfile[];
  jobs: Map<string, TranscodeJob>;
  createdAt: number;
  lastAccessed: number;
  directPlay: boolean;
  transcodeOptions?: TranscodeOptions;
}

const sessions = new Map<string, StreamSession>();
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
// A profile job nobody has requested a playlist/segment from in this long is
// an abandoned ABR rung (hls.js switched levels and never came back) — kill
// the encoder. The job entry stays: its segments remain servable from disk,
// and a later request revives it via the seek-restart path.
const JOB_IDLE_MS = 3 * 60 * 1000;
// A requested segment this close past the encode frontier is the player
// buffering ahead of a live-but-behind encoder (readrate 1.5 writes a 6s
// segment every 4s; an encoder that can't sustain 1.5x lags further) —
// waiting beats killing and respawning ffmpeg, which would thrash on any
// box where the encode itself is the bottleneck. Beyond this it's a real
// seek: restart at the position.
const WAIT_ZONE_SEGMENTS = 10;
// A freshly (re)started encoder has produced nothing yet — segments this
// close to its start point are coming; don't let racing requests thrash it.
const RESTART_SLACK_SEGMENTS = 3;
// Server-side segment wait must stay under hls.js's ~20s fragment timeout,
// or the client aborts/retries while we're still holding its request.
const SEGMENT_WAIT_MS = 15_000;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

// Direct-play sessions are cheap (file reads); only transcode sessions spawn
// ffmpeg, so only they count against the cap.
function transcodeSessionCount(): number {
  let count = 0;
  for (const s of sessions.values()) if (!s.directPlay) count++;
  return count;
}

/** Returns false when the transcode volume is below the configured free-space floor. */
export async function hasEnoughDiskSpace(config: Config): Promise<boolean> {
  try {
    const s = await statfs(config.transcodeTmpDir);
    return s.bavail * s.bsize >= config.minFreeDiskBytes;
  } catch {
    return true; // statfs failure must not block playback
  }
}

/** Returns null when the transcode-session cap is reached (caller should 503). */
export function createSession(
  config: Config,
  mediaId: number,
  filePath: string,
  userId: string,
  profiles: TranscodeProfile[],
  directPlay: boolean,
  transcodeOptions?: TranscodeOptions,
): StreamSession | null {
  if (!directPlay && transcodeSessionCount() >= config.maxTranscodeSessions)
    return null;
  // 128-bit CSPRNG session ID — acts as capability token for unauthenticated HLS endpoints
  const id = randomBytes(16).toString("hex");
  const session: StreamSession = {
    id,
    mediaId,
    filePath,
    userId,
    profiles,
    jobs: new Map(),
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    directPlay,
    transcodeOptions,
  };
  sessions.set(id, session);
  startCleanupTimer();
  return session;
}

export function getSession(id: string): StreamSession | undefined {
  const session = sessions.get(id);
  if (session) session.lastAccessed = Date.now();
  return session;
}

export function startProfileTranscode(
  session: StreamSession,
  profileName: string,
  config: Config,
  atSegment?: number,
): TranscodeJob | null {
  const profile = session.profiles.find((p) => p.name === profileName);
  if (!profile) return null;
  const existing = session.jobs.get(profileName);
  if (existing && !existing.process.killed) existing.process.kill("SIGTERM");
  // Seek restart: segment numbers are absolute on the session's timeline
  // (which itself starts at the resume offset), so the ffmpeg input seek
  // composes the session's startTime with the segment offset, and
  // -start_number keeps the new playlist aligned with what hls.js expects.
  const base = session.transcodeOptions ?? {};
  const opts =
    atSegment !== undefined && atSegment > 0
      ? {
          ...base,
          startTime: (base.startTime ?? 0) + atSegment * SEGMENT_SECONDS,
          startNumber: atSegment,
        }
      : base;
  const job = startTranscode(
    session.filePath,
    session.id,
    profile,
    config,
    opts,
  );
  session.jobs.set(profileName, job);
  return job;
}

const SEGMENT_NUMBER = /^segment_(\d{4})\.ts$/;

function encodeFrontier(outputDir: string): number {
  try {
    let max = -1;
    for (const f of readdirSync(outputDir)) {
      const m = SEGMENT_NUMBER.exec(f);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    return max;
  } catch {
    return -1;
  }
}

/**
 * Resolve a segment request against a paced encoder: serve what's on disk,
 * wait when the encoder is about to produce it, and restart ffmpeg at the
 * requested position when it isn't (far-forward seek, rewind past a previous
 * restart point, or a dead/reaped job). Resolves to the segment path;
 * rejects when the segment can't be made available.
 */
export async function ensureSegmentReady(
  session: StreamSession,
  profileName: string,
  segmentName: string,
  config: Config,
  waitMs: number = SEGMENT_WAIT_MS,
): Promise<string> {
  let job = session.jobs.get(profileName);
  if (!job) throw new Error("Profile not started");
  job.lastAccessed = Date.now();
  const segmentPath = join(job.outputDir, segmentName);
  if (existsSync(segmentPath)) return segmentPath;
  const m = SEGMENT_NUMBER.exec(segmentName);
  if (!m) throw new Error("Invalid segment name");
  const n = parseInt(m[1], 10);
  const frontier = encodeFrontier(job.outputDir);
  // A job started moments ago hasn't written anything yet — give it the
  // benefit of the doubt for segments near its start instead of thrashing
  // kill/respawn when concurrent requests race a fresh restart.
  const fresh = Date.now() - job.startedAt < 10_000;
  const producible =
    !job.exited &&
    n >= job.startNumber &&
    (n <= frontier + WAIT_ZONE_SEGMENTS ||
      (fresh && n <= job.startNumber + RESTART_SLACK_SEGMENTS));
  let restarted = false;
  if (!producible) {
    job = startProfileTranscode(session, profileName, config, n) ?? job;
    restarted = true;
  }
  try {
    await waitForSegment(job, segmentName, waitMs);
  } catch (err) {
    // A "producible" wait that still failed means the encoder wedged without
    // exiting (frozen frontier), died mid-wait, or the request sits deep in
    // the wait zone after a small seek. The reaper can't rescue any of these
    // — this very request refreshed lastAccessed — so restart at the
    // position, once. A wait that already follows a restart stays failed.
    if (restarted) throw err;
    job = startProfileTranscode(session, profileName, config, n) ?? job;
    await waitForSegment(job, segmentName, waitMs);
  }
  return segmentPath;
}

export function destroySession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  for (const job of session.jobs.values()) {
    if (!job.process.killed) job.process.kill("SIGTERM");
  }
  const firstJob = session.jobs.values().next().value;
  if (firstJob) {
    const sessionDir = join(firstJob.outputDir, "..");
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Windows: ffmpeg holds segment handles for a beat after kill(), so the
      // immediate rm routinely fails EBUSY. One delayed retry; anything still
      // stuck is caught by the boot-time sweep.
      setTimeout(() => {
        try {
          rmSync(sessionDir, { recursive: true, force: true });
        } catch {
          /* boot sweep will get it */
        }
      }, 2000).unref();
    }
  }
  sessions.delete(id);
}

export function getActiveSessions(): StreamSession[] {
  return Array.from(sessions.values());
}
export function getSessionCount(): number {
  return sessions.size;
}

function cleanupIdleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccessed > IDLE_TIMEOUT_MS) destroySession(id);
  }
  // Reap encoders for ABR rungs the player abandoned (job untouched while the
  // session itself stays live). Segments already on disk keep serving; a
  // later request revives the encoder via ensureSegmentReady. SIGKILL, not
  // SIGTERM: a SIGTERM'd ffmpeg finalizes the HLS muxer and writes
  // #EXT-X-ENDLIST into the frozen playlist, which a returning player reads
  // as "stream over" and stops — leaving the playlist un-finalized keeps it
  // live so segment requests past the frontier trigger the restart path.
  for (const session of sessions.values()) {
    for (const job of session.jobs.values()) {
      if (
        !job.exited &&
        !job.process.killed &&
        now - job.lastAccessed > JOB_IDLE_MS
      )
        job.process.kill("SIGKILL");
    }
  }
  if (sessions.size === 0 && cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

function startCleanupTimer(): void {
  if (!cleanupInterval)
    cleanupInterval = setInterval(cleanupIdleSessions, 60_000);
}

export function destroyAllSessions(): void {
  for (const id of sessions.keys()) destroySession(id);
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
