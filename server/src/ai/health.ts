import type Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";

export interface HealthIssue {
  type:
    | "missing_file"
    | "zero_byte"
    | "metadata_gap"
    | "no_subtitles"
    | "orphaned"
    | "duplicate";
  media_id: number;
  title: string;
  detail: string;
}

export interface HealthReport {
  summary: {
    total_items: number;
    missing_files: number;
    zero_byte_files: number;
    metadata_gaps: number;
    no_subtitles: number;
    orphaned_entries: number;
    duplicates: number;
  };
  codec_analysis: { codec: string; count: number }[];
  resolution_stats: { bucket: string; count: number }[];
  issues: HealthIssue[];
}

export function generateHealthReport(db: Database.Database): HealthReport {
  const issues: HealthIssue[] = [];

  // Total items
  const totalRow = db
    .prepare("SELECT COUNT(*) as count FROM media_items")
    .get() as { count: number };

  // 1. Missing files
  const missingFiles = getMissingFiles(db);
  issues.push(...missingFiles);

  // 2. Zero-byte files
  const zeroByte = db
    .prepare(
      "SELECT id, title, file_path FROM media_items WHERE file_size = 0 OR file_size IS NULL",
    )
    .all() as { id: number; title: string; file_path: string }[];

  const zeroByteIssues: HealthIssue[] = [];
  for (const item of zeroByte) {
    // Confirm with statSync if file exists
    try {
      if (existsSync(item.file_path)) {
        const stat = statSync(item.file_path);
        if (stat.size === 0) {
          zeroByteIssues.push({
            type: "zero_byte",
            media_id: item.id,
            title: item.title,
            detail: "File is zero bytes",
          });
        }
      }
    } catch {
      // File doesn't exist — already caught by missing files check
    }
  }
  issues.push(...zeroByteIssues);

  // 3. Metadata gaps
  const metadataGaps = db
    .prepare(
      "SELECT id, title FROM media_items WHERE poster_path IS NULL OR description IS NULL OR genres IS NULL",
    )
    .all() as { id: number; title: string }[];

  const metadataIssues: HealthIssue[] = metadataGaps.map((item) => ({
    type: "metadata_gap",
    media_id: item.id,
    title: item.title,
    detail: "Missing poster, description, or genres",
  }));
  issues.push(...metadataIssues);

  // 4. No subtitles
  const noSubs = db
    .prepare(
      `SELECT mi.id, mi.title FROM media_items mi
       LEFT JOIN subtitles s ON s.media_id = mi.id
       WHERE s.id IS NULL AND mi.type IN ('movie', 'episode')`,
    )
    .all() as { id: number; title: string }[];

  const subIssues: HealthIssue[] = noSubs.map((item) => ({
    type: "no_subtitles",
    media_id: item.id,
    title: item.title,
    detail: "No subtitles available",
  }));
  issues.push(...subIssues);

  // 5. Codec analysis
  const codecAnalysis = db
    .prepare(
      "SELECT COALESCE(codec_video, 'Unknown') as codec, COUNT(*) as count FROM media_items GROUP BY codec_video ORDER BY count DESC",
    )
    .all() as { codec: string; count: number }[];

  // 6. Resolution stats
  const resolutionStats = db
    .prepare(
      `SELECT
        CASE
          WHEN resolution_height >= 2160 THEN '4K'
          WHEN resolution_height >= 1080 THEN '1080p'
          WHEN resolution_height >= 720 THEN '720p'
          WHEN resolution_height > 0 THEN 'SD'
          ELSE 'Unknown'
        END as bucket,
        COUNT(*) as count
       FROM media_items
       GROUP BY bucket
       ORDER BY count DESC`,
    )
    .all() as { bucket: string; count: number }[];

  // 7. Orphaned entries
  const orphanedEpisodes = db
    .prepare(
      "SELECT e.id, e.media_id FROM episodes e LEFT JOIN seasons s ON s.id = e.season_id WHERE s.id IS NULL",
    )
    .all() as { id: number; media_id: number }[];

  const orphanedSeasons = db
    .prepare(
      "SELECT s.id FROM seasons s LEFT JOIN tv_shows t ON t.id = s.show_id WHERE t.id IS NULL",
    )
    .all() as { id: number }[];

  const orphanedMedia = db
    .prepare(
      "SELECT mi.id, mi.title FROM media_items mi WHERE mi.library_folder_id IS NOT NULL AND mi.library_folder_id NOT IN (SELECT id FROM library_folders)",
    )
    .all() as { id: number; title: string }[];

  for (const ep of orphanedEpisodes) {
    const media = db
      .prepare("SELECT title FROM media_items WHERE id = ?")
      .get(ep.media_id) as { title: string } | undefined;
    issues.push({
      type: "orphaned",
      media_id: ep.media_id,
      title: media?.title || `Episode ${ep.id}`,
      detail: "Episode references nonexistent season",
    });
  }

  for (const s of orphanedSeasons) {
    issues.push({
      type: "orphaned",
      media_id: 0,
      title: `Season ${s.id}`,
      detail: "Season references nonexistent show",
    });
  }

  for (const m of orphanedMedia) {
    issues.push({
      type: "orphaned",
      media_id: m.id,
      title: m.title,
      detail: "Media references nonexistent library folder",
    });
  }

  const totalOrphaned =
    orphanedEpisodes.length + orphanedSeasons.length + orphanedMedia.length;

  // 8. Duplicate detection
  const duplicates = db
    .prepare(
      "SELECT title, year, duration, COUNT(*) as count FROM media_items GROUP BY title, year, duration HAVING COUNT(*) > 1",
    )
    .all() as {
    title: string;
    year: number | null;
    duration: number | null;
    count: number;
  }[];

  let dupCount = 0;
  for (const dup of duplicates) {
    dupCount += dup.count;
    const dupeItems = db
      .prepare(
        "SELECT id, title, file_path FROM media_items WHERE title = ? AND (year = ? OR (year IS NULL AND ? IS NULL)) AND (duration = ? OR (duration IS NULL AND ? IS NULL))",
      )
      .all(dup.title, dup.year, dup.year, dup.duration, dup.duration) as {
      id: number;
      title: string;
      file_path: string;
    }[];

    for (const item of dupeItems) {
      issues.push({
        type: "duplicate",
        media_id: item.id,
        title: item.title,
        detail: `Possible duplicate (${dup.count} copies)`,
      });
    }
  }

  return {
    summary: {
      total_items: totalRow.count,
      missing_files: missingFiles.length,
      zero_byte_files: zeroByteIssues.length,
      metadata_gaps: metadataGaps.length,
      no_subtitles: noSubs.length,
      orphaned_entries: totalOrphaned,
      duplicates: dupCount,
    },
    codec_analysis: codecAnalysis,
    resolution_stats: resolutionStats,
    issues,
  };
}

