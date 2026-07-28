import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { stat } from "node:fs/promises";
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
import {
  listCategories,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
  type CategoryKind,
} from "../media/categories.js";
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
      exclude_episodes?: string;
      all?: string;
    };
  }>("/library/browse", { preHandler: auth }, async (request) => {
    const { type, category, limit, offset, search, exclude_episodes, all } =
      request.query;
    return browseLibrary(db, {
      type,
      category,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      search,
      includeHidden: request.user!.role === "admin",
      excludeEpisodes: exclude_episodes === "1" || exclude_episodes === "true",
      // "Load everything" is only for a scoped category view (how the client
      // uses it); without a category it would dump the whole table, so keep
      // the LIMIT in that case.
      all: (all === "1" || all === "true") && !!category,
      userId: parseInt(request.user!.sub, 10),
    });
  });

  // Categories are user data now (create/delete in Settings), so every
  // logged-in client needs the list to build its nav and browse pages.
  app.get("/categories", { preHandler: auth }, async () => listCategories(db));

  app.post<{ Body: { label: string; kind: CategoryKind; slug?: string } }>(
    "/admin/categories",
    {
      schema: {
        body: {
          type: "object",
          required: ["label", "kind"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: 80 },
            kind: { type: "string", enum: ["movie", "series"] },
            slug: { type: "string", minLength: 1, maxLength: 40 },
          },
          additionalProperties: false,
        },
      },
      preHandler: [auth, adminOnly],
    },
    async (request, reply) => {
      const result = createCategory(db, request.body);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      return reply.code(201).send(result.category);
    },
  );

  app.patch<{ Params: { id: string }; Body: { label: string } }>(
    "/admin/categories/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: 80 },
          },
          additionalProperties: false,
        },
      },
      preHandler: [auth, adminOnly],
    },
    async (request, reply) => {
      const id = parseIntParam(request.params.id, "id");
      const result = updateCategory(db, id, request.body);
      if (!result.ok)
        return reply.code(result.status).send({ error: result.error });
      return reply.send(result.category);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/categories/:id",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const id = parseIntParam(request.params.id, "id");
      const result = deleteCategory(db, id);
      if (!result.ok)
        return reply.code(result.status).send({ error: result.error });
      return reply.code(204).send();
    },
  );

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

  // Shows are no longer TV-only (any category can hold series) —
  // /library/shows is the canonical path; /library/tv/shows stays as a
  // compatibility alias for pre-0.2 API consumers.
  const showsHandler = async (
    request: FastifyRequest<{ Querystring: { category?: string } }>,
  ) =>
    getTVShows(
      db,
      request.user!.role === "admin",
      request.query.category,
      parseInt(request.user!.sub, 10),
    );
  app.get<{ Querystring: { category?: string } }>(
    "/library/shows",
    { preHandler: auth },
    showsHandler,
  );
  app.get<{ Querystring: { category?: string } }>(
    "/library/tv/shows",
    { preHandler: auth },
    showsHandler,
  );

  const showDetailHandler = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const showId = parseIntParam(request.params.id, "id");
    if (request.user!.role !== "admin" && !isShowVisible(db, showId))
      return reply.code(404).send({ error: "Show not found" });
    const result = getTVShowDetail(db, showId, request.user!.role === "admin");
    if (!result) return reply.code(404).send({ error: "Show not found" });
    return result;
  };
  app.get<{ Params: { id: string } }>(
    "/library/shows/:id",
    { preHandler: auth },
    showDetailHandler,
  );
  app.get<{ Params: { id: string } }>(
    "/library/tv/shows/:id",
    { preHandler: auth },
    showDetailHandler,
  );

  app.get("/admin/folders", { preHandler: [auth, adminOnly] }, async () =>
    getLibraryFolders(db),
  );

  app.post<{ Body: { path: string; category: string } }>(
    "/admin/folders",
    {
      schema: {
        body: {
          type: "object",
          required: ["path", "category"],
          properties: {
            path: { type: "string", minLength: 1 },
            category: { type: "string", minLength: 1, maxLength: 40 },
          },
          additionalProperties: false,
        },
      },
      preHandler: [auth, adminOnly],
    },
    async (request, reply) => {
      const { path, category } = request.body;
      // Categories live in the DB now — validate against it, not a frozen enum.
      if (!getCategoryBySlug(db, category))
        return reply
          .code(400)
          .send({ error: `Unknown category "${category}"` });
      // A typo'd path would otherwise create a row that scans to an empty
      // library with no hint of what went wrong.
      let isDir = false;
      try {
        isDir = (await stat(path)).isDirectory();
      } catch {
        /* not found */
      }
      if (!isDir)
        return reply
          .code(400)
          .send({ error: "Folder does not exist on the server" });
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

  // Fire-and-forget scan launch, shared by the admin route and the
  // view-triggered refresh. Callers must hold the atomic 'scanning' claim.
  // Holding the request open for a whole-library scan meant proxy
  // idle-timeouts aborted the response and a dead client connection was
  // indistinguishable from a dead scan — clients poll scan status instead.
  const runBackgroundScan = (
    folder: LibraryFolder,
    log: FastifyRequest["log"],
  ): Promise<void> =>
    scanLibraryFolder(db, folder, config).then(
      () => undefined,
      (err) => {
        log.error({ err, folder_id: folder.id }, "background scan failed");
        // scanLibraryFolder sets 'error' itself before rethrowing; this
        // covers a reject before its try block so the claim can't stick as
        // 'scanning'.
        try {
          db.prepare(
            "UPDATE library_folders SET scan_status = 'error' WHERE id = ? AND scan_status = 'scanning'",
          ).run(folder.id);
        } catch {
          /* status reset is best-effort */
        }
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
      // Atomic claim doubles as the concurrency guard — two racing POSTs
      // can't both start a scan of the same folder.
      const claimed = db
        .prepare(
          "UPDATE library_folders SET scan_status = 'scanning' WHERE id = ? AND scan_status != 'scanning'",
        )
        .run(id);
      if (claimed.changes === 0)
        return reply.code(409).send({ error: "Scan already running" });
      void runBackgroundScan(folder, request.log);
      return reply.code(202).send({ folder_id: id, status: "scanning" });
    },
  );

  // View-triggered rescan: the client pings this when a user OPENS a category
  // page, so exactly the folders behind the current screen refresh — no
  // filesystem watcher, no whole-library sweeps. Cooldown state is in-process
  // on purpose: last_scanned only advances on success, and a folder stuck in
  // 'error' (unmounted drive) must not re-walk on every page view.
  const lastAutoRescan = new Map<number, number>();
  const scanningInCategory = (slug: string, includeHidden: boolean): boolean =>
    !!db
      .prepare(
        `SELECT 1 FROM library_folders WHERE category = ? AND scan_status = 'scanning'${includeHidden ? "" : " AND is_visible = 1"} LIMIT 1`,
      )
      .get(slug);

  app.post<{ Params: { slug: string } }>(
    "/library/categories/:slug/refresh",
    { preHandler: auth },
    async (request) => {
      const { slug } = request.params;
      const admin = request.user!.role === "admin";
      const cooldownMs = config.autoRescanCooldownSeconds * 1000;
      // Feature off still reports REAL scanning state — an admin-triggered
      // scan should let open pages poll and refresh when it lands.
      if (cooldownMs === 0)
        return { started: 0, scanning: scanningInCategory(slug, admin) };
      // Non-admins may only refresh — and observe — folders they can see; a
      // hidden category answers exactly like an empty one.
      const folders = db
        .prepare(
          `SELECT * FROM library_folders WHERE category = ?${admin ? "" : " AND is_visible = 1"}`,
        )
        .all(slug) as LibraryFolder[];
      const claimed: LibraryFolder[] = [];
      const now = Date.now();
      for (const folder of folders) {
        if (now - (lastAutoRescan.get(folder.id) ?? 0) < cooldownMs) continue;
        // Same atomic claim as the admin route — never two scans of a folder.
        const claim = db
          .prepare(
            "UPDATE library_folders SET scan_status = 'scanning' WHERE id = ? AND scan_status != 'scanning'",
          )
          .run(folder.id);
        if (claim.changes === 0) continue;
        lastAutoRescan.set(folder.id, now);
        claimed.push(folder);
      }
      // SEQUENTIAL on purpose: a multi-folder category must not fan out N
      // concurrent walks + ffprobe chains from one page view. Claims were
      // all taken above, so a later folder can't be double-started while it
      // waits its turn. runBackgroundScan never rejects.
      if (claimed.length > 0) {
        void (async () => {
          for (const folder of claimed)
            await runBackgroundScan(folder, request.log);
        })();
      }
      return {
        started: claimed.length,
        scanning: claimed.length > 0 || scanningInCategory(slug, admin),
      };
    },
  );

  // Cheap poll target for the client while a view-triggered refresh runs.
  app.get<{ Params: { slug: string } }>(
    "/library/categories/:slug/scan-status",
    { preHandler: auth },
    async (request) => ({
      scanning: scanningInCategory(
        request.params.slug,
        request.user!.role === "admin",
      ),
    }),
  );
}
