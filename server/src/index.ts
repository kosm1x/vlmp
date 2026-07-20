import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { loadConfig } from "./config.js";
import { parseFfmpegCaps, primeFfmpegCaps } from "./streaming/ffmpeg-caps.js";
import { getDatabase, closeDatabase } from "./db/index.js";
import { initSchema } from "./db/schema.js";
import { resetInterruptedScans } from "./media/library.js";
import { startCleanupLoop } from "./db/cleanup.js";
import { startBackupLoop } from "./db/backup.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerFsRoutes } from "./routes/fs.js";
import { registerProgressRoutes } from "./routes/progress.js";
import { registerPlaybackRoutes } from "./routes/playback.js";
import { registerMetadataRoutes } from "./routes/metadata.js";
import { registerSubtitleRoutes } from "./routes/subtitles.js";
import { registerPlaylistRoutes } from "./routes/playlists.js";
import { registerFederationRoutes } from "./routes/federation.js";
import { registerFederationApiRoutes } from "./routes/federation-api.js";
import { registerRecommendationRoutes } from "./routes/recommendations.js";
import { registerHealthRoutes } from "./routes/health.js";
import { loadOrGenerateFingerprint } from "./federation/crypto.js";
import { destroyAllSessions } from "./streaming/session.js";
import { startHeartbeatLoop } from "./federation/health.js";

// Last-resort guards. This server typically runs without a supervisor, so
// availability wins over crash-on-unknown-state: known throw sources are
// handled at their origin; anything reaching here is logged, not fatal.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
});

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
// Sweep transcode segments orphaned by an unclean shutdown (the in-memory
// session map is the only other cleanup path, and it dies with the process).
// Guarded: on Windows a leftover handle on a segment file throws EBUSY/EPERM
// (force:true only swallows ENOENT) and this runs at module eval, where the
// uncaughtException handler can't save us — a failed sweep must not block boot.
try {
  rmSync(config.transcodeTmpDir, { recursive: true, force: true });
} catch (err) {
  console.warn("[boot] transcode-dir sweep incomplete:", err);
}
mkdirSync(config.transcodeTmpDir, { recursive: true });
mkdirSync(config.subtitleDir, { recursive: true });

// Preflight: fresh Windows installs commonly lack FFmpeg on PATH. Non-fatal —
// direct play still works — but say so loudly instead of failing at first scan.
for (const [name, bin] of [
  ["ffmpeg", config.ffmpegPath],
  ["ffprobe", config.ffprobePath],
] as const) {
  execFile(bin, ["-version"], (err, stdout) => {
    if (err) {
      console.warn(
        `[preflight] ${name} not found at "${bin}" — scanning/transcoding will fail. Install FFmpeg or set VLMP_${name.toUpperCase()}_PATH.`,
      );
      return;
    }
    // Prime the transcode-pacing capability cache from this output so the
    // first playback request doesn't pay a blocking `ffmpeg -version` probe.
    if (name === "ffmpeg") primeFfmpegCaps(bin, parseFfmpegCaps(stdout));
  });
}

config.serverFingerprint = loadOrGenerateFingerprint(config.dataDir);

const db = getDatabase(config);
initSchema(db);
resetInterruptedScans(db);

const app = Fastify({
  logger: {
    serializers: {
      req(request: { method: string; url: string; hostname: string }) {
        return {
          method: request.method,
          url: request.url.replace(/token=[^&]+/g, "token=REDACTED"),
          hostname: request.hostname,
        };
      },
    },
  },
  bodyLimit: 1_048_576,
});

if (config.jwtSecret === "vlmp-dev-secret-change-me") {
  if (process.env.NODE_ENV !== "development") {
    console.error("FATAL: VLMP_JWT_SECRET must be set. Exiting.");
    process.exit(1);
  }
  app.log.warn(
    "Using default JWT secret — set VLMP_JWT_SECRET before deploying.",
  );
}

// VLMP_CORS_ORIGIN is honored from vlmp.env only because loadConfig() above
// already applied the file to process.env — keep any direct env reads AFTER it.
await app.register(cors, {
  origin:
    process.env.VLMP_CORS_ORIGIN?.split(",").map((s) => s.trim()) || false,
});
await app.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: "1 minute",
});

// Client dir depends on how we're running: tsx (server/src → root/client) and
// the installer layout (app/server/src → app/client) are two levels up;
// compiled `npm start` (dist/server/src → root/client) is three. Pick the
// first that exists — dist/client/public is never emitted by tsc.
const clientCandidates = [
  resolve(import.meta.dirname, "../../client/public"),
  resolve(import.meta.dirname, "../../../client/public"),
];
const clientDir =
  clientCandidates.find((d) => existsSync(d)) ?? clientCandidates[0];
await app.register(fastifyStatic, {
  root: clientDir,
  prefix: "/",
  wildcard: false,
});

app.addHook("onSend", async (_request, reply, payload) => {
  const ct = reply.getHeader("content-type") as string | undefined;
  if (ct && ct.includes("video/mp2t")) return payload;
  reply.header(
    "Content-Security-Policy",
    // img-src blob: — generated thumbnails are fetched with the Authorization
    // header and rendered via object URLs (plain <img src> can't carry a JWT).
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://image.tmdb.org data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
  );
  reply.header(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return payload;
});

registerAuthRoutes(app, db, config);
registerUserRoutes(app, db, config);
registerLibraryRoutes(app, db, config);
registerFsRoutes(app, db, config);
registerProgressRoutes(app, db, config);
registerPlaybackRoutes(app, db, config);
registerMetadataRoutes(app, db, config);
registerSubtitleRoutes(app, db, config);
registerPlaylistRoutes(app, db, config);
registerFederationRoutes(app, db, config);
registerFederationApiRoutes(app, db, config);
registerRecommendationRoutes(app, db, config);
registerHealthRoutes(app, db, config);

const heartbeatTimer = startHeartbeatLoop(db, config);
const cleanupTimer = startCleanupLoop(db);
const backupTimer = startBackupLoop(db, config);

app.setNotFoundHandler(async (request, reply) => {
  if (
    request.url.startsWith("/api/") ||
    request.url.startsWith("/auth/") ||
    request.url.startsWith("/library/") ||
    request.url.startsWith("/admin/") ||
    request.url.startsWith("/progress/") ||
    request.url.startsWith("/stream/") ||
    request.url.startsWith("/metadata/") ||
    request.url.startsWith("/subtitles/") ||
    request.url.startsWith("/playlists/") ||
    request.url.startsWith("/federation/") ||
    request.url.startsWith("/recommendations/") ||
    request.url.startsWith("/preferences/")
  ) {
    return reply.code(404).send({ error: "Not found" });
  }
  return reply.sendFile("index.html");
});

const shutdown = async () => {
  app.log.info("Shutting down...");
  clearInterval(heartbeatTimer);
  clearInterval(cleanupTimer);
  if (backupTimer) clearInterval(backupTimer);
  destroyAllSessions();
  closeDatabase();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Windows: Ctrl+Break (and some service managers) deliver SIGBREAK, not
// SIGTERM. Registering it is a no-op on POSIX.
process.on("SIGBREAK", shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`VLMP server running on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { app, config };
