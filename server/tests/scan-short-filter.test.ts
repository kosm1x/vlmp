// The short-sample filter (VLMP_MIN_DURATION_SECONDS) exists for loose
// "sample.mkv" release junk. Sequenced files — linked episodes or numbered
// course/collection entries — are deliberate content and must never be
// dropped for being short. The probe is mocked so every file has a KNOWN
// short duration at insert time (browse-sort.test.ts covers the rescan-delete
// branch, which reads the stored duration instead).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const probeMock = vi.hoisted(() => vi.fn());
vi.mock("../src/scanner/probe.js", () => ({ probeFile: probeMock }));

import { initSchema } from "../src/db/schema.js";
import { addLibraryFolder, scanLibraryFolder } from "../src/media/library.js";
import { loadConfig } from "../src/config.js";

const scanConfig = {
  ...loadConfig(),
  tmdbApiKey: "",
  extractSubsOnScan: false,
  emptyTrashOnScan: true,
  minDurationSeconds: 120,
};

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  probeMock.mockResolvedValue({ duration: 45 }); // everything is "short"
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe("insert-time short filter", () => {
  it("drops loose short videos, keeps a grouped numbered lesson", async () => {
    const root = mkdtempSync(join(tmpdir(), "vlmp-shortins-"));
    try {
      mkdirSync(join(root, "Course"));
      writeFileSync(join(root, "Course", "01 - Welcome.mp4"), "x");
      writeFileSync(join(root, "sample.mp4"), "x");
      // A dotted numeric release prefix parses as a number — but at the
      // library ROOT (no group) it is NOT sequence evidence, so the sample
      // filter still applies. Only grouped numbered files are exempt.
      writeFileSync(join(root, "300.2006.720P.BRRIP.mkv"), "x");
      const folder = addLibraryFolder(db, root, "education");
      const result = await scanLibraryFolder(db, folder, scanConfig);
      expect(result.skippedShort).toBe(2);
      expect(result.added).toBe(1);
      const rows = db
        .prepare("SELECT title, duration FROM media_items")
        .all() as { title: string; duration: number }[];
      expect(rows).toEqual([{ title: "Welcome", duration: 45 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The DELETE branch is more lenient than the insert branch on purpose:
  // an existing numbered row — even ungrouped, at the library root — holds
  // watch progress/likes and must never be destroyed by the rescan a page
  // view now triggers automatically.
  it("rescan never deletes an existing numbered row, even ungrouped", async () => {
    const root = mkdtempSync(join(tmpdir(), "vlmp-shortdel-"));
    try {
      writeFileSync(join(root, "01 - Welcome.mp4"), "x");
      writeFileSync(join(root, "junk.mp4"), "x");
      const folder = addLibraryFolder(db, root, "education");
      // Pre-existing rows from an older version, both with known short
      // durations (85s < the 120s floor).
      const ins = db.prepare(
        "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, duration) VALUES (?, 'education', ?, ?, ?, 85)",
      );
      ins.run(folder.id, join(root, "01 - Welcome.mp4"), "Welcome", "welcome");
      ins.run(folder.id, join(root, "junk.mp4"), "junk", "junk");
      const result = await scanLibraryFolder(db, folder, scanConfig);
      const titles = (
        db.prepare("SELECT title FROM media_items ORDER BY title").all() as {
          title: string;
        }[]
      ).map((r) => r.title);
      // The unnumbered junk row is pruned; the numbered lesson survives.
      expect(result.skippedShort).toBe(1);
      expect(titles).toEqual(["Welcome"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a short SxxEyy episode (recaps/teasers are content)", async () => {
    const root = mkdtempSync(join(tmpdir(), "vlmp-shortep-"));
    try {
      mkdirSync(join(root, "Show", "Season 1"), { recursive: true });
      writeFileSync(
        join(root, "Show", "Season 1", "Show S01E00 - Recap.mkv"),
        "x",
      );
      const folder = addLibraryFolder(db, root, "tv");
      const result = await scanLibraryFolder(db, folder, scanConfig);
      expect(result.added).toBe(1);
      expect(result.skippedShort).toBe(0);
      expect(db.prepare("SELECT COUNT(*) c FROM episodes").get()).toEqual({
        c: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
