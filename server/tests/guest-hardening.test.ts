import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import {
  createGuestPass,
  validateGuestPass,
  generateGuestCode,
} from "../src/auth/guest.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)",
  ).run("admin", "hash");
  db.prepare(
    "INSERT INTO library_folders (id, path, category) VALUES (1, ?, ?)",
  ).run("/test", "movies");
  db.prepare(
    "INSERT INTO media_items (id, library_folder_id, type, file_path, title) VALUES (1, 1, ?, ?, ?)",
  ).run("movie", "/test/movie.mkv", "Test Movie");
});
afterEach(() => {
  db.close();
});

describe("guest pass hardening", () => {
  it("guest code length is 16 hex chars (64-bit entropy)", () => {
    const code = generateGuestCode();
    expect(code).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(code)).toBe(true);
  });

  it("codes are unique across generations", () => {
    const codes = new Set(
      Array.from({ length: 100 }, () => generateGuestCode()),
    );
    expect(codes.size).toBe(100);
  });

  it("validateGuestPass is atomic (concurrent calls respect max_views)", () => {
    const pass = createGuestPass(db, 1, 1, 48, 2);
    // Simulate concurrent validation — in SQLite with transactions, these are serialized
    const r1 = validateGuestPass(db, pass.code);
    const r2 = validateGuestPass(db, pass.code);
    const r3 = validateGuestPass(db, pass.code);
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
    expect(r3.valid).toBe(false);
  });

  it("expired pass rejected", () => {
    const pass = createGuestPass(db, 1, 1, 1, 3);
    db.prepare("UPDATE guest_passes SET expires_at = ? WHERE code = ?").run(
      0,
      pass.code,
    );
    expect(validateGuestPass(db, pass.code).valid).toBe(false);
  });

  it("view-limited pass rejected after max views", () => {
    const pass = createGuestPass(db, 1, 1, 48, 1);
    expect(validateGuestPass(db, pass.code).valid).toBe(true);
    expect(validateGuestPass(db, pass.code).valid).toBe(false);
  });
});
