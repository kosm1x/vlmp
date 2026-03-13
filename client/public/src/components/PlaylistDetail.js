import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import {
  useState,
  useEffect,
} from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { get, put, del } from "../api.js";
import { navigate } from "../router.js";
const html = htm.bind(h);

export function PlaylistDetail({ id }) {
  const [playlist, setPlaylist] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState("");

  function load() {
    get(`/playlists/${id}`)
      .then((data) => {
        setPlaylist(data);
        setEditName(data.name);
      })
      .catch((e) => setError(e.message));
  }
  useEffect(load, [id]);

  async function rename(e) {
    e.preventDefault();
    if (!editName.trim()) return;
    await put(`/playlists/${id}`, { name: editName.trim() });
    setEditing(false);
    load();
  }

  async function removeItem(itemId) {
    await del(`/playlists/${id}/items/${itemId}`);
    load();
  }

  if (error)
    return html`<div class="playlist-detail-page">
      <div class="detail-error">${error}</div>
    </div>`;
  if (!playlist)
    return html`<div class="playlist-detail-page">
      <div class="loading">Loading...</div>
    </div>`;

  return html`<div class="playlist-detail-page">
    <div class="playlist-header">
      ${editing
        ? html`<form
            onSubmit=${rename}
            style=${{ display: "flex", gap: "0.5rem" }}
          >
            <input
              type="text"
              value=${editName}
              onInput=${(e) => setEditName(e.target.value)}
            />
            <button type="submit">Save</button>
            <button type="button" onClick=${() => setEditing(false)}>
              Cancel
            </button>
          </form>`
        : html`<h1
            onClick=${() => setEditing(true)}
            style=${{ cursor: "pointer" }}
          >
            ${playlist.name}
          </h1>`}
      <button class="playlist-back" onClick=${() => navigate("/playlists")}>
        Back
      </button>
    </div>
    <div class="playlist-items">
      ${playlist.items.length === 0
        ? html`<div class="playlist-empty">No items in this playlist</div>`
        : playlist.items.map(
            (item, i) =>
              html`<div class="playlist-media-item">
                <span class="playlist-media-pos">${i + 1}</span>
                <div class="playlist-media-poster">
                  ${item.poster_path
                    ? html`<img src=${item.poster_path} alt=${item.title} />`
                    : html`<div class="no-poster-sm">
                        ${item.title?.charAt(0) || "?"}
                      </div>`}
                </div>
                <span
                  class="playlist-media-title"
                  onClick=${() => navigate("/detail/" + item.media_id)}
                  >${item.title || "Unknown"}</span
                >
                <span class="playlist-media-duration"
                  >${item.duration
                    ? Math.floor(item.duration / 60) + " min"
                    : ""}</span
                >
                <button
                  class="playlist-media-play"
                  onClick=${() => navigate("/play/" + item.media_id)}
                >
                  Play
                </button>
                <button
                  class="playlist-media-remove"
                  onClick=${() => removeItem(item.id)}
                >
                  X
                </button>
              </div>`,
          )}
    </div>
  </div>`;
}
