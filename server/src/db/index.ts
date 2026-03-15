import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";

let db: Database.Database | null = null;

export function getDatabase(config: Config): Database.Database {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("cache_size = -8000");
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.pragma("optimize");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
  }
}
