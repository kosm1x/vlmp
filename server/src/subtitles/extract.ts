import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config.js";
import type { SubtitleTrack } from "../scanner/probe.js";

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
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      code === 0
        ? resolve()
        : reject(
            new Error(
              `FFmpeg subtitle extract exit ${code}: ${stderr.slice(-200)}`,
            ),
          );
    });
    proc.on("error", reject);
  });
}
