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

const SENSITIVE_FIELDS = ["file_path", "file_size", "library_folder_id"];

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
  const localSessionId = `fed-${server.id}-${Date.now()}`;
  fedStreamSessions.set(localSessionId, {
    serverId: server.id,
    remoteSessionId: data.session_id as string,
    remoteBaseUrl: server.url.replace(/\/$/, ""),
    server,
  });

  // Rewrite the URL to point through our proxy
  const remoteUrl = data.url as string;
  if (remoteUrl && data.mode === "hls") {
    data.url = `/federation/servers/${server.id}/stream/${localSessionId}/playlist.m3u8`;
  }
  data.session_id = localSessionId;
  return data;
}

export async function proxyStreamContent(
  server: FederatedServer,
  config: Config,
  remoteSessionId: string,
  subpath: string,
): Promise<{ body: ArrayBuffer; contentType: string }> {
  const path = `/federation/api/stream/${remoteSessionId}/${subpath}`;
  const res = await federatedFetch(server, config, "GET", path);
  if (!res.ok) throw new Error(`Remote server returned ${res.status}`);

  const contentType =
    res.headers.get("content-type") || "application/octet-stream";
  let body = await res.arrayBuffer();

  // If this is an M3U8 playlist, rewrite the URLs
  if (
    contentType.includes("mpegurl") ||
    contentType.includes("m3u8") ||
    subpath.endsWith(".m3u8")
  ) {
    const text = new TextDecoder().decode(body);
    const rewritten = rewritePlaylist(text, server.id, remoteSessionId);
    body = new TextEncoder().encode(rewritten).buffer as ArrayBuffer;
  }

  return { body, contentType };
}

export function rewritePlaylist(
  content: string,
  serverId: number,
  sessionId: string,
): string {
  const proxyBase = `/federation/servers/${serverId}/stream/${sessionId}`;
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) return line;
      // This is a segment or playlist reference — rewrite to proxy
      // Handle both relative and absolute URLs
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        // Extract path portion after the host
        try {
          const url = new URL(trimmed);
          return `${proxyBase}${url.pathname}`;
        } catch {
          return `${proxyBase}/${trimmed}`;
        }
      }
      // Relative path — just prepend proxy base
      return `${proxyBase}/${trimmed}`;
    })
    .join("\n");
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
