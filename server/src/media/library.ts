import type Database from "better-sqlite3";
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
  return db
    .prepare(
      "INSERT INTO library_folders (path, category) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET category = excluded.category RETURNING *",
    )
    .get(path, category) as LibraryFolder;
}

export function getLibraryFolders(db: Database.Database): LibraryFolder[] {
  return db
    .prepare("SELECT * FROM library_folders ORDER BY path")
    .all() as LibraryFolder[];
}

export function removeLibraryFolder(db: Database.Database, id: number): void {
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM media_items WHERE library_folder_id = ?").run(id);
    db.prepare("DELETE FROM library_folders WHERE id = ?").run(id);
  });
  remove();
}

export async function scanLibraryFolder(
  db: Database.Database,
  folder: LibraryFolder,
  config: Config,
): Promise<number> {
  db.prepare("UPDATE library_folders SET scan_status = ? WHERE id = ?").run(
    "scanning",
    folder.id,
  );
  let added = 0;
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
  return added;
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
    conditions.push("mi.title LIKE ?");
    params.push(`%${options.search}%`);
  }
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
    | MediaItem
    | undefined;
}

export function getRecentlyAdded(
  db: Database.Database,
  limit: number = 20,
): MediaItem[] {
  return db
    .prepare("SELECT * FROM media_items ORDER BY added_at DESC LIMIT ?")
    .all(limit) as MediaItem[];
}

export function getTVShows(db: Database.Database) {
  return db
    .prepare(
      "SELECT ts.*, COUNT(DISTINCT s.id) as season_count, COUNT(e.id) as episode_count FROM tv_shows ts LEFT JOIN seasons s ON s.show_id = ts.id LEFT JOIN episodes e ON e.season_id = s.id GROUP BY ts.id ORDER BY ts.title",
    )
    .all();
}

export function getTVShowDetail(db: Database.Database, showId: number) {
  const show = db.prepare("SELECT * FROM tv_shows WHERE id = ?").get(showId);
  if (!show) return null;
  const seasons = db
    .prepare(
      "SELECT s.*, json_group_array(json_object('id', e.id, 'episode_number', e.episode_number, 'media_id', e.media_id, 'title', mi.title, 'duration', mi.duration, 'poster_path', mi.poster_path)) as episodes FROM seasons s LEFT JOIN episodes e ON e.season_id = s.id LEFT JOIN media_items mi ON mi.id = e.media_id WHERE s.show_id = ? GROUP BY s.id ORDER BY s.season_number",
    )
    .all(showId);
  return { show, seasons };
}
