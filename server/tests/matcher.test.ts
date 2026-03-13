import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import {
  matchAndApplyMetadata,
  matchAndApplyShowMetadata,
  applyManualMatch,
} from "../src/metadata/matcher.js";
import type { Config } from "../src/config.js";

// Mock TMDb API calls
vi.mock("../src/metadata/tmdb.js", () => ({
  searchMovie: vi.fn(),
  searchTV: vi.fn(),
  getMovieDetail: vi.fn(),
  getTVDetail: vi.fn(),
  fullPosterUrl: (p: string | null) =>
    p ? `https://image.tmdb.org/t/p/w500${p}` : null,
  fullBackdropUrl: (p: string | null) =>
    p ? `https://image.tmdb.org/t/p/w1280${p}` : null,
}));

import {
  searchMovie,
  searchTV,
  getMovieDetail,
  getTVDetail,
} from "../src/metadata/tmdb.js";

let db: Database.Database;
const config: Config = {
  port: 8080,
  host: "0.0.0.0",
  dataDir: "/tmp/test",
  dbPath: ":memory:",
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  jwtSecret: "test",
  jwtExpiresIn: "24h",
  tmdbApiKey: "testapikey",
  transcodeTmpDir: "/tmp/test/transcode",
  subtitleDir: "/tmp/test/subtitles",
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  // Insert a library folder and media item for testing
  db.prepare("INSERT INTO library_folders (path, category) VALUES (?, ?)").run(
    "/test/movies",
    "movies",
  );
  db.prepare(
    "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, year) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(1, "movie", "/test/movies/test.mp4", "Test Movie", "test movie", 2023);
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

describe("matchAndApplyMetadata", () => {
  it("should return false when no API key is configured", async () => {
    const noKeyConfig = { ...config, tmdbApiKey: "" };
    const result = await matchAndApplyMetadata(db, 1, noKeyConfig);
    expect(result).toBe(false);
  });

  it("should search and apply movie metadata", async () => {
    vi.mocked(searchMovie).mockResolvedValue([
      {
        id: 999,
        title: "Test Movie",
        original_title: "Test Movie",
        release_date: "2023-06-01",
        overview: "Overview",
        poster_path: "/poster.jpg",
        backdrop_path: "/backdrop.jpg",
        vote_average: 7.5,
        genre_ids: [28],
      },
    ]);
    vi.mocked(getMovieDetail).mockResolvedValue({
      id: 999,
      title: "Test Movie",
      overview: "Full overview of the movie",
      release_date: "2023-06-01",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
      vote_average: 7.5,
      genres: [
        { id: 28, name: "Action" },
        { id: 12, name: "Adventure" },
      ],
      runtime: 120,
    });

    const result = await matchAndApplyMetadata(db, 1, config);
    expect(result).toBe(true);

    const media = db
      .prepare("SELECT * FROM media_items WHERE id = 1")
      .get() as Record<string, unknown>;
    expect(media.description).toBe("Full overview of the movie");
    expect(media.poster_path).toBe(
      "https://image.tmdb.org/t/p/w500/poster.jpg",
    );
    expect(media.backdrop_path).toBe(
      "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
    );
    expect(media.rating).toBe(7.5);
    expect(media.genres).toBe("Action, Adventure");

    // Check metadata cache
    const cache = db
      .prepare("SELECT * FROM metadata_cache WHERE media_id = 1")
      .get() as Record<string, unknown>;
    expect(cache.provider).toBe("tmdb");
    expect(cache.external_id).toBe("999");
  });

  it("should return false when no search results found", async () => {
    vi.mocked(searchMovie).mockResolvedValue([]);
    const result = await matchAndApplyMetadata(db, 1, config);
    expect(result).toBe(false);
  });

  it("should skip if cache is fresh", async () => {
    // Insert a recent cache entry
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO metadata_cache (media_id, provider, external_id, data_json, fetched_at) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "tmdb", "999", "{}", now);

    const result = await matchAndApplyMetadata(db, 1, config);
    expect(result).toBe(true);
    expect(searchMovie).not.toHaveBeenCalled();
  });
});

describe("matchAndApplyShowMetadata", () => {
  beforeEach(() => {
    db.prepare("INSERT INTO tv_shows (title, folder_path) VALUES (?, ?)").run(
      "Test Show",
      "/test/shows/test",
    );
  });

  it("should search and apply TV show metadata", async () => {
    vi.mocked(searchTV).mockResolvedValue([
      {
        id: 888,
        title: "Test Show",
        original_title: "Test Show",
        release_date: "2022-01-01",
        overview: "Show overview",
        poster_path: "/show_poster.jpg",
        backdrop_path: "/show_backdrop.jpg",
        vote_average: 8.0,
        genre_ids: [18],
      },
    ]);
    vi.mocked(getTVDetail).mockResolvedValue({
      id: 888,
      name: "Test Show",
      overview: "Detailed show overview",
      first_air_date: "2022-01-01",
      poster_path: "/show_poster.jpg",
      backdrop_path: "/show_backdrop.jpg",
      vote_average: 8.0,
      genres: [{ id: 18, name: "Drama" }],
      number_of_seasons: 5,
    });

    const result = await matchAndApplyShowMetadata(db, 1, config);
    expect(result).toBe(true);

    const show = db
      .prepare("SELECT * FROM tv_shows WHERE id = 1")
      .get() as Record<string, unknown>;
    expect(show.description).toBe("Detailed show overview");
    expect(show.poster_path).toBe(
      "https://image.tmdb.org/t/p/w500/show_poster.jpg",
    );
  });
});

describe("applyManualMatch", () => {
  it("should apply manual movie match", async () => {
    vi.mocked(getMovieDetail).mockResolvedValue({
      id: 777,
      title: "Manual Match",
      overview: "Manual description",
      release_date: "2024-01-01",
      poster_path: "/manual.jpg",
      backdrop_path: null,
      vote_average: 6.0,
      genres: [{ id: 35, name: "Comedy" }],
      runtime: 90,
    });

    const result = await applyManualMatch(db, 1, 777, "movie", config);
    expect(result).toBe(true);

    const media = db
      .prepare("SELECT * FROM media_items WHERE id = 1")
      .get() as Record<string, unknown>;
    expect(media.description).toBe("Manual description");
    expect(media.genres).toBe("Comedy");
  });

  it("should return false without API key", async () => {
    const result = await applyManualMatch(db, 1, 777, "movie", {
      ...config,
      tmdbApiKey: "",
    });
    expect(result).toBe(false);
  });
});
