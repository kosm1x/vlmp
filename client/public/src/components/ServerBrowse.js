import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import {
  useState,
  useEffect,
} from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { get } from "../api.js";
import { navigate } from "../router.js";
const html = htm.bind(h);

function RemoteMediaCard({ item, serverId }) {
  const mediaId = item.media_id || item.id;
  return html`<div
    class="media-card"
    onClick=${() => navigate("/servers/" + serverId + "/detail/" + mediaId)}
  >
    <div class="media-card-poster">
      ${item.poster_path
        ? html`<img src=${item.poster_path} alt=${item.title} loading="lazy" />`
        : html`<div class="no-poster">${item.title}</div>`}
      <button
        class="media-card-play"
        onClick=${(e) => {
          e.stopPropagation();
          navigate("/play/fed/" + serverId + "/" + mediaId);
        }}
      >
        &#9654;
      </button>
    </div>
    <div class="media-card-title">${item.title}</div>
    ${item.year && html`<div class="media-card-year">${item.year}</div>`}
    ${item.server_name &&
    html`<div class="media-card-server">${item.server_name}</div>`}
  </div>`;
}

export function ServerBrowse({ serverId }) {
  const [items, setItems] = useState([]);
  const [serverName, setServerName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    get("/federation/servers/" + serverId + "/library?limit=50")
      .then((d) => {
        setItems(d.items || []);
        if (d.items && d.items.length > 0 && d.items[0].server_name) {
          setServerName(d.items[0].server_name);
        }
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [serverId]);

  if (loading)
    return html`<div class="browse">
      <div class="loading">Loading remote library...</div>
    </div>`;
  if (error)
    return html`<div class="browse">
      <div class="empty">
        <h2>Server Unavailable</h2>
        <p>${error}</p>
        <a href="#/servers">Back to servers</a>
      </div>
    </div>`;

  return html`<div class="browse">
    <div class="server-breadcrumb">
      <a href="#/servers">Servers</a> /
      <span>${serverName || "Remote Server"}</span>
    </div>
    <div class="media-row">
      <h2>Library</h2>
      <div class="media-row-items" style=${{ flexWrap: "wrap" }}>
        ${items.length
          ? items.map(
              (i) =>
                html`<${RemoteMediaCard}
                  key=${i.id}
                  item=${i}
                  serverId=${serverId}
                />`,
            )
          : html`<div class="empty">No media available</div>`}
      </div>
    </div>
  </div>`;
}
