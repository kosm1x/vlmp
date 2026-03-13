import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPLAY_WINDOW_SECONDS = 300;

export function loadOrGenerateFingerprint(dataDir: string): string {
  const keyPath = resolve(dataDir, "server.key");
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, "utf-8").trim();
  }
  const fingerprint = randomBytes(32).toString("hex");
  writeFileSync(keyPath, fingerprint, "utf-8");
  return fingerprint;
}

export function generateSecret(): string {
  return randomBytes(64).toString("hex");
}

export function generateInviteToken(): string {
  return randomBytes(16).toString("hex");
}

export function signRequest(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  const bodyHash = createHmac("sha256", secret)
    .update(body || "")
    .digest("hex");
  return createHmac("sha256", secret)
    .update(`${method}\n${path}\n${timestamp}\n${bodyHash}`)
    .digest("hex");
}

export function verifyRequest(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) return false;

  const expected = signRequest(secret, method, path, timestamp, body);
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}
