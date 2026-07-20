// Frame-grab thumbnail fallback: lazy generation with a fail marker (one
// ffmpeg attempt per media, ever), and the /media/:id/thumb route sits behind
// the same visibility boundary as media detail.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import { getOrCreateThumb, thumbFile } from "../src/metadata/thumbs.js";
import { registerMetadataRoutes } from "../src/routes/metadata.js";
import { issueToken } from "../src/auth/jwt.js";
import { loadConfig, type Config } from "../src/config.js";

const baseConfig = loadConfig();
let db: Database.Database;
let dataDir: string;
let cfg: Config;

function stubFFmpeg(script: string): string {
  const p = join(dataDir, "fake-ffmpeg.sh");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

// Writes bytes to its last argument (ffmpeg's output file) and counts runs.
const OK_STUB = `#!/bin/sh
echo run >> "$(dirname "$0")/runs"
for a in "$@"; do out="$a"; done
printf 'JPGDATA' > "$out"
`;
const FAIL_STUB = `#!/bin/sh
echo run >> "$(dirname "$0")/runs"
exit 1
`;

function runCount(): number {
  const p = join(dataDir, "runs");
  return existsSync(p) ? readFileSync(p, "utf-8").trim().split("\n").length : 0;
}

function addMedia(folderVisible: number): number {
  const folder = db
    .prepare(
      "INSERT INTO library_folders (path, category, is_visible, is_searchable) VALUES ('/m', 'movies', ?, ?) RETURNING id",
    )
    .get(folderVisible, folderVisible) as { id: number };
  return (
    db
      .prepare(
        "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, duration) VALUES (?, 'movie', '/m/a.mp4', 'A', 'a', 600) RETURNING id",
      )
      .get(folder.id) as { id: number }
  ).id;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  dataDir = mkdtempSync(join(tmpdir(), "vlmp-thumbs-"));
  cfg = { ...baseConfig, dataDir };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("getOrCreateThumb", () => {
  it("generates once, then serves from disk without re-running ffmpeg", async () => {
    cfg.ffmpegPath = stubFFmpeg(OK_STUB);
    const id = addMedia(1);
    const first = await getOrCreateThumb(db, id, cfg);
    expect(first).toBe(thumbFile(cfg, id));
    expect(readFileSync(first!, "utf-8")).toBe("JPGDATA");
    expect(runCount()).toBe(1);
    await getOrCreateThumb(db, id, cfg);
    expect(runCount()).toBe(1);
  });

  it("writes a fail marker on ffmpeg failure and never retries", async () => {
    cfg.ffmpegPath = stubFFmpeg(FAIL_STUB);
    const id = addMedia(1);
    expect(await getOrCreateThumb(db, id, cfg)).toBe(null);
    expect(runCount()).toBe(1);
    expect(await getOrCreateThumb(db, id, cfg)).toBe(null);
    expect(runCount()).toBe(1);
  });

  it("returns null for unknown media without touching ffmpeg", async () => {
    cfg.ffmpegPath = stubFFmpeg(OK_STUB);
    expect(await getOrCreateThumb(db, 9999, cfg)).toBe(null);
    expect(runCount()).toBe(0);
  });

  it("caps concurrent ffmpeg grabs across different media (global pool)", async () => {
    // Each stub run takes 0.5s. Firing 5 distinct media at once must not run
    // 5 ffmpegs — the pool admits 2 at a time (v0.1.4 CPU fix: a 60-card
    // category grid used to fan out 60 concurrent frame-grabs).
    const SLOW_STUB = `#!/bin/sh
echo run >> "$(dirname "$0")/runs"
sleep 0.5
for a in "$@"; do out="$a"; done
printf 'JPGDATA' > "$out"
`;
    cfg.ffmpegPath = stubFFmpeg(SLOW_STUB);
    const folder = db
      .prepare(
        "INSERT INTO library_folders (path, category, is_visible, is_searchable) VALUES ('/pool', 'movies', 1, 1) RETURNING id",
      )
      .get() as { id: number };
    const ids = Array.from(
      { length: 5 },
      (_, i) =>
        (
          db
            .prepare(
              "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, duration) VALUES (?, 'movie', ?, 'V', 'v', 600) RETURNING id",
            )
            .get(folder.id, `/pool/v${i}.mp4`) as { id: number }
        ).id,
    );
    const all = Promise.all(ids.map((id) => getOrCreateThumb(db, id, cfg)));
    await new Promise((r) => setTimeout(r, 250));
    expect(runCount()).toBeLessThanOrEqual(2); // only the pool is running
    const results = await all;
    expect(runCount()).toBe(5); // but everyone eventually ran
    expect(results.every((r) => r !== null)).toBe(true);
  });

  it("dedupes concurrent requests for the same media", async () => {
    cfg.ffmpegPath = stubFFmpeg(OK_STUB);
    const id = addMedia(1);
    const [a, b] = await Promise.all([
      getOrCreateThumb(db, id, cfg),
      getOrCreateThumb(db, id, cfg),
    ]);
    expect(a).toBe(b);
    expect(runCount()).toBe(1);
  });
});

describe.skipIf(process.platform === "win32")("GET /media/:id/thumb", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin'), (2, 'viewer', 'x', 'user')",
    ).run();
    adminToken = await issueToken(
      { sub: "1", username: "admin", role: "admin" },
      baseConfig,
    );
    userToken = await issueToken(
      { sub: "2", username: "viewer", role: "user" },
      baseConfig,
    );
    cfg.ffmpegPath = stubFFmpeg(OK_STUB);
    cfg.jwtSecret = baseConfig.jwtSecret;
    app = Fastify();
    registerMetadataRoutes(app, db, cfg);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("requires auth", async () => {
    const id = addMedia(1);
    const res = await app.inject({ method: "GET", url: `/media/${id}/thumb` });
    expect(res.statusCode).toBe(401);
  });

  it("serves a jpeg for visible media", async () => {
    const id = addMedia(1);
    const res = await app.inject({
      method: "GET",
      url: `/media/${id}/thumb`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.body).toBe("JPGDATA");
  });

  it("404s hidden media for non-admins, serves for admins", async () => {
    const id = addMedia(0);
    const user = await app.inject({
      method: "GET",
      url: `/media/${id}/thumb`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(user.statusCode).toBe(404);
    expect(runCount()).toBe(0); // gate must fire BEFORE any ffmpeg work
    const admin = await app.inject({
      method: "GET",
      url: `/media/${id}/thumb`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(admin.statusCode).toBe(200);
  });

  it("404s when no thumbnail can be produced", async () => {
    cfg.ffmpegPath = stubFFmpeg(FAIL_STUB);
    const id = addMedia(1);
    const res = await app.inject({
      method: "GET",
      url: `/media/${id}/thumb`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
