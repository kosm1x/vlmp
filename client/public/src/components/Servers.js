import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import {
  useState,
  useEffect,
} from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { get, post, del } from "../api.js";
import { navigate } from "../router.js";
const html = htm.bind(h);

function timeAgo(ts) {
  if (!ts) return "Never";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "Just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

export function Servers() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkToken, setLinkToken] = useState("");
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState("");

  function load() {
    setLoading(true);
    get("/federation/servers")
      .then((s) => {
        setServers(s);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }
  useEffect(load, []);

  function generateInvite() {
    setError("");
    post("/federation/invite")
      .then((i) => setInvite(i))
      .catch((e) => setError(e.message));
  }

  function linkServer(e) {
    e.preventDefault();
    if (!linkUrl.trim() || !linkToken.trim()) return;
    setError("");
    post("/federation/link-remote", {
      url: linkUrl.trim(),
      invite_token: linkToken.trim(),
    })
      .then(() => {
        setLinkUrl("");
        setLinkToken("");
        load();
      })
      .catch((e) => setError(e.message));
  }

  function removeServer(id) {
    if (!confirm("Remove this server?")) return;
    del("/federation/servers/" + id)
      .then(load)
      .catch((e) => setError(e.message));
  }

  if (loading)
    return html`<div class="browse">
      <div class="loading">Loading...</div>
    </div>`;

  return html`<div class="browse servers-page">
    <h2>Federated Servers</h2>
    ${error && html`<div class="error-msg">${error}</div>`}
    <div class="server-list">
      ${servers.length
        ? servers.map(
            (s) => html`
              <div
                class="server-card"
                key=${s.id}
                onClick=${() => navigate("/servers/" + s.id)}
              >
                <div class="server-info">
                  <span class="server-name">${s.name}</span>
                  <span
                    class="server-status ${s.status === "active"
                      ? "status-active"
                      : "status-offline"}"
                    >${s.status}</span
                  >
                </div>
                <div class="server-meta">
                  <span class="server-url">${s.url}</span>
                  <span class="server-seen"
                    >Last seen: ${timeAgo(s.last_seen)}</span
                  >
                </div>
                <button
                  class="btn-remove"
                  onClick=${(e) => {
                    e.stopPropagation();
                    removeServer(s.id);
                  }}
                >
                  Remove
                </button>
              </div>
            `,
          )
        : html`<div class="empty">
            <p>No federated servers. Link one below.</p>
          </div>`}
    </div>
    <div class="federation-admin">
      <div class="admin-section">
        <h3>Generate Invite</h3>
        <p>
          Share this token with another VLMP admin to let them link to your
          server.
        </p>
        <button class="btn-primary" onClick=${generateInvite}>
          Generate Invite Token
        </button>
        ${invite &&
        html`<div class="invite-display">
          <code>${invite.token}</code>
          <small>Expires in 1 hour</small>
        </div>`}
      </div>
      <div class="admin-section">
        <h3>Link to Server</h3>
        <form onSubmit=${linkServer}>
          <input
            type="text"
            placeholder="Server URL (e.g. https://friend.example.com)"
            value=${linkUrl}
            onInput=${(e) => setLinkUrl(e.target.value)}
          />
          <input
            type="text"
            placeholder="Invite token"
            value=${linkToken}
            onInput=${(e) => setLinkToken(e.target.value)}
          />
          <button type="submit" class="btn-primary">Link</button>
        </form>
      </div>
    </div>
  </div>`;
}
