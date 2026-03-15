import type Database from "better-sqlite3";
import type { ExtractedSubtitle } from "./extract.js";

export interface Subtitle {
  id: number;
  media_id: number;
  language: string | null;
  label: string | null;
  format: string;
  file_path: string;
  source: string;
}

export function persistSubtitles(
  db: Database.Database,
  mediaId: number,
  extracted: ExtractedSubtitle[],
): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO subtitles (media_id, language, label, format, file_path, source) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertAll = db.transaction(() => {
    for (const sub of extracted) {
      insert.run(
        mediaId,
        sub.language,
        sub.label,
        sub.format,
        sub.file_path,
        "extracted",
      );
    }
  });
  insertAll();
}

export function getSubtitlesForMedia(
  db: Database.Database,
  mediaId: number,
): Subtitle[] {
  return db
    .prepare("SELECT * FROM subtitles WHERE media_id = ? ORDER BY language")
    .all(mediaId) as Subtitle[];
}

export function deleteSubtitlesForMedia(
  db: Database.Database,
  mediaId: number,
): void {
  db.prepare("DELETE FROM subtitles WHERE media_id = ?").run(mediaId);
}
