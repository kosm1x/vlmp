import { spawnSync } from "node:child_process";

// Transcode pacing needs -readrate (ffmpeg >= 5.0) and ideally
// -readrate_initial_burst (>= 6.1). Passing an unknown option makes ffmpeg
// exit fatally, so both are feature-detected from `ffmpeg -version` once per
// binary and cached. Unparseable versions (git snapshot builds report
// "N-112345-g<hash>") fall back to unpaced — playback keeps working, it just
// burns CPU like before the pacing existed.

export interface FfmpegCaps {
  readrate: boolean;
  readrateInitialBurst: boolean;
}

const NO_CAPS: FfmpegCaps = { readrate: false, readrateInitialBurst: false };
const cache = new Map<string, FfmpegCaps>();

export function parseFfmpegCaps(versionOutput: string): FfmpegCaps {
  const m = /ffmpeg version n?(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return NO_CAPS;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return {
    readrate: major >= 5,
    readrateInitialBurst: major > 6 || (major === 6 && minor >= 1),
  };
}

export function getFfmpegCaps(ffmpegPath: string): FfmpegCaps {
  const hit = cache.get(ffmpegPath);
  if (hit) return hit;
  let caps = NO_CAPS;
  try {
    const out = spawnSync(ffmpegPath, ["-version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    caps = parseFfmpegCaps(out.stdout || "");
  } catch {
    /* unpaced fallback */
  }
  if (!caps.readrate)
    console.warn(
      "[transcode] ffmpeg does not support -readrate (needs >= 5.0) — transcodes will run unpaced at full CPU speed",
    );
  cache.set(ffmpegPath, caps);
  return caps;
}

/** Test hook: seed or clear the per-binary capability cache. */
export function primeFfmpegCaps(ffmpegPath: string, caps: FfmpegCaps): void {
  cache.set(ffmpegPath, caps);
}
export function resetFfmpegCapsCache(): void {
  cache.clear();
}
