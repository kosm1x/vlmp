import { readdir, stat, realpath } from "node:fs/promises";
import { join, extname, sep } from "node:path";

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

// Backstop against recursion the symlink rules can't see (recursive bind
// mounts have no symlink to inspect). Deep real libraries don't come close.
const MAX_DEPTH = 32;

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
  let rootReal: string;
  try {
    rootReal = await realpath(rootPath);
  } catch {
    rootReal = rootPath;
  }
  const results: DiscoveredFile[] = [];
  await walkDir(rootPath, results, rootReal, new Set([rootReal]), 0);
  return results;
}

function isInside(real: string, rootReal: string): boolean {
  return real === rootReal || real.startsWith(rootReal + sep);
}

// Symlink rules — file_path is the library's IDENTITY key (thumbs, the
// rescan `existing` lookup, and the empty-trash prune all key on it), so
// which path a file is discovered under must never depend on readdir order:
//
//   - Real directories/files inside the tree are canonical and always walked.
//   - A symlink pointing INSIDE the library root is skipped: its target is
//     already walked at its real path. Following both (or letting a global
//     visited-set race them) made an alias and its real directory compete —
//     the loser's rows were pruned as "missing" on the next scan, cascading
//     watch progress, likes and playlist entries.
//   - A symlink pointing OUTSIDE the root is followed (composing a library
//     from external trees is the supported use); the row keeps the symlink
//     path so classification stays relative to this library's structure.
//   - `ancestors` holds the realpaths of symlinked dirs on the CURRENT
//     recursion chain — external link cycles terminate; plain directories
//     cannot cycle without a symlink, and bind mounts hit MAX_DEPTH.
async function walkDir(
  dirPath: string,
  results: DiscoveredFile[],
  rootReal: string,
  ancestors: Set<string>,
  depth: number,
): Promise<void> {
  if (depth >= MAX_DEPTH) {
    console.warn(
      `[scan] directory depth cap (${MAX_DEPTH}) reached at ${dirPath} — not descending further`,
    );
    return;
  }
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    // Dirent reflects lstat: a symlink is neither isFile() nor isDirectory().
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    let linkReal: string | null = null;
    if (entry.isSymbolicLink()) {
      try {
        linkReal = await realpath(fullPath);
        const target = await stat(fullPath); // follows the link
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue; // broken link
      }
      if (isInside(linkReal, rootReal)) continue; // canonical copy wins
      if (isDir && ancestors.has(linkReal)) continue; // external cycle
    }
    if (isDir) {
      if (linkReal) ancestors.add(linkReal);
      await walkDir(fullPath, results, rootReal, ancestors, depth + 1);
      if (linkReal) ancestors.delete(linkReal);
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
