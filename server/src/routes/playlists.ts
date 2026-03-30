import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  createPlaylist,
  getUserPlaylists,
  getPlaylistWithItems,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  reorderPlaylist,
} from "../media/playlists.js";
import { parseIntParam } from "./params.js";

export function registerPlaylistRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

  app.get("/playlists", { preHandler: auth }, async (request) => {
    const userId = parseInt(request.user!.sub, 10);
    return getUserPlaylists(db, userId);
  });

  app.post<{ Body: { name: string } }>(
    "/playlists",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
      preHandler: auth,
    },
    async (request, reply) => {
      const { name } = request.body;
      const userId = parseInt(request.user!.sub, 10);
      return reply.code(201).send(createPlaylist(db, userId, name.trim()));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/playlists/:id",
    { preHandler: auth },
    async (request, reply) => {
      const userId = parseInt(request.user!.sub, 10);
      const playlist = getPlaylistWithItems(
        db,
        parseIntParam(request.params.id, "id"),
        userId,
      );
      if (!playlist)
        return reply.code(404).send({ error: "Playlist not found" });
      return playlist;
    },
  );

  app.put<{ Params: { id: string }; Body: { name: string } }>(
    "/playlists/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
      preHandler: auth,
    },
    async (request, reply) => {
      const { name } = request.body;
      const userId = parseInt(request.user!.sub, 10);
      const updated = renamePlaylist(
        db,
        parseIntParam(request.params.id, "id"),
        userId,
        name.trim(),
      );
      if (!updated)
        return reply.code(404).send({ error: "Playlist not found" });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/playlists/:id",
    { preHandler: auth },
    async (request, reply) => {
      const userId = parseInt(request.user!.sub, 10);
      const deleted = deletePlaylist(
        db,
        parseIntParam(request.params.id, "id"),
        userId,
      );
      if (!deleted)
        return reply.code(404).send({ error: "Playlist not found" });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { media_id: number } }>(
    "/playlists/:id/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["media_id"],
          properties: { media_id: { type: "number" } },
          additionalProperties: false,
        },
      },
      preHandler: auth,
    },
    async (request, reply) => {
      const { media_id } = request.body;
      const userId = parseInt(request.user!.sub, 10);
      const item = addToPlaylist(
        db,
        parseIntParam(request.params.id, "id"),
        userId,
        media_id,
      );
      if (!item) return reply.code(404).send({ error: "Playlist not found" });
      return reply.code(201).send(item);
    },
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    "/playlists/:id/items/:itemId",
    { preHandler: auth },
    async (request, reply) => {
      const userId = parseInt(request.user!.sub, 10);
      const removed = removeFromPlaylist(
        db,
        parseIntParam(request.params.id, "id"),
        userId,
        parseIntParam(request.params.itemId, "itemId"),
      );
      if (!removed) return reply.code(404).send({ error: "Item not found" });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { id: string }; Body: { item_ids: number[] } }>(
    "/playlists/:id/reorder",
    {
      schema: {
        body: {
          type: "object",
          required: ["item_ids"],
          properties: {
            item_ids: { type: "array", items: { type: "number" } },
          },
          additionalProperties: false,
        },
      },
      preHandler: auth,
    },
    async (request, reply) => {
      const { item_ids } = request.body;
      const userId = parseInt(request.user!.sub, 10);
      const reordered = reorderPlaylist(
        db,
        parseIntParam(request.params.id, "id"),
        userId,
        item_ids,
      );
      if (!reordered)
        return reply.code(404).send({ error: "Playlist not found" });
      return { ok: true };
    },
  );
}
