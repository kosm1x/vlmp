import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config.js";
import { discoverMedia } from "../scanner/discover.js";
import { probeFile } from "../scanner/probe.js";
import { classifyByFolder, type MediaCategory } from "../scanner/classify.js";
import {
  matchAndApplyMetadata,
  matchAndApplyShowMetadata,
} from "../metadata/matcher.js";
import { extractSubtitles } from "../subtitles/extract.js";
import { persistSubtitles } from "../subtitles/service.js";

export interface LibraryFolder {
  id: number;
  path: string;
  category: MediaCategory;
  scan_status: string;
  last_scanned: number | null;
  is_visible: number;
  is_searchable: number;
}

// The library gate: non-admins only see folders the admin marked visible, and
// only search folders marked searchable. Admins (includeHidden=true) bypass it.
// Returned as a self-contained subquery so callers can drop it into a WHERE.
function visibleFolderSubquery(mode: "view" | "search"): string {
  const extra = mode === "search" ? " AND is_searchable = 1" : "";
  return `SELECT id FROM library_folders WHERE is_visible = 1${extra}`;
}

export interface MediaItem {
  id: number;
  type: string;
  file_path: string;
  file_size: number | null;
  title: string;
  year: number | null;
  description: string | null;
  duration: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  codec_video: string | null;
  codec_audio: string | null;
  resolution_width: number | null;
  resolution_height: number | null;
  genres: string | null;
  rating: number | null;
}

export function addLibraryFolder(
  db: Database.Database,
  path: string,
  category: MediaCategory,
): LibraryFolder {
  // Normalize before storing: folder uniqueness is an exact-string UNIQUE, so
  // `C:\Media` vs `C:/Media/` (or a trailing slash on POSIX) would otherwise
  // create duplicate folder rows that each scan into duplicate media rows.
  return db
    .prepare(
      "INSERT INTO library_folders (path, category) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET category = excluded.category RETURNING *",
    )
    .get(resolve(path), category) as LibraryFolder;
}

export function getLibraryFolders(db: Database.Database): LibraryFolder[] {
  return db
    .prepare("SELECT * FROM library_folders ORDER BY path")
    .all() as LibraryFolder[];
}

export function setFolderVisibility(
  db: Database.Database,
  id: number,
  fields: { is_visible?: boolean; is_searchable?: boolean },
): LibraryFolder | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.is_visible !== undefined) {
    sets.push("is_visible = ?");
    params.push(fields.is_visible ? 1 : 0);
  }
  if (fields.is_searchable !== undefined) {
    sets.push("is_searchable = ?");
    params.push(fields.is_searchable ? 1 : 0);
  }
  if (sets.length === 0)
    return db.prepare("SELECT * FROM library_folders WHERE id = ?").get(id) as
      LibraryFolder | undefined;
  return db
    .prepare(
      `UPDATE library_folders SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params, id) as LibraryFolder | undefined;
}

// True if a media item's folder is visible to non-admins — the access boundary
// for detail + playback (an orphaned NULL folder is treated as hidden).
export function isMediaFolderVisible(
  db: Database.Database,
  mediaId: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM media_items WHERE id = ? AND library_folder_id IN (${visibleFolderSubquery(
        "view",
      )})`,
    )
    .get(mediaId);
  return !!row;
}

export function removeLibraryFolder(
  db: Database.Database,
  id: number,
): boolean {
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM media_items WHERE library_folder_id = ?").run(id);
    const result = db
      .prepare("DELETE FROM library_folders WHERE id = ?")
      .run(id);
    // Clean up orphaned tv_shows and seasons (H2)
    db.prepare(
      "DELETE FROM seasons WHERE id NOT IN (SELECT DISTINCT season_id FROM episodes)",
    ).run();
    db.prepare(
      "DELETE FROM tv_shows WHERE id NOT IN (SELECT DISTINCT show_id FROM seasons)",
    ).run();
    return result.changes > 0;
  });
  return remove() as boolean;
}

