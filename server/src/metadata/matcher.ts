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

const CACHE_DAYS = 30;

interface CacheRow {
  fetched_at: number;
  data_json: string;
}

function isCacheFresh(db: Database.Database, mediaId: number): boolean {
  const row = db
    .prepare(
      "SELECT fetched_at FROM metadata_cache WHERE media_id = ? ORDER BY fetched_at DESC LIMIT 1",
    )
    .get(mediaId) as CacheRow | undefined;
  if (!row) return false;
  const ageMs = Date.now() - row.fetched_at * 1000;
  return ageMs < CACHE_DAYS * 24 * 60 * 60 * 1000;
}

function isShowCacheFresh(db: Database.Database, showId: number): boolean {
  const row = db
    .prepare(
      "SELECT fetched_at FROM metadata_cache WHERE show_id = ? ORDER BY fetched_at DESC LIMIT 1",
    )
    .get(showId) as CacheRow | undefined;
  if (!row) return false;
  const ageMs = Date.now() - row.fetched_at * 1000;
  return ageMs < CACHE_DAYS * 24 * 60 * 60 * 1000;
}

export async function matchAndApplyMetadata(
  db: Database.Database,
  mediaId: number,
  config: Config,
): Promise<boolean> {
  if (!config.tmdbApiKey) return false;
  if (isCacheFresh(db, mediaId)) return true;

  const media = db
    .prepare("SELECT title, year, type FROM media_items WHERE id = ?")
    .get(mediaId) as
    | { title: string; year: number | null; type: string }
    | undefined;
  if (!media) return false;

  const isTV = media.type === "episode";
  const results = isTV
    ? await searchTV(media.title, media.year, config.tmdbApiKey)
    : await searchMovie(media.title, media.year, config.tmdbApiKey);

  if (results.length === 0) return false;

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
      "INSERT OR REPLACE INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?)",
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
      "INSERT OR REPLACE INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?)",
    ).run(mediaId, "tmdb", String(best.id), JSON.stringify(detail), now);
  }
  return true;
}

export async function matchAndApplyShowMetadata(
  db: Database.Database,
  showId: number,
  config: Config,
): Promise<boolean> {
  if (!config.tmdbApiKey) return false;
  if (isShowCacheFresh(db, showId)) return true;

  const show = db
    .prepare("SELECT title, year FROM tv_shows WHERE id = ?")
    .get(showId) as { title: string; year: number | null } | undefined;
  if (!show) return false;

  const results = await searchTV(show.title, show.year, config.tmdbApiKey);
  if (results.length === 0) return false;

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
    "INSERT OR REPLACE INTO metadata_cache (show_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?)",
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
      "INSERT OR REPLACE INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?)",
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
      "INSERT OR REPLACE INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?)",
    ).run(mediaId, "tmdb", String(tmdbId), JSON.stringify(detail), now);
  }
  return true;
}
