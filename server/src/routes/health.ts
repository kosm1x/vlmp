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
import { createHash } from "node:crypto";

export function registerHealthRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config, db);
  const appVersion = readAppVersion();

  // Public device-discovery identity. Expose a SHA-256-derived short ID, never
  // the raw serverFingerprint: the fingerprint is the private federation
  // identity (stored 0600 in server.key, sent as X-VLMP-Server-Id), so keeping
  // it off this anonymous endpoint removes any impersonation footgun if the
  // federation path ever trusts the Server-Id alone. Stable per server, so
  // clients can still recognize the same box across sessions.
  const publicServerId =
    "vlmp-" +
    createHash("sha256")
      .update(config.serverFingerprint)
      .digest("hex")
      .slice(0, 6);

  // Capabilities are derived from live config, not a hardcoded literal, so the
  // discovery contract can't drift from reality. hls/subtitles/playlists/
  // federation are always available (subtitles via embedded extraction + local
  // tracks regardless of key); online subtitle search needs an OpenSubtitles key.
  const capabilities = ["hls", "subtitles", "playlists", "federation"];
  if (config.opensubtitlesApiKey) capabilities.push("subtitle-search");

  // GET /api/info — public device-discovery endpoint (no auth required).
  // TV apps and remote clients use this to identify the server before login.
  app.get("/api/info", async () => ({
    name: config.serverName,
    version: appVersion,
    publicUrl: config.publicUrl,
    fingerprint: publicServerId,
    capabilities,
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