export async function scanLibraryFolder(
  db: Database.Database,
  folder: LibraryFolder,
  config: Config,
): Promise<{ added: number; pruned: number }> {
  db.prepare("UPDATE library_folders SET scan_status = ? WHERE id = ?").run(
    "scanning",
    folder.id,
  );
  let added = 0;
  let pruned = 0;
  try {
    const files = await discoverMedia(folder.path);
    const insertMedia = db.prepare(
      "INSERT OR IGNORE INTO media_items (library_folder_id, type, file_path, file_size, title, sort_title, year, codec_video, codec_audio, resolution_width, resolution_height, bitrate, duration, audio_tracks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const file of files) {
      const existing = db
        .prepare("SELECT id FROM media_items WHERE file_path = ?")
        .get(file.path);
      if (existing) continue;
      const classified = classifyByFolder(
        file.path,
        folder.path,
        folder.category as MediaCategory,
      );
      let probe = null;
      try {
        probe = await probeFile(file.path, config);
      } catch {
        /* skip */
      }
      const sortTitle = classified.title
        .replace(/^(?:the|a|an)\s+/i, "")
        .toLowerCase();
      insertMedia.run(
        folder.id,
        classified.type,
        file.path,
        file.size,
        classified.title,
        sortTitle,
        classified.year,
        probe?.codecVideo || null,
        probe?.codecAudio || null,
        probe?.width || null,
        probe?.height || null,
        probe?.bitrate || null,
        probe?.duration || null,
        probe?.audioTracks ? JSON.stringify(probe.audioTracks) : null,
      );
      added++;

      // Get the inserted media ID for post-insert hooks
      const inserted = db
        .prepare("SELECT id FROM media_items WHERE file_path = ?")
        .get(file.path) as { id: number } | undefined;

      if (inserted) {
        // Auto-match metadata from TMDb (non-fatal)
        if (config.tmdbApiKey) {
          try {
            await matchAndApplyMetadata(db, inserted.id, config);
          } catch {
            /* metadata fetch failure is non-fatal */
          }
        }

        // Extract subtitles if present (non-fatal)
        if (probe?.subtitleTracks && probe.subtitleTracks.length > 0) {
          try {
            const extracted = await extractSubtitles(
              file.path,
              inserted.id,
              probe.subtitleTracks,
              config,
            );
            persistSubtitles(db, inserted.id, extracted);
          } catch {
            /* subtitle extraction failure is non-fatal */
          }
        }
      }

      if (
        classified.type === "episode" &&
        classified.showTitle &&
        folder.category === "tv"
      ) {
        linkEpisodeToShow(db, file.path, classified);
        // Match show metadata from TMDb (non-fatal)
        if (config.tmdbApiKey) {
          const show = db
            .prepare("SELECT id FROM tv_shows WHERE title = ?")
            .get(classified.showTitle) as { id: number } | undefined;
          if (show) {
            try {
              await matchAndApplyShowMetadata(db, show.id, config);
            } catch {
              /* non-fatal */
            }
          }
        }
      }
    }
    // Empty trash: drop rows for files removed/renamed since the last scan.
    if (config.emptyTrashOnScan) pruned = pruneMissingFiles(db, folder.id);
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "UPDATE library_folders SET scan_status = ?, last_scanned = ? WHERE id = ?",
    ).run("complete", now, folder.id);
  } catch (err) {
    db.prepare("UPDATE library_folders SET scan_status = ? WHERE id = ?").run(
      "error",
      folder.id,
    );
    throw err;
  }
  return { added, pruned };
}

// Empty trash: remove media_items in this folder whose file no longer exists
// on disk (rename/delete leaves the old row otherwise — the add-only-scan gap).
// FK cascades clean up watch_progress / playlist_items / episodes; orphaned
// shows/seasons are swept after. Returns the number of rows removed.
export function pruneMissingFiles(
  db: Database.Database,
  folderId: number,
): number {
  const rows = db
    .prepare(
      "SELECT id, file_path FROM media_items WHERE library_folder_id = ?",
    )
    .all(folderId) as { id: number; file_path: string }[];
  const missing = rows.filter((r) => !existsSync(r.file_path));
  if (missing.length === 0) return 0;
  // Safety valve: if EVERY file is missing, the source drive is almost
  // certainly unmounted — deleting the whole library would be catastrophic and
  // is never what "empty trash" means. Skip and let the admin investigate.
  if (missing.length === rows.length) {
    console.warn(
      `[scan] all ${rows.length} files in folder ${folderId} are missing — skipping prune (drive unmounted?)`,
    );
    return 0;
  }
  const prune = db.transaction(() => {
    const del = db.prepare("DELETE FROM media_items WHERE id = ?");
    for (const r of missing) del.run(r.id);
    db.prepare(
      "DELETE FROM seasons WHERE id NOT IN (SELECT DISTINCT season_id FROM episodes)",
    ).run();
    db.prepare(
      "DELETE FROM tv_shows WHERE id NOT IN (SELECT DISTINCT show_id FROM seasons)",
    ).run();
  });
  prune();
  return missing.length;
}

function linkEpisodeToShow(
  db: Database.Database,
  filePath: string,
  classified: {
    showTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
  },
): void {
  if (!classified.showTitle || classified.episodeNumber == null) return;
  db.prepare(
    "INSERT OR IGNORE INTO tv_shows (title, folder_path) VALUES (?, ?)",
  ).run(classified.showTitle, classified.showTitle);
  const show = db
    .prepare("SELECT id FROM tv_shows WHERE title = ?")
    .get(classified.showTitle) as { id: number } | undefined;
  if (!show) return;
  const seasonNum = classified.seasonNumber || 1;
  db.prepare(
    "INSERT OR IGNORE INTO seasons (show_id, season_number) VALUES (?, ?)",
  ).run(show.id, seasonNum);
  const season = db
    .prepare("SELECT id FROM seasons WHERE show_id = ? AND season_number = ?")
    .get(show.id, seasonNum) as { id: number } | undefined;
  if (!season) return;
  const media = db
    .prepare("SELECT id FROM media_items WHERE file_path = ?")
    .get(filePath) as { id: number } | undefined;
  if (!media) return;
  db.prepare(
    "INSERT OR IGNORE INTO episodes (season_id, media_id, episode_number) VALUES (?, ?, ?)",
  ).run(season.id, media.id, classified.episodeNumber);
}

