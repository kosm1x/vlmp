import type { FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import { verifyRequest } from "./crypto.js";

interface FederatedServerRow {
  id: number;
  name: string;
  url: string;
  public_key: string;
  shared_secret: string;
  status: string;
  last_seen: number | null;
}

declare module "fastify" {
  interface FastifyRequest {
    federatedServer?: FederatedServerRow;
  }
}

const lastSeenWriteTime = new Map<number, number>();
const LAST_SEEN_DEBOUNCE_MS = 60_000;

export function federationAuth(db: Database.Database) {
  return async function verifyFederation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const serverId = request.headers["x-vlmp-server-id"] as string | undefined;
    const timestamp = request.headers["x-vlmp-timestamp"] as string | undefined;
    const signature = request.headers["x-vlmp-signature"] as string | undefined;

    if (!serverId || !timestamp || !signature) {
      reply.code(401).send({ error: "Missing federation headers" });
      return;
    }

    const server = db
      .prepare("SELECT * FROM federated_servers WHERE public_key = ?")
      .get(serverId) as FederatedServerRow | undefined;

    if (!server) {
      reply.code(401).send({ error: "Unknown server" });
      return;
    }

    if (server.status !== "active") {
      reply.code(403).send({ error: "Server not active" });
      return;
    }

    const rawBody =
      request.method === "GET" || request.method === "DELETE"
        ? ""
        : JSON.stringify(request.body || "");

    const valid = verifyRequest(
      server.shared_secret,
      request.method,
      request.url.split("?")[0],
      timestamp,
      rawBody,
      signature,
    );

    if (!valid) {
      reply.code(401).send({ error: "Invalid signature" });
      return;
    }

    const now = Date.now();
    const lastWrite = lastSeenWriteTime.get(server.id) || 0;
    if (now - lastWrite > LAST_SEEN_DEBOUNCE_MS) {
      db.prepare(
        "UPDATE federated_servers SET last_seen = unixepoch() WHERE id = ?",
      ).run(server.id);
      lastSeenWriteTime.set(server.id, now);
    }

    request.federatedServer = server;
  };
}
