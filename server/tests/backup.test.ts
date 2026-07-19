import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import { runBackup } from "../src/db/backup.js";

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  dir = mkdtempSync(join(tmpdir(), "vlmp-backup-"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function countBackups() {
  return readdirSync(dir).filter(
    (f) => f.startsWith("vlmp-") && f.endsWith(".db"),
  ).length;
}

describe("db backup", () => {
  it("writes a restorable backup file", async () => {
    const dest = await runBackup(db, {
      backupDir: dir,
      backupRetention: 7,
    } as never);
    expect(countBackups()).toBe(1);
    // The backup opens as a valid SQLite DB with our schema.
    const restored = new Database(dest);
    const cols = restored
      .prepare("PRAGMA table_info(library_folders)")
      .all() as { name: string }[];
    expect(cols.some((c) => c.name === "is_visible")).toBe(true);
    restored.close();
  });

  it("retention keeps only the newest N backups", async () => {
    const cfg = { backupDir: dir, backupRetention: 2 } as never;
    await runBackup(db, cfg);
    await runBackup(db, cfg);
    await runBackup(db, cfg);
    await runBackup(db, cfg);
    expect(countBackups()).toBe(2);
  });
});
