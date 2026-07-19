import type Database from "better-sqlite3";

export interface Playlist {
  id: number;
  user_id: number;
  name: string;
  created_at: string;
  item_count?: number;
}

export interface PlaylistItem {
  id: number;
  playlist_id: number;
  media_id: number;
  position: number;
  title?: string;
  poster_path?: string | null;
  duration?: number | null;
}

export interface PlaylistWithItems extends Playlist {
  items: PlaylistItem[];
}

export function createPlaylist(
  db: Database.Database,
  userId: number,
  name: string,
): Playlist {
  const result = db
    .prepare("INSERT INTO playlists (user_id, name) VALUES (?, ?) RETURNING *")
    .get(userId, name) as Playlist;
  return result;
}

export function getUserPlaylists(
  db: Database.Database,
  userId: number,
): Playlist[] {
  return db
    .prepare(
      "SELECT p.*, COUNT(pi.id) as item_count FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id = p.id WHERE p.user_id = ? GROUP BY p.id ORDER BY p.created_at DESC",
    )
    .all(userId) as Playlist[];
}

export function getPlaylistWithItems(
  db: Database.Database,
  playlistId: number,
  userId: number,
  includeHidden: boolean = false,
): PlaylistWithItems | null {
  const playlist = db
    .prepare("SELECT * FROM playlists WHERE id = ? AND user_id = ?")
    .get(playlistId, userId) as Playlist | undefined;
  if (!playlist) return null;

  // Library gate: a non-admin's playlist view drops items whose library was
  // hidden after they were added (also drops deleted-media placeholder rows).
  const gate = includeHidden
    ? ""
    : "AND pi.media_id IN (SELECT id FROM media_items WHERE library_folder_id IN (SELECT id FROM library_folders WHERE is_visible = 1))";
  const items = db
    .prepare(
      `SELECT pi.*, mi.title, mi.poster_path, mi.duration FROM playlist_items pi LEFT JOIN media_items mi ON mi.id = pi.media_id WHERE pi.playlist_id = ? ${gate} ORDER BY pi.position`,
    )
    .all(playlistId) as PlaylistItem[];

  return { ...playlist, items };
}

export function renamePlaylist(
  db: Database.Database,
  playlistId: number,
  userId: number,
  name: string,
): boolean {
  const result = db
    .prepare("UPDATE playlists SET name = ? WHERE id = ? AND user_id = ?")
    .run(name, playlistId, userId);
  return result.changes > 0;
}

export function deletePlaylist(
  db: Database.Database,
  playlistId: number,
  userId: number,
): boolean {
  const result = db
    .prepare("DELETE FROM playlists WHERE id = ? AND user_id = ?")
    .run(playlistId, userId);
  return result.changes > 0;
}

export function addToPlaylist(
  db: Database.Database,
  playlistId: number,
  userId: number,
  mediaId: number,
  includeHidden: boolean = false,
): PlaylistItem | null {
  // Verify ownership
  const playlist = db
    .prepare("SELECT id FROM playlists WHERE id = ? AND user_id = ?")
    .get(playlistId, userId);
  if (!playlist) return null;

  // Verify media exists AND (for non-admins) is in a visible library, so a
  // hidden title can't be smuggled into a playlist by its id.
  const media = includeHidden
    ? db.prepare("SELECT id FROM media_items WHERE id = ?").get(mediaId)
    : db
        .prepare(
          "SELECT id FROM media_items WHERE id = ? AND library_folder_id IN (SELECT id FROM library_folders WHERE is_visible = 1)",
        )
        .get(mediaId);
  if (!media) return null;

  const maxPos = db
    .prepare(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM playlist_items WHERE playlist_id = ?",
    )
    .get(playlistId) as { max_pos: number };

  return db
    .prepare(
      "INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?) RETURNING *",
    )
    .get(playlistId, mediaId, maxPos.max_pos + 1) as PlaylistItem;
}

export function removeFromPlaylist(
  db: Database.Database,
  playlistId: number,
  userId: number,
  itemId: number,
): boolean {
  // Verify ownership
  const playlist = db
    .prepare("SELECT id FROM playlists WHERE id = ? AND user_id = ?")
    .get(playlistId, userId);
  if (!playlist) return false;

  const result = db
    .prepare("DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?")
    .run(itemId, playlistId);
  return result.changes > 0;
}

export function reorderPlaylist(
  db: Database.Database,
  playlistId: number,
  userId: number,
  itemIds: number[],
): boolean {
  // Verify ownership
  const playlist = db
    .prepare("SELECT id FROM playlists WHERE id = ? AND user_id = ?")
    .get(playlistId, userId);
  if (!playlist) return false;

  const update = db.prepare(
    "UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?",
  );
  const txn = db.transaction(() => {
    // First pass: set all to negative (avoids UNIQUE constraint on position)
    for (let i = 0; i < itemIds.length; i++) {
      update.run(-(i + 1), itemIds[i], playlistId);
    }
    // Second pass: set to final positive positions
    for (let i = 0; i < itemIds.length; i++) {
      update.run(i + 1, itemIds[i], playlistId);
    }
  });
  txn();
  return true;
}
