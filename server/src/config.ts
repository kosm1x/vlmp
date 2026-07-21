import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  tmdbApiKey: string;
  opensubtitlesApiKey: string;
  transcodeTmpDir: string;
  subtitleDir: string;
  serverName: string;
  publicUrl: string;
  serverFingerprint: string;
  maxTranscodeSessions: number;
  minFreeDiskBytes: number;
  transcodePreset: string;
  hwTranscode: string;
  emptyTrashOnScan: boolean;
  extractSubsOnScan: boolean;
  minDurationSeconds: number;
  ffprobeTimeoutMs: number;
  backupDir: string;
  backupIntervalHours: number;
  backupRetention: number;
}

// x264 -preset values, slowest→fastest. Plex's "transcoder quality" slider.
const X264_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
];

// Optional KEY=VALUE config file at <dataDir>/vlmp.env — the Windows installer
// points users there so console and service mode share one config surface.
// Real environment variables always win; only VLMP_-prefixed keys are applied
// (the file must not be able to alter PATH/NODE_OPTIONS); VLMP_DATA_DIR itself
// can't come from the file because it's what locates the file.
function applyEnvFile(dataDir: string): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(dataDir, "vlmp.env"), "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^VLMP_[A-Z0-9_]+$/.test(key) || key === "VLMP_DATA_DIR") continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

