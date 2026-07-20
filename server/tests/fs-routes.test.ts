// Admin directory browser: admin-only, lists directory NAMES only (never
// files), hides dotfiles, and reports parent for "up" navigation.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import { registerFsRoutes } from "../src/routes/fs.js";
import { issueToken } from "../src/auth/jwt.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
let db: Database.Database;
let app: FastifyInstance;
let adminToken: string;
let userToken: string;
let root: string;

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
  root = mkdtempSync(join(tmpdir(), "vlmp-fs-"));
  mkdirSync(join(root, "Movies"));
  mkdirSync(join(root, "shows"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "a-file.mkv"), "x");
  app = Fastify();
  registerFsRoutes(app, db, config);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const hdr = (t: string) => ({ authorization: `Bearer ${t}` });

describe("GET /admin/fs/dirs", () => {
  it("requires auth and admin role", async () => {
    const anon = await app.inject({ method: "GET", url: "/admin/fs/dirs" });
    expect(anon.statusCode).toBe(401);
    const user = await app.inject({
      method: "GET",
      url: "/admin/fs/dirs",
      headers: hdr(userToken),
    });
    expect(user.statusCode).toBe(403);
  });

  it("lists subdirectories only — no files, no dotdirs — case-insensitively sorted", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/admin/fs/dirs?path=${encodeURIComponent(root)}`,
      headers: hdr(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe(root);
    expect(body.parent).toBe(join(root, ".."));
    expect(body.dirs.map((d: { name: string }) => d.name)).toEqual([
      "Movies",
      "shows",
    ]);
    expect(body.dirs[0].path).toBe(join(root, "Movies"));
  });

  it("400s on an unreadable path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/admin/fs/dirs?path=${encodeURIComponent(join(root, "nope"))}`,
      headers: hdr(adminToken),
    });
    expect(res.statusCode).toBe(400);
  });

  it.skipIf(process.platform === "win32")(
    "no path starts at / and the filesystem root has no parent",
    async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/fs/dirs",
        headers: hdr(adminToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.path).toBe("/");
      expect(body.parent).toBe(null);
    },
  );
});
