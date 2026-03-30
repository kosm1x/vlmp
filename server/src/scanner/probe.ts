import { spawn } from "node:child_process";
import type { Config } from "../config.js";

export interface ProbeResult {
  duration: number;
  codecVideo: string | null;
  codecAudio: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
}

export interface AudioTrack {
  index: number;
  language: string | null;
  codec: string;
  channels: number;
}

export interface SubtitleTrack {
  index: number;
  language: string | null;
  codec: string;
  title: string | null;
}

export async function probeFile(
  filePath: string,
  config: Config,
): Promise<ProbeResult> {
  const raw = await runFFprobe(filePath, config.ffprobePath);
  return parseProbeOutput(raw);
}

const MAX_PROBE_STDOUT = 1_048_576; // 1 MB

function runFFprobe(filePath: string, ffprobePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "--",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    let killed = false;
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_PROBE_STDOUT && !killed) {
        killed = true;
        proc.kill("SIGTERM");
        reject(new Error("ffprobe output exceeded 1MB limit"));
      }
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (killed) return;
      code === 0
        ? resolve(stdout)
        : reject(new Error(`ffprobe exit ${code}: ${stderr}`));
    });
    proc.on("error", (err) => {
      if (!killed) reject(err);
    });
  });
}

function parseProbeOutput(raw: string): ProbeResult {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse ffprobe output: ${raw.slice(0, 200)}`);
  }
  const streams = data.streams || [];
  const format = data.format || {};
  const videoStream = streams.find(
    (s: Record<string, unknown>) => s.codec_type === "video",
  );
  const audioStream = streams.find(
    (s: Record<string, unknown>) => s.codec_type === "audio",
  );
  const audioTracks: AudioTrack[] = streams
    .filter((s: Record<string, unknown>) => s.codec_type === "audio")
    .map((s: Record<string, unknown>, i: number) => ({
      index: i,
      language: (s.tags as Record<string, string>)?.language || null,
      codec: s.codec_name as string,
      channels: s.channels as number,
    }));
  const subtitleTracks: SubtitleTrack[] = streams
    .filter((s: Record<string, unknown>) => s.codec_type === "subtitle")
    .map((s: Record<string, unknown>, i: number) => ({
      index: i,
      language: (s.tags as Record<string, string>)?.language || null,
      codec: s.codec_name as string,
      title: (s.tags as Record<string, string>)?.title || null,
    }));
  return {
    duration: Math.round(parseFloat(format.duration || "0")),
    codecVideo: videoStream ? (videoStream.codec_name as string) : null,
    codecAudio: audioStream ? (audioStream.codec_name as string) : null,
    width: videoStream ? (videoStream.width as number) : null,
    height: videoStream ? (videoStream.height as number) : null,
    bitrate: format.bit_rate ? parseInt(format.bit_rate, 10) : null,
    audioTracks,
    subtitleTracks,
  };
}
