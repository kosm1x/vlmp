import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { TranscodeProfile } from "./adaptive.js";

export interface TranscodeJob {
  process: ChildProcess;
  outputDir: string;
  profile: TranscodeProfile;
  startedAt: number;
}

export function startTranscode(
  inputPath: string,
  sessionId: string,
  profile: TranscodeProfile,
  config: Config,
  options?: { startTime?: number; audioTrack?: number },
): TranscodeJob {
  if (inputPath.startsWith("-")) throw new Error("Invalid input path");
  const outputDir = join(config.transcodeTmpDir, sessionId, profile.name);
  mkdirSync(outputDir, { recursive: true });
  const playlistPath = join(outputDir, "playlist.m3u8");
  const segmentPath = join(outputDir, "segment_%04d.ts");
  const args: string[] = ["-hide_banner", "-loglevel", "warning"];
  if (options?.startTime && options.startTime > 0)
    args.push("-ss", String(options.startTime));
  args.push(
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
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
  args.push(
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_list_size",
    "0",
    "-hls_segment_type",
    "mpegts",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    segmentPath,
    playlistPath,
  );
  const proc = spawn(config.ffmpegPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && (msg.includes("Error") || msg.includes("error")))
      console.error(`[transcode ${sessionId}/${profile.name}] ${msg}`);
  });
  return { process: proc, outputDir, profile, startedAt: Date.now() };
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
  outputDir: string,
  timeoutMs: number = 15000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (isPlaylistReady(outputDir)) resolve();
      else if (Date.now() - start > timeoutMs)
        reject(new Error("Timeout waiting for HLS playlist"));
      else setTimeout(check, 200);
    };
    check();
  });
}

export function waitForSegment(
  outputDir: string,
  segmentName: string,
  timeoutMs: number = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (isSegmentReady(outputDir, segmentName)) resolve();
      else if (Date.now() - start > timeoutMs)
        reject(new Error(`Timeout waiting for segment ${segmentName}`));
      else setTimeout(check, 300);
    };
    check();
  });
}