export function getMissingFiles(db: Database.Database): HealthIssue[] {
  const allMedia = db
    .prepare("SELECT id, title, file_path FROM media_items")
    .all() as { id: number; title: string; file_path: string }[];

  const issues: HealthIssue[] = [];
  for (const item of allMedia) {
    if (!existsSync(item.file_path)) {
      issues.push({
        type: "missing_file",
        media_id: item.id,
        title: item.title,
        detail: `File not found: ${item.file_path}`,
      });
    }
  }
  return issues;
}

export function cleanupOrphaned(db: Database.Database): { removed: number } {
  let removed = 0;

  const cleanup = db.transaction(() => {
    // Remove episodes with invalid season_id
    const epResult = db
      .prepare(
        "DELETE FROM episodes WHERE season_id NOT IN (SELECT id FROM seasons)",
      )
      .run();
    removed += epResult.changes;

    // Remove seasons with invalid show_id
    const sResult = db
      .prepare(
        "DELETE FROM seasons WHERE show_id NOT IN (SELECT id FROM tv_shows)",
      )
      .run();
    removed += sResult.changes;

    // Remove media_items with invalid library_folder_id
    const mResult = db
      .prepare(
        "DELETE FROM media_items WHERE library_folder_id IS NOT NULL AND library_folder_id NOT IN (SELECT id FROM library_folders)",
      )
      .run();
    removed += mResult.changes;
  });

  cleanup();
  return { removed };
}
