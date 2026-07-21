// User-manageable categories: seeded once, deletable (defaults included)
// unless folders still use them; series detection generalized beyond the tv
// category; rescan backfills rows classified under older rules.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import {
  listCategories,
  createCategory,
  deleteCategory,
  slugify,
} from "../src/media/categories.js";
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
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

describe("categories — schema seed", () => {
  it("seeds the six defaults on a fresh database", () => {
    const cats = listCategories(db);
    expect(cats.map((c) => c.slug)).toEqual([
      "movies",
      "tv",
      "documentaries",
      "doc_series",
      "education",
      "other",
    ]);
    expect(cats.find((c) => c.slug === "tv")!.kind).toBe("series");
    expect(cats.find((c) => c.slug === "movies")!.kind).toBe("movie");
  });

  it("does NOT re-seed a deleted default on re-init (restart)", () => {
    db.prepare("DELETE FROM categories WHERE slug = 'other'").run();
    initSchema(db);
    expect(listCategories(db).some((c) => c.slug === "other")).toBe(false);
  });

  it("dropped the dead doc_series tables", () => {
    const t = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'doc_series%'",
      )
      .all();
    expect(t).toEqual([]);
  });
});

describe("categories — service", () => {
  it("creates with a slug derived from the label", () => {
    const r = createCategory(db, { label: "Concert Films!", kind: "movie" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.category.slug).toBe("concert_films");
      expect(r.category.kind).toBe("movie");
    }
  });

  it("slugify strips accents and symbols", () => {
    expect(slugify("Documentales de México")).toBe("documentales_de_mexico");
    expect(slugify("Kids' Shows")).toBe("kids_shows");
  });

  it("rejects duplicate slugs", () => {
    expect(createCategory(db, { label: "Movies", kind: "movie" }).ok).toBe(
      false,
    );
  });

  it("rejects reserved router slugs", () => {
    const r = createCategory(db, { label: "Settings", kind: "movie" });
    expect(r.ok).toBe(false);
  });

  it("deletes a default category when nothing references it", () => {
    const other = listCategories(db).find((c) => c.slug === "other")!;
    expect(deleteCategory(db, other.id)).toEqual({ ok: true });
    expect(listCategories(db).some((c) => c.slug === "other")).toBe(false);
  });

  it("refuses to delete a category still used by a folder", () => {
    addLibraryFolder(db, "/somewhere", "movies");
    const movies = listCategories(db).find((c) => c.slug === "movies")!;
    const r = deleteCategory(db, movies.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
});

describe("categories — routes", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin'), (2, 'viewer', 'x', 'user')",
    ).run();
    adminToken = await issueToken(
      { sub: "1", username: "admin", role: "admin" },
      config,
    );
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
  });

  it("GET /categories works for any logged-in user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/categories",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(6);
  });

  it("POST /admin/categories is admin-only and creates", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/admin/categories",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { label: "Anime", kind: "series" },
    });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({
      method: "POST",
      url: "/admin/categories",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { label: "Anime", kind: "series" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("anime");
    const dup = await app.inject({
      method: "POST",
      url: "/admin/categories",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { label: "Anime", kind: "series" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("DELETE /admin/categories/:id → 204, 409 when in use, 404 unknown", async () => {
    addLibraryFolder(db, "/x", "tv");
    const cats = listCategories(db);
    const tv = cats.find((c) => c.slug === "tv")!;
    const other = cats.find((c) => c.slug === "other")!;
    const auth = { authorization: `Bearer ${adminToken}` };
    const inUse = await app.inject({
      method: "DELETE",
      url: `/admin/categories/${tv.id}`,
      headers: auth,
    });
    expect(inUse.statusCode).toBe(409);
    const ok = await app.inject({
      method: "DELETE",
      url: `/admin/categories/${other.id}`,
      headers: auth,
    });
    expect(ok.statusCode).toBe(204);
    const gone = await app.inject({
      method: "DELETE",
      url: `/admin/categories/${other.id}`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(404);
  });

  it("POST /admin/folders rejects a category that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/folders",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: tmpdir(), category: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unknown category/);
  });
});

// End-to-end scan behavior on a real temp directory tree. ffprobe/TMDb are
// unavailable here by design — probe failures are non-fatal and the TMDb key
// is unset, so classification and linking are exactly what's exercised.
describe("categories — scan, series detection, backfill", () => {
  let root: string;
  let folder: LibraryFolder;

  const scanConfig = {
    ...config,
    tmdbApiKey: "",
    extractSubsOnScan: false,
    emptyTrashOnScan: true,
    ffprobePath: "/nonexistent/ffprobe",
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "vlmp-cats-"));
    // A movie-kind Docs library holding one single doc + one doc series.
    writeFileSync(join(root, "Free Solo (2018).mkv"), "x");
    mkdirSync(join(root, "Cosmos (2014)", "Season 1"), { recursive: true });
    mkdirSync(join(root, "Cosmos (2014)", "Season 2"), { recursive: true });
    writeFileSync(
      join(root, "Cosmos (2014)", "Season 1", "01. Standing Up.mkv"),
      "x",
    );
    writeFileSync(
      join(root, "Cosmos (2014)", "Season 1", "02. Some of the Things.mkv"),
      "x",
    );
    writeFileSync(
      join(root, "Cosmos (2014)", "Season 2", "01. Ladder of Life.mkv"),
      "x",
    );
    folder = addLibraryFolder(db, root, "documentaries");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("splits a Docs folder into a single doc + a grouped series", async () => {
    await scanLibraryFolder(db, folder, scanConfig);

    const single = db
      .prepare(
        "SELECT type FROM media_items WHERE file_path LIKE '%Free Solo%'",
      )
      .get() as { type: string };
    expect(single.type).toBe("documentary");

    const shows = getTVShows(db, true, "documentaries") as {
      id: number;
      title: string;
      year: number | null;
      folder_path: string;
      season_count: number;
      episode_count: number;
      first_media_id: number;
    }[];
    expect(shows).toHaveLength(1);
    expect(shows[0].title).toBe("Cosmos");
    expect(shows[0].year).toBe(2014);
    expect(shows[0].folder_path).toBe(join(root, "Cosmos (2014)"));
    expect(shows[0].season_count).toBe(2);
    expect(shows[0].episode_count).toBe(3);
    expect(shows[0].first_media_id).toBeGreaterThan(0);

    const detail = getTVShowDetail(db, shows[0].id, true)!;
    expect(detail.seasons).toHaveLength(2);
    expect(detail.seasons[0].episodes.map((e) => e.episode_number)).toEqual([
      1, 2,
    ]);

    // The flat grid hides linked episodes but keeps the single doc.
    const grid = browseLibrary(db, {
      category: "documentaries",
      excludeEpisodes: true,
      includeHidden: true,
    });
    expect(grid.items.map((i) => i.title)).toEqual(["Free Solo"]);
    // Without the flag everything is still reachable.
    expect(
      browseLibrary(db, { category: "documentaries", includeHidden: true })
        .total,
    ).toBe(4);
  });

  it("rescan is idempotent (no duplicate shows/episodes)", async () => {
    await scanLibraryFolder(db, folder, scanConfig);
    await scanLibraryFolder(db, folder, scanConfig);
    expect(db.prepare("SELECT COUNT(*) c FROM tv_shows").get()).toEqual({
      c: 1,
    });
    expect(db.prepare("SELECT COUNT(*) c FROM episodes").get()).toEqual({
      c: 3,
    });
  });

  it("backfills rows scanned under old rules and migrates legacy title-keyed shows", async () => {
    // Legacy state: the Cosmos episodes were stored as plain documentaries by
    // the old classifier...
    const epPath = join(
      root,
      "Cosmos (2014)",
      "Season 1",
      "01. Standing Up.mkv",
    );
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, 'documentary', ?, 'Standing Up 1080p junk', 'standing up 1080p junk')",
    ).run(folder.id, epPath);
    // ...and a legacy show keyed by TITLE in folder_path holds an episode.
    db.prepare(
      "INSERT INTO tv_shows (id, title, folder_path) VALUES (9, 'Cosmos', 'Cosmos')",
    ).run();
    db.prepare(
      "INSERT INTO seasons (id, show_id, season_number) VALUES (9, 9, 1)",
    ).run();
    const legacyMedia = db
      .prepare("SELECT id FROM media_items WHERE file_path = ?")
      .get(epPath) as { id: number };
    db.prepare(
      "INSERT INTO episodes (season_id, media_id, episode_number) VALUES (9, ?, 1)",
    ).run(legacyMedia.id);

    await scanLibraryFolder(db, folder, scanConfig);

    const migrated = db
      .prepare("SELECT type, title FROM media_items WHERE file_path = ?")
      .get(epPath) as { type: string; title: string };
    expect(migrated.type).toBe("episode");
    expect(migrated.title).toBe("Standing Up");

    // Exactly one Cosmos show remains, keyed by the real directory; the
    // legacy title-keyed row was emptied by the episode upsert and swept.
    const shows = db
      .prepare("SELECT title, folder_path FROM tv_shows")
      .all() as { title: string; folder_path: string }[];
    expect(shows).toHaveLength(1);
    expect(shows[0].folder_path).toBe(join(root, "Cosmos (2014)"));
  });

  it("rescan heals a stale title without a type change", async () => {
    const docPath = join(root, "Free Solo (2018).mkv");
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, 'documentary', ?, '720P BRRIP junk', '720p brrip junk')",
    ).run(folder.id, docPath);
    await scanLibraryFolder(db, folder, scanConfig);
    const healed = db
      .prepare("SELECT title, year FROM media_items WHERE file_path = ?")
      .get(docPath) as { title: string; year: number | null };
    expect(healed.title).toBe("Free Solo");
    expect(healed.year).toBe(2018);
  });

  it("first_media_id respects the visibility gate for cross-folder shows", async () => {
    // A legacy show spanning a hidden and a visible folder: the hidden
    // episode sorts first, but a non-admin's card must not receive its id.
    const hidden = db
      .prepare(
        "INSERT INTO library_folders (path, category, is_visible) VALUES ('/hid', 'documentaries', 0) RETURNING id",
      )
      .get() as { id: number };
    const visible = db
      .prepare(
        "INSERT INTO library_folders (path, category, is_visible) VALUES ('/vis', 'documentaries', 1) RETURNING id",
      )
      .get() as { id: number };
    const mkMedia = (fid: number, path: string) =>
      (
        db
          .prepare(
            "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, 'episode', ?, 'E', 'e') RETURNING id",
          )
          .get(fid, path) as { id: number }
      ).id;
    const hidMedia = mkMedia(hidden.id, "/hid/e1.mkv");
    const visMedia = mkMedia(visible.id, "/vis/e2.mkv");
    db.prepare(
      "INSERT INTO tv_shows (id, title, folder_path) VALUES (7, 'Span', 'Span')",
    ).run();
    db.prepare(
      "INSERT INTO seasons (id, show_id, season_number) VALUES (7, 7, 1)",
    ).run();
    db.prepare(
      "INSERT INTO episodes (season_id, media_id, episode_number) VALUES (7, ?, 1), (7, ?, 2)",
    ).run(hidMedia, visMedia);

    const asUser = getTVShows(db, false, "documentaries") as {
      title: string;
      first_media_id: number;
    }[];
    const span = asUser.find((s) => s.title === "Span")!;
    expect(span.first_media_id).toBe(visMedia);
    const asAdmin = getTVShows(db, true, "documentaries") as {
      title: string;
      first_media_id: number;
    }[];
    expect(asAdmin.find((s) => s.title === "Span")!.first_media_id).toBe(
      hidMedia,
    );
  });

  it("a series-kind custom category groups even bare numbered files", async () => {
    const r2 = mkdtempSync(join(tmpdir(), "vlmp-cats2-"));
    try {
      mkdirSync(join(r2, "Chef's Table"));
      writeFileSync(join(r2, "Chef's Table", "01 - Massimo.mkv"), "x");
      writeFileSync(join(r2, "Chef's Table", "02 - Grant.mkv"), "x");
      const created = createCategory(db, {
        label: "Food Docs",
        kind: "series",
      });
      expect(created.ok).toBe(true);
      const f2 = addLibraryFolder(db, r2, "food_docs");
      await scanLibraryFolder(db, f2, scanConfig);
      const shows = getTVShows(db, true, "food_docs") as {
        title: string;
        episode_count: number;
      }[];
      expect(shows).toHaveLength(1);
      expect(shows[0].title).toBe("Chef's Table");
      expect(shows[0].episode_count).toBe(2);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });
});
