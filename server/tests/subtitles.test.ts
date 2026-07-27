import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import {
  persistSubtitles,
  getSubtitlesForMedia,
  deleteSubtitlesForMedia,
} from "../src/subtitles/service.js";
import {
  extractSubtitles,
  type ExtractedSubtitle,
} from "../src/subtitles/extract.js";
import type { SubtitleTrack } from "../src/scanner/probe.js";
import type { Config } from "../src/config.js";

// File-scope on purpose: vitest hoists vi.mock to the top of the file no
// matter where it is written, so the previous copies INSIDE an it() were
// already file-wide — this just makes that visible. The DB tests never import
// either module (better-sqlite3 is native CJS, untouched by ESM mocks).
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import("node:fs");
  return { ...orig, mkdirSync: vi.fn() };
});

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("INSERT INTO library_folders (path, category) VALUES (?, ?)").run(
    "/test/movies",
    "movies",
  );
  db.prepare(
    "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "movie", "/test/movies/test.mkv", "Test Movie", "test movie");
});

afterEach(() => {
  db.close();
});

describe("subtitle service", () => {
  describe("persistSubtitles", () => {
    it("should insert subtitles into database", () => {
      const extracted: ExtractedSubtitle[] = [
        {
          language: "en",
          label: "English",
          format: "vtt",
          file_path: "/data/subtitles/1/en_0.vtt",
        },
        {
          language: "es",
          label: "Spanish",
          format: "vtt",
          file_path: "/data/subtitles/1/es_1.vtt",
        },
      ];

      persistSubtitles(db, 1, extracted);

      const subs = db
        .prepare("SELECT * FROM subtitles WHERE media_id = 1")
        .all();
      expect(subs).toHaveLength(2);
    });

    it("should not duplicate on re-insert (UNIQUE constraint)", () => {
      const extracted: ExtractedSubtitle[] = [
        {
          language: "en",
          label: "English",
          format: "vtt",
          file_path: "/data/subtitles/1/en_0.vtt",
        },
      ];

      persistSubtitles(db, 1, extracted);
      persistSubtitles(db, 1, extracted); // re-insert same

      const subs = db
        .prepare("SELECT * FROM subtitles WHERE media_id = 1")
        .all();
      expect(subs).toHaveLength(1);
    });
  });

  describe("getSubtitlesForMedia", () => {
    it("should return all subtitles for a media item", () => {
      db.prepare(
        "INSERT INTO subtitles (media_id, language, label, format, file_path, source) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        1,
        "en",
        "English",
        "vtt",
        "/data/subtitles/1/en_0.vtt",
        "extracted",
      );
      db.prepare(
        "INSERT INTO subtitles (media_id, language, label, format, file_path, source) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        1,
        "fr",
        "French",
        "vtt",
        "/data/subtitles/1/fr_1.vtt",
        "extracted",
      );

      const subs = getSubtitlesForMedia(db, 1);
      expect(subs).toHaveLength(2);
      expect(subs[0].language).toBe("en");
      expect(subs[1].language).toBe("fr");
    });

    it("should return empty array when no subtitles exist", () => {
      const subs = getSubtitlesForMedia(db, 999);
      expect(subs).toHaveLength(0);
    });
  });

  describe("deleteSubtitlesForMedia", () => {
    it("should delete all subtitles for a media item", () => {
      db.prepare(
        "INSERT INTO subtitles (media_id, language, label, format, file_path, source) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        1,
        "en",
        "English",
        "vtt",
        "/data/subtitles/1/en_0.vtt",
        "extracted",
      );

      deleteSubtitlesForMedia(db, 1);

      const subs = db
        .prepare("SELECT * FROM subtitles WHERE media_id = 1")
        .all();
      expect(subs).toHaveLength(0);
    });
  });

  describe("subtitle extraction args", () => {
    it("skips bitmap codecs — ffmpeg runs only for text tracks", async () => {
      // The old version of this test asserted a literal array contains its own
      // literal element; it passed with extract.ts deleted. This one counts
      // real spawn calls, so removing the BITMAP_CODECS check makes it fail.
      spawnMock.mockReset();
      spawnMock.mockImplementation(() => ({
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === "close") cb(0);
        }),
      }));
      const config = {
        subtitleDir: "/tmp/test-subs",
        ffmpegPath: "ffmpeg",
      } as unknown as Config;
      const tracks: SubtitleTrack[] = [
        { index: 0, language: "en", codec: "subrip", title: "English" },
        { index: 1, language: null, codec: "hdmv_pgs_subtitle", title: "PGS" },
        { index: 2, language: "es", codec: "dvd_subtitle", title: "DVD subs" },
      ];

      const results = await extractSubtitles("/x/test.mkv", 1, tracks, config);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const ffmpegArgs = spawnMock.mock.calls[0][1] as string[];
      expect(ffmpegArgs).toContain("0:s:0");
      expect(results).toHaveLength(1);
      expect(results[0].language).toBe("en");
    });
  });
});
