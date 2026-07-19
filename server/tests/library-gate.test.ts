// The library gate: admins see/search everything; non-admins are limited to
// folders marked visible (and, for search, searchable). Hidden libraries are a
// real access boundary — detail and stream return 404, not just a hidden row.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import {
  browseLibrary,
  getRecentlyAdded,
  isMediaFolderVisible,
  setFolderVisibility,
  pruneMissingFiles,
  getTVShowDetail,
} from "../src/media/library.js";
import { registerLibraryRoutes } from "../src/routes/library.js";
import { registerSubtitleRoutes } from "../src/routes/subtitles.js";
import {
  createPlaylist,
  addToPlaylist,
  getPlaylistWithItems,
} from "../src/media/playlists.js";
import { issueToken } from "../src/auth/jwt.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
let db: Database.Database;

function addFolder(
  path: string,
  category: string,
  visible = 1,
  searchable = 1,
) {
  return db
    .prepare(
      "INSERT INTO library_folders (path, category, is_visible, is_searchable) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(path, category, visible, searchable) as { id: number };
}

function addMedia(folderId: number, title: string, filePath: string) {
  return db
    .prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, 'movie', ?, ?, ?) RETURNING id",
    )
    .get(folderId, filePath, title, title.toLowerCase()) as { id: number };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

describe("library gate — query filtering", () => {
  it("hides non-visible folders from non-admin browse, shows to admin", () => {
    const vis = addFolder("/vis", "movies", 1, 1);
    const hid = addFolder("/hid", "movies", 0, 0);
    addMedia(vis.id, "Visible Movie", "/vis/a.mp4");
    addMedia(hid.id, "Hidden Movie", "/hid/b.mp4");

    const user = browseLibrary(db, { includeHidden: false });
    expect(user.items.map((i) => i.title)).toEqual(["Visible Movie"]);
    expect(user.total).toBe(1);

    const admin = browseLibrary(db, { includeHidden: true });
    expect(admin.items).toHaveLength(2);
  });

  it("search additionally requires the folder to be searchable", () => {
    const searchable = addFolder("/s", "movies", 1, 1);
    const browseOnly = addFolder("/b", "movies", 1, 0);
    addMedia(searchable.id, "Findable", "/s/a.mp4");
    addMedia(browseOnly.id, "Findable Two", "/b/b.mp4");

    // Browsing shows both (both visible)...
    const browse = browseLibrary(db, { includeHidden: false });
    expect(browse.items).toHaveLength(2);
    // ...but searching excludes the non-searchable one.
    const search = browseLibrary(db, {
      includeHidden: false,
      search: "Findable",
    });
    expect(search.items.map((i) => i.title)).toEqual(["Findable"]);
  });

  it("getRecentlyAdded respects the gate", () => {
    const vis = addFolder("/vis", "movies", 1, 1);
    const hid = addFolder("/hid", "movies", 0, 0);
    addMedia(vis.id, "V", "/vis/a.mp4");
    addMedia(hid.id, "H", "/hid/b.mp4");
    expect(getRecentlyAdded(db, 20, false).map((i) => i.title)).toEqual(["V"]);
    expect(getRecentlyAdded(db, 20, true)).toHaveLength(2);
  });

  it("isMediaFolderVisible is the access boundary", () => {
    const vis = addFolder("/vis", "movies", 1, 1);
    const hid = addFolder("/hid", "movies", 0, 0);
    const v = addMedia(vis.id, "V", "/vis/a.mp4");
    const h = addMedia(hid.id, "H", "/hid/b.mp4");
    expect(isMediaFolderVisible(db, v.id)).toBe(true);
    expect(isMediaFolderVisible(db, h.id)).toBe(false);
  });

  it("setFolderVisibility toggles flags and takes effect immediately", () => {
    const f = addFolder("/f", "movies", 1, 1);
    const m = addMedia(f.id, "M", "/f/a.mp4");
    expect(isMediaFolderVisible(db, m.id)).toBe(true);
    const updated = setFolderVisibility(db, f.id, { is_visible: false });
    expect(updated!.is_visible).toBe(0);
    expect(isMediaFolderVisible(db, m.id)).toBe(false);
  });
});

