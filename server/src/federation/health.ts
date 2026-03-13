import type Database from "better-sqlite3";
import { federatedFetch } from "./client.js";
import type { Config } from "../config.js";

interface ServerRow {
  id: number;
  name: string;
  url: string;
  public_key: string;
  shared_secret: string;
  status: string;
}

const failureCounts = new Map<number, number>();

export function startHeartbeatLoop(
  db: Database.Database,
  config: Config,
): NodeJS.Timeout {
  return setInterval(
    async () => {
      const servers = db
        .prepare(
          "SELECT * FROM federated_servers WHERE status IN ('active', 'offline')",
        )
        .all() as ServerRow[];

      for (const server of servers) {
        try {
          const res = await federatedFetch(
            server,
            config,
            "POST",
            "/federation/heartbeat",
            { name: config.serverName },
          );

          if (res.ok) {
            failureCounts.set(server.id, 0);
            if (server.status === "offline") {
              db.prepare(
                "UPDATE federated_servers SET status = 'active', last_seen = unixepoch() WHERE id = ?",
              ).run(server.id);
            } else {
              db.prepare(
                "UPDATE federated_servers SET last_seen = unixepoch() WHERE id = ?",
              ).run(server.id);
            }
          } else {
            incrementFailure(db, server);
          }
        } catch {
          incrementFailure(db, server);
        }
      }
    },
    5 * 60 * 1000,
  ); // 5 minutes
}

function incrementFailure(db: Database.Database, server: ServerRow): void {
  const count = (failureCounts.get(server.id) || 0) + 1;
  failureCounts.set(server.id, count);

  if (count >= 3 && server.status === "active") {
    db.prepare(
      "UPDATE federated_servers SET status = 'offline' WHERE id = ?",
    ).run(server.id);
  }
}
