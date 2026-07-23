import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { authMiddleware, adminOnly } from "../auth/middleware.js";
import { searchMovie, searchTV } from "../metadata/tmdb.js";
import {
  matchAndApplyMetadata,
  matchAndApplyShowMetadata,
  applyManualMatch,
  metadataStaleCutoff,
} from "../metadata/matcher.js";
import { parseIntParam } from "./params.js";
import { getOrCreateThumb } from "../metadata/thumbs.js";
import { classifyMedia } from "../scanner/classify.js";
import { getCategoryBySlug } from "../media/categories.js";
import { isMediaFolderVisible } from "../media/library.js";
import { createReadStream } from "node:fs";

let metadataScanState = {
  inProgress: false,
  total: 0,
  done: 0,
  matched: 0,
  failed: 0,
};

export function registerMetadataRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
): void {
  const auth = authMiddleware(config, db);

  // Frame-grab thumbnail fallback for media without a TMDb poster. Same
  // access boundary as media detail: non-admins only reach media in visible
  // folders (404, not 403 — existence must not leak). The client fetches this
  // with the Authorization header and renders a blob URL.
  app.get<{ Params: { id: string } }>(
    "/media/:id/thumb",
    { preHandler: auth },
    async (request, reply) => {
      const id = parseIntParam(request.params.id, "id");
      if (request.user!.role !== "admin" && !isMediaFolderVisible(db, id))
        return reply.code(404).send({ error: "Not found" });
      const path = await getOrCreateThumb(db, id, config);
      if (!path) return reply.code(404).send({ error: "No thumbnail" });
      reply.header("Content-Type", "image/jpeg");
      // private: thumbs sit behind auth; immutable-ish: regenerated only if
      // the thumbs dir is wiped, so a day of client caching is safe.
      reply.header("Cache-Control", "private, max-age=86400");
      return reply.send(createReadStream(path));
    },
  );

  app.get<{ Querystring: { q: string; type?: string; year?: string } }>(
    "/metadata/search",
    { preHandler: auth },
    async (request, reply) => {
      const { q, type, year } = request.query;
      if (!q)
        return reply.code(400).send({ error: 'Query parameter "q" required' });
      if (!config.tmdbApiKey)
        return reply.code(503).send({ error: "TMDb API key not configured" });
      const yearNum = year ? parseInt(year, 10) : null;
      const results =
        type === "tv"
          ? await searchTV(q, yearNum, config.tmdbApiKey)
          : await searchMovie(q, yearNum, config.tmdbApiKey);
      return { results };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { tmdb_id?: number; media_type?: "movie" | "tv" };
  }>(
    "/admin/metadata/:id/match",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const mediaId = parseIntParam(request.params.id, "id");
      if (!config.tmdbApiKey)
        return reply.code(503).send({ error: "TMDb API key not configured" });
      const { tmdb_id, media_type } = request.body || {};
      let matched: boolean;
      if (tmdb_id && media_type) {
        matched = await applyManualMatch(
          db,
          mediaId,
          tmdb_id,
          media_type,
          config,
        );
      } else {
        // Explicit admin action: bypass a remembered no-match and try again.
        matched = await matchAndApplyMetadata(db, mediaId, config, true);
      }
      return { matched, media_id: mediaId };
    },
  );

  app.post<{ Body: { folder_id?: number; full?: boolean } }>(
    "/admin/metadata/scan",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      if (!config.tmdbApiKey)
        return reply.code(503).send({ error: "TMDb API key not configured" });
      if (metadataScanState.inProgress)
        return reply
          .code(409)
          .send({ error: "Metadata scan already in progress" });
      const { folder_id, full } = request.body || {};
      // Incremental by default: only items with no artwork AND no fresh cache
      // row — i.e. the newly added and the never-matched — so a re-run doesn't
      // walk (and re-throttle over) the whole already-matched library. A
      // remembered no-match caches with fetched_at, so unmatchable files are
      // skipped too until the row goes stale. `full: true` forces every item.
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (!full) {
        conditions.push(
          "m.poster_path IS NULL AND NOT EXISTS (SELECT 1 FROM metadata_cache mc WHERE mc.media_id = m.id AND mc.provider = 'tmdb' AND mc.fetched_at > ?)",
        );
        params.push(metadataStaleCutoff());
      }
      if (folder_id) {
        conditions.push("m.library_folder_id = ?");
        params.push(folder_id);
      }
      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";
      const items = db
        .prepare(
          `SELECT m.id, m.file_path, m.poster_path, f.path AS folder_path, f.category
           FROM media_items m JOIN library_folders f ON f.id = m.library_folder_id ${where}`,
        )
        .all(...params) as {
        id: number;
        file_path: string;
        poster_path: string | null;
        folder_path: string;
        category: string;
      }[];
      metadataScanState = {
        inProgress: true,
        total: items.length,
        done: 0,
        matched: 0,
        failed: 0,
      };
      // Fire-and-forget with status polling: at 300ms/item (TMDb ~40 req/10s)
      // a few thousand items take many minutes — holding the request open
      // meant proxy idle-timeouts killed the response mid-scan.
      runMetadataBackfill(items).catch((err) =>
        request.log.error({ err }, "metadata backfill crashed"),
      );
      return reply.code(202).send({ total: items.length, status: "running" });
    },
  );

  app.get(
    "/admin/metadata/scan/status",
    { preHandler: [auth, adminOnly] },
    async () => metadataScanState,
  );

  async function runMetadataBackfill(
    items: {
      id: number;
      file_path: string;
      poster_path: string | null;
      folder_path: string;
      category: string;
    }[],
  ) {
    try {
      for (const item of items) {
        try {
          // Unmatched items get re-classified from the file path first: rows
          // scanned by older classifier versions carry release-junk titles
          // ("300" stored as "720P BRRIP XVID…") that TMDb can never match.
          // Matched items are left alone — their titles came from TMDb.
          if (!item.poster_path) {
            const c = classifyMedia(
              item.file_path,
              item.folder_path,
              getCategoryBySlug(db, item.category) ?? {
                slug: item.category,
                kind: "movie",
              },
            );
            const sortTitle = c.title
              .replace(/^(?:the|a|an)\s+/i, "")
              .toLowerCase();
            db.prepare(
              "UPDATE media_items SET title = ?, sort_title = ?, year = ? WHERE id = ?",
            ).run(c.title, sortTitle, c.year, item.id);
          }
          const result = await matchAndApplyMetadata(db, item.id, config);
          if (result) metadataScanState.matched++;
          // Throttle: 300ms between requests (respects TMDb ~40 req/10s limit)
          await new Promise((r) => setTimeout(r, 300));
        } catch {
          metadataScanState.failed++;
        } finally {
          metadataScanState.done++;
        }
      }
    } finally {
      metadataScanState.inProgress = false;
    }
  }

  app.post<{ Params: { showId: string } }>(
    "/admin/metadata/tv/:showId/match",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const showId = parseIntParam(request.params.showId, "showId");
      if (!config.tmdbApiKey)
        return reply.code(503).send({ error: "TMDb API key not configured" });
      const matched = await matchAndApplyShowMetadata(db, showId, config, true);
      return { matched, show_id: showId };
    },
  );
}
