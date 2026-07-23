// Metadata backfill: POST /admin/metadata/scan returns 202 and runs in the
// background (progress via /status), re-classifies unmatched rows from their
// file paths (junk titles from older classifier versions become matchable),
// and never clobbers titles on already-matched items.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import { registerMetadataRoutes } from "../src/routes/metadata.js";
import { issueToken } from "../src/auth/jwt.js";
import { loadConfig, type Config } from "../src/config.js";

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
import { searchMovie, getMovieDetail } from "../src/metadata/tmdb.js";

const baseConfig = loadConfig();
let db: Database.Database;
let app: FastifyInstance;
let adminToken: string;
let cfg: Config;

function seedMovie(title: string, filePath: string, poster: string | null) {
  const folder = db
    .prepare(
      "INSERT OR IGNORE INTO library_folders (id, path, category) VALUES (1, '/m', 'movies')",
    )
    .run();
  void folder;
  return (
    db
      .prepare(
        "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, year, poster_path) VALUES (1, 'movie', ?, ?, ?, NULL, ?) RETURNING id",
      )
      .get(filePath, title, title.toLowerCase(), poster) as { id: number }
  ).id;
}

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')",
  ).run();
  adminToken = await issueToken(
    { sub: "1", username: "admin", role: "admin" },
    baseConfig,
  );
  cfg = { ...baseConfig, tmdbApiKey: "testkey" };
  app = Fastify();
  registerMetadataRoutes(app, db, cfg);
  await app.ready();
  vi.mocked(searchMovie).mockResolvedValue([]);
});

afterEach(async () => {
  await app.close();
  db.close();
  vi.restoreAllMocks();
});

const hdr = () => ({ authorization: `Bearer ${adminToken}` });

async function waitForIdle(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({
      method: "GET",
      url: "/admin/metadata/scan/status",
      headers: hdr(),
    });
    const s = res.json();
    if (!s.inProgress) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("POST /admin/metadata/scan", () => {
  it("202s immediately, re-classifies junk titles, and reports progress", async () => {
    const id = seedMovie(
      "720P BRRIP XVID AC3-MAJESTIC",
      "/m/300.2006.720P.BRRIP.XViD.AC3-MAJESTIC.avi",
      null,
    );
    vi.mocked(searchMovie).mockResolvedValue([
      {
        id: 999,
        title: "300",
        original_title: "300",
        release_date: "2006-12-09",
        overview: "Overview",
        poster_path: "/poster.jpg",
        backdrop_path: "/backdrop.jpg",
        vote_average: 7.5,
        genre_ids: [28],
      },
    ]);
    vi.mocked(getMovieDetail).mockResolvedValue({
      id: 999,
      title: "300",
      overview: "Spartans.",
      release_date: "2006-12-09",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
      vote_average: 7.5,
      genres: [{ id: 28, name: "Action" }],
      runtime: 117,
    });

    const res = await app.inject({
      method: "POST",
      url: "/admin/metadata/scan",
      headers: hdr(),
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ total: 1, status: "running" });

    const final = await waitForIdle();
    expect(final.matched).toBe(1);
    expect(final.done).toBe(1);

    const row = db
      .prepare("SELECT title, year, poster_path FROM media_items WHERE id = ?")
      .get(id) as { title: string; year: number; poster_path: string };
    expect(row.title).toBe("300"); // re-classified from the file path
    expect(row.year).toBe(2006);
    expect(row.poster_path).toContain("/poster.jpg");
    // TMDb was searched with the CLEANED title, not the junk one
    expect(vi.mocked(searchMovie).mock.calls[0][0]).toBe("300");
  });

  it("does not re-classify already-matched items", async () => {
    const id = seedMovie(
      "Curated Title",
      "/m/Some.Junk.Name.1080p.BluRay.mkv",
      "https://image.tmdb.org/t/p/w500/existing.jpg",
    );
    await app.inject({
      method: "POST",
      url: "/admin/metadata/scan",
      headers: hdr(),
      payload: {},
    });
    await waitForIdle();
    const row = db
      .prepare("SELECT title FROM media_items WHERE id = ?")
      .get(id) as { title: string };
    expect(row.title).toBe("Curated Title");
  });

  it("409s while a scan is running", async () => {
    // Several items × 300ms throttle keeps the run alive during the 2nd POST.
    for (let i = 0; i < 4; i++) seedMovie(`t${i}`, `/m/t${i}.mkv`, null);
    const first = await app.inject({
      method: "POST",
      url: "/admin/metadata/scan",
      headers: hdr(),
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({
      method: "POST",
      url: "/admin/metadata/scan",
      headers: hdr(),
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    await waitForIdle();
  });

  it("incremental scan skips already-matched items", async () => {
    // One matched (has poster) + one new (no poster).
    seedMovie("Matched", "/m/matched.mkv", "https://img/existing.jpg");
    const fresh = seedMovie("New Item", "/m/new.mkv", null);
    vi.mocked(searchMovie).mockResolvedValue([]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/metadata/scan",
      headers: hdr(),
      payload: {},
    });
    // Only the unmatched item is enqueued — the matched one isn't re-walked.
    expect(res.json().total).toBe(1);
    await waitForIdle();
    // The new item now carries a remembered no-match, so a second incremental
    // run enqueues nothing at all.
    const again = await app.inject({
      method: "POST",
      url: "/admin/metadata/scan",
      headers: hdr(),
      payload: {},
    });
    expect(again.json().total).toBe(0);
    await waitForIdle();
    void fresh;
  });

  it("full=true re-scans every item regardless of match state", async () => {
    seedMovie("Matched", "/m/matched.mkv", "https://img/existing.jpg");
    seedMovie("New Item", "/m/new.mkv", null);
    vi.mocked(searchMovie).mockResolvedValue([]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/metadata/scan",
      headers: hdr(),
      payload: { full: true },
    });
    expect(res.json().total).toBe(2);
    await waitForIdle();
  });

  it("503s without a TMDb key and requires admin", async () => {
    const keyless = Fastify();
    const kdb = new Database(":memory:");
    kdb.pragma("foreign_keys = ON");
    initSchema(kdb);
    kdb
      .prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')",
      )
      .run();
    registerMetadataRoutes(keyless, kdb, {
      ...baseConfig,
      tmdbApiKey: "",
    });
    await keyless.ready();
    const res = await keyless.inject({
      method: "POST",
      url: "/admin/metadata/scan",
      headers: hdr(),
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    await keyless.close();
    kdb.close();
  });
});
