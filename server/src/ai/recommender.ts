import type Database from "better-sqlite3";
import {
  getCompletedMediaIds,
  getRecentCompletedMediaIds,
} from "./viewing-log.js";
import { getLikedMediaIds, getDislikedMediaIds } from "./preferences.js";
import { getCachedResult, setCachedResult, invalidateCache } from "./cache.js";

export interface ScoredItem {
  media_id: number;
  score: number;
  reason: string;
}

export interface RecommendationResult {
  items: ScoredItem[];
  strategies_used: string[];
  computed_at: number;
}

interface MediaRow {
  id: number;
  type: string;
  title: string;
  genres: string | null;
  year: number | null;
  rating: number | null;
  duration: number | null;
}

export function getRecommendations(
  db: Database.Database,
  userId: number,
  limit = 40,
): RecommendationResult {
  const cached = getCachedResult<RecommendationResult>(
    db,
    userId,
    "recommendations",
  );
  if (cached) return cached;

  const completedIds = getCompletedMediaIds(db, userId);
  const likedIds = getLikedMediaIds(db, userId);
  const dislikedIds = new Set(getDislikedMediaIds(db, userId));
  const watchedSet = new Set(completedIds);

  const allScored = new Map<number, ScoredItem>();
  const strategiesUsed: string[] = [];

  // Strategy 1: Next episode
  const nextEps = nextEpisodeStrategy(db, userId);
  if (nextEps.length > 0) {
    strategiesUsed.push("next_episode");
    for (const item of nextEps) mergeItem(allScored, item);
  }

  // Strategy 2: Collaborative filtering (requires >= 3 completions)
  if (completedIds.length >= 3) {
    const collab = collaborativeStrategy(db, userId, completedIds);
    if (collab.length > 0) {
      strategiesUsed.push("collaborative");
      for (const item of collab) mergeItem(allScored, item);
    }
  }

  // Strategy 3: Genre matching (requires >= 1 completion)
  if (completedIds.length >= 1) {
    const genreItems = genreMatchingStrategy(db, completedIds);
    if (genreItems.length > 0) {
      strategiesUsed.push("genre_matching");
      for (const item of genreItems) mergeItem(allScored, item);
    }
  }

  // Strategy 4: Similar items
  const recentIds = getRecentCompletedMediaIds(db, userId, 3);
  if (recentIds.length > 0) {
    const similar = similarItemsStrategy(db, recentIds);
    if (similar.length > 0) {
      strategiesUsed.push("similar_items");
      for (const item of similar) mergeItem(allScored, item);
    }
  }

  // Strategy 5: Popularity (always runs)
  const popular = popularityStrategy(db);
  if (popular.length > 0) {
    strategiesUsed.push("popularity");
    for (const item of popular) mergeItem(allScored, item);
  }

  // Build genre affinity for boosting
  const likedGenres = buildGenreAffinity(db, likedIds);

  // Pipeline: boost liked genres, exclude watched + disliked, sort, slice
  let results = Array.from(allScored.values());

  for (const item of results) {
    // Boost liked genre items by 20%
    const mediaGenres = getMediaGenres(db, item.media_id);
    for (const g of mediaGenres) {
      if (likedGenres.has(g)) {
        item.score *= 1.2;
        break;
      }
    }
  }

  results = results.filter(
    (item) => !watchedSet.has(item.media_id) && !dislikedIds.has(item.media_id),
  );
  results.sort((a, b) => b.score - a.score);
  results = results.slice(0, limit);

  const result: RecommendationResult = {
    items: results,
    strategies_used: strategiesUsed,
    computed_at: Math.floor(Date.now() / 1000),
  };

  setCachedResult(db, userId, "recommendations", result);
  return result;
}

export function getSimilarItems(
  db: Database.Database,
  mediaId: number,
  limit = 10,
): ScoredItem[] {
  return similarItemsStrategy(db, [mediaId]).slice(0, limit);
}

export function invalidateRecommendationCache(
  db: Database.Database,
  userId: number,
): void {
  invalidateCache(db, userId, "recommendations");
}

// --- Internal strategies ---

