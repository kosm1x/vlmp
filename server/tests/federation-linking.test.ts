import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import {
  createInvite,
  handleLink,
  removeFederatedServer,
  listFederatedServers,
} from "../src/federation/linking.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

describe("Federation Linking", () => {
  it("createInvite creates a valid invite", () => {
    const invite = createInvite(db);
    expect(invite.token).toHaveLength(32);
    expect(invite.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const row = db
      .prepare("SELECT * FROM federation_invites WHERE token = ?")
      .get(invite.token) as { used: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.used).toBe(0);
  });

  it("handleLink with valid invite creates server entry", () => {
    const invite = createInvite(db);
    const result = handleLink(
      db,
      "local-fingerprint",
      "Local Server",
      "http://localhost:8080",
      "http://remote:8080",
      "Remote Server",
      "remote-fingerprint",
      invite.token,
    );

    expect(result.shared_secret).toHaveLength(128);
    expect(result.name).toBe("Local Server");
    expect(result.fingerprint).toBe("local-fingerprint");

    const servers = listFederatedServers(db);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("Remote Server");
    expect(servers[0].url).toBe("http://remote:8080");
    expect(servers[0].status).toBe("active");
  });

  it("handleLink marks invite as used", () => {
    const invite = createInvite(db);
    handleLink(db, "fp", "S", "http://s", "http://r", "R", "rfp", invite.token);

    const row = db
      .prepare("SELECT used FROM federation_invites WHERE token = ?")
      .get(invite.token) as { used: number };
    expect(row.used).toBe(1);
  });

  it("rejects already-used invite", () => {
    const invite = createInvite(db);
    handleLink(
      db,
      "fp",
      "S",
      "http://s",
      "http://r1",
      "R1",
      "rfp1",
      invite.token,
    );

    expect(() =>
      handleLink(
        db,
        "fp",
        "S",
        "http://s",
        "http://r2",
        "R2",
        "rfp2",
        invite.token,
      ),
    ).toThrow("Invite already used");
  });

  it("rejects invalid invite token", () => {
    expect(() =>
      handleLink(
        db,
        "fp",
        "S",
        "http://s",
        "http://r",
        "R",
        "rfp",
        "nonexistent-token",
      ),
    ).toThrow("Invalid invite token");
  });

  it("rejects expired invite", () => {
    const invite = createInvite(db);
    // Force expire it
    db.prepare(
      "UPDATE federation_invites SET expires_at = ? WHERE token = ?",
    ).run(Math.floor(Date.now() / 1000) - 100, invite.token);

    expect(() =>
      handleLink(
        db,
        "fp",
        "S",
        "http://s",
        "http://r",
        "R",
        "rfp",
        invite.token,
      ),
    ).toThrow("Invite expired");
  });

  it("removeFederatedServer deletes server", () => {
    const invite = createInvite(db);
    handleLink(db, "fp", "S", "http://s", "http://r", "R", "rfp", invite.token);
    const servers = listFederatedServers(db);
    expect(servers).toHaveLength(1);

    const removed = removeFederatedServer(db, servers[0].id);
    expect(removed).toBe(true);
    expect(listFederatedServers(db)).toHaveLength(0);
  });

  it("removeFederatedServer returns false for unknown id", () => {
    expect(removeFederatedServer(db, 999)).toBe(false);
  });

  it("listFederatedServers returns empty for fresh db", () => {
    expect(listFederatedServers(db)).toHaveLength(0);
  });
});
