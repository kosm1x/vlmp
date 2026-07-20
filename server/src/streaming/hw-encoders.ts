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

/** Test hooks. */
export function primeHwEncoder(encoder: string | null): void {
  selectedEncoder = encoder;
}
