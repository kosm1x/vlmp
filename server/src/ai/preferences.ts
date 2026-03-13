import type Database from "better-sqlite3";

export interface UserPreference {
  id: number;
  user_id: number;
  media_id: number;
  action: "like" | "dislike";
  created_at: number;
}

export function setPreference(
  db: Database.Database,
  userId: number,
  mediaId: number,
  action: "like" | "dislike",
): void {
  db.prepare(
    "INSERT INTO user_preferences (user_id, media_id, action) VALUES (?, ?, ?) ON CONFLICT(user_id, media_id) DO UPDATE SET action = excluded.action, created_at = unixepoch()",
  ).run(userId, mediaId, action);
}

export function removePreference(
  db: Database.Database,
  userId: number,
  mediaId: number,
): boolean {
  const result = db
    .prepare("DELETE FROM user_preferences WHERE user_id = ? AND media_id = ?")
    .run(userId, mediaId);
  return result.changes > 0;
}

export function getUserPreferences(
  db: Database.Database,
  userId: number,
): UserPreference[] {
  return db
    .prepare(
      "SELECT * FROM user_preferences WHERE user_id = ? ORDER BY created_at DESC",
    )
    .all(userId) as UserPreference[];
}

export function getLikedMediaIds(
  db: Database.Database,
  userId: number,
): number[] {
  const rows = db
    .prepare(
      "SELECT media_id FROM user_preferences WHERE user_id = ? AND action = 'like'",
    )
    .all(userId) as { media_id: number }[];
  return rows.map((r) => r.media_id);
}

export function getDislikedMediaIds(
  db: Database.Database,
  userId: number,
): number[] {
  const rows = db
    .prepare(
      "SELECT media_id FROM user_preferences WHERE user_id = ? AND action = 'dislike'",
    )
    .all(userId) as { media_id: number }[];
  return rows.map((r) => r.media_id);
}
