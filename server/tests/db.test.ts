import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
});
afterEach(() => {
  db.close();
});

describe("schema", () => {
  it("creates all tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of [
      "users",
      "sessions",
      "guest_passes",
      "library_folders",
      "media_items",
      "tv_shows",
      "seasons",
      "episodes",
      "doc_series",
      "doc_series_episodes",
      "watch_progress",
      "playlists",
      "playlist_items",
      "subtitles",
      "metadata_cache",
      "federated_servers",
      "schema_version",
      "viewing_log",
      "user_preferences",
      "ai_cache",
    ]) {
      expect(names).toContain(t);
    }
  });
  it("tracks schema version", () => {
    const row = db.prepare("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(1);
  });
  it("is idempotent", () => {
    expect(() => initSchema(db)).not.toThrow();
  });
  it("enforces unique username", () => {
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
      "alice",
      "hash1",
    );
    expect(() =>
      db
        .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
        .run("alice", "hash2"),
    ).toThrow();
  });
  it("enforces foreign keys", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (user_id, refresh_token, expires_at) VALUES (?, ?, ?)",
        )
        .run(999, "tok", 0),
    ).toThrow();
  });
  it("cascades user deletion", () => {
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
      "bob",
      "hash",
    );
    const user = db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get("bob") as { id: number };
    db.prepare(
      "INSERT INTO sessions (user_id, refresh_token, expires_at) VALUES (?, ?, ?)",
    ).run(user.id, "tok1", 9999999999);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    expect(
      db.prepare("SELECT * FROM sessions WHERE user_id = ?").all(user.id),
    ).toHaveLength(0);
  });
});
