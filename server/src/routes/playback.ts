import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createReadStream, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { isPathInside } from "../paths.js";
import type { Config } from "../config.js";
import { authMiddleware, adminOnly } from "../auth/middleware.js";
import { validateGuestPass } from "../auth/guest.js";
import { canDirectPlay, serveDirectFile } from "../streaming/direct.js";
import { isMediaFolderVisible } from "../media/library.js";
import {
  getAvailableProfiles,
  generateMasterPlaylist,
  generateVariantPlaylist,
} from "../streaming/adaptive.js";
import {
  createSession,
  getSession,
  startProfileTranscode,
  ensureSegmentReady,
  destroySession,
  getActiveSessions,
  hasEnoughDiskSpace,
} from "../streaming/session.js";
import { waitForPlaylist, SEGMENT_SECONDS } from "../streaming/transcoder.js";
import { parseIntParam, parseJsonColumn } from "./params.js";

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

function getMediaById(db: Database.Database, id: number): MediaRow | undefined {
  return db
    .prepare(
      "SELECT id, file_path, codec_video, codec_audio, resolution_width, resolution_height, duration, audio_tracks FROM media_items WHERE id = ?",
    )
    .get(id) as MediaRow | undefined;
}

const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;

function validateSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function registerPlaybackRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config, db);

  app.post<{
    Params: { id: string };
    Body: {
      bandwidth_kbps?: number;
      start_time?: number;
      audio_track?: number;
    };
  }>(
    "/stream/:id/start",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            start_time: { type: "number", minimum: 0 },
            audio_track: { type: "number", minimum: 0 },
            bandwidth_kbps: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler: auth,
    },
    async (request, reply) => {
      const mediaId = parseIntParam(request.params.id, "id");
      const media = getMediaById(db, mediaId);
      if (!media) return reply.code(404).send({ error: "Media not found" });
      // Access boundary: non-admins cannot stream media in a hidden library.
      if (request.user!.role !== "admin" && !isMediaFolderVisible(db, mediaId))
        return reply.code(404).send({ error: "Media not found" });
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
      // start_time stays in the accepted schema for stale cached clients but
      // is ignored: the stream timeline is absolute (synthesized VOD
      // playlist), so resume is a client-side seek, not a server offset.
      const session = createSession(
        config,
        mediaId,
        media.file_path,
        request.user!.sub,
        profiles,
        direct,
        { audioTrack: request.body.audio_track },
        media.duration,
      );
      if (!session)
        return reply
          .code(503)
          .send({ error: "Too many active streams — try again later" });
      if (direct)
        return reply.send({
          session_id: session.id,
          mode: "direct",
          url: `/stream/${session.id}/direct`,
          duration: media.duration,
          audio_tracks: parseJsonColumn(media.audio_tracks, []),
        });
      // Transcodes start lazily when a profile playlist is first requested —
      // the client only ever plays one variant, so eager-starting all of them
      // multiplies CPU and disk cost by the profile count for nothing.
      return reply.send({
        session_id: session.id,
        mode: "transcode",
        url: `/stream/${session.id}/master.m3u8`,
        profiles: profiles.map((p) => p.name),
        duration: media.duration,
        audio_tracks: parseJsonColumn(media.audio_tracks, []),
      });
    },
  );

  app.post<{ Params: { code: string }; Body: { bandwidth_kbps?: number } }>(
    "/stream/guest/:code/start",
    async (request, reply) => {
      const result = validateGuestPass(db, request.params.code);
      if (!result.valid || !result.mediaId)
        return reply.code(401).send({ error: "Invalid or expired guest pass" });
      const media = getMediaById(db, result.mediaId);
      if (!media) return reply.code(404).send({ error: "Media not found" });
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
        result.mediaId,
        media.file_path,
        "guest",
        profiles,
        direct,
        undefined,
        media.duration,
      );
      if (!session)
        return reply
          .code(503)
          .send({ error: "Too many active streams — try again later" });
      if (direct)
        return reply.send({
          session_id: session.id,
          mode: "direct",
          url: `/stream/${session.id}/direct`,
        });
      return reply.send({
        session_id: session.id,
        mode: "transcode",
        url: `/stream/${session.id}/master.m3u8`,
        profiles: profiles.map((p) => p.name),
        duration: media.duration,
      });
    },
  );

  // Touch a session so the 10-minute idle sweep spares it. VOD playlists are
  // fetched once and a paused player requests nothing, so without this ping
  // a >10-min pause would destroy the session out from under the viewer.
  // Capability model matches the other /stream/:sessionId routes (the
  // unguessable session id IS the credential).
  app.post<{ Params: { sessionId: string } }>(
    "/stream/:sessionId/keepalive",
    async (request, reply) => {
      if (!validateSessionId(request.params.sessionId))
        return reply.code(400).send({ error: "Invalid session ID format" });
      if (!getSession(request.params.sessionId))
        return reply.code(404).send({ error: "Session not found" });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/stream/:sessionId/master.m3u8",
    async (request, reply) => {
      if (!validateSessionId(request.params.sessionId))
        return reply.code(400).send({ error: "Invalid session ID format" });
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .send(generateMasterPlaylist(session.profiles));
    },
  );

  app.get<{ Params: { sessionId: string; profile: string } }>(
    "/stream/:sessionId/:profile/playlist.m3u8",
    async (request, reply) => {
      if (!validateSessionId(request.params.sessionId))
        return reply.code(400).send({ error: "Invalid session ID format" });
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (!session.profiles.some((p) => p.name === request.params.profile))
        return reply.code(404).send({ error: "Profile not found" });
      // Synthesized VOD playlist: the player sees the TRUE duration and can
      // seek anywhere; segments are encoded on demand by the segment route.
      if (session.duration && session.duration > 0)
        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .send(generateVariantPlaylist(session.duration, SEGMENT_SECONDS));
      // Legacy live path for media whose duration ffprobe couldn't read:
      // serve ffmpeg's own growing playlist (no reliable seek past frontier).
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
      // Live-playlist polling is the liveness signal on this path.
      job.lastAccessed = Date.now();
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

  app.get<{ Params: { sessionId: string; profile: string; segment: string } }>(
    "/stream/:sessionId/:profile/:segment",
    async (request, reply) => {
      if (!validateSessionId(request.params.sessionId))
        return reply.code(400).send({ error: "Invalid session ID format" });
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (!session.profiles.some((p) => p.name === request.params.profile))
        return reply.code(404).send({ error: "Profile not found" });
      const SEGMENT_PATTERN = /^segment_\d{4}\.ts$/;
      if (!SEGMENT_PATTERN.test(request.params.segment)) {
        return reply.code(400).send({ error: "Invalid segment name" });
      }
      // First segment demand for a profile spawns its encoder — gate on disk
      // space here, where the spawn actually happens (the playlist is now
      // synthetic and never starts ffmpeg).
      if (
        !session.jobs.get(request.params.profile) &&
        !(await hasEnoughDiskSpace(config))
      )
        return reply
          .code(507)
          .send({ error: "Insufficient disk space for transcoding" });
      // Paced encoders don't have the whole file ready — this waits for the
      // encoder when the segment is imminent, or spawns/restarts ffmpeg at
      // the requested position (first demand, far seek, dead job) and
      // resolves to the path.
      let readyPath: string;
      try {
        readyPath = await ensureSegmentReady(
          session,
          request.params.profile,
          request.params.segment,
          config,
        );
      } catch {
        return reply.code(404).send({ error: "Segment not available" });
      }
      const outputDir = join(
        config.transcodeTmpDir,
        session.id,
        request.params.profile,
      );
      if (!isPathInside(outputDir, readyPath)) {
        return reply.code(400).send({ error: "Invalid segment path" });
      }
      return reply
        .header("Content-Type", "video/mp2t")
        .send(createReadStream(readyPath));
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/stream/:sessionId/direct",
    async (request, reply) => {
      if (!validateSessionId(request.params.sessionId))
        return reply.code(400).send({ error: "Invalid session ID format" });
      const session = getSession(request.params.sessionId);
      if (!session || !session.directPlay)
        return reply
          .code(404)
          .send({ error: "Session not found or not direct play" });
      // Must be awaited: a floating rejection here (file deleted mid-session)
      // would escape Fastify's error handling and crash the process.
      return serveDirectFile(session.filePath, request, reply);
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/stream/:sessionId",
    { preHandler: auth },
    async (request, reply) => {
      if (!validateSessionId(request.params.sessionId))
        return reply.code(400).send({ error: "Invalid session ID format" });
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (session.userId !== "guest" && session.userId !== request.user!.sub) {
        return reply.code(404).send({ error: "Session not found" });
      }
      destroySession(request.params.sessionId);
      return reply.code(204).send();
    },
  );

  // Session IDs are capability tokens for the unauthenticated stream routes —
  // this list must never be visible to non-admin users.
  app.get("/stream/sessions", { preHandler: [auth, adminOnly] }, async () => {
    return getActiveSessions().map((s) => ({
      id: s.id,
      mediaId: s.mediaId,
      userId: s.userId,
      directPlay: s.directPlay,
      profiles: s.profiles.map((p) => p.name),
      activeJobs: Array.from(s.jobs.keys()),
      createdAt: s.createdAt,
      lastAccessed: s.lastAccessed,
    }));
  });
}
