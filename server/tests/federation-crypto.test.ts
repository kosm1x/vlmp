import { describe, it, expect } from "vitest";
import {
  generateSecret,
  generateInviteToken,
  signRequest,
  verifyRequest,
} from "../src/federation/crypto.js";

describe("Federation Crypto", () => {
  it("generateSecret produces 128-char hex", () => {
    const secret = generateSecret();
    expect(secret).toHaveLength(128);
    expect(/^[0-9a-f]+$/.test(secret)).toBe(true);
  });

  it("generateInviteToken produces 32-char hex", () => {
    const token = generateInviteToken();
    expect(token).toHaveLength(32);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it("signRequest/verifyRequest round-trip succeeds", () => {
    const secret = generateSecret();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(
      secret,
      "GET",
      "/federation/api/library",
      timestamp,
      "",
    );
    expect(
      verifyRequest(
        secret,
        "GET",
        "/federation/api/library",
        timestamp,
        "",
        sig,
      ),
    ).toBe(true);
  });

  it("signRequest/verifyRequest with body", () => {
    const secret = generateSecret();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ hello: "world" });
    const sig = signRequest(
      secret,
      "POST",
      "/federation/link",
      timestamp,
      body,
    );
    expect(
      verifyRequest(secret, "POST", "/federation/link", timestamp, body, sig),
    ).toBe(true);
  });

  it("rejects tampered signature", () => {
    const secret = generateSecret();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret, "GET", "/test", timestamp, "");
    const tampered = sig.slice(0, -2) + "ff";
    expect(verifyRequest(secret, "GET", "/test", timestamp, "", tampered)).toBe(
      false,
    );
  });

  it("rejects wrong method", () => {
    const secret = generateSecret();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret, "GET", "/test", timestamp, "");
    expect(verifyRequest(secret, "POST", "/test", timestamp, "", sig)).toBe(
      false,
    );
  });

  it("rejects wrong path", () => {
    const secret = generateSecret();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret, "GET", "/test", timestamp, "");
    expect(verifyRequest(secret, "GET", "/other", timestamp, "", sig)).toBe(
      false,
    );
  });

  it("rejects expired timestamp", () => {
    const secret = generateSecret();
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const sig = signRequest(secret, "GET", "/test", oldTimestamp, "");
    expect(verifyRequest(secret, "GET", "/test", oldTimestamp, "", sig)).toBe(
      false,
    );
  });

  it("rejects future timestamp beyond window", () => {
    const secret = generateSecret();
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 600);
    const sig = signRequest(secret, "GET", "/test", futureTimestamp, "");
    expect(
      verifyRequest(secret, "GET", "/test", futureTimestamp, "", sig),
    ).toBe(false);
  });

  it("accepts timestamp within window", () => {
    const secret = generateSecret();
    const recentTimestamp = String(Math.floor(Date.now() / 1000) - 200);
    const sig = signRequest(secret, "GET", "/test", recentTimestamp, "");
    expect(
      verifyRequest(secret, "GET", "/test", recentTimestamp, "", sig),
    ).toBe(true);
  });

  it("rejects wrong secret", () => {
    const secret1 = generateSecret();
    const secret2 = generateSecret();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(secret1, "GET", "/test", timestamp, "");
    expect(verifyRequest(secret2, "GET", "/test", timestamp, "", sig)).toBe(
      false,
    );
  });
});
