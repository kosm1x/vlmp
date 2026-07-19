import { randomBytes } from "node:crypto";
import { federatedFetch } from "./client.js";
import type { Config } from "../config.js";

interface FederatedServer {
  id: number;
  name: string;
  url: string;
  shared_secret: string;
  public_key: string;
}

// In-memory tracking of federated stream sessions
interface FedStreamSession {
  serverId: number;
  remoteSessionId: string;
  remoteBaseUrl: string;
  server: FederatedServer;
  userId: string;
}

const fedStreamSessions = new Map<string, FedStreamSession>();

export function getFedStreamSession(
  sessionId: string,
): FedStreamSession | undefined {
  return fedStreamSessions.get(sessionId);
}

export function cleanupFedStreamSession(sessionId: string): void {
  fedStreamSessions.delete(sessionId);
}

const SENSITIVE_FIELDS = [
  "file_path",
  "file_size",
  "library_folder_id",
  "folder_path",
];

export function stripSensitiveFields(
  item: Record<string, unknown>,
  serverId: number,
  serverName: string,
): Record<string, unknown> {
  const stripped = { ...item };
  for (const field of SENSITIVE_FIELDS) {
    delete stripped[field];
  }
  stripped.server_id = serverId;
  stripped.server_name = serverName;
  return stripped;
}

export async function proxyLibrary(
  server: FederatedServer,
  config: Config,
  query: string,
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const path = `/federation/api/library${query ? `?${query}` : ""}`;
  const res = await federatedFetch(server, config, "GET", path);
  if (!res.ok) throw new Error(`Remote server returned ${res.status}`);
  const data = (await res.json()) as {
    items: Record<string, unknown>[];
    total?: number;
  };
  const items = (data.items || []).map((i) =>
    stripSensitiveFields(i, server.id, server.name),
  );
  return { items, total: data.total || items.length };
}

export async function proxyMediaDetail(
  server: FederatedServer,
  config: Config,
  mediaId: string,
): Promise<Record<string, unknown> | null> {
  const res = await federatedFetch(
    server,
    config,
    "GET",
    `/federation/api/media/${mediaId}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Remote server returned ${res.status}`);
  const item = (await res.json()) as Record<string, unknown>;
  return stripSensitiveFields(item, server.id, server.name);
}

export async function proxyTVShows(
  server: FederatedServer,
  config: Config,
): Promise<Record<string, unknown>[]> {
  const res = await federatedFetch(
    server,
    config,
    "GET",
    "/federation/api/tv/shows",
  );
  if (!res.ok) throw new Error(`Remote server returned ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>[];
  return data.map((s) => stripSensitiveFields(s, server.id, server.name));
}

export async function proxyStreamStart(
  server: FederatedServer,
  config: Config,
  mediaId: string,
  body: unknown,
  userId: string,
): Promise<Record<string, unknown>> {
  const res = await federatedFetch(
    server,
    config,
    "POST",
    `/federation/api/stream/${mediaId}/start`,
    body,
  );
  if (!res.ok) throw new Error(`Remote server returned ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;

  // Generate a local session ID and track the remote session
  const localSessionId = `fed-${randomBytes(16).toString("hex")}`;
  fedStreamSessions.set(localSessionId, {
    serverId: server.id,
    remoteSessionId: data.session_id as string,
    remoteBaseUrl: server.url.replace(/\/$/, ""),
    server,
    userId,
  });

  // Rewrite the URL to point through our proxy. The suffix must match a route
  // the remote actually serves: master.m3u8 for HLS, direct for direct play
  // (the remote's own /federation/api/... URL is useless to a browser — it
  // has no HMAC headers).
  const remoteUrl = data.url as string;
  if (remoteUrl) {
    const suffix = data.mode === "direct" ? "direct" : "master.m3u8";
    data.url = `/federation/servers/${server.id}/stream/${localSessionId}/${suffix}`;
  }
  data.session_id = localSessionId;
  return data;
}

// Playlists need no URL rewriting: the master playlist uses relative variant
// URIs and ffmpeg writes segment names as bare filenames, so every reference
// resolves naturally against the local proxy URL that served the playlist.
export async function proxyStreamContent(
  server: FederatedServer,
  config: Config,
  remoteSessionId: string,
  subpath: string,
  rangeHeader?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const path = `/federation/api/stream/${remoteSessionId}/${subpath}`;
  const isDirect = subpath === "direct";
  const res = await federatedFetch(server, config, "GET", path, undefined, {
    headers: rangeHeader ? { range: rangeHeader } : undefined,
    // A direct-play fetch streams a whole file — the default 10s abort would
    // chop it mid-movie. The caller-supplied signal (wired to client
    // disconnect) is what cancels it instead.
    timeoutMs: isDirect ? 0 : 10000,
    signal,
  });
  if (!res.ok) throw new Error(`Remote server returned ${res.status}`);
  return res;
}

export async function proxyStreamStop(
  server: FederatedServer,
  config: Config,
  remoteSessionId: string,
): Promise<void> {
  await federatedFetch(
    server,
    config,
    "DELETE",
    `/federation/api/stream/${remoteSessionId}`,
  );
}