export function browseLibrary(
  db: Database.Database,
  options: {
    type?: string;
    category?: string;
    limit?: number;
    offset?: number;
    search?: string;
    includeHidden?: boolean;
  },
): { items: MediaItem[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.type) {
    conditions.push("mi.type = ?");
    params.push(options.type);
  }
  if (options.category) {
    conditions.push("lf.category = ?");
    params.push(options.category);
  }
  if (options.search) {
    const escaped = options.search.replace(/[%_\\]/g, "\\$&");
    conditions.push("mi.title LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);
  }
  // Filter in SQL (not post-hoc) so LIMIT/OFFSET pagination stays correct.
  // A search additionally requires the folder to be searchable.
  if (!options.includeHidden)
    conditions.push(
      `mi.library_folder_id IN (${visibleFolderSubquery(
        options.search ? "search" : "view",
      )})`,
    );
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit || 50;
  const offset = options.offset || 0;
  const total = db
    .prepare(
      `SELECT COUNT(*) as count FROM media_items mi LEFT JOIN library_folders lf ON mi.library_folder_id = lf.id ${where}`,
    )
    .get(...params) as { count: number };
  const items = db
    .prepare(
      `SELECT mi.* FROM media_items mi LEFT JOIN library_folders lf ON mi.library_folder_id = lf.id ${where} ORDER BY mi.sort_title ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as MediaItem[];
  return { items, total: total.count };
}

export function getMediaItem(
  db: Database.Database,
  id: number,
): MediaItem | undefined {
  return db.prepare("SELECT * FROM media_items WHERE id = ?").get(id) as
    MediaItem | undefined;
}

export function getRecentlyAdded(
  db: Database.Database,
  limit: number = 20,
  includeHidden: boolean = false,
): MediaItem[] {
  const where = includeHidden
    ? ""
    : `WHERE library_folder_id IN (${visibleFolderSubquery("view")})`;
  return db
    .prepare(
      `SELECT * FROM media_items ${where} ORDER BY added_at DESC LIMIT ?`,
    )
    .all(limit) as MediaItem[];
}

export function getTVShows(
  db: Database.Database,
  includeHidden: boolean = false,
) {
  // A show is visible when at least one of its episodes' media is in a visible
  // folder; hidden-only shows drop out via HAVING episode_count > 0.
  const join = includeHidden
    ? "LEFT JOIN episodes e ON e.season_id = s.id"
    : `LEFT JOIN episodes e ON e.season_id = s.id AND e.media_id IN (SELECT id FROM media_items WHERE library_folder_id IN (${visibleFolderSubquery(
        "view",
      )}))`;
  const having = includeHidden ? "" : "HAVING episode_count > 0";
  return db
    .prepare(
      `SELECT ts.*, COUNT(DISTINCT s.id) as season_count, COUNT(e.id) as episode_count FROM tv_shows ts LEFT JOIN seasons s ON s.show_id = ts.id ${join} GROUP BY ts.id ${having} ORDER BY ts.title`,
    )
    .all();
}

// True if a show has at least one episode in a visible folder — the access
// boundary for the show-detail route for non-admins.
export function isShowVisible(db: Database.Database, showId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM episodes e
       JOIN seasons s ON s.id = e.season_id
       WHERE s.show_id = ? AND e.media_id IN (SELECT id FROM media_items WHERE library_folder_id IN (${visibleFolderSubquery(
         "view",
       )})) LIMIT 1`,
    )
    .get(showId);
  return !!row;
}

export function getTVShowDetail(
  db: Database.Database,
  showId: number,
  includeHidden: boolean = false,
) {
  const show = db.prepare("SELECT * FROM tv_shows WHERE id = ?").get(showId);
  if (!show) return null;
  // A show can span folders (episodes matched by title across libraries). For a
  // non-admin, only surface episodes whose media is in a visible folder — a
  // show that's reachable via one visible episode must not leak hidden ones.
  const epGate = includeHidden
    ? ""
    : `AND e.media_id IN (SELECT id FROM media_items WHERE library_folder_id IN (${visibleFolderSubquery(
        "view",
      )}))`;
  const seasons = db
    .prepare(
      `SELECT s.*, json_group_array(json_object('id', e.id, 'episode_number', e.episode_number, 'media_id', e.media_id, 'title', mi.title, 'duration', mi.duration, 'poster_path', mi.poster_path)) as episodes FROM seasons s LEFT JOIN episodes e ON e.season_id = s.id ${epGate} LEFT JOIN media_items mi ON mi.id = e.media_id WHERE s.show_id = ? GROUP BY s.id ORDER BY s.season_number`,
    )
    .all(showId);
  return { show, seasons };
}
