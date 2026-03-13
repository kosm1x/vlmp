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

export function registerHealthRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

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
