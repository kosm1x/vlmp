import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware, adminOnly } from "../auth/middleware.js";
import { hashPassword } from "../auth/passwords.js";
import { parseIntParam } from "./params.js";

interface UserRow {
  id: number;
  username: string;
  role: string;
  created_at: number;
}

export function registerUserRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config, db);

  app.get("/admin/users", { preHandler: [auth, adminOnly] }, async () => {
    return db
      .prepare("SELECT id, username, role, created_at FROM users ORDER BY id")
      .all() as UserRow[];
  });

  app.post<{ Body: { username: string; password: string; role?: string } }>(
    "/admin/users",
    {
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string", minLength: 3, maxLength: 50 },
            password: { type: "string", minLength: 8, maxLength: 128 },
            role: { type: "string", enum: ["user", "admin"] },
          },
          additionalProperties: false,
        },
      },
      preHandler: [auth, adminOnly],
    },
    async (request, reply) => {
      const { username, password, role = "user" } = request.body;
      const existing = db
        .prepare("SELECT id FROM users WHERE username = ?")
        .get(username);
      if (existing)
        return reply.code(409).send({ error: "Username already taken" });
      const passwordHash = await hashPassword(password);
      const result = db
        .prepare(
          "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        )
        .run(username, passwordHash, role);
      return reply
        .code(201)
        .send({ id: result.lastInsertRowid, username, role });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const userId = parseIntParam(request.params.id, "id");
      if (userId === parseInt(request.user!.sub, 10))
        return reply
          .code(400)
          .send({ error: "You cannot delete your own account" });
      const target = db
        .prepare("SELECT id, role FROM users WHERE id = ?")
        .get(userId) as { id: number; role: string } | undefined;
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (target.role === "admin") {
        const admins = db
          .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
          .get() as { count: number };
        if (admins.count <= 1)
          return reply
            .code(400)
            .send({ error: "Cannot delete the last administrator" });
      }
      // All user-owned rows (progress, playlists, preferences, viewing log,
      // guest passes) cascade; the auth middleware's per-request account check
      // makes any still-valid JWT die on the holder's next request.
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return reply.code(204).send();
    },
  );
}
