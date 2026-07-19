import type { FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import { verifyToken, type TokenPayload } from "./jwt.js";
import type { Config } from "../config.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: TokenPayload;
  }
}

export function authMiddleware(config: Config, db: Database.Database) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      reply
        .code(401)
        .send({ error: "Missing or invalid authorization header" });
      return;
    }
    const token = header.slice(7);
    let payload: TokenPayload;
    try {
      payload = await verifyToken(token, config);
    } catch {
      reply.code(401).send({ error: "Invalid or expired token" });
      return;
    }
    // The admin controls who can access the library: deleting an account must
    // revoke access NOW, not when the JWT expires — so re-check the account
    // exists and take its CURRENT role, not the one baked into the token.
    const row = db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(parseInt(payload.sub, 10)) as { role: string } | undefined;
    if (!row) {
      reply.code(401).send({ error: "Account no longer exists" });
      return;
    }
    request.user = { ...payload, role: row.role };
  };
}

export function adminOnly(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (request.user?.role !== "admin") {
    reply.code(403).send({ error: "Admin access required" });
    return;
  }
  done();
}
