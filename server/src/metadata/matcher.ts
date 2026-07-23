import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import {
  searchMovie,
  searchTV,
  getMovieDetail,
  getTVDetail,
  fullPosterUrl,
  fullBackdropUrl,
} from "./tmdb.js";

export const CACHE_DAYS = 30;

interface CacheRow {
  fetched_at: number;
  external_id: string;
}

// The Unix-seconds cutoff before which a cache row is stale. Anything with
// fetched_at > this is fresh (matched or negatively cached) and needs no fetch;
// the incremental backfill uses the same cutoff to skip fresh rows in SQL.
export function metadataStaleCutoff(): number {
  return Math.floor(Date.now() / 1000) - CACHE_DAYS * 24 * 60 * 60;
}

// The fresh tmdb cache row for a media item, or null if none/stale. A row with
// external_id '' is a remembered NO-MATCH (a title TMDb couldn't find) — kept so
// unmatchable files aren't re-searched on every scan.
function freshCacheRow(
  db: Database.Database,
  mediaId: number,
): CacheRow | null {
  const row = db
    .prepare(
      "SELECT fetched_at, external_id FROM metadata_cache WHERE media_id = ? AND provider = 'tmdb'",
    )
    .get(mediaId) as CacheRow | undefined;
  if (!row || row.fetched_at <= metadataStaleCutoff()) return null;
  return row;
}

function freshShowCacheRow(
  db: Database.Database,
  showId: number,
): CacheRow | null {
  const row = db
    .prepare(
      "SELECT fetched_at, external_id FROM metadata_cache WHERE show_id = ? AND provider = 'tmdb'",
    )
    .get(showId) as CacheRow | undefined;
  if (!row || row.fetched_at <= metadataStaleCutoff()) return null;
  return row;
}

// Remember that a search found nothing (external_id '', empty data), so the
// item isn't re-queried until the row goes stale. Distinct from a real match.
function cacheNoMatch(
  db: Database.Database,
  key: { mediaId: number } | { showId: number },
): void {
  const now = Math.floor(Date.now() / 1000);
  if ("mediaId" in key)
    db.prepare(
      "INSERT INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, 'tmdb', '', '', ?) ON CONFLICT(media_id, provider) DO UPDATE SET external_id = '', data_json = '', fetched_at = excluded.fetched_at",
    ).run(key.mediaId, now);
  else
    db.prepare(
      "INSERT INTO metadata_cache (show_id, provider, external_id, data_json, fetched_at) VALUES (?, 'tmdb', '', '', ?) ON CONFLICT(show_id, provider) DO UPDATE SET external_id = '', data_json = '', fetched_at = excluded.fetched_at",
    ).run(key.showId, now);
}

export async function matchAndApplyMetadata(
  db: Database.Database,
  mediaId: number,
  config: Config,
  // force: an explicit user "match this" re-searches even a remembered
  // no-match; the automatic backfill leaves force off and respects the cache.
  force = false,
): Promise<boolean> {
  if (!config.tmdbApiKey) return false;
  const cached = force ? null : freshCacheRow(db, mediaId);
  if (cached) return cached.external_id !== ""; // '' = remembered no-match

  const media = db
    .prepare("SELECT title, year, type FROM media_items WHERE id = ?")
    .get(mediaId) as
    { title: string; year: number | null; type: string } | undefined;
  if (!media) return false;

  const isTV = media.type === "episode";
  const results = isTV
    ? await searchTV(media.title, media.year, config.tmdbApiKey)
    : await searchMovie(media.title, media.year, config.tmdbApiKey);

  if (results.length === 0) {
    cacheNoMatch(db, { mediaId });
    return false;
  }

  const best = results[0];
  if (isTV) {
    const detail = await getTVDetail(best.id, config.tmdbApiKey);
    const genres = detail.genres.map((g) => g.name).join(", ");
    db.prepare(
      "UPDATE media_items SET description = ?, poster_path = ?, backdrop_path = ?, rating = ?, genres = ? WHERE id = ?",
    ).run(
      detail.overview || null,
      fullPosterUrl(detail.poster_path),
      fullBackdropUrl(detail.backdrop_path),
      detail.vote_average || null,
      genres || null,
      mediaId,
    );
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(media_id, provider) DO UPDATE SET external_id = excluded.external_id, data_json = excluded.data_json, fetched_at = excluded.fetched_at",
    ).run(mediaId, "tmdb", String(best.id), JSON.stringify(detail), now);
  } else {
    const detail = await getMovieDetail(best.id, config.tmdbApiKey);
    const genres = detail.genres.map((g) => g.name).join(", ");
    db.prepare(
      "UPDATE media_items SET description = ?, poster_path = ?, backdrop_path = ?, rating = ?, genres = ? WHERE id = ?",
    ).run(
      detail.overview || null,
      fullPosterUrl(detail.poster_path),
      fullBackdropUrl(detail.backdrop_path),
      detail.vote_average || null,
      genres || null,
      mediaId,
    );
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(media_id, provider) DO UPDATE SET external_id = excluded.external_id, data_json = excluded.data_json, fetched_at = excluded.fetched_at",
    ).run(mediaId, "tmdb", String(best.id), JSON.stringify(detail), now);
  }
  return true;
}

