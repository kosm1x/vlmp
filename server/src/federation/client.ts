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
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
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
    ...options?.headers,
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  // timeoutMs 0 disables the timeout — needed when proxying whole-file
  // streams, where the caller's signal (client disconnect) cancels instead.
  const timeoutMs = options?.timeoutMs ?? 10000;
  const signals: AbortSignal[] = [];
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (options?.signal) signals.push(options.signal);
  return fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
    signal: signals.length ? AbortSignal.any(signals) : undefined,
  });
}
