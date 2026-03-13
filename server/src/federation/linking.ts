import type Database from "better-sqlite3";
import { generateSecret, generateInviteToken } from "./crypto.js";

export function createInvite(db: Database.Database): {
  token: string;
  expires_at: number;
} {
  const token = generateInviteToken();
  const expires_at = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  db.prepare(
    "INSERT INTO federation_invites (token, created_at, expires_at) VALUES (?, unixepoch(), ?)",
  ).run(token, expires_at);
  return { token, expires_at };
}

export function handleLink(
  db: Database.Database,
  serverFingerprint: string,
  serverName: string,
  serverPublicUrl: string,
  remoteUrl: string,
  remoteName: string,
  remoteFingerprint: string,
  inviteToken: string,
): {
  shared_secret: string;
  name: string;
  fingerprint: string;
  public_url: string;
} {
  const invite = db
    .prepare("SELECT * FROM federation_invites WHERE token = ?")
    .get(inviteToken) as
    | { id: number; token: string; expires_at: number; used: number }
    | undefined;

  if (!invite) throw new Error("Invalid invite token");
  if (invite.used) throw new Error("Invite already used");

  const now = Math.floor(Date.now() / 1000);
  if (invite.expires_at < now) throw new Error("Invite expired");

  const shared_secret = generateSecret();

  db.prepare("UPDATE federation_invites SET used = 1 WHERE id = ?").run(
    invite.id,
  );

  db.prepare(
    "INSERT INTO federated_servers (name, url, public_key, shared_secret, status, last_seen) VALUES (?, ?, ?, ?, 'active', unixepoch())",
  ).run(remoteName, remoteUrl, remoteFingerprint, shared_secret);

  return {
    shared_secret,
    name: serverName,
    fingerprint: serverFingerprint,
    public_url: serverPublicUrl,
  };
}

export function removeFederatedServer(
  db: Database.Database,
  serverId: number,
): boolean {
  const result = db
    .prepare("DELETE FROM federated_servers WHERE id = ?")
    .run(serverId);
  return result.changes > 0;
}

export function listFederatedServers(db: Database.Database): Array<{
  id: number;
  name: string;
  url: string;
  status: string;
  last_seen: number | null;
}> {
  return db
    .prepare(
      "SELECT id, name, url, status, last_seen FROM federated_servers ORDER BY name",
    )
    .all() as Array<{
    id: number;
    name: string;
    url: string;
    status: string;
    last_seen: number | null;
  }>;
}