export async function matchAndApplyShowMetadata(
  db: Database.Database,
  showId: number,
  config: Config,
  force = false,
): Promise<boolean> {
  if (!config.tmdbApiKey) return false;
  const cached = force ? null : freshShowCacheRow(db, showId);
  if (cached) return cached.external_id !== ""; // '' = remembered no-match

  const show = db
    .prepare("SELECT title, year FROM tv_shows WHERE id = ?")
    .get(showId) as { title: string; year: number | null } | undefined;
  if (!show) return false;

  const results = await searchTV(show.title, show.year, config.tmdbApiKey);
  if (results.length === 0) {
    cacheNoMatch(db, { showId });
    return false;
  }

  const best = results[0];
  const detail = await getTVDetail(best.id, config.tmdbApiKey);

  db.prepare(
    "UPDATE tv_shows SET description = ?, poster_path = ?, backdrop_path = ? WHERE id = ?",
  ).run(
    detail.overview || null,
    fullPosterUrl(detail.poster_path),
    fullBackdropUrl(detail.backdrop_path),
    showId,
  );

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO metadata_cache (show_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(show_id, provider) DO UPDATE SET external_id = excluded.external_id, data_json = excluded.data_json, fetched_at = excluded.fetched_at",
  ).run(showId, "tmdb", String(best.id), JSON.stringify(detail), now);

  return true;
}

export async function applyManualMatch(
  db: Database.Database,
  mediaId: number,
  tmdbId: number,
  mediaType: "movie" | "tv",
  config: Config,
): Promise<boolean> {
  if (!config.tmdbApiKey) return false;

  if (mediaType === "tv") {
    const detail = await getTVDetail(tmdbId, config.tmdbApiKey);
    const genres = detail.genres.map((g) => g.name).join(", ");
    db.prepare(
      "UPDATE media_items SET description = ?, poster_path = ?, backdrop_path = ?, rating = ?, genres = ? WHERE id = ?",
    ).run(
      detail.overview || null,
      fullPosterUrl(detail.poster_path),
      fullBackdropUrl(detail.backdrop_path),
      detail.vote_average || null,
      genres || null,
      mediaId,
    );
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(media_id, provider) DO UPDATE SET external_id = excluded.external_id, data_json = excluded.data_json, fetched_at = excluded.fetched_at",
    ).run(mediaId, "tmdb", String(tmdbId), JSON.stringify(detail), now);
  } else {
    const detail = await getMovieDetail(tmdbId, config.tmdbApiKey);
    const genres = detail.genres.map((g) => g.name).join(", ");
    db.prepare(
      "UPDATE media_items SET description = ?, poster_path = ?, backdrop_path = ?, rating = ?, genres = ? WHERE id = ?",
    ).run(
      detail.overview || null,
      fullPosterUrl(detail.poster_path),
      fullBackdropUrl(detail.backdrop_path),
      detail.vote_average || null,
      genres || null,
      mediaId,
    );
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(media_id, provider) DO UPDATE SET external_id = excluded.external_id, data_json = excluded.data_json, fetched_at = excluded.fetched_at",
    ).run(mediaId, "tmdb", String(tmdbId), JSON.stringify(detail), now);
  }
  return true;
}
