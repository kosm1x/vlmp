import { resolve } from 'node:path';

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
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env.VLMP_DATA_DIR || './data');
  return {
    port: parseInt(process.env.VLMP_PORT || '8080', 10),
    host: process.env.VLMP_HOST || '0.0.0.0',
    dataDir,
    dbPath: resolve(dataDir, 'vlmp.db'),
    ffmpegPath: process.env.VLMP_FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.VLMP_FFPROBE_PATH || 'ffprobe',
    jwtSecret: process.env.VLMP_JWT_SECRET || 'vlmp-dev-secret-change-me',
    jwtExpiresIn: process.env.VLMP_JWT_EXPIRES_IN || '24h',
    tmdbApiKey: process.env.VLMP_TMDB_API_KEY || '',
    transcodeTmpDir: resolve(dataDir, 'transcode'),
  };
}
