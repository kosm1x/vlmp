import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import {
  generateHealthReport,
  getMissingFiles,
  cleanupOrphaned,
} from "../src/ai/health.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);

  // Library folder
  db.prepare("INSERT INTO library_folders (path, category) VALUES (?, ?)").run(
    "/test/movies",
    "movies",
  );

  // 5 media items — all with nonexistent file paths (missing files)
  const items = [
    {
      title: "Complete Movie",
      path: "/test/movies/complete.mp4",
      genres: "Action, Thriller",
      poster: "/poster.jpg",
      desc: "A complete movie",
      codec: "h264",
      resH: 1080,
      year: 2020,
      duration: 7200,
      fileSize: 1000,
    },
    {
      title: "No Poster",
      path: "/test/movies/noposter.mp4",
      genres: "Drama",
      poster: null,
      desc: "Has description",
      codec: "h264",
      resH: 720,
      year: 2021,
      duration: 5400,
      fileSize: 800,
    },
    {
      title: "No Desc",
      path: "/test/movies/nodesc.mp4",
      genres: "Comedy",
      poster: "/poster2.jpg",
      desc: null,
      codec: "hevc",
      resH: 2160,
      year: 2022,
      duration: 6000,
      fileSize: 2000,
    },
    {
      title: "No Genres",
      path: "/test/movies/nogenres.mp4",
      genres: null,
      poster: "/poster3.jpg",
      desc: "Has description",
      codec: "h264",
      resH: 480,
      year: 2019,
      duration: 3600,
      fileSize: 500,
    },
    {
      title: "Low Res",
      path: "/test/movies/lowres.mp4",
      genres: "Horror",
      poster: "/poster4.jpg",
      desc: "A horror film",
      codec: "hevc",
      resH: 0,
      year: 2020,
      duration: 5000,
      fileSize: 700,
    },
  ];

  for (const item of items) {
    db.prepare(
      `INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, genres, poster_path, description, codec_video, resolution_height, year, duration, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "movie",
      item.path,
      item.title,
      item.title.toLowerCase(),
      item.genres,
      item.poster,
      item.desc,
      item.codec,
      item.resH,
      item.year,
      item.duration,
      item.fileSize,
    );
  }
});

afterEach(() => {
  db.close();
});

describe("health report", () => {
  it("summary counts correct for seeded data", async () => {
    const report = await generateHealthReport(db);
    expect(report.summary.total_items).toBe(5);
  });

  it("metadata gaps detected for items missing poster/description/genres", async () => {
    const report = await generateHealthReport(db);
    // Items 2 (no poster), 3 (no desc), 4 (no genres) = 3 gaps
    expect(report.summary.metadata_gaps).toBe(3);
    const gapIssues = report.issues.filter((i) => i.type === "metadata_gap");
    expect(gapIssues).toHaveLength(3);
  });

  it("no subtitles detected", async () => {
    // Add a subtitle for item 1
    db.prepare(
      "INSERT INTO subtitles (media_id, language, format, file_path) VALUES (?, ?, ?, ?)",
    ).run(1, "en", "srt", "/test/movies/complete.srt");

    const report = await generateHealthReport(db);
    // Items 2-5 have no subtitles = 4
    expect(report.summary.no_subtitles).toBe(4);
  });

  it("codec analysis correct", async () => {
    const report = await generateHealthReport(db);
    const codecs = report.codec_analysis;
    const h264 = codecs.find((c) => c.codec === "h264");
    const hevc = codecs.find((c) => c.codec === "hevc");
    expect(h264?.count).toBe(3);
    expect(hevc?.count).toBe(2);
  });

  it("resolution stats buckets correct", async () => {
    const report = await generateHealthReport(db);
    const res = report.resolution_stats;
    const bucketMap = new Map(res.map((r) => [r.bucket, r.count]));
    expect(bucketMap.get("4K")).toBe(1); // 2160
    expect(bucketMap.get("1080p")).toBe(1); // 1080
    expect(bucketMap.get("720p")).toBe(1); // 720
    expect(bucketMap.get("SD")).toBe(1); // 480
    expect(bucketMap.get("Unknown")).toBe(1); // 0
  });

  it("duplicate detection with same title+year+duration", async () => {
    // Insert a duplicate of item 1
    db.prepare(
      `INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, genres, poster_path, description, codec_video, resolution_height, year, duration, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "movie",
      "/test/movies/complete_copy.mp4",
      "Complete Movie",
      "complete movie",
      "Action, Thriller",
      "/poster.jpg",
      "A complete movie",
      "h264",
      1080,
      2020,
      7200,
      1000,
    );

    const report = await generateHealthReport(db);
    expect(report.summary.duplicates).toBe(2);
    const dupIssues = report.issues.filter((i) => i.type === "duplicate");
    expect(dupIssues).toHaveLength(2);
  });

  it("orphaned episode with invalid season_id detected", async () => {
    // Create a show and season
    db.prepare(
      "INSERT INTO tv_shows (title, year, folder_path) VALUES (?, ?, ?)",
    ).run("Test Show", 2022, "/test/tv/testshow");
    db.prepare(
      "INSERT INTO seasons (show_id, season_number) VALUES (?, ?)",
    ).run(1, 1);

    // Create episode media item
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "episode", "/test/tv/ep1.mp4", "Episode 1", "episode 1");

    const epMediaId = (
      db
        .prepare("SELECT id FROM media_items WHERE title = 'Episode 1'")
        .get() as { id: number }
    ).id;

    // Create valid episode
    db.prepare(
      "INSERT INTO episodes (season_id, media_id, episode_number) VALUES (?, ?, ?)",
    ).run(1, epMediaId, 1);

    // Delete the season to orphan the episode (CASCADE won't fire since we're simulating)
    // Actually, with FK CASCADE, deleting season would delete episode too
    // Instead, insert directly with bad season_id by temporarily disabling FK
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "episode", "/test/tv/ep_orphan.mp4", "Orphan Ep", "orphan ep");
    const orphanMediaId = (
      db
        .prepare("SELECT id FROM media_items WHERE title = 'Orphan Ep'")
        .get() as { id: number }
    ).id;
    db.prepare(
      "INSERT INTO episodes (season_id, media_id, episode_number) VALUES (?, ?, ?)",
    ).run(9999, orphanMediaId, 1);
    db.pragma("foreign_keys = ON");

    const report = await generateHealthReport(db);
    expect(report.summary.orphaned_entries).toBeGreaterThanOrEqual(1);
    const orphanIssues = report.issues.filter((i) => i.type === "orphaned");
    expect(orphanIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("cleanupOrphaned removes orphaned entries and returns count", () => {
    // Insert orphaned episode
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "episode", "/test/tv/orphan.mp4", "Orphan", "orphan");
    const mediaId = (
      db.prepare("SELECT id FROM media_items WHERE title = 'Orphan'").get() as {
        id: number;
      }
    ).id;
    db.prepare(
      "INSERT INTO episodes (season_id, media_id, episode_number) VALUES (?, ?, ?)",
    ).run(9999, mediaId, 1);
    db.pragma("foreign_keys = ON");

    const before = db.prepare("SELECT COUNT(*) as c FROM episodes").get() as {
      c: number;
    };
    expect(before.c).toBe(1);

    const result = cleanupOrphaned(db);
    expect(result.removed).toBeGreaterThanOrEqual(1);

    const after = db.prepare("SELECT COUNT(*) as c FROM episodes").get() as {
      c: number;
    };
    expect(after.c).toBe(0);
  });

  it("missing files detected for nonexistent paths", async () => {
    const missing = await getMissingFiles(db);
    // All 5 items have nonexistent paths
    expect(missing).toHaveLength(5);
    expect(missing[0].type).toBe("missing_file");
  });
});
