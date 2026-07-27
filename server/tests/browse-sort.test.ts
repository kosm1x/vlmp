// Series files with no parseable episode number must still bundle under their
// show (task 1 — "unbundled on scroll" fix), and browse/getTVShows must carry
// the fields the client sorts on (task 2/3 — full load + sort).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import {
  addLibraryFolder,
  scanLibraryFolder,
  browseLibrary,
  getTVShows,
  getTVShowDetail,
  type LibraryFolder,
} from "../src/media/library.js";
import { registerLibraryRoutes } from "../src/routes/library.js";
import { issueToken } from "../src/auth/jwt.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
// ffprobe intentionally missing: probe fails, duration stays null, so nothing
// is dropped by the short-sample filter — every file lands as media.
const scanConfig = {
  ...config,
  tmdbApiKey: "",
  extractSubsOnScan: false,
  emptyTrashOnScan: true,
  ffprobePath: "/nonexistent/ffprobe",
};

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

describe("series bundling — files with no episode number still group", () => {
  let root: string;
  let folder: LibraryFolder;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vlmp-bundle-"));
    mkdirSync(join(root, "The Wire", "Season 1"), { recursive: true });
    // No SxxEyy, no leading number, no NxM — the classifier can't number these.
    writeFileSync(join(root, "The Wire", "Season 1", "The Target.mkv"), "x");
    writeFileSync(join(root, "The Wire", "Season 1", "Old Cases.mkv"), "x");
    // One properly numbered episode alongside the unnumbered ones.
    writeFileSync(
      join(root, "The Wire", "Season 1", "S01E03 - The Buys.mkv"),
      "x",
    );
    folder = addLibraryFolder(db, root, "tv"); // seeded default, kind=series
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("bundles every episode and leaves the flat grid empty", async () => {
    await scanLibraryFolder(db, folder, scanConfig);

    const shows = getTVShows(db, true, "tv") as {
      id: number;
      title: string;
      episode_count: number;
    }[];
    expect(shows).toHaveLength(1);
    expect(shows[0].title).toBe("The Wire");
    expect(shows[0].episode_count).toBe(3);

    // Nothing leaks into the flat grid — all three are linked episodes.
    const grid = browseLibrary(db, {
      category: "tv",
      excludeEpisodes: true,
      includeHidden: true,
    });
    expect(grid.items).toHaveLength(0);

    // Every episode got a distinct in-season number.
    const detail = getTVShowDetail(db, shows[0].id, true)!;
    const numbers = detail.seasons[0].episodes.map((e) => e.episode_number);
    expect(numbers).toHaveLength(3);
    expect(new Set(numbers).size).toBe(3);
  });

  it("rescan does not renumber the synthetic episodes", async () => {
    await scanLibraryFolder(db, folder, scanConfig);
    const before = db
      .prepare(
        "SELECT media_id, episode_number FROM episodes ORDER BY media_id",
      )
      .all();
    await scanLibraryFolder(db, folder, scanConfig);
    const after = db
      .prepare(
        "SELECT media_id, episode_number FROM episodes ORDER BY media_id",
      )
      .all();
    expect(after).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) c FROM episodes").get()).toEqual({
      c: 3,
    });
  });
});

