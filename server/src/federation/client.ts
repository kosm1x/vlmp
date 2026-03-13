import { signRequest } from "./crypto.js";
import type { Config } from "../config.js";

interface FederatedServer {
  id: number;
  url: string;
  shared_secret: string;
  public_key: string;
}

export async function federatedFetch(
  server: FederatedServer,
  config: Config,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyStr = body ? JSON.stringify(body) : "";
  const signature = signRequest(
    server.shared_secret,
    method,
    path,
    timestamp,
    bodyStr,
  );

  const url = `${server.url.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    "X-VLMP-Server-Id": config.serverFingerprint,
    "X-VLMP-Timestamp": timestamp,
    "X-VLMP-Signature": signature,
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  return fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(10000),
  });
}
