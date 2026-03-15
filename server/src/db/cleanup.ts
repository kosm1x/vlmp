import type Database from "better-sqlite3";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const AI_CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function runCleanup(db: Database.Database): void {
  const cleanup = db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE expires_at < unixepoch()").run();
    db.prepare("DELETE FROM guest_passes WHERE expires_at < unixepoch()").run();
    db.prepare(
      "DELETE FROM federation_invites WHERE expires_at < unixepoch()",
    ).run();
    db.prepare("DELETE FROM ai_cache WHERE computed_at < unixepoch() - ?").run(
      AI_CACHE_MAX_AGE_SECONDS,
    );
  });
  cleanup();
}

export function startCleanupLoop(
  db: Database.Database,
): ReturnType<typeof setInterval> {
  runCleanup(db);
  return setInterval(() => runCleanup(db), CLEANUP_INTERVAL_MS);
}
