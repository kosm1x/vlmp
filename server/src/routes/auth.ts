import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { issueToken } from '../auth/jwt.js';
import { authMiddleware } from '../auth/middleware.js';
import { createGuestPass, validateGuestPass } from '../auth/guest.js';

export function registerAuthRoutes(app: FastifyInstance, db: Database.Database, config: Config): void {
  app.post<{ Body: { username: string; password: string } }>('/auth/register', async (request, reply) => {
    const { username, password } = request.body;
    if (!username || !password || username.length < 3 || password.length < 8) return reply.code(400).send({ error: 'Username (3+ chars) and password (8+ chars) required' });
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return reply.code(409).send({ error: 'Username already taken' });
    const passwordHash = await hashPassword(password);
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    const role = userCount.count === 0 ? 'admin' : 'user';
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, role);
    const token = await issueToken({ sub: String(result.lastInsertRowid), username, role }, config);
    return reply.code(201).send({ token, user: { id: result.lastInsertRowid, username, role } });
  });

  app.post<{ Body: { username: string; password: string } }>('/auth/login', async (request, reply) => {
    const { username, password } = request.body;
    if (!username || !password) return reply.code(400).send({ error: 'Username and password required' });
    const user = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get(username) as { id: number; username: string; password_hash: string; role: string } | undefined;
    if (!user || !(await verifyPassword(password, user.password_hash))) return reply.code(401).send({ error: 'Invalid credentials' });
    const token = await issueToken({ sub: String(user.id), username: user.username, role: user.role }, config);
    return reply.send({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post<{ Body: { media_id: number; expires_hours?: number; max_views?: number } }>('/auth/guest', { preHandler: authMiddleware(config) }, async (request, reply) => {
    const { media_id, expires_hours = 48, max_views = 3 } = request.body;
    const userId = parseInt(request.user!.sub, 10);
    const media = db.prepare('SELECT id FROM media_items WHERE id = ?').get(media_id);
    if (!media) return reply.code(404).send({ error: 'Media not found' });
    const pass = createGuestPass(db, media_id, userId, expires_hours, max_views);
    return reply.code(201).send(pass);
  });

  app.get<{ Params: { code: string } }>('/auth/guest/:code', async (request, reply) => {
    const result = validateGuestPass(db, request.params.code);
    if (!result.valid) return reply.code(401).send({ error: 'Invalid or expired guest pass' });
    return reply.send({ mediaId: result.mediaId });
  });
}