describe("library gate — route boundary", () => {
  let app: FastifyInstance;
  let userToken: string;
  let adminToken: string;
  let hiddenId: number;
  let visibleId: number;

  beforeEach(async () => {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin'), (2, 'viewer', 'x', 'user')",
    ).run();
    const vis = addFolder("/vis", "movies", 1, 1);
    const hid = addFolder("/hid", "movies", 0, 0);
    visibleId = addMedia(vis.id, "V", "/vis/a.mp4").id;
    hiddenId = addMedia(hid.id, "H", "/hid/b.mp4").id;
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

  const hdr = (t: string) => ({ authorization: `Bearer ${t}` });

  it("non-admin gets 404 on hidden media detail, 200 on visible", async () => {
    const hidden = await app.inject({
      method: "GET",
      url: `/library/${hiddenId}`,
      headers: hdr(userToken),
    });
    expect(hidden.statusCode).toBe(404);
    const visible = await app.inject({
      method: "GET",
      url: `/library/${visibleId}`,
      headers: hdr(userToken),
    });
    expect(visible.statusCode).toBe(200);
  });

  it("admin can open hidden media", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/library/${hiddenId}`,
      headers: hdr(adminToken),
    });
    expect(res.statusCode).toBe(200);
  });

  it("admin PATCH toggles visibility; then the non-admin can reach it", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/folders/2",
      headers: hdr(adminToken),
      payload: { is_visible: true },
    });
    expect(patch.statusCode).toBe(200);
    const res = await app.inject({
      method: "GET",
      url: `/library/${hiddenId}`,
      headers: hdr(userToken),
    });
    expect(res.statusCode).toBe(200);
  });

  it("non-admin cannot PATCH folder flags", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/folders/1",
      headers: hdr(userToken),
      payload: { is_visible: false },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("empty trash — pruneMissingFiles", () => {
  it("removes rows whose file is gone, keeps present ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "vlmp-prune-"));
    try {
      const present = join(dir, "here.mp4");
      writeFileSync(present, "x");
      const f = addFolder(dir, "movies", 1, 1);
      addMedia(f.id, "Here", present);
      addMedia(f.id, "Gone", join(dir, "gone.mp4"));

      expect(browseLibrary(db, { includeHidden: true }).total).toBe(2);
      const pruned = pruneMissingFiles(db, f.id);
      expect(pruned).toBe(1);
      const remaining = browseLibrary(db, { includeHidden: true });
      expect(remaining.items.map((i) => i.title)).toEqual(["Here"]);
      expect(existsSync(present)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never deletes the whole folder when ALL files are missing (unmounted drive)", () => {
    const f = addFolder("/mnt/unmounted", "movies", 1, 1);
    addMedia(f.id, "A", "/mnt/unmounted/a.mp4");
    addMedia(f.id, "B", "/mnt/unmounted/b.mp4");
    // Both files are absent — must be treated as a mount failure, not trash.
    const pruned = pruneMissingFiles(db, f.id);
    expect(pruned).toBe(0);
    expect(browseLibrary(db, { includeHidden: true }).total).toBe(2);
  });
});

describe("library gate — subtitle token cannot cross media (R2 bypass)", () => {
  let app: FastifyInstance;
  let userToken: string;
  let visibleMediaId: number;
  let hiddenSubtitleId: number;

  beforeEach(async () => {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (2, 'viewer', 'x', 'user')",
    ).run();
    const vis = addFolder("/vis", "movies", 1, 1);
    const hid = addFolder("/hid", "movies", 0, 0);
    visibleMediaId = addMedia(vis.id, "V", "/vis/a.mp4").id;
    const hiddenMediaId = addMedia(hid.id, "H", "/hid/b.mp4").id;
    hiddenSubtitleId = (
      db
        .prepare(
          "INSERT INTO subtitles (media_id, language, format, file_path, source) VALUES (?, 'en', 'vtt', '/sub/h.vtt', 'extracted') RETURNING id",
        )
        .get(hiddenMediaId) as { id: number }
    ).id;
    userToken = await issueToken(
      { sub: "2", username: "viewer", role: "user" },
      config,
    );
    app = Fastify();
    registerSubtitleRoutes(app, db, config);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("refuses to mint a token pairing a visible media with a hidden title's subtitle", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/subtitles/${visibleMediaId}/${hiddenSubtitleId}/token`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("library gate — cross-folder TV show", () => {
  it("show-detail hides episodes from a hidden folder for non-admins", () => {
    const vis = addFolder("/vis", "tv", 1, 1);
    const hid = addFolder("/hid", "tv", 0, 0);
    const e1 = addMedia(vis.id, "S1E1", "/vis/e1.mp4");
    const e2 = addMedia(hid.id, "S1E2", "/hid/e2.mp4");
    const show = db
      .prepare(
        "INSERT INTO tv_shows (title, folder_path) VALUES ('Show', 'Show') RETURNING id",
      )
      .get() as { id: number };
    const season = db
      .prepare(
        "INSERT INTO seasons (show_id, season_number) VALUES (?, 1) RETURNING id",
      )
      .get(show.id) as { id: number };
    db.prepare(
      "INSERT INTO episodes (season_id, media_id, episode_number) VALUES (?, ?, 1), (?, ?, 2)",
    ).run(season.id, e1.id, season.id, e2.id);

    const asUser = getTVShowDetail(db, show.id, false) as {
      seasons: { episodes: string }[];
    };
    const userEps = JSON.parse(asUser.seasons[0].episodes).filter(
      (e: { id: number | null }) => e.id !== null,
    );
    expect(userEps.map((e: { media_id: number }) => e.media_id)).toEqual([
      e1.id,
    ]);

    const asAdmin = getTVShowDetail(db, show.id, true) as {
      seasons: { episodes: string }[];
    };
    const adminEps = JSON.parse(asAdmin.seasons[0].episodes);
    expect(adminEps).toHaveLength(2);
  });
});

describe("library gate — playlists do not leak hidden media", () => {
  it("blocks a non-admin from adding hidden media and hides it on read", () => {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (2, 'viewer', 'x', 'user')",
    ).run();
    const vis = addFolder("/vis", "movies", 1, 1);
    const hid = addFolder("/hid", "movies", 0, 0);
    const v = addMedia(vis.id, "Visible", "/vis/a.mp4");
    const h = addMedia(hid.id, "Hidden", "/hid/b.mp4");
    const pl = createPlaylist(db, 2, "My List");

    // Non-admin cannot smuggle hidden media in by id.
    expect(addToPlaylist(db, pl.id, 2, h.id, false)).toBeNull();
    expect(addToPlaylist(db, pl.id, 2, v.id, false)).not.toBeNull();

    // Even if a hidden row already exists (e.g. library hidden after adding),
    // the non-admin read drops it; the admin read keeps it.
    addToPlaylist(db, pl.id, 2, h.id, true); // simulate pre-existing row
    const asUser = getPlaylistWithItems(db, pl.id, 2, false);
    expect(asUser!.items.map((i) => i.title)).toEqual(["Visible"]);
    const asAdmin = getPlaylistWithItems(db, pl.id, 2, true);
    expect(asAdmin!.items.map((i) => i.title).sort()).toEqual([
      "Hidden",
      "Visible",
    ]);
  });
});
