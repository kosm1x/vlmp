import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.mpg', '.mpeg', '.ts', '.vob', '.3gp', '.ogv',
]);
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.flac', '.aac', '.ogg', '.wma', '.wav', '.opus',
]);

export interface DiscoveredFile {
  path: string;
  size: number;
  isVideo: boolean;
  isAudio: boolean;
}

export async function discoverMedia(rootPath: string): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = [];
  await walkDir(rootPath, results);
  return results;
}

async function walkDir(dirPath: string, results: DiscoveredFile[]): Promise<void> {
  let entries;
  try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, results);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      const isVideo = VIDEO_EXTENSIONS.has(ext);
      const isAudio = AUDIO_EXTENSIONS.has(ext);
      if (isVideo || isAudio) {
        try {
          const fileStat = await stat(fullPath);
          results.push({ path: fullPath, size: fileStat.size, isVideo, isAudio });
        } catch { /* skip */ }
      }
    }
  }
}
