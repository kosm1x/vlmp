import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware } from "../auth/middleware.js";

export function registerProgressRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

  app.get<{ Params: { mediaId: string } }>(
    "/progress/:mediaId",
    { preHandler: auth },
    async (request) => {
      const userId = parseInt(request.user!.sub, 10);
      const mediaId = parseInt(request.params.mediaId, 10);
      const progress = db
        .prepare(
          "SELECT * FROM watch_progress WHERE user_id = ? AND media_id = ?",
        )
        .get(userId, mediaId);
      return progress || { position_seconds: 0, completed: false };
    },
  );

  app.put<{
    Params: { mediaId: string };
    Body: { position_seconds: number; duration_seconds?: number };
  }>(
    "/progress/:mediaId",
    {
      schema: {
        body: {
          type: "object",
          required: ["position_seconds"],
          properties: {
            position_seconds: { type: "number", minimum: 0 },
            duration_seconds: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler: auth,
    },
    async (request, reply) => {
      const userId = parseInt(request.user!.sub, 10);
      const mediaId = parseInt(request.params.mediaId, 10);
      const media = db
        .prepare("SELECT id FROM media_items WHERE id = ?")
        .get(mediaId);
      if (!media) return reply.code(404).send({ error: "Media not found" });
      const { position_seconds, duration_seconds } = request.body;
      const completed = duration_seconds
        ? position_seconds / duration_seconds > 0.95
          ? 1
          : 0
        : 0;
      db.prepare(
        "INSERT INTO watch_progress (user_id, media_id, position_seconds, duration_seconds, completed, updated_at) VALUES (?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(user_id, media_id) DO UPDATE SET position_seconds = excluded.position_seconds, duration_seconds = excluded.duration_seconds, completed = excluded.completed, updated_at = unixepoch()",
      ).run(
        userId,
        mediaId,
        position_seconds,
        duration_seconds || null,
        completed,
      );
      return { ok: true };
    },
  );

  app.get("/progress/continue", { preHandler: auth }, async (request) => {
    const userId = parseInt(request.user!.sub, 10);
    return db
      .prepare(
        "SELECT mi.*, wp.position_seconds, wp.duration_seconds, wp.updated_at as progress_updated FROM watch_progress wp JOIN media_items mi ON mi.id = wp.media_id WHERE wp.user_id = ? AND wp.completed = 0 AND wp.position_seconds > 0 ORDER BY wp.updated_at DESC LIMIT 20",
      )
      .all(userId);
  });
}
