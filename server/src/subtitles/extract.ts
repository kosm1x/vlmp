import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { isProcessAlive } from "../process-liveness.js";
import type { Config } from "../config.js";
import type { SubtitleTrack } from "../scanner/probe.js";

// Extraction demuxes the ENTIRE container (unlike ffprobe, which reads
// headers), so the bound must accommodate a big file on a slow network mount.
// 15 minutes is far past any healthy extract; past it we assume the mount or
// drive is wedged — the case that otherwise strands the folder at
// scan_status='scanning' forever, since library.ts awaits this in-line.
const EXTRACT_TIMEOUT_MS = 15 * 60_000;

export interface ExtractedSubtitle {
  language: string | null;
  label: string | null;
  format: string;
  file_path: string;
}

const BITMAP_CODECS = ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"];

export async function extractSubtitles(
  mediaPath: string,
  mediaId: number,
  subtitleTracks: SubtitleTrack[],
  config: Config,
): Promise<ExtractedSubtitle[]> {
  const outDir = resolve(config.subtitleDir, String(mediaId));
  mkdirSync(outDir, { recursive: true });

  const results: ExtractedSubtitle[] = [];

  for (const track of subtitleTracks) {
    if (BITMAP_CODECS.includes(track.codec)) {
      continue;
    }

    const lang = track.language || "und";
    const outFile = resolve(outDir, `${lang}_${track.index}.vtt`);

    try {
      await runFFmpegExtract(
        mediaPath,
        track.index,
        outFile,
        config.ffmpegPath,
      );
      results.push({
        language: track.language,
        label: track.title || track.language,
        format: "vtt",
        file_path: outFile,
      });
    } catch {
      // Skip tracks that fail to extract
    }
  }

  return results;
}

function runFFmpegExtract(
  input: string,
  trackIndex: number,
  output: string,
  ffmpegPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      "-y",
      "-i",
      input,
      "-map",
      `0:s:${trackIndex}`,
      "-c:s",
      "webvtt",
      output,
    ]);
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      if (!killed) {
        killed = true;
        // isProcessAlive, not a local flag — same reaped-PID reasoning as
        // scanner/probe.ts.
        if (isProcessAlive(proc)) proc.kill("SIGKILL");
        reject(
          new Error(
            `FFmpeg subtitle extract timed out after ${EXTRACT_TIMEOUT_MS}ms: ${input}`,
          ),
        );
      }
    }, EXTRACT_TIMEOUT_MS);
    timer.unref();
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      code === 0
        ? resolve()
        : reject(
            new Error(
              `FFmpeg subtitle extract exit ${code}: ${stderr.slice(-200)}`,
            ),
          );
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!killed) reject(err);
    });
  });
}
