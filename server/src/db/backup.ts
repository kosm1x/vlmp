import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";

const PREFIX = "vlmp-";
const SUFFIX = ".db";

// Online backup of the live SQLite DB. better-sqlite3's backup() is WAL-safe
// (copies a consistent snapshot without blocking writers). Timestamp avoids
// ':' so filenames are valid on Windows too.
export async function runBackup(
  db: Database.Database,
  config: Config,
): Promise<string> {
  mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(config.backupDir, `${PREFIX}${stamp}${SUFFIX}`);
  await db.backup(dest);
  pruneOldBackups(config);
  return dest;
}

// Keep the newest `backupRetention` backups; delete the rest.
function pruneOldBackups(config: Config): void {
  let entries: string[];
  try {
    entries = readdirSync(config.backupDir);
  } catch {
    return;
  }
  const backups = entries
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .flatMap((f) => {
      const path = join(config.backupDir, f);
      try {
        return [{ path, mtime: statSync(path).mtimeMs }];
      } catch {
        // Vanished or locked (Windows AV scans backups) — skip this entry
        // rather than aborting the whole prune.
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of backups.slice(config.backupRetention)) {
    try {
      unlinkSync(stale.path);
    } catch {
      /* best effort */
    }
  }
}

// interval 0 disables scheduled backups. A throw inside the timer must never
// escape (a full disk would otherwise take down the process).
export function startBackupLoop(
  db: Database.Database,
  config: Config,
): ReturnType<typeof setInterval> | null {
  if (config.backupIntervalHours <= 0) return null;
  const run = () => {
    runBackup(db, config).catch((err) =>
      console.error("[backup] scheduled backup failed:", err),
    );
  };
  run(); // take one at startup so a fresh deploy is covered immediately
  return setInterval(run, config.backupIntervalHours * 60 * 60 * 1000);
}
