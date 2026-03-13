import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import {
  logViewingEvent,
  getUserViewingHistory,
  getCompletedMediaIds,
  getRecentCompletedMediaIds,
} from "../src/ai/viewing-log.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("testuser", "hash", "user");
  db.prepare("INSERT INTO library_folders (path, category) VALUES (?, ?)").run(
    "/test/movies",
    "movies",
  );
  for (let i = 1; i <= 5; i++) {
    db.prepare(
      "INSERT INTO media_items (library_folder_id, type, file_path, title, sort_title, duration) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      1,
      "movie",
      `/test/movies/${i}.mp4`,
      `Movie ${i}`,
      `movie ${i}`,
      7200,
    );
  }
});

afterEach(() => {
  db.close();
});

describe("viewing log", () => {
  it("inserts on completion", () => {
    logViewingEvent(db, 1, 1, 7000, 7200, true);
    const history = getUserViewingHistory(db, 1);
    expect(history).toHaveLength(1);
    expect(history[0].completed).toBe(1);
    expect(history[0].media_id).toBe(1);
  });

  it("inserts when progress > 25%", () => {
    logViewingEvent(db, 1, 1, 2000, 7200, false);
    const history = getUserViewingHistory(db, 1);
    expect(history).toHaveLength(1);
    expect(history[0].completed).toBe(0);
  });

  it("inserts non-completion events (dedup relies on timestamp)", () => {
    logViewingEvent(db, 1, 1, 2000, 7200, false);
    // Second insert within dedup window is skipped
    logViewingEvent(db, 1, 1, 2500, 7200, false);
    const history = getUserViewingHistory(db, 1);
    expect(history).toHaveLength(1);
  });

  it("5-min dedup prevents duplicate non-completion entries", () => {
    logViewingEvent(db, 1, 1, 2000, 7200, false);
    // Simulate entry from 6 minutes ago to test window expiry
    db.prepare(
      "UPDATE viewing_log SET watched_at = unixepoch() - 360 WHERE id = 1",
    ).run();
    logViewingEvent(db, 1, 1, 3000, 7200, false);
    const history = getUserViewingHistory(db, 1);
    expect(history).toHaveLength(2);
  });

  it("completion always inserts even within dedup window", () => {
    logViewingEvent(db, 1, 1, 2000, 7200, false);
    logViewingEvent(db, 1, 1, 7000, 7200, true);
    const history = getUserViewingHistory(db, 1);
    expect(history).toHaveLength(2);
    expect(history.some((h) => h.completed === 1)).toBe(true);
  });

  it("getCompletedMediaIds returns correct IDs", () => {
    logViewingEvent(db, 1, 1, 7000, 7200, true);
    logViewingEvent(db, 1, 3, 7000, 7200, true);
    logViewingEvent(db, 1, 2, 2000, 7200, false);
    const ids = getCompletedMediaIds(db, 1);
    expect(ids.sort()).toEqual([1, 3]);
  });

  it("getRecentCompletedMediaIds returns most recent first", () => {
    logViewingEvent(db, 1, 1, 7000, 7200, true);
    // Stagger timestamps so ordering is deterministic
    db.prepare(
      "UPDATE viewing_log SET watched_at = unixepoch() - 200 WHERE media_id = 1",
    ).run();
    logViewingEvent(db, 1, 3, 7000, 7200, true);
    db.prepare(
      "UPDATE viewing_log SET watched_at = unixepoch() - 100 WHERE media_id = 3",
    ).run();
    logViewingEvent(db, 1, 5, 7000, 7200, true);
    const ids = getRecentCompletedMediaIds(db, 1, 2);
    expect(ids).toHaveLength(2);
    // Most recent completions first (5, then 3)
    expect(ids[0]).toBe(5);
    expect(ids[1]).toBe(3);
  });
});
