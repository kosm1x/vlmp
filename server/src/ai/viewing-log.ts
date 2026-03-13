import type Database from "better-sqlite3";

const DEDUP_WINDOW_SECONDS = 300; // 5 minutes

export function logViewingEvent(
  db: Database.Database,
  userId: number,
  mediaId: number,
  positionSeconds: number,
  durationSeconds: number | null,
  completed: boolean,
): void {
  if (!completed) {
    // Check dedup window for non-completion events
    const recent = db
      .prepare(
        "SELECT id FROM viewing_log WHERE user_id = ? AND media_id = ? AND completed = 0 AND watched_at > unixepoch() - ?",
      )
      .get(userId, mediaId, DEDUP_WINDOW_SECONDS);
    if (recent) return;
  }

  db.prepare(
    "INSERT INTO viewing_log (user_id, media_id, position_seconds, duration_seconds, completed) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, mediaId, positionSeconds, durationSeconds, completed ? 1 : 0);
}

export function getUserViewingHistory(
  db: Database.Database,
  userId: number,
  limit = 100,
): {
  id: number;
  media_id: number;
  watched_at: number;
  position_seconds: number;
  duration_seconds: number | null;
  completed: number;
}[] {
  return db
    .prepare(
      "SELECT * FROM viewing_log WHERE user_id = ? ORDER BY watched_at DESC LIMIT ?",
    )
    .all(userId, limit) as any[];
}

export function getCompletedMediaIds(
  db: Database.Database,
  userId: number,
): number[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT media_id FROM viewing_log WHERE user_id = ? AND completed = 1",
    )
    .all(userId) as { media_id: number }[];
  return rows.map((r) => r.media_id);
}

export function getRecentCompletedMediaIds(
  db: Database.Database,
  userId: number,
  limit = 3,
): number[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT media_id FROM viewing_log WHERE user_id = ? AND completed = 1 ORDER BY watched_at DESC LIMIT ?",
    )
    .all(userId, limit) as { media_id: number }[];
  return rows.map((r) => r.media_id);
}
