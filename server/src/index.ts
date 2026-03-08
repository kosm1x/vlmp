import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { getDatabase, closeDatabase } from './db/index.js';
import { initSchema } from './db/schema.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerPlaybackRoutes } from './routes/playback.js';
import { destroyAllSessions } from './streaming/session.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.transcodeTmpDir, { recursive: true });

const db = getDatabase(config);
initSchema(db);

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const clientDir = resolve(import.meta.dirname, '../../client/public');
await app.register(fastifyStatic, { root: clientDir, prefix: '/', wildcard: false });

registerAuthRoutes(app, db, config);
registerLibraryRoutes(app, db, config);
registerProgressRoutes(app, db, config);
registerPlaybackRoutes(app, db, config);

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/auth/') ||
      request.url.startsWith('/library/') || request.url.startsWith('/admin/') ||
      request.url.startsWith('/progress/') || request.url.startsWith('/stream/')) {
    return reply.code(404).send({ error: 'Not found' });
  }
  return reply.sendFile('index.html');
});

const shutdown = async () => {
  app.log.info('Shutting down...');
  destroyAllSessions();
  closeDatabase();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`VLMP server running on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { app, config };
