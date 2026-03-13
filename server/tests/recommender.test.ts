import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import { logViewingEvent } from "../src/ai/viewing-log.js";
import { setPreference } from "../src/ai/preferences.js";
import { getRecommendations, getSimilarItems } from "../src/ai/recommender.js";

let db: Database.Database;

function seedMedia() {
  db.prepare("INSERT INTO library_folders (path, category) VALUES (?, ?)").run(
    "/test/movies",
    "movies",
  );
  db.prepare("INSERT INTO library_folders (path, category) VALUES (?, ?)").run(
    "/test/tv",
    "tv",
  );

  // 10 media items with genres
  const movies = [
    {
      title: "Action Movie 1",
      genres: "Action, Thriller",
      year: 2020,
      rating: 7.5,
    },
    {
      title: "Action Movie 2",
      genres: "Action, Adventure",
      year: 2021,
      rating: 7.0,
    },
    {
      title: "Comedy Film",
      genres: "Comedy, Romance",
      year: 2019,
      rating: 6.5,
    },
    { title: "Drama Film", genres: "Drama", year: 2020, rating: 8.0 },
    { title: "Sci-Fi Epic", genres: "Sci-Fi, Action", year: 2022, rating: 7.8 },
    {
      title: "Horror Night",
      genres: "Horror, Thriller",
      year: 2021,
      rating: 6.0,
    },
    {
      title: "Romance Story",
      genres: "Romance, Drama",
      year: 2018,
      rating: 7.2,
    },
    {
      title: "Action Movie 3",
      genres: "Action, Sci-Fi",
      year: 2023,
      rating: 7.3,
    },
    { title: "Comedy 2", genres: "Comedy", year: 2020, rating: 6.8 },
    {
      title: "Thriller Film",
      genres: "Thriller, Mystery",
      year: 2021,
      rating: 7.6,
    },
  ];

  for (let i = 0; i < movies.length; i++) {
    const m = movies[i];
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, genres, year, rating, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      1,
      "movie",
      `/test/movies/${i + 1}.mp4`,
      m.title,
      m.title.toLowerCase(),
      m.genres,
      m.year,
      m.rating,
      7200,
    );
  }

  // TV show with 5 episodes across 2 seasons
  db.prepare(
    "INSERT INTO tv_shows (title, year, folder_path) VALUES (?, ?, ?)",
  ).run("Test Show", 2022, "/test/tv/testshow");

  // Season 1 with 3 episodes
  db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, ?)").run(
    1,
    1,
  );
  // Season 2 with 2 episodes
  db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, ?)").run(
    1,
    2,
  );

  // Episode media items (IDs 11-15)
  for (let i = 1; i <= 5; i++) {
    const seasonId = i <= 3 ? 1 : 2;
    const epNum = i <= 3 ? i : i - 3;
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, genres, duration) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      2,
      "episode",
      `/test/tv/testshow/s${seasonId}e${epNum}.mp4`,
      `Test Show S${seasonId}E${String(epNum).padStart(2, "0")}`,
      `test show s${seasonId}e${epNum}`,
      "Drama, Thriller",
      2700,
    );
    db.prepare(
      "INSERT INTO episodes (season_id, media_id, episode_number) VALUES (?, ?, ?)",
    ).run(seasonId, 10 + i, epNum);
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  // 2 users
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("userA", "hash", "user");
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("userB", "hash", "user");
  seedMedia();
});

afterEach(() => {
  db.close();
});

