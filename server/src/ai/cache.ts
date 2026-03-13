import type Database from "better-sqlite3";

export function getCachedResult<T = unknown>(
  db: Database.Database,
  userId: number,
  cacheKey: string,
  ttlSeconds = 3600,
): T | null {
  const row = db
    .prepare(
      "SELECT data_json, computed_at FROM ai_cache WHERE user_id = ? AND cache_key = ? AND computed_at > unixepoch() - ?",
    )
    .get(userId, cacheKey, ttlSeconds) as
    | { data_json: string; computed_at: number }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data_json) as T;
  } catch {
    return null;
  }
}

export function setCachedResult(
  db: Database.Database,
  userId: number,
  cacheKey: string,
  data: unknown,
): void {
  db.prepare(
    "INSERT INTO ai_cache (user_id, cache_key, data_json, computed_at) VALUES (?, ?, ?, unixepoch()) ON CONFLICT(user_id, cache_key) DO UPDATE SET data_json = excluded.data_json, computed_at = unixepoch()",
  ).run(userId, cacheKey, JSON.stringify(data));
}

export function invalidateCache(
  db: Database.Database,
  userId: number,
  cacheKey?: string,
): void {
  if (cacheKey) {
    db.prepare("DELETE FROM ai_cache WHERE user_id = ? AND cache_key = ?").run(
      userId,
      cacheKey,
    );
  } else {
    db.prepare("DELETE FROM ai_cache WHERE user_id = ?").run(userId);
  }
}
