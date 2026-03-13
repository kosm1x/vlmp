import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import {
  useState,
  useEffect,
} from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { get, post, del } from "../api.js";
import { navigate } from "../router.js";
const html = htm.bind(h);

export function Playlists() {
  const [playlists, setPlaylists] = useState([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);

  function load() {
    get("/playlists")
      .then((data) => {
        setPlaylists(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }
  useEffect(load, []);

  async function create(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    await post("/playlists", { name: newName.trim() });
    setNewName("");
    load();
  }

  async function remove(id) {
    if (!confirm("Delete this playlist?")) return;
    await del(`/playlists/${id}`);
    load();
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  return html`<div class="playlists-page">
    <h1>Playlists</h1>
    <form class="playlist-create" onSubmit=${create}>
      <input
        type="text"
        placeholder="New playlist name..."
        value=${newName}
        onInput=${(e) => setNewName(e.target.value)}
      />
      <button type="submit">Create</button>
    </form>
    <div class="playlist-list">
      ${playlists.length === 0
        ? html`<div class="playlist-empty">No playlists yet</div>`
        : playlists.map(
            (p) =>
              html`<div
                class="playlist-item"
                onClick=${() => navigate("/playlists/" + p.id)}
              >
                <span class="playlist-name">${p.name}</span>
                <span class="playlist-count">${p.item_count || 0} items</span>
                <button
                  class="playlist-delete"
                  onClick=${(e) => {
                    e.stopPropagation();
                    remove(p.id);
                  }}
                >
                  X
                </button>
              </div>`,
          )}
    </div>
  </div>`;
}