function nextEpisodeStrategy(
  db: Database.Database,
  userId: number,
): ScoredItem[] {
  const results: ScoredItem[] = [];
  // Find episodes the user completed
  const completedEpisodes = db
    .prepare(
      `SELECT e.season_id, e.episode_number, s.show_id, s.season_number, mi.title as show_title
       FROM viewing_log vl
       JOIN episodes e ON e.media_id = vl.media_id
       JOIN seasons s ON s.id = e.season_id
       JOIN tv_shows tv ON tv.id = s.show_id
       JOIN media_items mi ON mi.id = vl.media_id
       WHERE vl.user_id = ? AND vl.completed = 1
       ORDER BY vl.watched_at DESC`,
    )
    .all(userId) as {
    season_id: number;
    episode_number: number;
    show_id: number;
    season_number: number;
    show_title: string;
  }[];

  const suggestedShows = new Set<number>();

  for (const ep of completedEpisodes) {
    if (suggestedShows.has(ep.show_id)) continue;

    // Try next episode in same season
    const nextInSeason = db
      .prepare(
        "SELECT e.media_id FROM episodes e WHERE e.season_id = ? AND e.episode_number = ?",
      )
      .get(ep.season_id, ep.episode_number + 1) as
      | { media_id: number }
      | undefined;

    if (nextInSeason) {
      results.push({
        media_id: nextInSeason.media_id,
        score: 200,
        reason: "Next episode",
      });
      suggestedShows.add(ep.show_id);
      continue;
    }

    // Try first episode of next season
    const nextSeason = db
      .prepare(
        "SELECT s.id as season_id FROM seasons s WHERE s.show_id = ? AND s.season_number = ?",
      )
      .get(ep.show_id, ep.season_number + 1) as
      | { season_id: number }
      | undefined;

    if (nextSeason) {
      const firstEp = db
        .prepare(
          "SELECT e.media_id FROM episodes e WHERE e.season_id = ? ORDER BY e.episode_number ASC LIMIT 1",
        )
        .get(nextSeason.season_id) as { media_id: number } | undefined;

      if (firstEp) {
        results.push({
          media_id: firstEp.media_id,
          score: 200,
          reason: "Next season premiere",
        });
        suggestedShows.add(ep.show_id);
      }
    }
  }

  return results;
}

function collaborativeStrategy(
  db: Database.Database,
  userId: number,
  completedIds: number[],
): ScoredItem[] {
  if (completedIds.length === 0) return [];

  const placeholders = completedIds.map(() => "?").join(",");

  // Find users who completed the same items
  const similarUsers = db
    .prepare(
      `SELECT DISTINCT user_id FROM viewing_log
       WHERE media_id IN (${placeholders}) AND completed = 1 AND user_id != ?`,
    )
    .all(...completedIds, userId) as { user_id: number }[];

  if (similarUsers.length === 0) return [];

  const similarUserIds = similarUsers.map((u) => u.user_id);
  const userPlaceholders = similarUserIds.map(() => "?").join(",");

  // Get items those users completed that target user hasn't
  const completedSet = completedIds.map(() => "?").join(",");
  const candidates = db
    .prepare(
      `SELECT media_id, COUNT(DISTINCT user_id) as viewer_count
       FROM viewing_log
       WHERE user_id IN (${userPlaceholders}) AND completed = 1 AND media_id NOT IN (${completedSet})
       GROUP BY media_id
       ORDER BY viewer_count DESC
       LIMIT 50`,
    )
    .all(...similarUserIds, ...completedIds) as {
    media_id: number;
    viewer_count: number;
  }[];

  if (candidates.length === 0) return [];

  const maxCount = candidates[0].viewer_count;
  return candidates.map((c) => ({
    media_id: c.media_id,
    score: (c.viewer_count / maxCount) * 100,
    reason: `Liked by ${c.viewer_count} similar viewer${c.viewer_count > 1 ? "s" : ""}`,
  }));
}

function genreMatchingStrategy(
  db: Database.Database,
  completedIds: number[],
): ScoredItem[] {
  // Build genre affinity map from completed items
  const genreAffinity = buildGenreAffinity(db, completedIds);
  if (genreAffinity.size === 0) return [];

  // Score all unwatched items by genre overlap
  const allMedia = db
    .prepare("SELECT id, genres FROM media_items WHERE genres IS NOT NULL")
    .all() as { id: number; genres: string }[];

  const completedSet = new Set(completedIds);
  const results: ScoredItem[] = [];

  for (const item of allMedia) {
    if (completedSet.has(item.id)) continue;
    const itemGenres = item.genres
      .split(",")
      .map((g) => g.trim().toLowerCase());
    let score = 0;
    const matchedGenres: string[] = [];
    for (const g of itemGenres) {
      const affinity = genreAffinity.get(g);
      if (affinity) {
        score += affinity;
        matchedGenres.push(g);
      }
    }
    if (score > 0) {
      results.push({
        media_id: item.id,
        score,
        reason: `Matches genres: ${matchedGenres.join(", ")}`,
      });
    }
  }

  // Normalize scores to 0-80 range
  if (results.length > 0) {
    const maxScore = Math.max(...results.map((r) => r.score));
    if (maxScore > 0) {
      for (const r of results) {
        r.score = (r.score / maxScore) * 80;
      }
    }
  }

  return results;
}

