import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { getToken } from "../api.js";
const html = htm.bind(h);

// Generated-thumbnail <img> for media without a TMDb poster. Plain <img src>
// can't send the Authorization header, so the thumb is fetched and rendered
// as a blob URL. Session cache: one fetch (and one server-side ffmpeg, ever)
// per (media id, version); null marks a server-confirmed miss (404) so those
// don't refetch every render. Transient failures (network, expired token) are
// NOT cached — the next render retries. Bounded: oldest blob is revoked+
// evicted past the cap (Map preserves insertion order).
//
// CACHING STRATEGY — content-addressed, not revalidated. Media ids get
// RECYCLED server-side after a folder delete (SQLite rowid reuse), so a bare
// id URL can later point at a different file. Revalidating every fetch fixed
// that but cost one round-trip per tile per page load — a big grid crawled.
// Instead, callers pass `version` (the row's updated_at): the URL embeds it,
// the server marks versioned responses immutable, and the browser serves
// them from cache with ZERO network. A recycled or reclassified id arrives
// with a NEW version → new URL → cache miss → fresh image. Refresh therefore
// happens exactly when the window loads fresh data, never per render.
// Callers without a version fall back to the revalidating mode.
const cache = new Map();
const CACHE_MAX = 300;

const cacheKey = (mediaId, version) => `${mediaId}:${version ?? ""}`;

// A remembered blob can still belong to a deleted item (same id+version can
// in principle be re-served within a session across a folder delete), so
// library invalidation drops these too.
//
// Mounted components must be woken up as well: their src state holds a blob
// URL this revokes, and their effect would never re-run on its own — a lazy
// image scrolled into view later would load a dead URL forever.
const invalidationListeners = new Set();

export function invalidateThumbCache() {
  for (const url of cache.values()) if (url) URL.revokeObjectURL(url);
  cache.clear();
  for (const wake of invalidationListeners) wake();
}

function remember(key, value) {
  if (cache.size >= CACHE_MAX) {
    const [oldestKey, oldest] = cache.entries().next().value;
    if (oldest) URL.revokeObjectURL(oldest);
    cache.delete(oldestKey);
  }
  cache.set(key, value);
}

export function ThumbImg({ mediaId, title, version }) {
  const key = cacheKey(mediaId, version);
  const [src, setSrc] = useState(cache.has(key) ? cache.get(key) : undefined);
  // Bumped by invalidateThumbCache so the fetch effect re-runs even though
  // mediaId is unchanged (the cached URL it holds has been revoked).
  const [gen, setGen] = useState(0);

  useEffect(() => {
    const wake = () => setGen((g) => g + 1);
    invalidationListeners.add(wake);
    return () => invalidationListeners.delete(wake);
  }, []);

  useEffect(() => {
    const k = cacheKey(mediaId, version);
    if (cache.has(k)) {
      setSrc(cache.get(k));
      return;
    }
    let alive = true;
    // Versioned URL → browser cache does the work (immutable server-side).
    // Unversioned fallback → "no-cache" keeps a stable URL from ever serving
    // a deleted item's image past one revalidation (and evicts ghost entries
    // stamped by pre-v0.1.9.9.1 servers, which carried max-age=86400).
    const versioned = version != null;
    const url = versioned
      ? `/media/${mediaId}/thumb?v=${encodeURIComponent(version)}`
      : `/media/${mediaId}/thumb`;
    fetch(url, {
      cache: versioned ? "default" : "no-cache",
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then(async (res) => {
        if (res.status === 404) {
          // Server-confirmed: no thumbnail possible. Safe to remember.
          remember(k, null);
          if (alive) setSrc(null);
          return;
        }
        if (!res.ok) throw new Error("transient");
        const blobUrl = URL.createObjectURL(await res.blob());
        remember(k, blobUrl);
        if (alive) setSrc(blobUrl);
      })
      .catch(() => {
        // Network blip / expired token: don't poison the cache — leave the
        // text fallback for this render and retry on the next mount.
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [mediaId, version, gen]);

  // onError: last-resort fallback if a revoked blob URL slips through to a
  // render — degrade to the text placeholder instead of a broken image.
  if (src)
    return html`<img
      src=${src}
      alt=${title}
      loading="lazy"
      onError=${() => setSrc(null)}
    />`;
  // undefined = still loading, null = known miss; both render the text
  // fallback (loading flashes are worse than late image swaps here).
  return html`<div class="no-poster">${title}</div>`;
}
