import { spawn } from "node:child_process";
import type { Config } from "../config.js";

// Hardware H.264 encoder selection. An encoder appearing in `ffmpeg
// -encoders` proves the BUILD supports it, not that this machine can use it
// (nvenc is listed on every full build, GPU or not) — so each candidate is
// probed with a real tiny encode and the first one that exits 0 wins.
// Probing runs once at boot (initHwEncoder); startTranscode reads the result
// synchronously and uses software x264 until/unless a probe succeeded.

const ENCODER_BY_MODE: Record<string, string> = {
  nvenc: "h264_nvenc",
  qsv: "h264_qsv",
  amf: "h264_amf",
  videotoolbox: "h264_videotoolbox",
};

// Per-encoder speed/quality knobs, used by BOTH the boot probe and real
// transcodes — probing with the exact flags we ship means a wrong option
// name fails the probe cleanly at boot instead of killing first playback.
// forced-idr: -force_key_frames on hw encoders emits plain I-frames unless
// told otherwise; segments led by a non-IDR frame aren't independently
// decodable, so seeks glitch. NOTE: h264_amf has no such option in any
// released ffmpeg (master-only as of 7.1) — do not add it (audit 2026-07-21).
export const HW_ENCODER_TUNING: Record<string, string[]> = {
  h264_nvenc: ["-preset", "p4", "-forced-idr", "1"],
  h264_qsv: ["-preset", "veryfast", "-forced_idr", "1"],
  h264_amf: ["-quality", "speed"],
  h264_videotoolbox: [],
};
const AUTO_ORDER = ["nvenc", "qsv", "amf", "videotoolbox"];
const PROBE_TIMEOUT_MS = 10_000;

let selectedEncoder: string | null = null;

export function getHwEncoder(): string | null {
  return selectedEncoder;
}

function probeEncode(ffmpegPath: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=256x144:d=0.2:r=10",
        "-frames:v",
        "3",
        "-c:v",
        encoder,
        ...HW_ENCODER_TUNING[encoder],
        "-f",
        "null",
        "-",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        proc.kill("SIGKILL");
        resolve(false);
      }
    }, PROBE_TIMEOUT_MS);
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

export async function initHwEncoder(config: Config): Promise<void> {
  if (config.hwTranscode === "off") {
    selectedEncoder = null;
    return;
  }
  const modes =
    config.hwTranscode === "auto" ? AUTO_ORDER : [config.hwTranscode];
  for (const mode of modes) {
    const encoder = ENCODER_BY_MODE[mode];
    if (await probeEncode(config.ffmpegPath, encoder)) {
      selectedEncoder = encoder;
      console.log(
        `[transcode] hardware encoder: ${encoder} (VLMP_HW_TRANSCODE=${config.hwTranscode})`,
      );
      return;
    }
  }
  selectedEncoder = null;
  console.warn(
    `[transcode] VLMP_HW_TRANSCODE=${config.hwTranscode} but no hardware encoder passed the probe — using software x264`,
  );
}

// The boot probe only proves the encoder works on a synthetic clip — real
// media can still kill the GPU pipeline (unsupported decode, driver limits).
// A hardware job that dies without finishing disables hardware for the rest
// of the process: playback self-heals to software, never breaks.
export function disableHwEncoder(reason: string): void {
  if (!selectedEncoder) return;
  console.warn(
    `[transcode] disabling hardware encoder ${selectedEncoder} — ${reason}; using software x264 until restart`,
  );
  selectedEncoder = null;
}

/** Test hooks. */
export function primeHwEncoder(encoder: string | null): void {
  selectedEncoder = encoder;
}
