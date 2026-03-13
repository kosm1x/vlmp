import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createReadStream, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import type { Config } from "../config.js";
import { federationAuth } from "../federation/middleware.js";
import {
  browseLibrary,
  getMediaItem,
  getTVShows,
  getTVShowDetail,
} from "../media/library.js";
import { stripSensitiveFields } from "../federation/proxy.js";
import { canDirectPlay, serveDirectFile } from "../streaming/direct.js";
import {
  getAvailableProfiles,
  generateMasterPlaylist,
} from "../streaming/adaptive.js";
import {
  createSession,
  getSession,
  startProfileTranscode,
  destroySession,
} from "../streaming/session.js";
import { waitForPlaylist, waitForSegment } from "../streaming/transcoder.js";

export function registerFederationApiRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const hmac = federationAuth(db);

  // Browse library (stripped)
  app.get<{
    Querystring: {
      type?: string;
      category?: string;
      limit?: string;
      offset?: string;
      search?: string;
    };
  }>("/federation/api/library", { preHandler: hmac }, async (request) => {
    const { type, category, limit, offset, search } = request.query;
    const result = browseLibrary(db, {
      type,
      category,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      search,
    });
    return {
      items: (result.items || []).map((i) =>
        stripSensitiveFields(
          i as unknown as Record<string, unknown>,
          0,
          config.serverName,
        ),
      ),
      total: result.total,
    };
  });

  // Media detail (stripped)
  app.get<{ Params: { id: string } }>(
    "/federation/api/media/:id",
    { preHandler: hmac },
    async (request, reply) => {
      const item = getMediaItem(db, parseInt(request.params.id, 10));
      if (!item) return reply.code(404).send({ error: "Not found" });
      return stripSensitiveFields(
        item as unknown as Record<string, unknown>,
        0,
        config.serverName,
      );
    },
  );

  // TV shows list
  app.get("/federation/api/tv/shows", { preHandler: hmac }, async () => {
    return getTVShows(db);
  });

  // TV show detail
  app.get<{ Params: { id: string } }>(
    "/federation/api/tv/shows/:id",
    { preHandler: hmac },
    async (request, reply) => {
      const result = getTVShowDetail(db, parseInt(request.params.id, 10));
      if (!result) return reply.code(404).send({ error: "Show not found" });
      return result;
    },
  );

  // Heartbeat endpoint
  app.post("/federation/heartbeat", { preHandler: hmac }, async () => {
    return { ok: true, name: config.serverName };
  });

  // --- Stream API (exposed to other servers) ---

  interface MediaRow {
    id: number;
    file_path: string;
    codec_video: string | null;
    codec_audio: string | null;
    resolution_width: number | null;
    resolution_height: number | null;
    duration: number | null;
    audio_tracks: string | null;
  }

  function getMediaById(id: number): MediaRow | undefined {
    return db
      .prepare(
        "SELECT id, file_path, codec_video, codec_audio, resolution_width, resolution_height, duration, audio_tracks FROM media_items WHERE id = ?",
      )
      .get(id) as MediaRow | undefined;
  }

  // Start stream (HMAC auth)
  app.post<{
    Params: { id: string };
    Body: { start_time?: number; audio_track?: number };
  }>(
    "/federation/api/stream/:id/start",
    { preHandler: hmac },
    async (request, reply) => {
      const mediaId = parseInt(request.params.id, 10);
      const media = getMediaById(mediaId);
      if (!media) return reply.code(404).send({ error: "Media not found" });
      if (!existsSync(media.file_path))
        return reply.code(404).send({ error: "Media file not found on disk" });
      const ext = extname(media.file_path).toLowerCase();
      const direct = canDirectPlay(media.codec_video, media.codec_audio, ext);
      const profiles = direct
        ? []
        : getAvailableProfiles(media.resolution_width, media.resolution_height);
      const session = createSession(
        mediaId,
        media.file_path,
        "federation",
        profiles,
        direct,
      );
      if (direct) {
        return reply.send({
          session_id: session.id,
          mode: "direct",
          url: `/federation/api/stream/${session.id}/direct`,
          duration: media.duration,
          audio_tracks: media.audio_tracks
            ? JSON.parse(media.audio_tracks)
            : [],
        });
      }
      for (const profile of profiles) {
        startProfileTranscode(session, profile.name, config, {
          startTime: request.body?.start_time,
          audioTrack: request.body?.audio_track,
        });
      }
      return reply.send({
        session_id: session.id,
        mode: "hls",
        url: `/federation/api/stream/${session.id}/master.m3u8`,
        profiles: profiles.map((p) => p.name),
        duration: media.duration,
        audio_tracks: media.audio_tracks ? JSON.parse(media.audio_tracks) : [],
      });
    },
  );

  // Serve HLS master playlist
  app.get<{ Params: { sessionId: string } }>(
    "/federation/api/stream/:sessionId/master.m3u8",
    { preHandler: hmac },
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .send(generateMasterPlaylist(session.profiles, session.id));
    },
  );

  // Serve profile playlist
  app.get<{ Params: { sessionId: string; profile: string } }>(
    "/federation/api/stream/:sessionId/:profile/playlist.m3u8",
    { preHandler: hmac },
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const job = session.jobs.get(request.params.profile);
      if (!job) return reply.code(404).send({ error: "Profile not found" });
      try {
        await waitForPlaylist(job.outputDir);
      } catch {
        return reply.code(503).send({ error: "Playlist not ready yet" });
      }
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .send(createReadStream(join(job.outputDir, "playlist.m3u8")));
    },
  );

  // Serve segment
  app.get<{
    Params: { sessionId: string; profile: string; segment: string };
  }>(
    "/federation/api/stream/:sessionId/:profile/:segment",
    { preHandler: hmac },
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const job = session.jobs.get(request.params.profile);
      if (!job) return reply.code(404).send({ error: "Profile not found" });
      const SEGMENT_PATTERN = /^segment_\d{4}\.ts$/;
      if (!SEGMENT_PATTERN.test(request.params.segment)) {
        return reply.code(400).send({ error: "Invalid segment name" });
      }
      const segmentPath = join(job.outputDir, request.params.segment);
      if (!resolve(segmentPath).startsWith(resolve(job.outputDir))) {
        return reply.code(400).send({ error: "Invalid segment path" });
      }
      if (!existsSync(segmentPath)) {
        try {
          await waitForSegment(job.outputDir, request.params.segment);
        } catch {
          return reply.code(404).send({ error: "Segment not available" });
        }
      }
      return reply
        .header("Content-Type", "video/mp2t")
        .send(createReadStream(segmentPath));
    },
  );

  // Direct play
  app.get<{ Params: { sessionId: string } }>(
    "/federation/api/stream/:sessionId/direct",
    { preHandler: hmac },
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session || !session.directPlay)
        return reply
          .code(404)
          .send({ error: "Session not found or not direct play" });
      serveDirectFile(session.filePath, request, reply);
    },
  );

  // Stop stream
  app.delete<{ Params: { sessionId: string } }>(
    "/federation/api/stream/:sessionId",
    { preHandler: hmac },
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      destroySession(request.params.sessionId);
      return reply.code(204).send();
    },
  );
}