describe("recommender", () => {
  it("cold start returns popularity/recently-added results", () => {
    const result = getRecommendations(db, 1);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.strategies_used).toContain("popularity");
  });

  it("genre matching returns genre-similar unwatched items", () => {
    // User watches action movies (IDs 1, 2)
    logViewingEvent(db, 1, 1, 7000, 7200, true);
    logViewingEvent(db, 1, 2, 7000, 7200, true);

    const result = getRecommendations(db, 1);
    expect(result.strategies_used).toContain("genre_matching");
    // Should suggest other action items (5, 8) but not already watched (1, 2)
    const recIds = result.items.map((i) => i.media_id);
    expect(recIds).not.toContain(1);
    expect(recIds).not.toContain(2);
    // Action items should be high-scored
    const actionItems = result.items.filter(
      (i) => i.media_id === 5 || i.media_id === 8,
    );
    expect(actionItems.length).toBeGreaterThan(0);
  });

  it("collaborative: A and B share watches, B's unique watches recommended to A", () => {
    // Both users complete items 1, 2, 3
    for (const mediaId of [1, 2, 3]) {
      logViewingEvent(db, 1, mediaId, 7000, 7200, true);
      logViewingEvent(db, 2, mediaId, 7000, 7200, true);
    }
    // User B also completes items 4, 5
    logViewingEvent(db, 2, 4, 7000, 7200, true);
    logViewingEvent(db, 2, 5, 7000, 7200, true);

    const result = getRecommendations(db, 1);
    expect(result.strategies_used).toContain("collaborative");
    const recIds = result.items.map((i) => i.media_id);
    // Items 4 and 5 should be recommended to user A
    expect(recIds).toContain(4);
    expect(recIds).toContain(5);
  });

  it("next episode: completed S01E03 suggests S01E04 (doesn't exist) then S02E01", () => {
    // Complete all 3 episodes in season 1 with staggered timestamps
    logViewingEvent(db, 1, 11, 2700, 2700, true); // S01E01
    db.prepare(
      "UPDATE viewing_log SET watched_at = unixepoch() - 200 WHERE media_id = 11",
    ).run();
    logViewingEvent(db, 1, 12, 2700, 2700, true); // S01E02
    db.prepare(
      "UPDATE viewing_log SET watched_at = unixepoch() - 100 WHERE media_id = 12",
    ).run();
    logViewingEvent(db, 1, 13, 2700, 2700, true); // S01E03 (finale, most recent)

    const result = getRecommendations(db, 1);
    expect(result.strategies_used).toContain("next_episode");
    // S01E03 is most recent, no S01E04 exists, so it should suggest S02E01 (media_id 14)
    const nextEps = result.items.filter((i) => i.score === 200);
    expect(nextEps.length).toBeGreaterThan(0);
    expect(nextEps.some((e) => e.media_id === 14)).toBe(true);
  });

  it("next episode: completed S01E01 suggests S01E02", () => {
    logViewingEvent(db, 1, 11, 2700, 2700, true); // S01E01

    const result = getRecommendations(db, 1);
    expect(result.strategies_used).toContain("next_episode");
    const nextEps = result.items.filter((i) => i.score === 200);
    expect(nextEps.some((e) => e.media_id === 12)).toBe(true); // S01E02
  });

  it("watched items excluded from results", () => {
    logViewingEvent(db, 1, 1, 7000, 7200, true);
    logViewingEvent(db, 1, 2, 7000, 7200, true);
    logViewingEvent(db, 1, 3, 7000, 7200, true);

    const result = getRecommendations(db, 1);
    const recIds = new Set(result.items.map((i) => i.media_id));
    expect(recIds.has(1)).toBe(false);
    expect(recIds.has(2)).toBe(false);
    expect(recIds.has(3)).toBe(false);
  });

  it("disliked items excluded from results", () => {
    logViewingEvent(db, 1, 1, 7000, 7200, true);
    setPreference(db, 1, 5, "dislike");

    const result = getRecommendations(db, 1);
    const recIds = result.items.map((i) => i.media_id);
    expect(recIds).not.toContain(5);
  });

  it("getSimilarItems returns genre-similar items", () => {
    // Item 1: Action, Thriller
    const similar = getSimilarItems(db, 1, 5);
    expect(similar.length).toBeGreaterThan(0);
    // Should include other action/thriller items
    const ids = similar.map((s) => s.media_id);
    expect(ids).not.toContain(1); // Not the item itself
  });

  it("deduplication keeps highest score per media_id", () => {
    // Create scenario where same item appears in multiple strategies
    logViewingEvent(db, 1, 1, 7000, 7200, true);
    logViewingEvent(db, 1, 2, 7000, 7200, true);
    logViewingEvent(db, 1, 3, 7000, 7200, true);

    const result = getRecommendations(db, 1);
    const mediaIds = result.items.map((i) => i.media_id);
    const uniqueIds = new Set(mediaIds);
    // No duplicates
    expect(mediaIds.length).toBe(uniqueIds.size);
  });
});
