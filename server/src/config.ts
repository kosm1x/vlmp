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
}

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
  };
}
