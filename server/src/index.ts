import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { getDatabase, closeDatabase } from "./db/index.js";
import { initSchema } from "./db/schema.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerProgressRoutes } from "./routes/progress.js";
import { registerPlaybackRoutes } from "./routes/playback.js";
import { registerMetadataRoutes } from "./routes/metadata.js";
import { registerSubtitleRoutes } from "./routes/subtitles.js";
import { registerPlaylistRoutes } from "./routes/playlists.js";
import { registerFederationRoutes } from "./routes/federation.js";
import { registerFederationApiRoutes } from "./routes/federation-api.js";
import { loadOrGenerateFingerprint } from "./federation/crypto.js";
import { destroyAllSessions } from "./streaming/session.js";
import { startHeartbeatLoop } from "./federation/health.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.transcodeTmpDir, { recursive: true });
mkdirSync(config.subtitleDir, { recursive: true });

config.serverFingerprint = loadOrGenerateFingerprint(config.dataDir);

const db = getDatabase(config);
initSchema(db);

const app = Fastify({ logger: true });

if (config.jwtSecret === "vlmp-dev-secret-change-me") {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: VLMP_JWT_SECRET must be set in production. Exiting.");
    process.exit(1);
  }
  app.log.warn(
    "Using default JWT secret — set VLMP_JWT_SECRET before deploying.",
  );
}

await app.register(cors, {
  origin:
    process.env.VLMP_CORS_ORIGIN?.split(",").map((s) => s.trim()) || false,
});
await app.register(rateLimit, { global: false });

const clientDir = resolve(import.meta.dirname, "../../client/public");
await app.register(fastifyStatic, {
  root: clientDir,
  prefix: "/",
  wildcard: false,
});

registerAuthRoutes(app, db, config);
registerLibraryRoutes(app, db, config);
registerProgressRoutes(app, db, config);
registerPlaybackRoutes(app, db, config);
registerMetadataRoutes(app, db, config);
registerSubtitleRoutes(app, db, config);
registerPlaylistRoutes(app, db, config);
registerFederationRoutes(app, db, config);
registerFederationApiRoutes(app, db, config);

const heartbeatTimer = startHeartbeatLoop(db, config);

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
    request.url.startsWith("/federation/")
  ) {
    return reply.code(404).send({ error: "Not found" });
  }
  return reply.sendFile("index.html");
});

const shutdown = async () => {
  app.log.info("Shutting down...");
  clearInterval(heartbeatTimer);
  destroyAllSessions();
  closeDatabase();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`VLMP server running on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { app, config };
