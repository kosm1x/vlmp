import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  getRecommendations,
  getSimilarItems,
  invalidateRecommendationCache,
  type ScoredItem,
} from "../ai/recommender.js";
import {
  setPreference,
  removePreference,
  getUserPreferences,
} from "../ai/preferences.js";

interface MediaDetails {
  id: number;
  title: string;
  type: string;
  poster_path: string | null;
  backdrop_path: string | null;
  year: number | null;
  rating: number | null;
  genres: string | null;
  duration: number | null;
  description: string | null;
}

function enrichWithMediaDetails(
  db: Database.Database,
  items: ScoredItem[],
): (ScoredItem & Partial<MediaDetails>)[] {
  if (items.length === 0) return [];
  const placeholders = items.map(() => "?").join(",");
  const ids = items.map((i) => i.media_id);
  const mediaRows = db
    .prepare(
      `SELECT id, title, type, poster_path, backdrop_path, year, rating, genres, duration, description
       FROM media_items WHERE id IN (${placeholders})`,
    )
    .all(...ids) as MediaDetails[];

  const mediaMap = new Map(mediaRows.map((m) => [m.id, m]));
  return items
    .map((item) => {
      const media = mediaMap.get(item.media_id);
      if (!media) return null;
      return { ...item, ...media };
    })
    .filter(Boolean) as (ScoredItem & MediaDetails)[];
}

export function registerRecommendationRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

  // GET /recommendations
  app.get<{ Querystring: { limit?: string } }>(
    "/recommendations",
    { preHandler: auth },
    async (request) => {
      const userId = parseInt(request.user!.sub, 10);
      const limit = Math.min(parseInt(request.query.limit || "20", 10), 100);
      const result = getRecommendations(db, userId, limit);
      const enriched = enrichWithMediaDetails(db, result.items);
      return {
        items: enriched,
        strategies_used: result.strategies_used,
        computed_at: result.computed_at,
      };
    },
  );

  // POST /recommendations/refresh
  app.post(
    "/recommendations/refresh",
    { preHandler: auth },
    async (request) => {
      const userId = parseInt(request.user!.sub, 10);
      invalidateRecommendationCache(db, userId);
      const result = getRecommendations(db, userId);
      const enriched = enrichWithMediaDetails(db, result.items);
      return {
        items: enriched,
        strategies_used: result.strategies_used,
        computed_at: result.computed_at,
      };
    },
  );

  // GET /recommendations/similar/:mediaId
  app.get<{ Params: { mediaId: string }; Querystring: { limit?: string } }>(
    "/recommendations/similar/:mediaId",
    { preHandler: auth },
    async (request) => {
      const mediaId = parseInt(request.params.mediaId, 10);
      const limit = Math.min(parseInt(request.query.limit || "10", 10), 50);
      const items = getSimilarItems(db, mediaId, limit);
      const enriched = enrichWithMediaDetails(db, items);
      return { items: enriched };
    },
  );

  // POST /preferences/:mediaId
  app.post<{
    Params: { mediaId: string };
    Body: { action: "like" | "dislike" };
  }>(
    "/preferences/:mediaId",
    {
      schema: {
        body: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["like", "dislike"] },
          },
          additionalProperties: false,
        },
      },
      preHandler: auth,
    },
    async (request) => {
      const userId = parseInt(request.user!.sub, 10);
      const mediaId = parseInt(request.params.mediaId, 10);
      setPreference(db, userId, mediaId, request.body.action);
      invalidateRecommendationCache(db, userId);
      return { ok: true };
    },
  );

  // DELETE /preferences/:mediaId
  app.delete<{ Params: { mediaId: string } }>(
    "/preferences/:mediaId",
    { preHandler: auth },
    async (request) => {
      const userId = parseInt(request.user!.sub, 10);
      const mediaId = parseInt(request.params.mediaId, 10);
      const removed = removePreference(db, userId, mediaId);
      if (removed) invalidateRecommendationCache(db, userId);
      return { ok: true, removed };
    },
  );

  // GET /preferences
  app.get("/preferences", { preHandler: auth }, async (request) => {
    const userId = parseInt(request.user!.sub, 10);
    return getUserPreferences(db, userId);
  });
}
