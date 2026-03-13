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
    { preHandler: auth },
    async (request, reply) => {
      const { name } = request.body || {};
      if (!name || !name.trim()) {
        return reply.code(400).send({ error: "Name required" });
      }
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
        parseInt(request.params.id, 10),
        userId,
      );
      if (!playlist)
        return reply.code(404).send({ error: "Playlist not found" });
      return playlist;
    },
  );

  app.put<{ Params: { id: string }; Body: { name: string } }>(
    "/playlists/:id",
    { preHandler: auth },
    async (request, reply) => {
      const { name } = request.body || {};
      if (!name || !name.trim()) {
        return reply.code(400).send({ error: "Name required" });
      }
      const userId = parseInt(request.user!.sub, 10);
      const updated = renamePlaylist(
        db,
        parseInt(request.params.id, 10),
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
        parseInt(request.params.id, 10),
        userId,
      );
      if (!deleted)
        return reply.code(404).send({ error: "Playlist not found" });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { media_id: number } }>(
    "/playlists/:id/items",
    { preHandler: auth },
    async (request, reply) => {
      const { media_id } = request.body || {};
      if (!media_id)
        return reply.code(400).send({ error: "media_id required" });
      const userId = parseInt(request.user!.sub, 10);
      const item = addToPlaylist(
        db,
        parseInt(request.params.id, 10),
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
        parseInt(request.params.id, 10),
        userId,
        parseInt(request.params.itemId, 10),
      );
      if (!removed) return reply.code(404).send({ error: "Item not found" });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { id: string }; Body: { item_ids: number[] } }>(
    "/playlists/:id/reorder",
    { preHandler: auth },
    async (request, reply) => {
      const { item_ids } = request.body || {};
      if (!item_ids || !Array.isArray(item_ids)) {
        return reply.code(400).send({ error: "item_ids array required" });
      }
      const userId = parseInt(request.user!.sub, 10);
      const reordered = reorderPlaylist(
        db,
        parseInt(request.params.id, 10),
        userId,
        item_ids,
      );
      if (!reordered)
        return reply.code(404).send({ error: "Playlist not found" });
      return { ok: true };
    },
  );
}
