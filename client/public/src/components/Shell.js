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
  return html`<nav class="nav" role="navigation" aria-label="Main navigation">
      <div
        class="nav-logo"
        onClick=${() => navigate("/")}
        role="button"
        aria-label="Go to home page"
      >
        VLMP
      </div>
      <ul class="nav-links">
        <li><a href="#/" aria-label="Home">Home</a></li>
        <li><a href="#/movies" aria-label="Movies">Movies</a></li>
        <li><a href="#/tv" aria-label="TV Shows">TV Shows</a></li>
        <li><a href="#/documentaries" aria-label="Documentaries">Docs</a></li>
        <li><a href="#/education" aria-label="Education">Education</a></li>
        <li><a href="#/playlists" aria-label="Playlists">Playlists</a></li>
        <li><a href="#/servers" aria-label="Servers">Servers</a></li>
      </ul>
      <form class="nav-search" onSubmit=${handleSearch}>
        <input
          type="text"
          placeholder="Search..."
          aria-label="Search media"
          value=${searchVal}
          onInput=${(e) => setSearchVal(e.target.value)}
        />
      </form>
      <span class="nav-user" onClick=${logout} role="button" aria-label="Logout"
        >Logout</span
      >
    </nav>
    ${children}`;
}
