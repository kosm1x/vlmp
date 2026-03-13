import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import { useState } from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { setToken } from "../api.js";
import { navigate } from "../router.js";
const html = htm.bind(h);
export function Shell({ children }) {
  const [searchVal, setSearchVal] = useState("");
  function handleSearch(e) {
    e.preventDefault();
    if (searchVal.trim())
      navigate(`/search?q=${encodeURIComponent(searchVal.trim())}`);
  }
  function logout() {
    setToken(null);
    navigate("/login");
    location.reload();
  }
  return html`<nav class="nav">
      <div class="nav-logo" onClick=${() => navigate("/")}>VLMP</div>
      <ul class="nav-links">
        <li><a href="#/">Home</a></li>
        <li><a href="#/movies">Movies</a></li>
        <li><a href="#/tv">TV Shows</a></li>
        <li><a href="#/documentaries">Docs</a></li>
        <li><a href="#/education">Education</a></li>
        <li><a href="#/playlists">Playlists</a></li>
      </ul>
      <form class="nav-search" onSubmit=${handleSearch}>
        <input
          type="text"
          placeholder="Search..."
          value=${searchVal}
          onInput=${(e) => setSearchVal(e.target.value)}
        />
      </form>
      <span class="nav-user" onClick=${logout}>Logout</span>
    </nav>
    ${children}`;
}
