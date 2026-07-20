import { watch, type FSWatcher } from "node:fs";
import { extname, join } from "node:path";

const MEDIA_EXTENSIONS = new Set([
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
  ".vob",
  ".3gp",
  ".ogv",
  ".mp3",
  ".m4a",
  ".flac",
  ".aac",
  ".ogg",
  ".wma",
  ".wav",
  ".opus",
]);

export interface WatcherEvent {
  type: "change";
  path: string;
}

export function watchLibraryFolder(
  folderPath: string,
  onChange: (event: WatcherEvent) => void,
): FSWatcher {
  return watch(folderPath, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const ext = extname(filename).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) return;
    // join, not `${folderPath}/${filename}`: on Windows a recursive watch
    // reports nested filenames with backslashes — string-joining would feed
    // mixed-separator paths into the scan pipeline (and duplicate DB rows).
    onChange({ type: "change", path: join(folderPath, filename) });
  });
}