// VLMP_JWT_SECRET wins; VLMP_JWT_SECRET_FILE lets the Windows service (and
// docker-secrets style setups) avoid putting the secret on a command line or
// in the registry. A set-but-unreadable file is a hard error — falling back to
// the dev default would demote a configured production secret silently.
function loadJwtSecret(): string {
  if (process.env.VLMP_JWT_SECRET) return process.env.VLMP_JWT_SECRET;
  const file = process.env.VLMP_JWT_SECRET_FILE;
  if (file) {
    let secret = "";
    try {
      secret = readFileSync(file, "utf-8").trim();
    } catch (err) {
      throw new Error(
        `VLMP_JWT_SECRET_FILE is set but unreadable: ${file} (${err})`,
      );
    }
    if (!secret) throw new Error(`VLMP_JWT_SECRET_FILE is empty: ${file}`);
    return secret;
  }
  return "vlmp-dev-secret-change-me";
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env.VLMP_DATA_DIR || "./data");
  applyEnvFile(dataDir);
  const port = parseInt(process.env.VLMP_PORT || "8080", 10);
  if (port < 1 || port > 65535 || isNaN(port)) {
    throw new Error(`Invalid port: ${process.env.VLMP_PORT}. Must be 1-65535.`);
  }
  const publicUrl = process.env.VLMP_PUBLIC_URL || "";
  if (publicUrl) {
    try {
      new URL(publicUrl);
    } catch {
      throw new Error(
        `Invalid VLMP_PUBLIC_URL: "${publicUrl}". Must be a valid URL.`,
      );
    }
  }
  const maxTranscodeSessions = parseInt(
    process.env.VLMP_MAX_TRANSCODE_SESSIONS || "4",
    10,
  );
  if (isNaN(maxTranscodeSessions) || maxTranscodeSessions < 1) {
    throw new Error(
      `Invalid VLMP_MAX_TRANSCODE_SESSIONS: ${process.env.VLMP_MAX_TRANSCODE_SESSIONS}. Must be >= 1.`,
    );
  }
  const minFreeDiskMb = parseInt(
    process.env.VLMP_MIN_FREE_DISK_MB || "2048",
    10,
  );
  if (isNaN(minFreeDiskMb) || minFreeDiskMb < 0) {
    throw new Error(
      `Invalid VLMP_MIN_FREE_DISK_MB: ${process.env.VLMP_MIN_FREE_DISK_MB}. Must be >= 0.`,
    );
  }
  // off = software x264 (default, works everywhere). auto = probe
  // nvenc → qsv → amf → videotoolbox at boot and use the first that actually
  // encodes (an encoder listed in the ffmpeg build ≠ a working GPU/driver).
  // A specific name forces that encoder (still probed; falls back to
  // software with a warning if the probe fails).
  const hwTranscode = process.env.VLMP_HW_TRANSCODE || "off";
  const HW_MODES = ["off", "auto", "nvenc", "qsv", "amf", "videotoolbox"];
  if (!HW_MODES.includes(hwTranscode)) {
    throw new Error(
      `Invalid VLMP_HW_TRANSCODE: "${hwTranscode}". Must be one of ${HW_MODES.join(", ")}.`,
    );
  }

  const transcodePreset = process.env.VLMP_TRANSCODE_PRESET || "veryfast";
  if (!X264_PRESETS.includes(transcodePreset)) {
    throw new Error(
      `Invalid VLMP_TRANSCODE_PRESET: "${transcodePreset}". Must be one of ${X264_PRESETS.join(", ")}.`,
    );
  }
  const backupIntervalHours = parseInt(
    process.env.VLMP_BACKUP_INTERVAL_HOURS || "24",
    10,
  );
  if (isNaN(backupIntervalHours) || backupIntervalHours < 0) {
    throw new Error(
      `Invalid VLMP_BACKUP_INTERVAL_HOURS: ${process.env.VLMP_BACKUP_INTERVAL_HOURS}. Must be >= 0 (0 disables).`,
    );
  }
  const backupRetention = parseInt(
    process.env.VLMP_BACKUP_RETENTION || "7",
    10,
  );
  if (isNaN(backupRetention) || backupRetention < 1) {
    throw new Error(
      `Invalid VLMP_BACKUP_RETENTION: ${process.env.VLMP_BACKUP_RETENTION}. Must be >= 1.`,
    );
  }
  // Sample-file floor: VIDEO files with a known duration under this are
  // ignored by scans (release-folder sample clips). 0 disables the filter
  // (e.g. libraries of legitimate short clips). Audio is never filtered —
  // sub-2-minute tracks are normal.
  const minDurationSeconds = parseInt(
    process.env.VLMP_MIN_DURATION_SECONDS || "120",
    10,
  );
  if (isNaN(minDurationSeconds) || minDurationSeconds < 0) {
    throw new Error(
      `Invalid VLMP_MIN_DURATION_SECONDS: ${process.env.VLMP_MIN_DURATION_SECONDS}. Must be >= 0 (0 disables).`,
    );
  }
  const tmdbApiKey = process.env.VLMP_TMDB_API_KEY || "";
  if (!tmdbApiKey) {
    console.warn(
      "VLMP_TMDB_API_KEY not set — metadata enrichment will not work.",
    );
  }
  return {
    port,
    host: process.env.VLMP_HOST || "0.0.0.0",
    dataDir,
    dbPath: resolve(dataDir, "vlmp.db"),
    ffmpegPath: process.env.VLMP_FFMPEG_PATH || "ffmpeg",
    ffprobePath: process.env.VLMP_FFPROBE_PATH || "ffprobe",
    jwtSecret: loadJwtSecret(),
    jwtExpiresIn: process.env.VLMP_JWT_EXPIRES_IN || "24h",
    tmdbApiKey,
    // Optional: enables searching/downloading subtitles from opensubtitles.com
    // (free key at opensubtitles.com/consumers). Absent = the feature reports
    // itself unconfigured; nothing else degrades.
    opensubtitlesApiKey: process.env.VLMP_OPENSUBTITLES_API_KEY || "",
    transcodeTmpDir: resolve(dataDir, "transcode"),
    subtitleDir: resolve(dataDir, "subtitles"),
    serverName: process.env.VLMP_SERVER_NAME || "VLMP",
    publicUrl,
    serverFingerprint: "", // Set at startup after loading/generating key
    maxTranscodeSessions,
    minFreeDiskBytes: minFreeDiskMb * 1024 * 1024,
    transcodePreset,
    hwTranscode,
    emptyTrashOnScan: process.env.VLMP_EMPTY_TRASH_ON_SCAN !== "false",
    // Off by default: extraction demuxes each file END TO END, which pins the
    // media drive at 100% for the whole scan. Playback already extracts on
    // demand (routes/subtitles.ts); this exists for operators who prefer to
    // pre-warm subtitles overnight.
    extractSubsOnScan: process.env.VLMP_EXTRACT_SUBS_ON_SCAN === "true",
    minDurationSeconds,
    ffprobeTimeoutMs: parseInt(
      process.env.VLMP_FFPROBE_TIMEOUT_MS || "30000",
      10,
    ),
    backupDir: resolve(dataDir, "backups"),
    backupIntervalHours,
    backupRetention,
  };
}
