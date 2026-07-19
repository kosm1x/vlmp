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
  transcodeTmpDir: string;
  subtitleDir: string;
  serverName: string;
  publicUrl: string;
  serverFingerprint: string;
  maxTranscodeSessions: number;
  minFreeDiskBytes: number;
  transcodePreset: string;
  emptyTrashOnScan: boolean;
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

export function loadConfig(): Config {
  const dataDir = resolve(process.env.VLMP_DATA_DIR || "./data");
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
    jwtSecret: process.env.VLMP_JWT_SECRET || "vlmp-dev-secret-change-me",
    jwtExpiresIn: process.env.VLMP_JWT_EXPIRES_IN || "24h",
    tmdbApiKey,
    transcodeTmpDir: resolve(dataDir, "transcode"),
    subtitleDir: resolve(dataDir, "subtitles"),
    serverName: process.env.VLMP_SERVER_NAME || "VLMP",
    publicUrl,
    serverFingerprint: "", // Set at startup after loading/generating key
    maxTranscodeSessions,
    minFreeDiskBytes: minFreeDiskMb * 1024 * 1024,
    transcodePreset,
    emptyTrashOnScan: process.env.VLMP_EMPTY_TRASH_ON_SCAN !== "false",
    backupDir: resolve(dataDir, "backups"),
    backupIntervalHours,
    backupRetention,
  };
}
