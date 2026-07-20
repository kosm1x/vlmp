// Scanner hardening: interrupted scans reset at boot, scans run in the
// background behind an atomic claim (409 on double-start), ffprobe can't hang
// a scan forever, and scan-time subtitle extraction is opt-in (it demuxes
// whole files and pins the media drive for the entire scan).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import { resetInterruptedScans } from "../src/media/library.js";
import { registerLibraryRoutes } from "../src/routes/library.js";
import { probeFile } from "../src/scanner/probe.js";
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
  vi.restoreAllMocks();
});

function addFolder(path: string, scanStatus = "pending") {
  return db
    .prepare(
      "INSERT INTO library_folders (path, category, scan_status) VALUES (?, 'movies', ?) RETURNING id",
    )
    .get(path, scanStatus) as { id: number };
}

describe("resetInterruptedScans", () => {
  it("flips 'scanning' folders to 'error' and leaves the rest alone", () => {
    addFolder("/a", "scanning");
    addFolder("/b", "complete");
    addFolder("/c", "pending");
    expect(resetInterruptedScans(db)).toBe(1);
    const statuses = db
      .prepare("SELECT path, scan_status FROM library_folders ORDER BY path")
      .all() as { path: string; scan_status: string }[];
    expect(statuses.map((s) => s.scan_status)).toEqual([
      "error",
      "complete",
      "pending",
    ]);
  });

  it("is a no-op when nothing was interrupted", () => {
    addFolder("/a", "complete");
    expect(resetInterruptedScans(db)).toBe(0);
  });
});

describe("scan route — background + claim", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let scanDir: string;

  beforeEach(async () => {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')",
    ).run();
    adminToken = await issueToken(
      { sub: "1", username: "admin", role: "admin" },
      config,
    );
    scanDir = mkdtempSync(join(tmpdir(), "vlmp-scan-"));
    app = Fastify();
    registerLibraryRoutes(app, db, config);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(scanDir, { recursive: true, force: true });
  });

  async function waitForStatus(folderId: number, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = db
        .prepare("SELECT scan_status FROM library_folders WHERE id = ?")
        .get(folderId) as { scan_status: string } | undefined;
      if (
        row &&
        row.scan_status !== "scanning" &&
        row.scan_status !== "pending"
      )
        return row.scan_status;
      if (Date.now() > deadline) return row?.scan_status ?? "missing";
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("returns 202 immediately and completes the scan in the background", async () => {
    const folder = addFolder(scanDir);
    const res = await app.inject({
      method: "POST",
      url: `/admin/folders/${folder.id}/scan`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ folder_id: folder.id, status: "scanning" });
    // Empty dir scans to completion quickly.
    expect(await waitForStatus(folder.id)).toBe("complete");
  });

  it("rejects a second scan of a folder already scanning with 409", async () => {
    const folder = addFolder(scanDir, "scanning");
    const res = await app.inject({
      method: "POST",
      url: `/admin/folders/${folder.id}/scan`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it("records 'error' when the folder path is unreadable", async () => {
    const folder = addFolder(join(scanDir, "does-not-exist"));
    const res = await app.inject({
      method: "POST",
      url: `/admin/folders/${folder.id}/scan`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(202);
    expect(await waitForStatus(folder.id)).toBe("error");
  });

  it("rejects adding a folder whose path does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/folders",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: join(scanDir, "nope"), category: "movies" },
    });
    expect(res.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: "/admin/folders",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: scanDir, category: "movies" },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("404s on a nonexistent folder id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/folders/9999/scan",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("ffprobe timeout", () => {
  // A stub "ffprobe" that never exits — POSIX-only; the timeout logic itself
  // is platform-independent.
  it.skipIf(process.platform === "win32")(
    "kills a stalled ffprobe and rejects instead of hanging the scan",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "vlmp-probe-"));
      const stub = join(dir, "fake-ffprobe.sh");
      writeFileSync(stub, "#!/bin/sh\nsleep 30\n");
      chmodSync(stub, 0o755);
      try {
        const cfg = { ...config, ffprobePath: stub, ffprobeTimeoutMs: 200 };
        await expect(probeFile("/dev/null", cfg)).rejects.toThrow(/timed out/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("scan-time subtitle extraction config", () => {
  const saved = process.env.VLMP_EXTRACT_SUBS_ON_SCAN;
  afterEach(() => {
    if (saved === undefined) delete process.env.VLMP_EXTRACT_SUBS_ON_SCAN;
    else process.env.VLMP_EXTRACT_SUBS_ON_SCAN = saved;
  });

  it("defaults OFF and only 'true' opts in", () => {
    delete process.env.VLMP_EXTRACT_SUBS_ON_SCAN;
    expect(loadConfig().extractSubsOnScan).toBe(false);
    process.env.VLMP_EXTRACT_SUBS_ON_SCAN = "true";
    expect(loadConfig().extractSubsOnScan).toBe(true);
    process.env.VLMP_EXTRACT_SUBS_ON_SCAN = "1";
    expect(loadConfig().extractSubsOnScan).toBe(false);
  });

  it("ffprobe timeout is configurable with a sane default", () => {
    expect(loadConfig().ffprobeTimeoutMs).toBe(30000);
    process.env.VLMP_FFPROBE_TIMEOUT_MS = "5000";
    expect(loadConfig().ffprobeTimeoutMs).toBe(5000);
    delete process.env.VLMP_FFPROBE_TIMEOUT_MS;
  });
});
