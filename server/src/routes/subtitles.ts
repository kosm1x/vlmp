import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { resolve } from "node:path";
import { createReadStream, existsSync } from "node:fs";
import type { Config } from "../config.js";
import { authMiddleware, adminOnly } from "../auth/middleware.js";
import {
  generateSubtitleToken,
  validateSubtitleToken,
} from "../subtitles/tokens.js";
import {
  getSubtitlesForMedia,
  persistSubtitles,
  type Subtitle,
} from "../subtitles/service.js";
import { extractSubtitles } from "../subtitles/extract.js";
import { probeFile } from "../scanner/probe.js";
import { isMediaFolderVisible } from "../media/library.js";
import { isPathInside } from "../paths.js";
import { parseIntParam } from "./params.js";

export function registerSubtitleRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config, db);

  // Subtitle content follows the library gate: a non-admin must not read the
  // dialogue of a title in a hidden library (media ids are enumerable). Gating
  // the list + token routes is sufficient — /file requires a token minted here.
  app.get<{ Params: { mediaId: string } }>(
    "/subtitles/:mediaId",
    { preHandler: auth },
    async (request, reply) => {
      const mediaId = parseIntParam(request.params.mediaId, "mediaId");
      if (request.user!.role !== "admin" && !isMediaFolderVisible(db, mediaId))
        return reply.code(404).send({ error: "Not found" });
      return getSubtitlesForMedia(db, mediaId);
    },
  );

  // Generate a short-lived HMAC token for subtitle file access
  app.get<{ Params: { mediaId: string; subtitleId: string } }>(
    "/subtitles/:mediaId/:subtitleId/token",
    { preHandler: auth },
    async (request, reply) => {
      const mediaId = parseIntParam(request.params.mediaId, "mediaId");
      const subtitleId = parseIntParam(request.params.subtitleId, "subtitleId");
      // The token binds (subtitleId, mediaId), but that binding is only
      // meaningful if the subtitle actually belongs to that media — otherwise a
      // non-admin pairs a visible mediaId with a hidden title's subtitleId.
      const sub = db
        .prepare("SELECT media_id FROM subtitles WHERE id = ?")
        .get(subtitleId) as { media_id: number } | undefined;
      if (!sub || sub.media_id !== mediaId)
        return reply.code(404).send({ error: "Not found" });
      if (request.user!.role !== "admin" && !isMediaFolderVisible(db, mediaId))
        return reply.code(404).send({ error: "Not found" });
      return generateSubtitleToken(
        config.jwtSecret,
        request.params.subtitleId,
        request.params.mediaId,
      );
    },
  );

  // Serve subtitle file using HMAC token (no JWT in URL)
  app.get<{
    Params: { mediaId: string; subtitleId: string };
    Querystring: { token?: string };
  }>("/subtitles/:mediaId/:subtitleId/file", async (request, reply) => {
    const token = request.query.token;
    if (!token) return reply.code(401).send({ error: "Unauthorized" });
    const valid = validateSubtitleToken(
      config.jwtSecret,
      request.params.subtitleId,
      request.params.mediaId,
      token,
    );
    if (!valid)
      return reply.code(401).send({ error: "Invalid or expired token" });
    const subtitleId = parseIntParam(request.params.subtitleId, "subtitleId");
    const mediaId = parseIntParam(request.params.mediaId, "mediaId");
    const sub = db
      .prepare("SELECT * FROM subtitles WHERE id = ?")
      .get(subtitleId) as Subtitle | undefined;
    // Make the token's mediaId binding load-bearing: the served subtitle must
    // belong to the media the token was issued for.
    if (!sub || sub.media_id !== mediaId)
      return reply.code(404).send({ error: "Subtitle not found" });

    // Path traversal protection (separator/case-robust; a bare startsWith
    // also matched sibling dirs sharing the subtitleDir prefix)
    const normalizedPath = resolve(sub.file_path);
    if (!isPathInside(config.subtitleDir, normalizedPath)) {
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
      const mediaId = parseIntParam(request.params.mediaId, "mediaId");
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
