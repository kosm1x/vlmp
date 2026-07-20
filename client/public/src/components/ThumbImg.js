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

  useEffect(() => {
    if (cache.has(mediaId)) {
      setSrc(cache.get(mediaId));
      return;
    }
    let alive = true;
    fetch(`/media/${mediaId}/thumb`, {
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
  }, [mediaId]);

  if (src) return html`<img src=${src} alt=${title} loading="lazy" />`;
  // undefined = still loading, null = known miss; both render the text
  // fallback (loading flashes are worse than late image swaps here).
  return html`<div class="no-poster">${title}</div>`;
}
