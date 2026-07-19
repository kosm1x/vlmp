import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware, adminOnly } from "../auth/middleware.js";
import {
  browseLibrary,
  getMediaItem,
  getRecentlyAdded,
  getTVShows,
  getTVShowDetail,
  addLibraryFolder,
  getLibraryFolders,
  removeLibraryFolder,
  setFolderVisibility,
  scanLibraryFolder,
  isMediaFolderVisible,
  isShowVisible,
  type LibraryFolder,
} from "../media/library.js";
import type { MediaCategory } from "../scanner/classify.js";
import { parseIntParam } from "./params.js";

export function registerLibraryRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config, db);

  app.get<{
    Querystring: {
      type?: string;
      category?: string;
      limit?: string;
      offset?: string;
      search?: string;
    };
  }>("/library/browse", { preHandler: auth }, async (request) => {
    const { type, category, limit, offset, search } = request.query;
    return browseLibrary(db, {
      type,
      category,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      search,
      includeHidden: request.user!.role === "admin",
    });
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/library/recent",
    { preHandler: auth },
    async (request) => {
      return getRecentlyAdded(
        db,
        request.query.limit ? parseInt(request.query.limit, 10) : 20,
        request.user!.role === "admin",
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/library/:id",
    { preHandler: auth },
    async (request, reply) => {
      const id = parseIntParam(request.params.id, "id");
      const item = getMediaItem(db, id);
      if (!item) return reply.code(404).send({ error: "Not found" });
      // Access boundary: a non-admin cannot open media in a hidden library.
      if (request.user!.role !== "admin" && !isMediaFolderVisible(db, id))
        return reply.code(404).send({ error: "Not found" });
      return item;
    },
  );

  app.get("/library/tv/shows", { preHandler: auth }, async (request) =>
    getTVShows(db, request.user!.role === "admin"),
  );

  app.get<{ Params: { id: string } }>(
    "/library/tv/shows/:id",
    { preHandler: auth },
    async (request, reply) => {
      const showId = parseIntParam(request.params.id, "id");
      if (request.user!.role !== "admin" && !isShowVisible(db, showId))
        return reply.code(404).send({ error: "Show not found" });
      const result = getTVShowDetail(
        db,
        showId,
        request.user!.role === "admin",
      );
      if (!result) return reply.code(404).send({ error: "Show not found" });
      return result;
    },
  );

  app.get("/admin/folders", { preHandler: [auth, adminOnly] }, async () =>
    getLibraryFolders(db),
  );

  app.post<{ Body: { path: string; category: MediaCategory } }>(
    "/admin/folders",
    {
      schema: {
        body: {
          type: "object",
          required: ["path", "category"],
          properties: {
            path: { type: "string", minLength: 1 },
            category: {
              type: "string",
              enum: [
                "movies",
                "tv",
                "documentaries",
                "doc_series",
                "education",
                "other",
              ],
            },
          },
          additionalProperties: false,
        },
      },
      preHandler: [auth, adminOnly],
    },
    async (request, reply) => {
      const { path, category } = request.body;
      return reply.code(201).send(addLibraryFolder(db, path, category));
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { is_visible?: boolean; is_searchable?: boolean };
  }>(
    "/admin/folders/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            is_visible: { type: "boolean" },
            is_searchable: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      preHandler: [auth, adminOnly],
    },
    async (request, reply) => {
      const folderId = parseIntParam(request.params.id, "id");
      const updated = setFolderVisibility(db, folderId, request.body);
      if (!updated) return reply.code(404).send({ error: "Folder not found" });
      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/folders/:id",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const folderId = parseIntParam(request.params.id, "id");
      const existed = removeLibraryFolder(db, folderId);
      if (!existed) return reply.code(404).send({ error: "Folder not found" });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/folders/:id/scan",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const id = parseIntParam(request.params.id, "id");
      const folder = db
        .prepare("SELECT * FROM library_folders WHERE id = ?")
        .get(id) as LibraryFolder | undefined;
      if (!folder) return reply.code(404).send({ error: "Folder not found" });
      const { added, pruned } = await scanLibraryFolder(db, folder, config);
      return reply.send({ added, pruned, folder_id: id });
    },
  );
}
