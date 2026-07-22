import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import { discoverMedia } from "../scanner/discover.js";
import { probeFile } from "../scanner/probe.js";
import { classifyMedia, type ClassifiedMedia } from "../scanner/classify.js";
import { getCategoryBySlug } from "./categories.js";
import {
  matchAndApplyMetadata,
  matchAndApplyShowMetadata,
} from "../metadata/matcher.js";
import { extractSubtitles } from "../subtitles/extract.js";
import { persistSubtitles } from "../subtitles/service.js";

export interface LibraryFolder {
  id: number;
  path: string;
  category: string;
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
  added_at?: number;
  // 1 when the requesting user has liked this item (only populated when
  // browseLibrary is called with a userId — the client's "liked first" sort).
  liked?: number;
}

export function addLibraryFolder(
  db: Database.Database,
  path: string,
  category: string,
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

// Boot-time fixup: scans run in-process, so none survive a restart. A folder
// left in 'scanning' is an interrupted scan — and the UI disables its
// Scan/Remove buttons for as long as the status says so.
export function resetInterruptedScans(db: Database.Database): number {
  return db
    .prepare(
      "UPDATE library_folders SET scan_status = 'error' WHERE scan_status = 'scanning'",
    )
    .run().changes;
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

// Sample/trailer filter: release folders ship 30-60s "sample" clips next to
// the real file. A VIDEO file with a KNOWN duration under the configured
// floor (config.minDurationSeconds, default 120, 0 = off) is neither
// inserted nor enriched. Two hard rules: unknown duration (probe failed,
// container reports 0) is NOT short — never drop media on missing evidence;
// and audio is NEVER filtered — sub-2-minute tracks are normal music.
function isShortSample(
  isVideo: boolean,
  duration: number | null | undefined,
  config: Config,
): boolean {
  return (
    config.minDurationSeconds > 0 &&
    isVideo &&
    duration != null &&
    duration > 0 &&
    duration < config.minDurationSeconds
  );
}

export async function scanLibraryFolder(
  db: Database.Database,
  folder: LibraryFolder,
  config: Config,
): Promise<{ added: number; pruned: number; skippedShort: number }> {
  db.prepare("UPDATE library_folders SET scan_status = ? WHERE id = ?").run(
    "scanning",
    folder.id,
  );
  let added = 0;
  let pruned = 0;
  let skippedShort = 0;
  try {
    const files = await discoverMedia(folder.path);
    // Folder rows can only reference existing categories (creation is
    // validated), but a legacy slug with no row degrades to plain movie-kind.
    const category = getCategoryBySlug(db, folder.category) ?? {
      slug: folder.category,
      kind: "movie" as const,
    };
    const insertMedia = db.prepare(
      "INSERT OR IGNORE INTO media_items (library_folder_id, type, file_path, file_size, title, sort_title, year, codec_video, codec_audio, resolution_width, resolution_height, bitrate, duration, audio_tracks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const file of files) {
      const classified = classifyMedia(file.path, folder.path, category);
      const existing = db
        .prepare(
          "SELECT id, type, title, year, duration FROM media_items WHERE file_path = ?",
        )
        .get(file.path) as
        | {
            id: number;
            type: string;
            title: string;
            year: number | null;
            duration: number | null;
          }
        | undefined;
      if (existing) {
        // Backfill: rows stored before the short-file filter existed get
        // pruned on rescan (FK cascades clean episodes/progress/playlists;
        // orphaned shows are swept below). Row deletion on scan is exactly
        // what VLMP_EMPTY_TRASH_ON_SCAN opts out of — honor it here too.
        if (
          config.emptyTrashOnScan &&
          isShortSample(file.isVideo, existing.duration, config)
        ) {
          db.prepare("DELETE FROM media_items WHERE id = ?").run(existing.id);
          skippedShort++;
          continue;
        }
        // Backfill: classification rules changed (or the folder's category
        // did) — re-derive from the source path and migrate the stored row.
        // Metadata enrichment is safe: TMDb writes description/poster/genres,
        // never title/year, so re-deriving those clobbers nothing.
        reclassifyExistingItem(db, existing, file.path, classified, folder);
        continue;
      }
      let probe = null;
      try {
        probe = await probeFile(file.path, config);
      } catch {
        /* skip */
      }
      // Short video = sample/trailer: don't insert, don't TMDb-match, don't
      // extract subtitles.
      if (isShortSample(file.isVideo, probe?.duration, config)) {
        skippedShort++;
        continue;
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

        // Extract subtitles if present (non-fatal). Off by default: extraction
        // demuxes the ENTIRE file, so a full-library scan pins the media drive
        // at 100% read for hours. Playback-time extraction covers the normal
        // path; VLMP_EXTRACT_SUBS_ON_SCAN=true opts back in.
        if (
          config.extractSubsOnScan &&
          probe?.subtitleTracks &&
          probe.subtitleTracks.length > 0
        ) {
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

      if (classified.type === "episode" && classified.showTitle) {
        const showId = linkEpisodeToShow(db, file.path, folder, classified);
        // Match show metadata from TMDb (non-fatal)
        if (showId && config.tmdbApiKey) {
          try {
            await matchAndApplyShowMetadata(db, showId, config);
          } catch {
            /* non-fatal */
          }
        }
      }
    }
    // Empty trash: drop rows for files removed/renamed since the last scan.
    if (config.emptyTrashOnScan) pruned = pruneMissingFiles(db, folder.id);
    // Reclassification can move episodes between shows (and legacy shows were
    // keyed by title, not folder) — sweep whatever is left empty.
    sweepOrphanShows(db);
    if (skippedShort > 0)
      console.log(
        `[scan] ignored ${skippedShort} video${skippedShort === 1 ? "" : "s"} shorter than ${config.minDurationSeconds}s (samples) in folder ${folder.id}`,
      );
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
  return { added, pruned, skippedShort };
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

// Show identity is the show's real directory (library-relative root resolved
// against the folder path) — two shows with the same title in different
// folders stay distinct, and renaming a title doesn't duplicate the show.
// Legacy rows stored the TITLE in folder_path; the episode upsert migrates
// their episodes here and sweepOrphanShows removes the emptied legacy row.
function showFolderPath(
  folder: LibraryFolder,
  classified: ClassifiedMedia,
): string {
  if (classified.showRootRel === null)
    // Bare file in the library root: no directory to key on. Synthetic id,
    // scoped to the folder, that can't collide with a real absolute path.
    return `title:${folder.id}:${classified.showTitle}`;
  if (classified.showRootRel === "") return folder.path;
  return join(folder.path, classified.showRootRel);
}

function linkEpisodeToShow(
  db: Database.Database,
  filePath: string,
  folder: LibraryFolder,
  classified: ClassifiedMedia,
): number | null {
  if (!classified.showTitle) return null;
  const show = db
    .prepare(
      "INSERT INTO tv_shows (title, year, folder_path) VALUES (?, ?, ?) ON CONFLICT(folder_path) DO UPDATE SET title = excluded.title, year = COALESCE(excluded.year, tv_shows.year) RETURNING id",
    )
    .get(
      classified.showTitle,
      classified.showYear,
      showFolderPath(folder, classified),
    ) as { id: number } | undefined;
  if (!show) return null;
  const seasonNum = classified.seasonNumber || 1;
  db.prepare(
    "INSERT OR IGNORE INTO seasons (show_id, season_number) VALUES (?, ?)",
  ).run(show.id, seasonNum);
  const season = db
    .prepare("SELECT id FROM seasons WHERE show_id = ? AND season_number = ?")
    .get(show.id, seasonNum) as { id: number } | undefined;
  if (!season) return show.id;
  const media = db
    .prepare("SELECT id FROM media_items WHERE file_path = ?")
    .get(filePath) as { id: number } | undefined;
  if (!media) return show.id;
  const nextSlot = () =>
    ((
      db
        .prepare(
          "SELECT MAX(episode_number) AS m FROM episodes WHERE season_id = ?",
        )
        .get(season.id) as { m: number | null }
    ).m ?? 0) + 1;
  // A series file must bundle under its show even when the filename carries no
  // episode number (bare "1.mkv", "E01.mkv", a descriptive title, or a number
  // that lives only in the "Season N" folder). Left unlinked, such a row stays
  // type='episode' yet absent from the episodes table — and the flat grid,
  // which hides LINKED episodes rather than the 'episode' type, would surface
  // it loose below the bundled show card ("unbundled on scroll"). Give it a
  // stable in-season slot instead: reuse the number already stored so rescans
  // never renumber, else take the next free slot after any real episodes.
  const synthetic = classified.episodeNumber == null;
  let episodeNumber: number;
  if (synthetic) {
    const prior = db
      .prepare("SELECT episode_number FROM episodes WHERE media_id = ?")
      .get(media.id) as { episode_number: number } | undefined;
    episodeNumber = prior ? prior.episode_number : nextSlot();
  } else {
    episodeNumber = classified.episodeNumber!;
    // A synthetic episode may have already claimed this real number (an
    // unnumbered sibling scanned first). Move the squatter to a fresh slot so
    // the real episode keeps its rightful number instead of failing to link.
    const squatter = db
      .prepare(
        "SELECT id FROM episodes WHERE season_id = ? AND episode_number = ? AND synthetic = 1 AND media_id != ?",
      )
      .get(season.id, episodeNumber, media.id) as { id: number } | undefined;
    if (squatter)
      db.prepare("UPDATE episodes SET episode_number = ? WHERE id = ?").run(
        nextSlot(),
        squatter.id,
      );
  }
  try {
    // Upsert on media_id so reclassification MOVES an episode to its new
    // show/season instead of leaving it stuck on the legacy link.
    db.prepare(
      "INSERT INTO episodes (season_id, media_id, episode_number, synthetic) VALUES (?, ?, ?, ?) ON CONFLICT(media_id) DO UPDATE SET season_id = excluded.season_id, episode_number = excluded.episode_number, synthetic = excluded.synthetic",
    ).run(season.id, media.id, episodeNumber, synthetic ? 1 : 0);
  } catch (err) {
    // UNIQUE(season_id, episode_number): a second copy of the same episode
    // (different quality/container) — keep the first one linked. Anything
    // else (BUSY, IO) must not be silent: the episode would just vanish
    // from the show page with no trace.
    const code = (err as { code?: string }).code || "";
    if (!code.startsWith("SQLITE_CONSTRAINT"))
      console.warn(
        `[scan] episode link failed for media ${media.id}: ${err instanceof Error ? err.message : err}`,
      );
  }
  return show.id;
}

// Backfill for rows scanned under older classification rules: re-derive
// type/title/year from the file path and repair the episode link. Runs on
// every rescan; a no-op when nothing changed.
function reclassifyExistingItem(
  db: Database.Database,
  existing: { id: number; type: string; title: string; year: number | null },
  filePath: string,
  classified: ClassifiedMedia,
  folder: LibraryFolder,
): void {
  // Any parse difference (not just a type flip) gets re-derived: classifier
  // fixes must heal rows stored by older versions. TMDb never writes
  // title/year (only description/poster/genres/rating), so this clobbers
  // nothing enrichment owns.
  if (
    existing.type !== classified.type ||
    existing.title !== classified.title ||
    existing.year !== classified.year
  ) {
    const sortTitle = classified.title
      .replace(/^(?:the|a|an)\s+/i, "")
      .toLowerCase();
    db.prepare(
      "UPDATE media_items SET type = ?, title = ?, sort_title = ?, year = ?, updated_at = unixepoch() WHERE id = ?",
    ).run(
      classified.type,
      classified.title,
      sortTitle,
      classified.year,
      existing.id,
    );
  }
  if (classified.type === "episode") {
    linkEpisodeToShow(db, filePath, folder, classified);
  } else if (existing.type === "episode") {
    db.prepare("DELETE FROM episodes WHERE media_id = ?").run(existing.id);
  }
}

// Delete seasons/shows that no longer have any episodes.
export function sweepOrphanShows(db: Database.Database): void {
  db.prepare(
    "DELETE FROM seasons WHERE id NOT IN (SELECT DISTINCT season_id FROM episodes)",
  ).run();
  db.prepare(
    "DELETE FROM tv_shows WHERE id NOT IN (SELECT DISTINCT show_id FROM seasons)",
  ).run();
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
    excludeEpisodes?: boolean;
    // Return the whole matching set in one shot (LIMIT/OFFSET skipped). The
    // client caches and sorts a full category locally, so it loads it once.
    all?: boolean;
    // When set, each row carries a `liked` 0/1 for this user (client sort).
    userId?: number;
  },
): { items: MediaItem[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.type) {
    conditions.push("mi.type = ?");
    params.push(options.type);
  }
  // Grid/shelf views list shows as single cards, so hide exactly the items
  // reachable through a show page. Keyed on the episodes LINK, not on
  // type='episode': an unlinkable episode (no parseable number) must stay
  // visible in the flat grid or it would be reachable nowhere.
  if (options.excludeEpisodes)
    conditions.push("mi.id NOT IN (SELECT media_id FROM episodes)");
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
  // The liked flag lives in the SELECT list, so its param precedes the WHERE
  // params in bind order.
  const selectParams: unknown[] = [];
  let likedCol = "0 AS liked";
  if (options.userId != null) {
    likedCol =
      "CASE WHEN EXISTS (SELECT 1 FROM user_preferences up WHERE up.media_id = mi.id AND up.user_id = ? AND up.action = 'like') THEN 1 ELSE 0 END AS liked";
    selectParams.push(options.userId);
  }
  const total = db
    .prepare(
      `SELECT COUNT(*) as count FROM media_items mi LEFT JOIN library_folders lf ON mi.library_folder_id = lf.id ${where}`,
    )
    .get(...params) as { count: number };
  const limitClause = options.all ? "" : "LIMIT ? OFFSET ?";
  const limitParams = options.all
    ? []
    : [options.limit || 50, options.offset || 0];
  const items = db
    .prepare(
      `SELECT mi.*, ${likedCol} FROM media_items mi LEFT JOIN library_folders lf ON mi.library_folder_id = lf.id ${where} ORDER BY mi.sort_title ASC ${limitClause}`,
    )
    .all(...selectParams, ...params, ...limitParams) as MediaItem[];
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
  category?: string,
  userId?: number,
) {
  // A show is visible when at least one of its episodes' media is in a visible
  // folder; hidden-only shows drop out via HAVING episode_count > 0.
  const epJoin = includeHidden
    ? "LEFT JOIN episodes e ON e.season_id = s.id"
    : `LEFT JOIN episodes e ON e.season_id = s.id AND e.media_id IN (SELECT id FROM media_items WHERE library_folder_id IN (${visibleFolderSubquery(
        "view",
      )}))`;
  const having = includeHidden ? "" : "HAVING episode_count > 0";
  // Same visibility gate reused by the correlated subqueries below so a show
  // spanning a visible + hidden folder never borrows a hidden episode's id,
  // date, or like (read_gate_every_surface).
  const mediaGate = includeHidden
    ? ""
    : `AND {alias}.media_id IN (SELECT id FROM media_items WHERE library_folder_id IN (${visibleFolderSubquery("view")}))`;
  // The liked flag's param sits in the SELECT list, so it precedes the
  // category param (WHERE) in bind order.
  const params: unknown[] = [];
  let likedCol = "0 AS liked";
  if (userId != null) {
    likedCol = `CASE WHEN EXISTS (SELECT 1 FROM episodes le JOIN seasons ls ON le.season_id = ls.id JOIN user_preferences up ON up.media_id = le.media_id WHERE ls.show_id = ts.id AND up.user_id = ? AND up.action = 'like' ${mediaGate.replace("{alias}", "le")}) THEN 1 ELSE 0 END AS liked`;
    params.push(userId);
  }
  let categoryFilter = "";
  if (category) {
    categoryFilter = `WHERE EXISTS (SELECT 1 FROM episodes e2 JOIN seasons s2 ON e2.season_id = s2.id JOIN media_items m2 ON m2.id = e2.media_id JOIN library_folders lf2 ON lf2.id = m2.library_folder_id WHERE s2.show_id = ts.id AND lf2.category = ?)`;
    params.push(category);
  }
  return db
    .prepare(
      `SELECT ts.*, COUNT(DISTINCT s.id) as season_count, COUNT(e.id) as episode_count,
        (SELECT e3.media_id FROM episodes e3 JOIN seasons s3 ON e3.season_id = s3.id WHERE s3.show_id = ts.id ${mediaGate.replace("{alias}", "e3")} ORDER BY s3.season_number, e3.episode_number LIMIT 1) as first_media_id,
        (SELECT MAX(m4.added_at) FROM episodes e4 JOIN seasons s4 ON e4.season_id = s4.id JOIN media_items m4 ON m4.id = e4.media_id WHERE s4.show_id = ts.id ${mediaGate.replace("{alias}", "e4")}) as added_at,
        ${likedCol}
       FROM tv_shows ts LEFT JOIN seasons s ON s.show_id = ts.id ${epJoin} ${categoryFilter} GROUP BY ts.id ${having} ORDER BY ts.title`,
    )
    .all(...params);
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
  const rows = db
    .prepare(
      `SELECT s.*, json_group_array(json_object('id', e.id, 'episode_number', e.episode_number, 'media_id', e.media_id, 'title', mi.title, 'duration', mi.duration, 'poster_path', mi.poster_path)) as episodes FROM seasons s LEFT JOIN episodes e ON e.season_id = s.id ${epGate} LEFT JOIN media_items mi ON mi.id = e.media_id WHERE s.show_id = ? GROUP BY s.id ORDER BY s.season_number`,
    )
    .all(showId) as ({ episodes: string } & Record<string, unknown>)[];
  // json_group_array returns a JSON STRING per row, and a season whose
  // episodes were all filtered by the gate yields [{"id":null,...}] — parse
  // and drop those so clients get real arrays with real episodes only.
  const seasons = rows
    .map((row) => {
      let episodes: {
        id: number | null;
        episode_number: number;
        media_id: number;
        title: string | null;
        duration: number | null;
        poster_path: string | null;
      }[] = [];
      try {
        episodes = JSON.parse(row.episodes);
      } catch {
        /* defensive: malformed aggregate row */
      }
      return {
        ...row,
        episodes: episodes
          .filter((e) => e.id !== null)
          .sort((a, b) => a.episode_number - b.episode_number),
      };
    })
    .filter((s) => s.episodes.length > 0 || includeHidden);
  return { show, seasons };
}