describe("series bundling — a real episode evicts a synthetic squatter", () => {
  let root: string;
  let folder: LibraryFolder;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vlmp-evict-"));
    mkdirSync(join(root, "Show", "Season 1"), { recursive: true });
    folder = addLibraryFolder(db, root, "tv");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("gives the real number to the real episode, re-homing the squatter", async () => {
    // Deterministic ordering, independent of readdir(): the unnumbered file is
    // scanned first and claims episode 1, then a real S01E01 arrives.
    writeFileSync(join(root, "Show", "Season 1", "Alpha.mkv"), "x");
    await scanLibraryFolder(db, folder, scanConfig);
    const alpha = db
      .prepare(
        "SELECT episode_number, synthetic FROM episodes e JOIN media_items m ON m.id = e.media_id WHERE m.file_path LIKE '%Alpha%'",
      )
      .get() as { episode_number: number; synthetic: number };
    expect(alpha).toEqual({ episode_number: 1, synthetic: 1 });

    writeFileSync(join(root, "Show", "Season 1", "S01E01 - Beta.mkv"), "x");
    await scanLibraryFolder(db, folder, scanConfig);

    const beta = db
      .prepare(
        "SELECT episode_number, synthetic FROM episodes e JOIN media_items m ON m.id = e.media_id WHERE m.file_path LIKE '%Beta%'",
      )
      .get() as { episode_number: number; synthetic: number };
    // The real episode holds its rightful slot; the squatter moved aside.
    expect(beta).toEqual({ episode_number: 1, synthetic: 0 });
    const alphaAfter = db
      .prepare(
        "SELECT episode_number, synthetic FROM episodes e JOIN media_items m ON m.id = e.media_id WHERE m.file_path LIKE '%Alpha%'",
      )
      .get() as { episode_number: number; synthetic: number };
    expect(alphaAfter.synthetic).toBe(1);
    expect(alphaAfter.episode_number).not.toBe(1);

    // Both remain bundled — nothing leaks into the flat grid.
    const grid = browseLibrary(db, {
      category: "tv",
      excludeEpisodes: true,
      includeHidden: true,
    });
    expect(grid.items).toHaveLength(0);
  });
});

describe("folder grouping — movie-kind subfolders keep their sequence", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vlmp-groups-"));
    // Two course folders plus a loose root file. In "B Course" the numbered
    // order (Zeta before Apple) contradicts the alphabetical order — the one
    // case a flat title sort gets wrong.
    mkdirSync(join(root, "A Course"));
    writeFileSync(join(root, "A Course", "01 - Intro.mp4"), "x");
    writeFileSync(join(root, "A Course", "02 - Deep Dive.mp4"), "x");
    mkdirSync(join(root, "B Course"));
    writeFileSync(join(root, "B Course", "01 - Zeta.mp4"), "x");
    writeFileSync(join(root, "B Course", "02 - Apple.mp4"), "x");
    writeFileSync(join(root, "Standalone Lecture.mp4"), "x");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("persists group_title/group_position and orders groups in sequence", async () => {
    const folder = addLibraryFolder(db, root, "education");
    await scanLibraryFolder(db, folder, scanConfig);

    const rows = browseLibrary(db, {
      category: "education",
      includeHidden: true,
      all: true,
    }).items;
    expect(rows.map((r) => r.title)).toEqual([
      "Intro", // A Course, position 1
      "Deep Dive", // A Course, position 2
      "Zeta", // B Course, position 1 — beats alphabetical
      "Apple", // B Course, position 2
      "Standalone Lecture",
    ]);
    expect(rows[0].group_title).toBe("A Course");
    expect(rows[0].group_position).toBe(1);
    expect(rows[3].group_title).toBe("B Course");
    expect(rows[3].group_position).toBe(2);
    expect(rows[4].group_title).toBeNull();
  });

  it("groups in a user-created movie-kind category too (not just 'education')", async () => {
    db.prepare(
      "INSERT INTO categories (slug, label, kind) VALUES ('cursos', 'Cursos', 'movie')",
    ).run();
    const folder = addLibraryFolder(db, root, "cursos");
    await scanLibraryFolder(db, folder, scanConfig);
    const rows = browseLibrary(db, {
      category: "cursos",
      includeHidden: true,
      all: true,
    }).items;
    const aCourse = rows.filter((r) => r.group_title === "A Course");
    expect(aCourse).toHaveLength(2);
    expect(aCourse.map((r) => r.group_position)).toEqual([1, 2]);
  });

  it("rescan heals rows scanned before the group columns existed", async () => {
    const folder = addLibraryFolder(db, root, "education");
    await scanLibraryFolder(db, folder, scanConfig);
    // Simulate a pre-group-columns row.
    db.prepare(
      "UPDATE media_items SET group_title = NULL, group_position = NULL",
    ).run();
    await scanLibraryFolder(db, folder, scanConfig);
    const healed = db
      .prepare(
        "SELECT COUNT(*) c FROM media_items WHERE group_title IS NOT NULL",
      )
      .get() as { c: number };
    expect(healed.c).toBe(4); // both courses; the loose root file stays NULL
  });

  it("linked episodes never carry group columns", async () => {
    const tvRoot = mkdtempSync(join(tmpdir(), "vlmp-tvgroups-"));
    try {
      mkdirSync(join(tvRoot, "Show", "Season 1"), { recursive: true });
      writeFileSync(join(tvRoot, "Show", "Season 1", "S01E01 - A.mkv"), "x");
      const folder = addLibraryFolder(db, tvRoot, "tv");
      await scanLibraryFolder(db, folder, scanConfig);
      const row = db
        .prepare(
          "SELECT group_title, group_position FROM media_items WHERE type = 'episode'",
        )
        .get() as { group_title: string | null; group_position: number | null };
      expect(row.group_title).toBeNull();
      expect(row.group_position).toBeNull();
    } finally {
      rmSync(tvRoot, { recursive: true, force: true });
    }
  });
});

