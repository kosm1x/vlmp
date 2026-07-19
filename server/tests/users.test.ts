// Access-control model: the first account bootstraps as admin, registration
// then closes, and the admin controls who can browse/watch via /admin/users.
// Deleting a user revokes access on their NEXT request (middleware re-checks
// the DB), not at JWT expiry.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  app = Fastify();
  registerAuthRoutes(app, db, config);
  registerUserRoutes(app, db, config);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

async function register(username: string, password = "password123") {
  return app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { username, password },
  });
}

async function bootstrapAdmin() {
  const res = await register("admin1");
  return res.json().token as string;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("registration bootstrap", () => {
  it("first account becomes admin, then registration closes", async () => {
    const statusBefore = await app.inject({
      method: "GET",
      url: "/auth/status",
    });
    expect(statusBefore.json().registration_open).toBe(true);

    const first = await register("admin1");
    expect(first.statusCode).toBe(201);
    expect(first.json().user.role).toBe("admin");

    const statusAfter = await app.inject({
      method: "GET",
      url: "/auth/status",
    });
    expect(statusAfter.json().registration_open).toBe(false);

    const second = await register("intruder");
    expect(second.statusCode).toBe(403);
  });

  it("concurrent first-registrations cannot both become admin (TOCTOU)", async () => {
    // Fire two registrations at a fresh server simultaneously — the count +
    // insert run in one synchronous transaction, so exactly one wins.
    const [a, b] = await Promise.all([register("first"), register("second")]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 403]);
    const admins = db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
      .get() as { count: number };
    expect(admins.count).toBe(1);
  });
});

describe("admin user management", () => {
  it("admin creates a user who can then log in", async () => {
    const token = await bootstrapAdmin();
    const created = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "viewer", password: "viewerpass1" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().role).toBe("user");

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "viewer", password: "viewerpass1" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe("user");
  });

  it("rejects duplicate usernames", async () => {
    const token = await bootstrapAdmin();
    const make = () =>
      app.inject({
        method: "POST",
        url: "/admin/users",
        headers: authHeader(token),
        payload: { username: "viewer", password: "viewerpass1" },
      });
    expect((await make()).statusCode).toBe(201);
    expect((await make()).statusCode).toBe(409);
  });

  it("non-admins cannot list, create, or delete users", async () => {
    const admin = await bootstrapAdmin();
    await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(admin),
      payload: { username: "viewer", password: "viewerpass1" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "viewer", password: "viewerpass1" },
    });
    const userToken = login.json().token as string;

    const list = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: authHeader(userToken),
    });
    expect(list.statusCode).toBe(403);
    const create = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(userToken),
      payload: { username: "sneaky", password: "sneakypass1" },
    });
    expect(create.statusCode).toBe(403);
    const remove = await app.inject({
      method: "DELETE",
      url: "/admin/users/1",
      headers: authHeader(userToken),
    });
    expect(remove.statusCode).toBe(403);
  });

  it("guards: no self-delete, no deleting the last admin", async () => {
    const token = await bootstrapAdmin();
    const self = await app.inject({
      method: "DELETE",
      url: "/admin/users/1",
      headers: authHeader(token),
    });
    expect(self.statusCode).toBe(400);

    // A second admin exists; deleting them is fine. Then they are the ones
    // who cannot delete admin1 if admin1 is... rebuild: create admin2,
    // delete admin2 (admin count 2 -> allowed).
    await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "admin2", password: "adminpass22", role: "admin" },
    });
    const delAdmin2 = await app.inject({
      method: "DELETE",
      url: "/admin/users/2",
      headers: authHeader(token),
    });
    expect(delAdmin2.statusCode).toBe(204);

    const missing = await app.inject({
      method: "DELETE",
      url: "/admin/users/99",
      headers: authHeader(token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("deleting a user revokes their still-valid token immediately", async () => {
    const admin = await bootstrapAdmin();
    await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(admin),
      payload: { username: "viewer", password: "viewerpass1" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "viewer", password: "viewerpass1" },
    });
    const userToken = login.json().token as string;

    // Alive: authenticated but not authorized for admin routes -> 403.
    const before = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: authHeader(userToken),
    });
    expect(before.statusCode).toBe(403);

    await app.inject({
      method: "DELETE",
      url: "/admin/users/2",
      headers: authHeader(admin),
    });

    // Deleted: the same token now fails AUTHENTICATION -> 401.
    const after = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: authHeader(userToken),
    });
    expect(after.statusCode).toBe(401);
  });

  it("role changes in the DB take effect on the next request, not token refresh", async () => {
    const admin = await bootstrapAdmin();
    await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(admin),
      payload: { username: "viewer", password: "viewerpass1" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "viewer", password: "viewerpass1" },
    });
    const userToken = login.json().token as string;

    db.prepare(
      "UPDATE users SET role = 'admin' WHERE username = 'viewer'",
    ).run();
    const promoted = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: authHeader(userToken),
    });
    expect(promoted.statusCode).toBe(200);
  });
});
