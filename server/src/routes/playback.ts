import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createReadStream, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import type { Config } from "../config.js";
import { authMiddleware } from "../auth/middleware.js";
import { validateGuestPass } from "../auth/guest.js";
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
  getActiveSessions,
} from "../streaming/session.js";
import { waitForPlaylist, waitForSegment } from "../streaming/transcoder.js";

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

export function registerPlaybackRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

  app.post<{
    Params: { id: string };
    Body: {
      bandwidth_kbps?: number;
      start_time?: number;
      audio_track?: number;
    };
  }>("/stream/:id/start", { preHandler: auth }, async (request, reply) => {
    const mediaId = parseInt(request.params.id, 10);
    const media = getMediaById(db, mediaId);
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
      request.user!.sub,
      profiles,
      direct,
    );
    if (direct)
      return reply.send({
        session_id: session.id,
        mode: "direct",
        url: `/stream/${session.id}/direct`,
        duration: media.duration,
        audio_tracks: media.audio_tracks ? JSON.parse(media.audio_tracks) : [],
      });
    for (const profile of profiles)
      startProfileTranscode(session, profile.name, config, {
        startTime: request.body.start_time,
        audioTrack: request.body.audio_track,
      });
    return reply.send({
      session_id: session.id,
      mode: "transcode",
      url: `/stream/${session.id}/master.m3u8`,
      profiles: profiles.map((p) => p.name),
      duration: media.duration,
      audio_tracks: media.audio_tracks ? JSON.parse(media.audio_tracks) : [],
    });
  });

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
      const session = createSession(
        result.mediaId,
        media.file_path,
        "guest",
        profiles,
        direct,
      );
      if (direct)
        return reply.send({
          session_id: session.id,
          mode: "direct",
          url: `/stream/${session.id}/direct`,
        });
      for (const profile of profiles)
        startProfileTranscode(session, profile.name, config);
      return reply.send({
        session_id: session.id,
        mode: "transcode",
        url: `/stream/${session.id}/master.m3u8`,
        profiles: profiles.map((p) => p.name),
      });
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/stream/:sessionId/master.m3u8",
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .send(generateMasterPlaylist(session.profiles, session.id));
    },
  );

  app.get<{ Params: { sessionId: string; profile: string } }>(
    "/stream/:sessionId/:profile/playlist.m3u8",
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

  app.get<{ Params: { sessionId: string; profile: string; segment: string } }>(
    "/stream/:sessionId/:profile/:segment",
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

  app.get<{ Params: { sessionId: string } }>(
    "/stream/:sessionId/direct",
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session || !session.directPlay)
        return reply
          .code(404)
          .send({ error: "Session not found or not direct play" });
      serveDirectFile(session.filePath, request, reply);
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/stream/:sessionId",
    { preHandler: auth },
    async (request, reply) => {
      const session = getSession(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (session.userId !== "guest" && session.userId !== request.user!.sub) {
        return reply.code(403).send({ error: "Not your session" });
      }
      destroySession(request.params.sessionId);
      return reply.code(204).send();
    },
  );

  app.get("/stream/sessions", { preHandler: auth }, async () => {
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