describe("short-sample filter exempts sequenced content", () => {
  it("a short numbered lesson survives rescan; a short loose file is pruned", async () => {
    const root = mkdtempSync(join(tmpdir(), "vlmp-short-"));
    try {
      mkdirSync(join(root, "Course"));
      writeFileSync(join(root, "Course", "01 - Intro.mp4"), "x");
      writeFileSync(join(root, "sample.mp4"), "x");
      const folder = addLibraryFolder(db, root, "education");
      // First scan: probe fails, duration unknown, both rows land.
      await scanLibraryFolder(db, folder, scanConfig);
      db.prepare("UPDATE media_items SET duration = 60").run();
      // Rescan with known short durations: the sequenced lesson is content,
      // the loose short file is a sample.
      const result = await scanLibraryFolder(db, folder, scanConfig);
      expect(result.skippedShort).toBe(1);
      const titles = db
        .prepare("SELECT title FROM media_items ORDER BY title")
        .all() as { title: string }[];
      expect(titles).toEqual([{ title: "Intro" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("season 0 (specials) stays season 0", () => {
  it("S00E01 lands in season 0 and does not collide with S01E01", async () => {
    const root = mkdtempSync(join(tmpdir(), "vlmp-specials-"));
    try {
      mkdirSync(join(root, "Show"));
      writeFileSync(join(root, "Show", "Show S00E01 - Special.mkv"), "x");
      writeFileSync(join(root, "Show", "Show S01E01 - Pilot.mkv"), "x");
      const folder = addLibraryFolder(db, root, "tv");
      await scanLibraryFolder(db, folder, scanConfig);
      const seasons = db
        .prepare(
          "SELECT s.season_number, COUNT(e.id) c FROM seasons s JOIN episodes e ON e.season_id = s.id GROUP BY s.id ORDER BY s.season_number",
        )
        .all() as { season_number: number; c: number }[];
      // The || 1 coercion used to fold the special into season 1, where it
      // lost the UNIQUE(season_id, episode_number) race and vanished.
      expect(seasons).toEqual([
        { season_number: 0, c: 1 },
        { season_number: 1, c: 1 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("browse — full load and per-user liked flag", () => {
  let root: string;
  let folder: LibraryFolder;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "vlmp-movies-"));
    writeFileSync(join(root, "Alien (1979).mkv"), "x");
    writeFileSync(join(root, "Blade Runner (1982).mkv"), "x");
    writeFileSync(join(root, "Contact (1997).mkv"), "x");
    folder = addLibraryFolder(db, root, "movies");
    await scanLibraryFolder(db, folder, scanConfig);
    db.prepare(
      "INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'h')",
    ).run();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("all=true returns the whole category regardless of limit", () => {
    const paged = browseLibrary(db, {
      category: "movies",
      includeHidden: true,
      limit: 1,
    });
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(3);

    const full = browseLibrary(db, {
      category: "movies",
      includeHidden: true,
      limit: 1,
      all: true,
    });
    expect(full.items).toHaveLength(3);
    expect(full.total).toBe(3);
  });

  it("liked reflects the requesting user's likes", () => {
    const alien = db
      .prepare("SELECT id FROM media_items WHERE title = 'Alien'")
      .get() as { id: number };
    db.prepare(
      "INSERT INTO user_preferences (user_id, media_id, action) VALUES (1, ?, 'like')",
    ).run(alien.id);

    const withUser = browseLibrary(db, {
      category: "movies",
      includeHidden: true,
      all: true,
      userId: 1,
    });
    const likedTitles = withUser.items
      .filter((i) => i.liked === 1)
      .map((i) => i.title);
    expect(likedTitles).toEqual(["Alien"]);

    // A different user with no likes sees nothing flagged.
    const other = browseLibrary(db, {
      category: "movies",
      includeHidden: true,
      all: true,
      userId: 2,
    });
    expect(other.items.every((i) => i.liked === 0)).toBe(true);

    // Omitting userId keeps the flag off entirely (federation path).
    const anon = browseLibrary(db, {
      category: "movies",
      includeHidden: true,
      all: true,
    });
    expect(anon.items.every((i) => i.liked === 0)).toBe(true);
  });
});

describe("getTVShows — added_at and liked for sorting", () => {
  let root: string;
  let folder: LibraryFolder;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "vlmp-shows-"));
    mkdirSync(join(root, "Cosmos", "Season 1"), { recursive: true });
    writeFileSync(join(root, "Cosmos", "Season 1", "S01E01 - Intro.mkv"), "x");
    writeFileSync(join(root, "Cosmos", "Season 1", "S01E02 - Stars.mkv"), "x");
    folder = addLibraryFolder(db, root, "tv");
    await scanLibraryFolder(db, folder, scanConfig);
    db.prepare(
      "INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'h')",
    ).run();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("added_at is the newest episode's timestamp", () => {
    // Stamp the two episodes with known, distinct added_at values.
    const eps = db
      .prepare(
        "SELECT mi.id FROM media_items mi JOIN episodes e ON e.media_id = mi.id ORDER BY e.episode_number",
      )
      .all() as { id: number }[];
    db.prepare("UPDATE media_items SET added_at = 1000 WHERE id = ?").run(
      eps[0].id,
    );
    db.prepare("UPDATE media_items SET added_at = 2000 WHERE id = ?").run(
      eps[1].id,
    );
    const shows = getTVShows(db, true, "tv", 1) as { added_at: number }[];
    expect(shows[0].added_at).toBe(2000);
  });

  it("liked is 1 when any episode is liked by the user", () => {
    const ep = db.prepare("SELECT media_id FROM episodes LIMIT 1").get() as {
      media_id: number;
    };
    let shows = getTVShows(db, true, "tv", 1) as { liked: number }[];
    expect(shows[0].liked).toBe(0);

    db.prepare(
      "INSERT INTO user_preferences (user_id, media_id, action) VALUES (1, ?, 'like')",
    ).run(ep.media_id);
    shows = getTVShows(db, true, "tv", 1) as { liked: number }[];
    expect(shows[0].liked).toBe(1);

    // Another user without the like sees 0.
    shows = getTVShows(db, true, "tv", 2) as { liked: number }[];
    expect(shows[0].liked).toBe(0);
  });
});

describe("browse routes — all + liked wiring, no-category dump guard", () => {
  let root: string;
  let app: FastifyInstance;
  let userToken: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "vlmp-routes-"));
    writeFileSync(join(root, "Alien (1979).mkv"), "x");
    writeFileSync(join(root, "Blade Runner (1982).mkv"), "x");
    writeFileSync(join(root, "Contact (1997).mkv"), "x");
    const folder = addLibraryFolder(db, root, "movies");
    await scanLibraryFolder(db, folder, scanConfig);
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (2, 'viewer', 'x', 'user')",
    ).run();
    const alien = db
      .prepare("SELECT id FROM media_items WHERE title = 'Alien'")
      .get() as { id: number };
    db.prepare(
      "INSERT INTO user_preferences (user_id, media_id, action) VALUES (2, ?, 'like')",
    ).run(alien.id);
    userToken = await issueToken(
      { sub: "2", username: "viewer", role: "user" },
      config,
    );
    app = Fastify();
    registerLibraryRoutes(app, db, config);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("all=1 with a category returns everything and flags the caller's likes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/library/browse?category=movies&all=1&limit=1",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(3); // all=1 overrides limit=1
    expect(body.items.filter((i: { liked: number }) => i.liked === 1)).toEqual([
      expect.objectContaining({ title: "Alien" }),
    ]);
  });

  it("all=1 WITHOUT a category still respects the limit (no whole-table dump)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/library/browse?all=1&limit=1",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
  });
});
