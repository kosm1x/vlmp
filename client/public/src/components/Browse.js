import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { get, getUserRole } from "../api.js";
import { MediaRow } from "./MediaRow.js";
import { MediaCard } from "./MediaCard.js";
const html = htm.bind(h);
const CATS = [
  {
    key: "continue",
    label: "Continue Watching",
    endpoint: "/progress/continue",
  },
  {
    key: "recommended",
    label: "Recommended for You",
    endpoint: "/recommendations?limit=20",
  },
  {
    key: "recent",
    label: "Recently Added",
    endpoint: "/library/recent?limit=20",
  },
  {
    key: "movies",
    label: "Movies",
    endpoint: "/library/browse?category=movies&limit=20",
  },
  {
    key: "tv",
    label: "TV Shows",
    endpoint: "/library/browse?category=tv&limit=20",
  },
  {
    key: "documentaries",
    label: "Documentaries",
    endpoint: "/library/browse?category=documentaries&limit=20",
  },
  {
    key: "education",
    label: "Education & Training",
    endpoint: "/library/browse?category=education&limit=20",
  },
  {
    key: "other",
    label: "Other",
    endpoint: "/library/browse?category=other&limit=20",
  },
];
const CATEGORY_LABELS = {
  movies: "Movies",
  tv: "TV Shows",
  documentaries: "Documentaries",
  doc_series: "Documentary Series",
  education: "Education & Training",
  other: "Other",
};
const PAGE_SIZE = 60;

// Full-category view: wrapping grid of the ENTIRE category with paging —
// the home page's horizontal 20-item rows are a shelf, not the library.
function CategoryGrid({ category }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Category switches reconcile the SAME component instance — a slow response
  // for the old category must not land in the new one's grid.
  const genRef = useRef(0);

  async function loadPage(offset, gen = genRef.current) {
    setLoading(true);
    setError("");
    try {
      const d = await get(
        `/library/browse?category=${category}&limit=${PAGE_SIZE}&offset=${offset}`,
      );
      if (gen !== genRef.current) return; // stale category response
      setItems((prev) =>
        offset === 0 ? d.items || [] : prev.concat(d.items || []),
      );
      setTotal(d.total ?? (d.items || []).length);
    } catch (err) {
      if (gen === genRef.current)
        setError(err.message || "Failed to load library");
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    const gen = ++genRef.current;
    setItems([]);
    setTotal(null);
    loadPage(0, gen);
  }, [category]);

  const label = CATEGORY_LABELS[category] || category;
  return html`<div class="browse">
    <div class="category-header">
      <h1 class="category-title">${label}</h1>
      ${
        total !== null &&
        html`<span class="category-count"
          >${total} ${total === 1 ? "title" : "titles"}</span
        >`
      }
    </div>
    ${error && html`<div class="empty"><h2>${error}</h2></div>`}
    ${
      !error &&
      !loading &&
      items.length === 0 &&
      html`<div class="empty"><h2>Nothing in ${label} yet</h2></div>`
    }
    <div class="category-grid">
      ${items.map((item) => html`<${MediaCard} key=${item.id} item=${item} />`)}
    </div>
    ${loading && html`<div class="loading">Loading...</div>`}
    ${
      !loading &&
      total !== null &&
      items.length < total &&
      html`<div class="category-more">
        <button class="lum-btn" onClick=${() => loadPage(items.length)}>
          Load more (${items.length} of ${total})
        </button>
      </div>`
    }
  </div>`;
}

export function Browse({ category }) {
  if (category) return html`<${CategoryGrid} category=${category} />`;
  return html`<${HomeRows} />`;
}

function HomeRows() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    Promise.all(
      CATS.map(async (cat) => {
        try {
          const d = await get(cat.endpoint);
          return { ...cat, items: Array.isArray(d) ? d : d.items || [] };
        } catch {
          return { ...cat, items: [] };
        }
      }),
    ).then((r) => {
      setRows(r.filter((x) => x.items.length > 0));
      setLoading(false);
    });
  }, []);
  if (loading)
    return html`<div class="browse">
      <div class="loading">Loading...</div>
    </div>`;
  if (!rows.length)
    return html`<div class="browse">
      <div class="empty">
        <h2>No media found</h2>
        ${
          getUserRole() === "admin"
            ? html`<p>Add library folders to get started.</p>
                <a
                  class="lum-btn"
                  href="#/settings"
                  style=${{ marginTop: "1rem" }}
                  >Open Settings</a
                >`
            : html`<p>Ask an administrator to add library folders.</p>`
        }
      </div>
    </div>`;
  return html`<div class="browse">
    ${rows.map(
      (r) =>
        html`<${MediaRow} key=${r.key} label=${r.label} items=${r.items} />`,
    )}
  </div>`;
}
