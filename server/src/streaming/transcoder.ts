import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { TranscodeProfile } from "./adaptive.js";
import { getFfmpegCaps } from "./ffmpeg-caps.js";

export const SEGMENT_SECONDS = 6;
// 1.5x playback speed keeps the encoder comfortably ahead of the player
// without racing the whole file at max speed (the pre-v0.1.4 behavior pegged
// every core for minutes). The initial burst encodes the first 2 minutes
// unpaced so startup and near seeks stay instant.
const READRATE = 1.5;
const READRATE_BURST_SECONDS = 120;

export interface TranscodeJob {
  process: ChildProcess;
  outputDir: string;
  profile: TranscodeProfile;
  startedAt: number;
  /** First HLS segment number this job produces (0 unless a seek restart). */
  startNumber: number;
  /** Last time a playlist/segment request touched this job — reaper input. */
  lastAccessed: number;
  exited: boolean;
  exitCode: number | null;
}

export function startTranscode(
  inputPath: string,
  sessionId: string,
  profile: TranscodeProfile,
  config: Config,
  options?: { startTime?: number; audioTrack?: number; startNumber?: number },
): TranscodeJob {
  if (inputPath.startsWith("-")) throw new Error("Invalid input path");
  const outputDir = join(config.transcodeTmpDir, sessionId, profile.name);
  mkdirSync(outputDir, { recursive: true });
  const playlistPath = join(outputDir, "playlist.m3u8");
  const segmentPath = join(outputDir, "segment_%04d.ts");
  const args: string[] = ["-hide_banner", "-loglevel", "warning"];
  if (options?.startTime && options.startTime > 0)
    args.push("-ss", String(options.startTime));
  const caps = getFfmpegCaps(config.ffmpegPath);
  if (caps.readrate) {
    args.push("-readrate", String(READRATE));
    if (caps.readrateInitialBurst)
      args.push("-readrate_initial_burst", String(READRATE_BURST_SECONDS));
  }
  args.push(
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-preset",
    config.transcodePreset,
    "-tune",
    "film",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-b:v",
    profile.videoBitrate,
    "-maxrate",
    profile.maxRate,
    "-bufsize",
    profile.bufSize,
    "-pix_fmt",
    "yuv420p",
    `-vf`,
    `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`,
    "-c:a",
    "aac",
    "-b:a",
    profile.audioBitrate,
    "-ac",
    "2",
  );
  if (options?.audioTrack !== undefined)
    args.push("-map", "0:v:0", "-map", `0:a:${options.audioTrack}`);
  else args.push("-map", "0:v:0", "-map", "0:a:0?");
  const startNumber = options?.startNumber ?? 0;
  args.push(
    "-f",
    "hls",
    "-hls_time",
    String(SEGMENT_SECONDS),
    "-start_number",
    String(startNumber),
    "-hls_list_size",
    "0",
    "-hls_segment_type",
    "mpegts",
    // temp_file: write segments to .tmp then rename, so the existence checks
    // in waitForSegment/ensureSegmentReady can never see (and serve) a
    // half-written segment — paced encoding makes that race the NORMAL case
    // for near-frontier requests, not an edge.
    "-hls_flags",
    "independent_segments+temp_file",
    "-hls_segment_filename",
    segmentPath,
    playlistPath,
  );
  const proc = spawn(config.ffmpegPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const job: TranscodeJob = {
    process: proc,
    outputDir,
    profile,
    startedAt: Date.now(),
    startNumber,
    lastAccessed: Date.now(),
    exited: false,
    exitCode: null,
  };
  proc.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && (msg.includes("Error") || msg.includes("error")))
      console.error(`[transcode ${sessionId}/${profile.name}] ${msg}`);
  });
  // Without an error listener, a missing/renamed ffmpeg binary would emit an
  // unhandled 'error' event and take down the whole process.
  proc.on("error", (err) => {
    job.exited = true;
    job.exitCode = -1;
    console.error(
      `[transcode ${sessionId}/${profile.name}] spawn failed: ${err.message}`,
    );
  });
  proc.on("exit", (code) => {
    job.exited = true;
    job.exitCode = code;
    if (code !== 0 && code !== null)
      console.error(
        `[transcode ${sessionId}/${profile.name}] ffmpeg exited with code ${code}`,
      );
  });
  return job;
}

export function isPlaylistReady(outputDir: string): boolean {
  return existsSync(join(outputDir, "playlist.m3u8"));
}
export function isSegmentReady(
  outputDir: string,
  segmentName: string,
): boolean {
  return existsSync(join(outputDir, segmentName));
}

export function waitForPlaylist(
  job: TranscodeJob,
  timeoutMs: number = 15000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (isPlaylistReady(job.outputDir)) resolve();
      else if (job.exited)
        reject(new Error(`Transcode exited (code ${job.exitCode})`));
      else if (Date.now() - start > timeoutMs)
        reject(new Error("Timeout waiting for HLS playlist"));
      else setTimeout(check, 200);
    };
    check();
  });
}

export function waitForSegment(
  job: TranscodeJob,
  segmentName: string,
  timeoutMs: number = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (isSegmentReady(job.outputDir, segmentName)) resolve();
      else if (job.exited)
        reject(new Error(`Transcode exited (code ${job.exitCode})`));
      else if (Date.now() - start > timeoutMs)
        reject(new Error(`Timeout waiting for segment ${segmentName}`));
      else setTimeout(check, 300);
    };
    check();
  });
}
