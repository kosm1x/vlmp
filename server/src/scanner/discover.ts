import { readdir, stat, realpath } from "node:fs/promises";
import { join, extname } from "node:path";

const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
  ".mts",
  ".vob",
  ".3gp",
  ".ogv",
]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".flac",
  ".aac",
  ".ogg",
  ".wma",
  ".wav",
  ".opus",
]);

export interface DiscoveredFile {
  path: string;
  size: number;
  isVideo: boolean;
  isAudio: boolean;
}

export async function discoverMedia(
  rootPath: string,
): Promise<DiscoveredFile[]> {
  // An unreadable ROOT is a scan error (typo'd path, unmounted drive), not an
  // empty library; deeper unreadable subdirectories are still skipped quietly.
  await readdir(rootPath);
  // Cycle guard for symlinked directories: track every real directory
  // entered so `Show -> ../Show` loops terminate instead of recursing forever.
  const visited = new Set<string>();
  try {
    visited.add(await realpath(rootPath));
  } catch {
    /* root exists (readdir above succeeded) — a realpath race just means the
       guard starts empty */
  }
  const results: DiscoveredFile[] = [];
  await walkDir(rootPath, results, visited);
  return results;
}

async function walkDir(
  dirPath: string,
  results: DiscoveredFile[],
  visited: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    // Dirent reflects lstat: a symlink is neither isFile() nor isDirectory(),
    // so symlinked files and symlinked sub-libraries (a normal way to compose
    // media roots) were silently invisible to the scan. Resolve through the
    // link; the row keeps the symlink PATH so classification stays relative
    // to this library's folder structure.
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(fullPath); // stat follows the link
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue; // broken link
      }
    }
    if (isDir) {
      try {
        const real = await realpath(fullPath);
        if (visited.has(real)) continue;
        visited.add(real);
      } catch {
        continue;
      }
      await walkDir(fullPath, results, visited);
    } else if (isFile) {
      const ext = extname(entry.name).toLowerCase();
      const isVideo = VIDEO_EXTENSIONS.has(ext);
      const isAudio = AUDIO_EXTENSIONS.has(ext);
      if (isVideo || isAudio) {
        try {
          const fileStat = await stat(fullPath);
          results.push({
            path: fullPath,
            size: fileStat.size,
            isVideo,
            isAudio,
          });
        } catch {
          /* skip */
        }
      }
    }
  }
}
