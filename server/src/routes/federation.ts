import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { Readable } from "node:stream";
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
  proxyStreamKeepalive,
  getFedStreamSession,
  cleanupFedStreamSession,
} from "../federation/proxy.js";
import { parseIntParam } from "./params.js";

export function registerFederationRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config, db);

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
        parseIntParam(request.params.id, "id"),
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
  }>(
    "/federation/link",
    {
      schema: {
        body: {
          type: "object",
          required: ["invite_token", "name", "url", "fingerprint"],
          properties: {
            invite_token: { type: "string", minLength: 1, maxLength: 200 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            url: { type: "string", minLength: 1, maxLength: 2048 },
            fingerprint: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { invite_token, name, url, fingerprint } = request.body;

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
    },
  );

  // Admin: link TO another server (initiates outbound link)
  app.post<{ Body: { url: string; invite_token: string } }>(
    "/federation/link-remote",
    {
      schema: {
        body: {
          type: "object",
          required: ["url", "invite_token"],
          properties: {
            url: { type: "string", minLength: 1, maxLength: 2048 },
            invite_token: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
      preHandler: [auth, adminOnly],
    },
    async (request, reply) => {
      const { url, invite_token } = request.body;

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
          request.user!.sub,
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
      if (session.userId !== request.user!.sub)
        return reply.code(404).send({ error: "Stream session not found" });
      try {
        const subpath = request.params["*"];
        // Cancel the upstream fetch when the viewer disconnects — otherwise a
        // timeout-less direct-play proxy would hold the remote socket open for
        // the rest of the file.
        const upstreamAbort = new AbortController();
        request.raw.on("close", () => {
          if (!reply.raw.writableEnded) upstreamAbort.abort();
        });
        const res = await proxyStreamContent(
          session.server,
          config,
          session.remoteSessionId,
          subpath,
          request.headers.range,
          upstreamAbort.signal,
        );
        reply.code(res.status);
        for (const name of [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
        ]) {
          const value = res.headers.get(name);
          if (value) reply.header(name, value);
        }
        return reply.send(
          res.body
            ? Readable.fromWeb(
                res.body as import("node:stream/web").ReadableStream,
              )
            : undefined,
        );
      } catch {
        return reply.code(502).send({ error: "Stream unavailable" });
      }
    },
  );

  // Keepalive for remote playback (paused viewers generate no HLS traffic)
  app.post<{ Params: { serverId: string; sessionId: string } }>(
    "/federation/servers/:serverId/stream/:sessionId/keepalive",
    { preHandler: auth },
    async (request, reply) => {
      const session = getFedStreamSession(request.params.sessionId);
      if (!session)
        return reply.code(404).send({ error: "Stream session not found" });
      if (session.userId !== request.user!.sub)
        return reply.code(404).send({ error: "Stream session not found" });
      try {
        await proxyStreamKeepalive(
          session.server,
          config,
          session.remoteSessionId,
        );
      } catch {
        // Best-effort — the next segment fetch revives things anyway
      }
      return reply.code(204).send();
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
      if (session.userId !== request.user!.sub)
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