function similarItemsStrategy(
  db: Database.Database,
  seedIds: number[],
): ScoredItem[] {
  if (seedIds.length === 0) return [];

  const seedMedia = db
    .prepare(
      `SELECT id, type, genres, year, rating FROM media_items WHERE id IN (${seedIds.map(() => "?").join(",")})`,
    )
    .all(...seedIds) as MediaRow[];

  const allMedia = db
    .prepare("SELECT id, type, genres, year, rating FROM media_items")
    .all() as MediaRow[];

  const seedSet = new Set(seedIds);
  const scored = new Map<number, number>();

  for (const seed of seedMedia) {
    const seedGenres = parseGenres(seed.genres);

    for (const candidate of allMedia) {
      if (seedSet.has(candidate.id)) continue;

      let score = 0;
      const candidateGenres = parseGenres(candidate.genres);

      // Shared genres: +10 each
      for (const g of candidateGenres) {
        if (seedGenres.has(g)) score += 10;
      }

      // Year proximity within 5 years: +5
      if (
        seed.year &&
        candidate.year &&
        Math.abs(seed.year - candidate.year) <= 5
      ) {
        score += 5;
      }

      // Same type: +3
      if (seed.type === candidate.type) score += 3;

      // Close rating (within 1.0): +2
      if (
        seed.rating &&
        candidate.rating &&
        Math.abs(seed.rating - candidate.rating) <= 1.0
      ) {
        score += 2;
      }

      if (score > 0) {
        const existing = scored.get(candidate.id) || 0;
        scored.set(candidate.id, Math.max(existing, score));
      }
    }
  }

  return Array.from(scored.entries())
    .map(([media_id, score]) => ({
      media_id,
      score,
      reason: "Similar to recently watched",
    }))
    .sort((a, b) => b.score - a.score);
}

function popularityStrategy(db: Database.Database): ScoredItem[] {
  const rows = db
    .prepare(
      `SELECT media_id, COUNT(*) as watch_count
       FROM viewing_log WHERE completed = 1
       GROUP BY media_id
       ORDER BY watch_count DESC
       LIMIT 50`,
    )
    .all() as { media_id: number; watch_count: number }[];

  if (rows.length === 0) {
    // Cold start: return recently added items
    const recent = db
      .prepare("SELECT id FROM media_items ORDER BY added_at DESC LIMIT 20")
      .all() as { id: number }[];
    return recent.map((r, i) => ({
      media_id: r.id,
      score: 20 - i,
      reason: "Recently added",
    }));
  }

  const maxCount = rows[0].watch_count;
  return rows.map((r) => ({
    media_id: r.media_id,
    score: (r.watch_count / maxCount) * 50,
    reason: `Popular (${r.watch_count} completions)`,
  }));
}

// --- Helpers ---

function mergeItem(map: Map<number, ScoredItem>, item: ScoredItem): void {
  const existing = map.get(item.media_id);
  if (!existing || item.score > existing.score) {
    map.set(item.media_id, item);
  }
}

function buildGenreAffinity(
  db: Database.Database,
  mediaIds: number[],
): Map<string, number> {
  const affinity = new Map<string, number>();
  if (mediaIds.length === 0) return affinity;

  const placeholders = mediaIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT genres FROM media_items WHERE id IN (${placeholders}) AND genres IS NOT NULL`,
    )
    .all(...mediaIds) as { genres: string }[];

  for (const row of rows) {
    const genres = row.genres.split(",").map((g) => g.trim().toLowerCase());
    for (const g of genres) {
      if (g) affinity.set(g, (affinity.get(g) || 0) + 1);
    }
  }
  return affinity;
}

function parseGenres(genres: string | null): Set<string> {
  if (!genres) return new Set();
  return new Set(
    genres
      .split(",")
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean),
  );
}

function getMediaGenres(db: Database.Database, mediaId: number): string[] {
  const row = db
    .prepare("SELECT genres FROM media_items WHERE id = ?")
    .get(mediaId) as { genres: string | null } | undefined;
  if (!row?.genres) return [];
  return row.genres
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}
