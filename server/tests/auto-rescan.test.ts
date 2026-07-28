// View-triggered rescan: opening a category page refreshes exactly that
// category's folders in the background — per-folder cooldown, atomic claim
// shared with the admin scan route, and non-admins can neither trigger nor
// observe folders hidden from them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import { registerLibraryRoutes } from "../src/routes/library.js";
import { issueToken } from "../src/auth/jwt.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
// ffprobe intentionally missing: probes fail fast, scans still complete.
const cfg = {
  ...config,
  tmdbApiKey: "",
  extractSubsOnScan: false,
  ffprobePath: "/nonexistent/ffprobe",
  autoRescanCooldownSeconds: 300,
};

let db: Database.Database;
let app: FastifyInstance;
let adminToken: string;
let userToken: string;
let root: string;

function addFolder(path: string, category: string, visible = 1) {
  return db
    .prepare(
      "INSERT INTO library_folders (path, category, is_visible, is_searchable) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(path, category, visible, visible) as { id: number };
}

function folderStatus(id: number): string {
  return (
    db
      .prepare("SELECT scan_status FROM library_folders WHERE id = ?")
      .get(id) as { scan_status: string }
  ).scan_status;
}

async function waitSettled(id: number, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = folderStatus(id);
    if (status !== "scanning") return status;
    if (Date.now() > deadline) return status;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
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
  root = mkdtempSync(join(tmpdir(), "vlmp-autorescan-"));
  writeFileSync(join(root, "A.mkv"), "x");
  app = Fastify();
  registerLibraryRoutes(app, db, cfg);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const refresh = (slug: string, token: string) =>
  app.inject({
    method: "POST",
    url: `/library/categories/${slug}/refresh`,
    headers: { authorization: `Bearer ${token}` },
  });

describe("POST /library/categories/:slug/refresh", () => {
  it("a viewer opening a category scans its folders; new files appear", async () => {
    const folder = addFolder(root, "movies");
    const res = await refresh("movies", userToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ started: 1, scanning: true });
    expect(await waitSettled(folder.id)).toBe("complete");
    expect(db.prepare("SELECT COUNT(*) c FROM media_items").get()).toEqual({
      c: 1,
    });
  });

  it("a second visit inside the cooldown window is a no-op", async () => {
    const folder = addFolder(root, "movies");
    await refresh("movies", userToken);
    await waitSettled(folder.id);
    const again = await refresh("movies", userToken);
    expect(again.json()).toEqual({ started: 0, scanning: false });
  });

  it("scans only the viewed category's folders", async () => {
    const other = join(root, "other-lib");
    mkdirSync(other);
    const viewed = addFolder(root, "movies");
    const notViewed = addFolder(other, "other");
    await refresh("movies", userToken);
    await waitSettled(viewed.id);
    expect(folderStatus(notViewed.id)).toBe("pending"); // untouched
  });

  it("hidden folders: a viewer cannot trigger them, an admin can", async () => {
    const folder = addFolder(root, "movies", 0);
    const asUser = await refresh("movies", userToken);
    // Indistinguishable from an empty category — no probe oracle.
    expect(asUser.json()).toEqual({ started: 0, scanning: false });
    expect(folderStatus(folder.id)).toBe("pending");
    const asAdmin = await refresh("movies", adminToken);
    expect(asAdmin.json().started).toBe(1);
    expect(await waitSettled(folder.id)).toBe("complete");
  });

  it("an unknown slug answers like an empty category", async () => {
    const res = await refresh("no-such-category", userToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ started: 0, scanning: false });
  });

  it("cooldown 0 disables the feature entirely", async () => {
    const offApp = Fastify();
    registerLibraryRoutes(offApp, db, { ...cfg, autoRescanCooldownSeconds: 0 });
    await offApp.ready();
    try {
      const folder = addFolder(root, "movies");
      const res = await offApp.inject({
        method: "POST",
        url: "/library/categories/movies/refresh",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.json()).toEqual({ started: 0, scanning: false });
      expect(folderStatus(folder.id)).toBe("pending");
      // Feature off must still report REAL scanning state, so open pages
      // can follow an admin-triggered scan and refresh when it lands.
      db.prepare("UPDATE library_folders SET scan_status = 'scanning'").run();
      const during = await offApp.inject({
        method: "POST",
        url: "/library/categories/movies/refresh",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(during.json()).toEqual({ started: 0, scanning: true });
    } finally {
      await offApp.close();
    }
  });
});

describe("GET /library/categories/:slug/scan-status", () => {
  it("reports scanning only for folders the caller can see", async () => {
    // A hidden folder pinned in 'scanning' state (no live scan needed).
    addFolder(root, "movies", 0);
    db.prepare("UPDATE library_folders SET scan_status = 'scanning'").run();
    const asUser = await app.inject({
      method: "GET",
      url: "/library/categories/movies/scan-status",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(asUser.json()).toEqual({ scanning: false }); // hidden ⇒ invisible
    const asAdmin = await app.inject({
      method: "GET",
      url: "/library/categories/movies/scan-status",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(asAdmin.json()).toEqual({ scanning: true });
  });

  it("requires auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/library/categories/movies/scan-status",
    });
    expect(res.statusCode).toBe(401);
    const post = await app.inject({
      method: "POST",
      url: "/library/categories/movies/refresh",
    });
    expect(post.statusCode).toBe(401);
  });
});
