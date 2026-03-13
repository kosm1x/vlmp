import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware } from "../auth/middleware.js";
import { adminOnly } from "../auth/middleware.js";
import {
  createInvite,
  handleLink,
  removeFederatedServer,
  listFederatedServers,
} from "../federation/linking.js";
import {
  proxyLibrary,
  proxyMediaDetail,
  proxyTVShows,
  proxyStreamStart,
  proxyStreamContent,
  proxyStreamStop,
  getFedStreamSession,
  cleanupFedStreamSession,
} from "../federation/proxy.js";

export function registerFederationRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

  // List federated servers (admin only)
  app.get(
    "/federation/servers",
    { preHandler: [auth, adminOnly] },
    async () => {
      return listFederatedServers(db);
    },
  );

  // Generate invite token (admin only)
  app.post(
    "/federation/invite",
    { preHandler: [auth, adminOnly] },
    async (_request, reply) => {
      const invite = createInvite(db);
      return reply.code(201).send(invite);
    },
  );

  // Remove a federated server (admin only)
  app.delete<{ Params: { id: string } }>(
    "/federation/servers/:id",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const removed = removeFederatedServer(
        db,
        parseInt(request.params.id, 10),
      );
      if (!removed) return reply.code(404).send({ error: "Server not found" });
      return reply.code(204).send();
    },
  );

  // Receive link request from a remote server (no JWT — validated by invite token)
  app.post<{
    Body: {
      invite_token: string;
      name: string;
      url: string;
      fingerprint: string;
    };
  }>("/federation/link", async (request, reply) => {
    const { invite_token, name, url, fingerprint } = request.body || {};
    if (!invite_token || !name || !url || !fingerprint) {
      return reply.code(400).send({ error: "Missing required fields" });
    }

    try {
      const result = handleLink(
        db,
        config.serverFingerprint,
        config.serverName,
        config.publicUrl,
        url,
        name,
        fingerprint,
        invite_token,
      );
      return reply.code(201).send(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Link failed";
      return reply.code(400).send({ error: message });
    }
  });

  // Admin: link TO another server (initiates outbound link)
  app.post<{ Body: { url: string; invite_token: string } }>(
    "/federation/link-remote",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const { url, invite_token } = request.body || {};
      if (!url || !invite_token) {
        return reply.code(400).send({ error: "url and invite_token required" });
      }

      const body = JSON.stringify({
        invite_token,
        name: config.serverName,
        url: config.publicUrl,
        fingerprint: config.serverFingerprint,
      });

      try {
        const res = await fetch(`${url.replace(/\/$/, "")}/federation/link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Link failed" }));
          return reply.code(res.status).send(err);
        }

        const remote = (await res.json()) as {
          shared_secret: string;
          name: string;
          fingerprint: string;
          public_url: string;
        };

        // Store the remote server locally
        db.prepare(
          "INSERT INTO federated_servers (name, url, public_key, shared_secret, status, last_seen) VALUES (?, ?, ?, ?, 'active', unixepoch())",
        ).run(
          remote.name,
          remote.public_url || url,
          remote.fingerprint,
          remote.shared_secret,
        );

        return reply.code(201).send({ ok: true, name: remote.name });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Connection failed";
        return reply.code(502).send({ error: message });
      }
    },
  );

  // --- Proxy routes for local users to access remote libraries ---

  const getServer = (id: string) => {
    return db
      .prepare(
        "SELECT * FROM federated_servers WHERE id = ? AND status = 'active'",
      )
      .get(parseInt(id, 10)) as
      | {
          id: number;
          name: string;
          url: string;
          public_key: string;
          shared_secret: string;
          status: string;
        }
      | undefined;
  };

  // Browse remote library (admin only)
  app.get<{
    Params: { serverId: string };
    Querystring: Record<string, string>;
  }>(
    "/federation/servers/:serverId/library",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const server = getServer(request.params.serverId);
      if (!server)
        return reply.code(404).send({ error: "Server not found or offline" });
      try {
        const qs = new URLSearchParams(
          request.query as Record<string, string>,
        ).toString();
        return await proxyLibrary(server, config, qs);
      } catch {
        return reply.code(502).send({ error: "Remote server unavailable" });
      }
    },
  );

  // Remote media detail (admin only)
  app.get<{ Params: { serverId: string; mediaId: string } }>(
    "/federation/servers/:serverId/media/:mediaId",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const server = getServer(request.params.serverId);
      if (!server)
        return reply.code(404).send({ error: "Server not found or offline" });
      try {
        const item = await proxyMediaDetail(
          server,
          config,
          request.params.mediaId,
        );
        if (!item) return reply.code(404).send({ error: "Not found" });
        return item;
      } catch {
        return reply.code(502).send({ error: "Remote server unavailable" });
      }
    },
  );

  // Remote TV shows (admin only)
  app.get<{ Params: { serverId: string } }>(
    "/federation/servers/:serverId/tv/shows",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const server = getServer(request.params.serverId);
      if (!server)
        return reply.code(404).send({ error: "Server not found or offline" });
      try {
        return await proxyTVShows(server, config);
      } catch {
        return reply.code(502).send({ error: "Remote server unavailable" });
      }
    },
  );

  // --- Stream proxy routes ---

  // Start remote playback
  app.post<{ Params: { serverId: string; mediaId: string }; Body: unknown }>(
    "/federation/servers/:serverId/stream/:mediaId/start",
    { preHandler: auth },
    async (request, reply) => {
      const server = getServer(request.params.serverId);
      if (!server)
        return reply.code(404).send({ error: "Server not found or offline" });
      try {
        const result = await proxyStreamStart(
          server,
          config,
          request.params.mediaId,
          request.body,
        );
        return result;
      } catch {
        return reply.code(502).send({ error: "Remote server unavailable" });
      }
    },
  );

  // Proxy HLS content (playlists and segments)
  app.get<{ Params: { serverId: string; sessionId: string; "*": string } }>(
    "/federation/servers/:serverId/stream/:sessionId/*",
    { preHandler: auth },
    async (request, reply) => {
      const session = getFedStreamSession(request.params.sessionId);
      if (!session)
        return reply.code(404).send({ error: "Stream session not found" });
      try {
        const subpath = request.params["*"];
        const { body, contentType } = await proxyStreamContent(
          session.server,
          config,
          session.remoteSessionId,
          subpath,
        );
        return reply
          .header("content-type", contentType)
          .send(Buffer.from(body));
      } catch {
        return reply.code(502).send({ error: "Stream unavailable" });
      }
    },
  );

  // Stop remote playback
  app.delete<{ Params: { serverId: string; sessionId: string } }>(
    "/federation/servers/:serverId/stream/:sessionId",
    { preHandler: auth },
    async (request, reply) => {
      const session = getFedStreamSession(request.params.sessionId);
      if (!session)
        return reply.code(404).send({ error: "Stream session not found" });
      try {
        await proxyStreamStop(session.server, config, session.remoteSessionId);
      } catch {
        // Best-effort cleanup
      }
      cleanupFedStreamSession(request.params.sessionId);
      return reply.code(204).send();
    },
  );
}
