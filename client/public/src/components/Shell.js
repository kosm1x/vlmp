import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { setToken, getUserRole } from "../api.js";
import { fetchCategories } from "../categories.js";
import { navigate } from "../router.js";
const html = htm.bind(h);
export function Shell({ children }) {
  const [searchVal, setSearchVal] = useState("");
  const [categories, setCategories] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetchCategories()
      .then((cats) => {
        if (!cancelled) setCategories(cats);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
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
        ${categories.map(
          (c) =>
            html`<li key=${c.slug}>
              <a href=${"#/" + c.slug} aria-label=${c.label}>${c.label}</a>
            </li>`,
        )}
        <li><a href="#/playlists" aria-label="Playlists">Playlists</a></li>
        <li><a href="#/servers" aria-label="Servers">Servers</a></li>
        ${
          getUserRole() === "admin" &&
          html`<li>
              <a href="#/health" aria-label="Library Health">Health</a>
            </li>
            <li>
              <a href="#/settings" aria-label="Server Settings">Settings</a>
            </li>`
        }
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
