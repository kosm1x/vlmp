import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import type { Config } from "../config.js";
import { authMiddleware, adminOnly } from "../auth/middleware.js";

// Windows dirs that are never sensible library folders and only produce
// EACCES noise when entered.
const WIN_JUNK = new Set(["$RECYCLE.BIN", "System Volume Information"]);

async function listDrives(): Promise<string[]> {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const checks = await Promise.all(
    [...letters].map(async (l) => {
      try {
        await stat(`${l}:\\`);
        return `${l}:\\`;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((d): d is string => d !== null);
}

// Directory browser backing the Settings folder picker. Admin-only by design:
// admins already point the scanner at arbitrary server paths, so listing
// directory NAMES grants nothing they don't have. Never lists files.
export function registerFsRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: Config,
) {
  const auth = authMiddleware(config, db);

  app.get<{ Querystring: { path?: string } }>(
    "/admin/fs/dirs",
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const requested = request.query.path;

      // No path: platform root — drive list on Windows, / elsewhere.
      if (!requested) {
        if (process.platform === "win32") {
          const drives = await listDrives();
          return reply.send({
            path: null,
            parent: null,
            dirs: drives.map((d) => ({ name: d, path: d })),
          });
        }
        return listDir(reply, "/");
      }
      return listDir(reply, resolve(requested));
    },
  );

  async function listDir(
    reply: {
      send: (body: unknown) => unknown;
      code: (c: number) => { send: (body: unknown) => unknown };
    },
    path: string,
  ) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return reply.code(400).send({ error: `Cannot read directory: ${path}` });
    }
    const dirs = entries
      .filter(
        (e) =>
          e.isDirectory() && !e.name.startsWith(".") && !WIN_JUNK.has(e.name),
      )
      .map((e) => ({ name: e.name, path: join(path, e.name) }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    // At a filesystem root, "up" leaves the tree: on Windows that goes back to
    // the drive list (parent null + path non-null), on POSIX it disappears.
    const { root } = parse(path);
    const parent = path === root ? null : dirname(path);
    return reply.send({ path, parent, dirs });
  }
}
