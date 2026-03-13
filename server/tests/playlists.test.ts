import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import {
  createPlaylist,
  getUserPlaylists,
  getPlaylistWithItems,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  reorderPlaylist,
} from "../src/media/playlists.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  // Create test user
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("testuser", "hash", "user");
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("otheruser", "hash", "user");
  // Create library folder and media items
  db.prepare("INSERT INTO library_folders (path, category) VALUES (?, ?)").run(
    "/test/movies",
    "movies",
  );
  db.prepare(
    "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "movie", "/test/movies/a.mp4", "Movie A", "movie a");
  db.prepare(
    "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "movie", "/test/movies/b.mp4", "Movie B", "movie b");
  db.prepare(
    "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "movie", "/test/movies/c.mp4", "Movie C", "movie c");
});

afterEach(() => {
  db.close();
});

describe("playlist CRUD", () => {
  it("should create a playlist", () => {
    const playlist = createPlaylist(db, 1, "My Favorites");
    expect(playlist.id).toBeDefined();
    expect(playlist.name).toBe("My Favorites");
    expect(playlist.user_id).toBe(1);
  });

  it("should list user playlists with item count", () => {
    createPlaylist(db, 1, "Playlist 1");
    createPlaylist(db, 1, "Playlist 2");
    createPlaylist(db, 2, "Other User Playlist");

    const playlists = getUserPlaylists(db, 1);
    expect(playlists).toHaveLength(2);
    expect(playlists[0].item_count).toBe(0);
  });

  it("should not list other users playlists", () => {
    createPlaylist(db, 1, "User 1 Playlist");
    createPlaylist(db, 2, "User 2 Playlist");

    const user1 = getUserPlaylists(db, 1);
    const user2 = getUserPlaylists(db, 2);
    expect(user1).toHaveLength(1);
    expect(user2).toHaveLength(1);
    expect(user1[0].name).toBe("User 1 Playlist");
    expect(user2[0].name).toBe("User 2 Playlist");
  });

  it("should rename a playlist", () => {
    const playlist = createPlaylist(db, 1, "Old Name");
    const result = renamePlaylist(db, playlist.id, 1, "New Name");
    expect(result).toBe(true);

    const updated = getPlaylistWithItems(db, playlist.id, 1);
    expect(updated?.name).toBe("New Name");
  });

  it("should not rename another users playlist", () => {
    const playlist = createPlaylist(db, 1, "My Playlist");
    const result = renamePlaylist(db, playlist.id, 2, "Hijacked");
    expect(result).toBe(false);
  });

  it("should delete a playlist", () => {
    const playlist = createPlaylist(db, 1, "To Delete");
    const result = deletePlaylist(db, playlist.id, 1);
    expect(result).toBe(true);

    const playlists = getUserPlaylists(db, 1);
    expect(playlists).toHaveLength(0);
  });

  it("should not delete another users playlist", () => {
    const playlist = createPlaylist(db, 1, "Protected");
    const result = deletePlaylist(db, playlist.id, 2);
    expect(result).toBe(false);

    const playlists = getUserPlaylists(db, 1);
    expect(playlists).toHaveLength(1);
  });
});

describe("playlist items", () => {
  it("should add items to a playlist with auto-incrementing position", () => {
    const playlist = createPlaylist(db, 1, "Watch List");

    const item1 = addToPlaylist(db, playlist.id, 1, 1);
    const item2 = addToPlaylist(db, playlist.id, 1, 2);

    expect(item1?.position).toBe(1);
    expect(item2?.position).toBe(2);
  });

  it("should not add items to another users playlist", () => {
    const playlist = createPlaylist(db, 1, "My Playlist");
    const result = addToPlaylist(db, playlist.id, 2, 1);
    expect(result).toBeNull();
  });

  it("should get playlist with items and media details", () => {
    const playlist = createPlaylist(db, 1, "Full Playlist");
    addToPlaylist(db, playlist.id, 1, 1);
    addToPlaylist(db, playlist.id, 1, 2);

    const full = getPlaylistWithItems(db, playlist.id, 1);
    expect(full).not.toBeNull();
    expect(full!.items).toHaveLength(2);
    expect(full!.items[0].title).toBe("Movie A");
    expect(full!.items[1].title).toBe("Movie B");
  });

  it("should remove items from a playlist", () => {
    const playlist = createPlaylist(db, 1, "Shrinking List");
    const item = addToPlaylist(db, playlist.id, 1, 1);

    const result = removeFromPlaylist(db, playlist.id, 1, item!.id);
    expect(result).toBe(true);

    const full = getPlaylistWithItems(db, playlist.id, 1);
    expect(full!.items).toHaveLength(0);
  });

  it("should not remove items from another users playlist", () => {
    const playlist = createPlaylist(db, 1, "Protected");
    const item = addToPlaylist(db, playlist.id, 1, 1);

    const result = removeFromPlaylist(db, playlist.id, 2, item!.id);
    expect(result).toBe(false);
  });
});

describe("playlist reorder", () => {
  it("should reorder playlist items", () => {
    const playlist = createPlaylist(db, 1, "Reorder Test");
    const item1 = addToPlaylist(db, playlist.id, 1, 1);
    const item2 = addToPlaylist(db, playlist.id, 1, 2);
    const item3 = addToPlaylist(db, playlist.id, 1, 3);

    // Reverse order
    const result = reorderPlaylist(db, playlist.id, 1, [
      item3!.id,
      item2!.id,
      item1!.id,
    ]);
    expect(result).toBe(true);

    const full = getPlaylistWithItems(db, playlist.id, 1);
    expect(full!.items[0].media_id).toBe(3); // Movie C first
    expect(full!.items[1].media_id).toBe(2); // Movie B second
    expect(full!.items[2].media_id).toBe(1); // Movie A third
  });

  it("should not reorder another users playlist", () => {
    const playlist = createPlaylist(db, 1, "Protected");
    addToPlaylist(db, playlist.id, 1, 1);

    const result = reorderPlaylist(db, playlist.id, 2, [1]);
    expect(result).toBe(false);
  });
});
