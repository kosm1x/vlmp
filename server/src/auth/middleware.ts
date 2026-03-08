import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, type TokenPayload } from './jwt.js';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: TokenPayload;
  }
}

export function authMiddleware(config: Config) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Missing or invalid authorization header' });
      return;
    }
    const token = header.slice(7);
    try {
      request.user = await verifyToken(token, config);
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
    }
  };
}

export function adminOnly(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (request.user?.role !== 'admin') {
    reply.code(403).send({ error: 'Admin access required' });
    return;
  }
  done();
}
