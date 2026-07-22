import { h, render } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { isLoggedIn } from "./api.js";
import { getRoute, onRouteChange } from "./router.js";
import { Login } from "./components/Login.js";
import { Shell } from "./components/Shell.js";
import { Browse, invalidateLibraryCache } from "./components/Browse.js";
import { invalidateCategories } from "./categories.js";
import { Player } from "./components/Player.js";
import { Search } from "./components/Search.js";
import { MediaDetail } from "./components/MediaDetail.js";
import { ShowDetail } from "./components/ShowDetail.js";
import { Playlists } from "./components/Playlists.js";
import { PlaylistDetail } from "./components/PlaylistDetail.js";
import { Servers } from "./components/Servers.js";
import { ServerBrowse } from "./components/ServerBrowse.js";
import { HealthDashboard } from "./components/HealthDashboard.js";
import { Settings } from "./components/Settings.js";
const html = htm.bind(h);

function App() {
  const [route, setRoute] = useState(getRoute());
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());
  useEffect(
    () =>
      onRouteChange((r) => {
        setRoute(r);
        setLoggedIn(isLoggedIn());
      }),
    [],
  );
  if (!loggedIn)
    return html`<${Login}
      onLogin=${() => {
        // A new session may be a different user than the one whose data is
        // still cached in memory (session-expiry doesn't reload the page).
        // Drop both caches so a non-admin never inherits an admin's
        // hidden-folder listing, another user's liked flags, or a stale nav.
        invalidateLibraryCache();
        invalidateCategories();
        setLoggedIn(true);
        setRoute({ path: "/", params: {} });
      }}
    />`;
  const pathParts = route.path.split("/").filter(Boolean);
  if (pathParts[0] === "play") {
    if (pathParts[1] === "fed")
      return html`<${Player}
        mediaId=${pathParts[3]}
        serverId=${pathParts[2]}
        federated=${true}
        onClose=${() => history.back()}
      />`;
    return html`<${Player}
      mediaId=${pathParts[1]}
      onClose=${() => history.back()}
    />`;
  }
  let content;
  switch (pathParts[0]) {
    case "search":
      content = html`<${Search} query=${route.params.q || ""} />`;
      break;
    case "detail":
      content = html`<${MediaDetail} id=${pathParts[1]} />`;
      break;
    case "show":
      content = html`<${ShowDetail} id=${pathParts[1]} />`;
      break;
    case "playlists":
      content = pathParts[1]
        ? html`<${PlaylistDetail} id=${pathParts[1]} />`
        : html`<${Playlists} />`;
      break;
    case "health":
      content = html`<${HealthDashboard} />`;
      break;
    case "settings":
      content = html`<${Settings} />`;
      break;
    case "servers":
      if (pathParts[1] && pathParts[2] === "detail")
        content = html`<${MediaDetail}
          id=${pathParts[3]}
          serverId=${pathParts[1]}
        />`;
      else if (pathParts[1])
        content = html`<${ServerBrowse} serverId=${pathParts[1]} />`;
      else content = html`<${Servers} />`;
      break;
    default:
      // Category slugs are dynamic (user-created in Settings) — Browse
      // validates the slug against /categories and renders not-found itself.
      content = html`<${Browse} category=${pathParts[0] || null} />`;
      break;
  }
  return html`<${Shell}>${content}</${Shell}>`;
}
try {
  render(html`<${App} />`, document.getElementById("app"));
} catch (err) {
  const container = document.getElementById("app");
  const wrapper = document.createElement("div");
  wrapper.style.cssText =
    "display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:1rem;color:#e5e5e5";
  const heading = document.createElement("h2");
  heading.textContent = "Something went wrong";
  const msg = document.createElement("p");
  msg.style.color = "#808080";
  msg.textContent = err.message || "An unexpected error occurred";
  const btn = document.createElement("button");
  btn.style.cssText =
    "padding:.6rem 1.25rem;background:#e50914;border:none;border-radius:4px;color:#fff;font-size:.9rem;cursor:pointer";
  btn.textContent = "Reload";
  btn.onclick = () => location.reload();
  wrapper.append(heading, msg, btn);
  container.innerHTML = "";
  container.append(wrapper);
}
