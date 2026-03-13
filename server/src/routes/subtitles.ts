import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { resolve } from "node:path";
import { createReadStream, existsSync } from "node:fs";
import type { Config } from "../config.js";
import { authMiddleware, adminOnly } from "../auth/middleware.js";
import { verifyToken } from "../auth/jwt.js";
import {
  getSubtitlesForMedia,
  persistSubtitles,
  type Subtitle,
} from "../subtitles/service.js";
import { extractSubtitles } from "../subtitles/extract.js";
import { probeFile } from "../scanner/probe.js";

export function registerSubtitleRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

  app.get<{ Params: { mediaId: string } }>(
    "/subtitles/:mediaId",
    { preHandler: auth },
    async (request) => {
      const mediaId = parseInt(request.params.mediaId, 10);
      return getSubtitlesForMedia(db, mediaId);
    },
  );

  app.get<{
    Params: { mediaId: string; subtitleId: string };
    Querystring: { token?: string };
  }>("/subtitles/:mediaId/:subtitleId/file", async (request, reply) => {
    // Auth via header OR query param (for <track> elements that can't set headers)
    const token =
      request.headers.authorization?.replace("Bearer ", "") ||
      request.query.token;
    if (!token) return reply.code(401).send({ error: "Unauthorized" });
    try {
      await verifyToken(token, config);
    } catch {
      return reply.code(401).send({ error: "Invalid token" });
    }
    const subtitleId = parseInt(request.params.subtitleId, 10);
    const sub = db
      .prepare("SELECT * FROM subtitles WHERE id = ?")
      .get(subtitleId) as Subtitle | undefined;
    if (!sub) return reply.code(404).send({ error: "Subtitle not found" });

    // Path traversal protection
    const normalizedPath = resolve(sub.file_path);
    if (!normalizedPath.startsWith(config.subtitleDir)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (!existsSync(normalizedPath)) {
      return reply.code(404).send({ error: "Subtitle file not found" });
    }

    reply.header("Content-Type", "text/vtt; charset=utf-8");
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.send(createReadStream(normalizedPath));
  });

  app.post<{ Params: { mediaId: string } }>(
    "/admin/subtitles/:mediaId/extract",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const mediaId = parseInt(request.params.mediaId, 10);
      const media = db
        .prepare("SELECT file_path FROM media_items WHERE id = ?")
        .get(mediaId) as { file_path: string } | undefined;
      if (!media) return reply.code(404).send({ error: "Media not found" });

      const probe = await probeFile(media.file_path, config);
      if (probe.subtitleTracks.length === 0) {
        return { extracted: 0, message: "No subtitle tracks found" };
      }

      const extracted = await extractSubtitles(
        media.file_path,
        mediaId,
        probe.subtitleTracks,
        config,
      );
      persistSubtitles(db, mediaId, extracted);
      return { extracted: extracted.length };
    },
  );
}
