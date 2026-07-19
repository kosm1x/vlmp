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
  hasEnoughDiskSpace,
} from "../streaming/session.js";
import { waitForPlaylist, waitForSegment } from "../streaming/transcoder.js";
import { parseIntParam, parseJsonColumn } from "./params.js";

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
      // Federation peers are a separate trust domain from local non-admin
      // users — the local visibility gate doesn't apply here.
      includeHidden: true,
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
      const item = getMediaItem(db, parseIntParam(request.params.id, "id"));
      if (!item) return reply.code(404).send({ error: "Not found" });
      return stripSensitiveFields(
        item as unknown as Record<string, unknown>,
        0,
        config.serverName,
      );
    },
  );

  // TV shows list (stripped)
  app.get("/federation/api/tv/shows", { preHandler: hmac }, async () => {
    const shows = getTVShows(db, true) as Record<string, unknown>[];
    return shows.map((s) => stripSensitiveFields(s, 0, config.serverName));
  });

  // TV show detail (stripped)
  app.get<{ Params: { id: string } }>(
    "/federation/api/tv/shows/:id",
    { preHandler: hmac },
    async (request, reply) => {
      const result = getTVShowDetail(
        db,
        parseIntParam(request.params.id, "id"),
        true, // federation peers bypass the local visibility gate
      );
      if (!result) return reply.code(404).send({ error: "Show not found" });
      const strippedShow = stripSensitiveFields(
        result.show as Record<string, unknown>,
        0,
        config.serverName,
      );
      const strippedSeasons = (result.seasons as Record<string, unknown>[]).map(
        (s) => stripSensitiveFields(s, 0, config.serverName),
      );
      return { show: strippedShow, seasons: strippedSeasons };
    },
  );

  // Heartbeat endpoint. An HMAC-verified heartbeat from a peer we marked
  // offline proves it is reachable again — reactivate it (recovers the
  // mutual-offline deadlock after a network partition).
  app.post("/federation/heartbeat", { preHandler: hmac }, async (request) => {
    const peer = request.federatedServer!;
    if (peer.status === "offline") {
      db.prepare(
        "UPDATE federated_servers SET status = 'active', last_seen = unixepoch() WHERE id = ?",
      ).run(peer.id);
    }
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
      const mediaId = parseIntParam(request.params.id, "id");
      const media = getMediaById(mediaId);
      if (!media) return reply.code(404).send({ error: "Media not found" });
      if (!existsSync(media.file_path))
        return reply.code(404).send({ error: "Media file not found on disk" });
      const ext = extname(media.file_path).toLowerCase();
      const direct = canDirectPlay(media.codec_video, media.codec_audio, ext);
      const profiles = direct
        ? []
        : getAvailableProfiles(media.resolution_width, media.resolution_height);
      if (!direct && !(await hasEnoughDiskSpace(config)))
        return reply
          .code(507)
          .send({ error: "Insufficient disk space for transcoding" });
      const session = createSession(
        config,
        mediaId,
        media.file_path,
        "federation",
        profiles,
        direct,
        {
          startTime: request.body?.start_time,
          audioTrack: request.body?.audio_track,
        },
      );
      if (!session)
        return reply
          .code(503)
          .send({ error: "Too many active streams — try again later" });
      if (direct) {
        return reply.send({
          session_id: session.id,
          mode: "direct",
          url: `/federation/api/stream/${session.id}/direct`,
          duration: media.duration,
          audio_tracks: parseJsonColumn(media.audio_tracks, []),
        });
      }
      // Transcodes start lazily on first profile-playlist request (see playback.ts).
      return reply.send({
        session_id: session.id,
        mode: "hls",
        url: `/federation/api/stream/${session.id}/master.m3u8`,
        profiles: profiles.map((p) => p.name),
        duration: media.duration,
        audio_tracks: parseJsonColumn(media.audio_tracks, []),
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
        .send(generateMasterPlaylist(session.profiles));
    },
  );

  // Serve profile playlist
  app.get<{ Params: { sessionId: string; profile: string } }>(
    "/federation/api/stream/:sessionId/:profile/playlist.m3u8",
    { preHandler: hmac },
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      let job = session.jobs.get(request.params.profile);
      if (!job) {
        if (!(await hasEnoughDiskSpace(config)))
          return reply
            .code(507)
            .send({ error: "Insufficient disk space for transcoding" });
        // Re-check after the await: a concurrent request may have started the
        // job at that yield point, and starting again would SIGTERM it.
        job =
          session.jobs.get(request.params.profile) ??
          startProfileTranscode(session, request.params.profile, config) ??
          undefined;
        if (!job) return reply.code(404).send({ error: "Profile not found" });
      }
      try {
        await waitForPlaylist(job);
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
          await waitForSegment(job, request.params.segment);
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
      // Must be awaited: a floating rejection here would crash the process.
      return serveDirectFile(session.filePath, request, reply);
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
