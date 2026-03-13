import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware, adminOnly } from "../auth/middleware.js";
import { searchMovie, searchTV } from "../metadata/tmdb.js";
import {
  matchAndApplyMetadata,
  matchAndApplyShowMetadata,
  applyManualMatch,
} from "../metadata/matcher.js";

export function registerMetadataRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

  app.get<{ Querystring: { q: string; type?: string; year?: string } }>(
    "/metadata/search",
    { preHandler: auth },
    async (request, reply) => {
      const { q, type, year } = request.query;
      if (!q)
        return reply.code(400).send({ error: 'Query parameter "q" required' });
      if (!config.tmdbApiKey)
        return reply.code(503).send({ error: "TMDb API key not configured" });
      const yearNum = year ? parseInt(year, 10) : null;
      const results =
        type === "tv"
          ? await searchTV(q, yearNum, config.tmdbApiKey)
          : await searchMovie(q, yearNum, config.tmdbApiKey);
      return { results };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { tmdb_id?: number; media_type?: "movie" | "tv" };
  }>(
    "/admin/metadata/:id/match",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const mediaId = parseInt(request.params.id, 10);
      if (!config.tmdbApiKey)
        return reply.code(503).send({ error: "TMDb API key not configured" });
      const { tmdb_id, media_type } = request.body || {};
      let matched: boolean;
      if (tmdb_id && media_type) {
        matched = await applyManualMatch(
          db,
          mediaId,
          tmdb_id,
          media_type,
          config,
        );
      } else {
        matched = await matchAndApplyMetadata(db, mediaId, config);
      }
      return { matched, media_id: mediaId };
    },
  );

  app.post<{ Body: { folder_id?: number } }>(
    "/admin/metadata/scan",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      if (!config.tmdbApiKey)
        return reply.code(503).send({ error: "TMDb API key not configured" });
      const { folder_id } = request.body || {};
      const condition = folder_id ? "WHERE library_folder_id = ?" : "";
      const params = folder_id ? [folder_id] : [];
      const items = db
        .prepare(`SELECT id FROM media_items ${condition}`)
        .all(...params) as { id: number }[];
      let matched = 0;
      let failed = 0;
      for (const item of items) {
        try {
          const result = await matchAndApplyMetadata(db, item.id, config);
          if (result) matched++;
          // Throttle: 300ms between requests (respects TMDb ~40 req/10s limit)
          await new Promise((r) => setTimeout(r, 300));
        } catch {
          failed++;
        }
      }
      return { total: items.length, matched, failed };
    },
  );

  app.post<{ Params: { showId: string } }>(
    "/admin/metadata/tv/:showId/match",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const showId = parseInt(request.params.showId, 10);
      if (!config.tmdbApiKey)
        return reply.code(503).send({ error: "TMDb API key not configured" });
      const matched = await matchAndApplyShowMetadata(db, showId, config);
      return { matched, show_id: showId };
    },
  );
}
