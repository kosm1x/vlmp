import { h, render } from "https://unpkg.com/preact@10/dist/preact.module.js";
import {
  useState,
  useEffect,
} from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { isLoggedIn } from "./api.js";
import { getRoute, onRouteChange } from "./router.js";
import { Login } from "./components/Login.js";
import { Shell } from "./components/Shell.js";
import { Browse } from "./components/Browse.js";
import { Player } from "./components/Player.js";
import { Search } from "./components/Search.js";
import { MediaDetail } from "./components/MediaDetail.js";
import { Playlists } from "./components/Playlists.js";
import { PlaylistDetail } from "./components/PlaylistDetail.js";
import { Servers } from "./components/Servers.js";
import { ServerBrowse } from "./components/ServerBrowse.js";
import { HealthDashboard } from "./components/HealthDashboard.js";
const html = htm.bind(h);

function NotFound() {
  return html`<div class="empty" style=${{ paddingTop: "120px" }}>
    <h2>Page not found</h2>
    <p>The page you're looking for doesn't exist.</p>
    <a
      href="#/"
      style=${{
        color: "var(--accent)",
        marginTop: "1rem",
        display: "inline-block",
      }}
      >Go home</a
    >
  </div>`;
}

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
    case "playlists":
      content = pathParts[1]
        ? html`<${PlaylistDetail} id=${pathParts[1]} />`
        : html`<${Playlists} />`;
      break;
    case "health":
      content = html`<${HealthDashboard} />`;
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
    default: {
      const knownCategories = [
        undefined,
        "movies",
        "tv",
        "documentaries",
        "education",
        "doc_series",
        "other",
      ];
      if (!pathParts[0] || knownCategories.includes(pathParts[0]))
        content = html`<${Browse} category=${pathParts[0] || null} />`;
      else content = html`<${NotFound} />`;
      break;
    }
  }
  return html`<${Shell}>${content}</${Shell}>`;
}
try {
  render(html`<${App} />`, document.getElementById("app"));
} catch (err) {
  document.getElementById("app").innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:1rem;color:#e5e5e5">
      <h2>Something went wrong</h2>
      <p style="color:#808080">${err.message || "An unexpected error occurred"}</p>
      <button onclick="location.reload()" style="padding:.6rem 1.25rem;background:#e50914;border:none;border-radius:4px;color:#fff;font-size:.9rem;cursor:pointer">Reload</button>
    </div>`;
}
