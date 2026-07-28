import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { getToken } from "../api.js";
const html = htm.bind(h);

// Generated-thumbnail <img> for media without a TMDb poster. Plain <img src>
// can't send the Authorization header, so the thumb is fetched and rendered
// as a blob URL. Session cache: one fetch (and one server-side ffmpeg, ever)
// per media id; null marks a server-confirmed miss (404) so those don't
// refetch every render. Transient failures (network, expired token) are NOT
// cached — the next render retries. Bounded: oldest blob is revoked+evicted
// past the cap (Map preserves insertion order).
const cache = new Map();
const CACHE_MAX = 300;

// Media ids get RECYCLED server-side after a folder delete (SQLite rowid
// reuse), so an id-keyed blob — or a remembered 404 — can belong to a media
// item that no longer exists. Callers that invalidate the library cache must
// drop these too, or a new item renders a deleted item's frame.
//
// Mounted components must be woken up as well: their src state holds a blob
// URL this revokes, and their [mediaId] effect would never re-run on its own
// — a lazy image scrolled into view later would load a dead URL forever.
const invalidationListeners = new Set();

export function invalidateThumbCache() {
  for (const url of cache.values()) if (url) URL.revokeObjectURL(url);
  cache.clear();
  for (const wake of invalidationListeners) wake();
}

function remember(mediaId, value) {
  if (cache.size >= CACHE_MAX) {
    const [oldestId, oldest] = cache.entries().next().value;
    if (oldest) URL.revokeObjectURL(oldest);
    cache.delete(oldestId);
  }
  cache.set(mediaId, value);
}

export function ThumbImg({ mediaId, title }) {
  const [src, setSrc] = useState(
    cache.has(mediaId) ? cache.get(mediaId) : undefined,
  );
  // Bumped by invalidateThumbCache so the fetch effect re-runs even though
  // mediaId is unchanged (the cached URL it holds has been revoked).
  const [gen, setGen] = useState(0);

  useEffect(() => {
    const wake = () => setGen((g) => g + 1);
    invalidationListeners.add(wake);
    return () => invalidationListeners.delete(wake);
  }, []);

  useEffect(() => {
    if (cache.has(mediaId)) {
      setSrc(cache.get(mediaId));
      return;
    }
    let alive = true;
    // cache:"no-cache" = always revalidate, the request-side mirror of the
    // server's `Cache-Control: private, no-cache`. It is what evicts GHOSTS
    // left by pre-v0.1.9.9.1 servers: those sent max-age=86400, so a browser
    // holding such an entry serves a deleted item's image WITHOUT any request
    // — the fixed server never gets asked. With no-cache the entry is
    // revalidated (old entries carry no ETag, so they refetch outright);
    // current entries cost a 304. The in-memory Map above still keeps it to
    // one network round-trip per media id per session.
    fetch(`/media/${mediaId}/thumb`, {
      cache: "no-cache",
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then(async (res) => {
        if (res.status === 404) {
          // Server-confirmed: no thumbnail possible. Safe to remember.
          remember(mediaId, null);
          if (alive) setSrc(null);
          return;
        }
        if (!res.ok) throw new Error("transient");
        const url = URL.createObjectURL(await res.blob());
        remember(mediaId, url);
        if (alive) setSrc(url);
      })
      .catch(() => {
        // Network blip / expired token: don't poison the cache — leave the
        // text fallback for this render and retry on the next mount.
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [mediaId, gen]);

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
