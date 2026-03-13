import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import {
  setPreference,
  removePreference,
  getUserPreferences,
  getLikedMediaIds,
  getDislikedMediaIds,
} from "../src/ai/preferences.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("user1", "hash", "user");
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("user2", "hash", "user");
  db.prepare("INSERT INTO library_folders (path, category) VALUES (?, ?)").run(
    "/test/movies",
    "movies",
  );
  for (let i = 1; i <= 3; i++) {
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "movie", `/test/movies/${i}.mp4`, `Movie ${i}`, `movie ${i}`);
  }
});

afterEach(() => {
  db.close();
});

describe("preferences", () => {
  it("creates a like preference", () => {
    setPreference(db, 1, 1, "like");
    const prefs = getUserPreferences(db, 1);
    expect(prefs).toHaveLength(1);
    expect(prefs[0].action).toBe("like");
    expect(prefs[0].media_id).toBe(1);
  });

  it("creates a dislike preference", () => {
    setPreference(db, 1, 2, "dislike");
    const disliked = getDislikedMediaIds(db, 1);
    expect(disliked).toEqual([2]);
  });

  it("toggles from like to dislike via upsert", () => {
    setPreference(db, 1, 1, "like");
    setPreference(db, 1, 1, "dislike");
    const prefs = getUserPreferences(db, 1);
    expect(prefs).toHaveLength(1);
    expect(prefs[0].action).toBe("dislike");
  });

  it("removes a preference", () => {
    setPreference(db, 1, 1, "like");
    const result = removePreference(db, 1, 1);
    expect(result).toBe(true);
    expect(getUserPreferences(db, 1)).toHaveLength(0);
  });

  it("remove nonexistent returns false", () => {
    const result = removePreference(db, 1, 99);
    expect(result).toBe(false);
  });

  it("lists only user's own preferences", () => {
    setPreference(db, 1, 1, "like");
    setPreference(db, 1, 2, "dislike");
    setPreference(db, 2, 3, "like");

    const user1Prefs = getUserPreferences(db, 1);
    const user2Prefs = getUserPreferences(db, 2);
    expect(user1Prefs).toHaveLength(2);
    expect(user2Prefs).toHaveLength(1);
    expect(user2Prefs[0].media_id).toBe(3);
  });

  it("getLikedMediaIds returns only liked", () => {
    setPreference(db, 1, 1, "like");
    setPreference(db, 1, 2, "dislike");
    setPreference(db, 1, 3, "like");
    const liked = getLikedMediaIds(db, 1);
    expect(liked.sort()).toEqual([1, 3]);
  });
});
