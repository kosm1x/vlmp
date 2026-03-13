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
        setLoggedIn(true);
        setRoute({ path: "/", params: {} });
      }}
    />`;
  const pathParts = route.path.split("/").filter(Boolean);
  if (pathParts[0] === "play")
    return html`<${Player}
      mediaId=${pathParts[1]}
      onClose=${() => history.back()}
    />`;
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
    default:
      content = html`<${Browse} category=${pathParts[0] || null} />`;
      break;
  }
  return html`<${Shell}>${content}</${Shell}>`;
}
render(html`<${App} />`, document.getElementById("app"));
