// GET /api/info — public device-discovery endpoint (no auth required).
// Invariant: returns server identity fields without authentication.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import { registerHealthRoutes } from "../src/routes/health.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  app = Fastify();
  registerHealthRoutes(app, db, config);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe("GET /api/info", () => {
  it("responds 200 with no auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/info" });
    expect(res.statusCode).toBe(200);
  });

  it("returns required identity fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/info" });
    const body = res.json<{
      name: string;
      version: string;
      publicUrl: string;
      fingerprint: string;
      capabilities: string[];
    }>();
    expect(typeof body.name).toBe("string");
    expect(typeof body.version).toBe("string");
    expect(body.version).toMatch(/^\d+\.\d+/);
    expect(typeof body.publicUrl).toBe("string");
    expect(typeof body.fingerprint).toBe("string");
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(body.capabilities).toContain("hls");
  });
});
