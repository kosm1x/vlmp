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
  scanLibraryFolder,
  type LibraryFolder,
} from "../media/library.js";
import type { MediaCategory } from "../scanner/classify.js";

export function registerLibraryRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config);

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
    });
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/library/recent",
    { preHandler: auth },
    async (request) => {
      return getRecentlyAdded(
        db,
        request.query.limit ? parseInt(request.query.limit, 10) : 20,
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/library/:id",
    { preHandler: auth },
    async (request, reply) => {
      const item = getMediaItem(db, parseInt(request.params.id, 10));
      if (!item) return reply.code(404).send({ error: "Not found" });
      return item;
    },
  );

  app.get("/library/tv/shows", { preHandler: auth }, async () =>
    getTVShows(db),
  );

  app.get<{ Params: { id: string } }>(
    "/library/tv/shows/:id",
    { preHandler: auth },
    async (request, reply) => {
      const result = getTVShowDetail(db, parseInt(request.params.id, 10));
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

  app.delete<{ Params: { id: string } }>(
    "/admin/folders/:id",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      removeLibraryFolder(db, parseInt(request.params.id, 10));
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/folders/:id/scan",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const folder = db
        .prepare("SELECT * FROM library_folders WHERE id = ?")
        .get(id) as LibraryFolder | undefined;
      if (!folder) return reply.code(404).send({ error: "Folder not found" });
      const added = await scanLibraryFolder(db, folder, config);
      return reply.send({ added, folder_id: id });
    },
  );
}
