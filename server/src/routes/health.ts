import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware } from "../auth/middleware.js";
import { adminOnly } from "../auth/middleware.js";
import {
  generateHealthReport,
  getMissingFiles,
  cleanupOrphaned,
} from "../ai/health.js";
import { readAppVersion } from "../version.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config, db);
  const appVersion = readAppVersion();

  // GET /api/info — public device-discovery endpoint (no auth required).
  // TV apps and remote clients use this to identify the server before login.
  app.get("/api/info", async () => ({
    name: config.serverName,
    version: appVersion,
    publicUrl: config.publicUrl,
    fingerprint: config.serverFingerprint,
    capabilities: ["hls", "subtitles", "playlists", "federation"],
  }));

  // GET /version — the running app version (any logged-in user; shown in
  // Settings). Read once at registration, not per request.
  app.get("/version", { preHandler: auth }, async () => ({
    version: appVersion,
  }));

  // GET /admin/health — Full health report
  app.get("/admin/health", { preHandler: [auth, adminOnly] }, async () => {
    return generateHealthReport(db);
  });

  // GET /admin/health/missing — Missing files list
  app.get(
    "/admin/health/missing",
    { preHandler: [auth, adminOnly] },
    async () => {
      return getMissingFiles(db);
    },
  );

  // POST /admin/health/cleanup — Remove orphaned entries
  app.post(
    "/admin/health/cleanup",
    { preHandler: [auth, adminOnly] },
    async () => {
      return cleanupOrphaned(db);
    },
  );
}
