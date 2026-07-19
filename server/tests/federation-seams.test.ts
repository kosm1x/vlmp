// Integration tests for the client↔middleware federation seams: outbound
// signing (federatedFetch's exact string construction) verified against the
// real federationAuth middleware through real registered routes. These seams
// were previously covered only by symmetric unit tests, which cannot catch
// sign/verify construction mismatches.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import { registerFederationApiRoutes } from "../src/routes/federation-api.js";
import { signRequest } from "../src/federation/crypto.js";
import { loadConfig } from "../src/config.js";

const SECRET = "a".repeat(64);
const PEER_KEY = "peer-fingerprint";
const config = loadConfig();

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare(
    "INSERT INTO federated_servers (name, url, public_key, shared_secret, status) VALUES (?, ?, ?, ?, ?)",
  ).run("Peer", "http://peer.test", PEER_KEY, SECRET, "active");
  app = Fastify();
  registerFederationApiRoutes(app, db, config);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

// Mirrors federatedFetch exactly: sign the full path INCLUDING the query
// string, and "" when there is no body.
function signedHeaders(method: string, path: string, body?: unknown) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyStr = body ? JSON.stringify(body) : "";
  return {
    "x-vlmp-server-id": PEER_KEY,
    "x-vlmp-timestamp": timestamp,
    "x-vlmp-signature": signRequest(SECRET, method, path, timestamp, bodyStr),
  };
}

function setPeerStatus(status: string) {
  db.prepare(
    "UPDATE federated_servers SET status = ? WHERE public_key = ?",
  ).run(status, PEER_KEY);
}

describe("federation HMAC seam", () => {
  it("accepts a signed GET with query string", async () => {
    const path = "/federation/api/library?type=movie&limit=5";
    const res = await app.inject({
      method: "GET",
      url: path,
      headers: signedHeaders("GET", path),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
  });

  it("rejects when the query string was not part of the signature", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/federation/api/library?type=movie",
      headers: signedHeaders("GET", "/federation/api/library"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a signed POST with no body", async () => {
    const path = "/federation/heartbeat";
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: signedHeaders("POST", path),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("accepts a signed POST with a JSON body", async () => {
    const path = "/federation/heartbeat";
    const body = { name: "Peer" };
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: {
        ...signedHeaders("POST", path, body),
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a bad signature", async () => {
    const path = "/federation/api/library";
    const headers = signedHeaders("GET", path);
    headers["x-vlmp-signature"] = "0".repeat(64);
    const res = await app.inject({ method: "GET", url: path, headers });
    expect(res.statusCode).toBe(401);
  });
});

describe("federation heartbeat deadlock recovery", () => {
  it("accepts a heartbeat from an offline peer and reactivates it", async () => {
    setPeerStatus("offline");
    const path = "/federation/heartbeat";
    const body = { name: "Peer" };
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: {
        ...signedHeaders("POST", path, body),
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(200);
    const row = db
      .prepare("SELECT status FROM federated_servers WHERE public_key = ?")
      .get(PEER_KEY) as { status: string };
    expect(row.status).toBe("active");
  });

  it("still rejects offline peers on non-heartbeat routes", async () => {
    setPeerStatus("offline");
    const path = "/federation/api/library";
    const res = await app.inject({
      method: "GET",
      url: path,
      headers: signedHeaders("GET", path),
    });
    expect(res.statusCode).toBe(403);
  });

  it("never admits pending or revoked peers, even to heartbeat", async () => {
    for (const status of ["pending", "revoked"]) {
      setPeerStatus(status);
      const path = "/federation/heartbeat";
      const res = await app.inject({
        method: "POST",
        url: path,
        headers: signedHeaders("POST", path),
      });
      expect(res.statusCode).toBe(403);
    }
  });
});
