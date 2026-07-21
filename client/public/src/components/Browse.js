import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { get, getUserRole } from "../api.js";
import { fetchCategories } from "../categories.js";
import { MediaCard } from "./MediaCard.js";
import { ShowCard } from "./ShowCard.js";
const html = htm.bind(h);

// Home shelves that aren't categories. Category shelves are appended from
// /categories at load time.
const FIXED_ROWS = [
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
];
const PAGE_SIZE = 60;

// A category's contents = its shows (episodes grouped as one card each) +
// its loose items (browse with exclude_episodes so nothing appears twice).
async function loadCategoryContent(slug, limit, offset) {
  const [shows, items] = await Promise.all([
    offset === 0 ? get(`/library/shows?category=${slug}`) : Promise.resolve([]),
    get(
      `/library/browse?category=${slug}&exclude_episodes=1&limit=${limit}&offset=${offset}`,
    ),
  ]);
  return { shows: shows || [], items: items.items || [], total: items.total };
}

// Full-category view: shows first, then a wrapping grid of the ENTIRE
// category with paging — the home page's horizontal rows are a shelf, not
// the library.
function CategoryGrid({ category }) {
  const [cat, setCat] = useState(undefined); // undefined=loading, null=unknown
  const [shows, setShows] = useState([]);
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
      const d = await loadCategoryContent(category, PAGE_SIZE, offset);
      if (gen !== genRef.current) return; // stale category response
      if (offset === 0) setShows(d.shows);
      setItems((prev) => (offset === 0 ? d.items : prev.concat(d.items)));
      setTotal(d.total ?? d.items.length);
    } catch (err) {
      if (gen === genRef.current)
        setError(err.message || "Failed to load library");
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    const gen = ++genRef.current;
    setCat(undefined);
    setShows([]);
    setItems([]);
    setTotal(null);
    fetchCategories()
      .then((cats) => {
        if (gen !== genRef.current) return;
        const found = cats.find((c) => c.slug === category) || null;
        setCat(found);
        if (found) loadPage(0, gen);
      })
      .catch(() => {
        if (gen !== genRef.current) return;
        // Category list unavailable — try the browse anyway with the slug as
        // its own label rather than dead-ending the page.
        setCat({ slug: category, label: category });
        loadPage(0, gen);
      });
  }, [category]);

  if (cat === undefined)
    return html`<div class="browse">
      <div class="loading">Loading...</div>
    </div>`;
  if (cat === null)
    return html`<div class="browse">
      <div class="empty">
        <h2>Page not found</h2>
        <p>No category named “${category}”.</p>
        <a href="#/" style=${{ color: "var(--accent)" }}>Go home</a>
      </div>
    </div>`;

  const label = cat.label || category;
  const empty = !loading && shows.length === 0 && items.length === 0;
  return html`<div class="browse">
    <div class="category-header">
      <h1 class="category-title">${label}</h1>
      ${
        total !== null &&
        html`<span class="category-count"
          >${shows.length > 0 ? `${shows.length} series · ` : ""}${total}
          ${total === 1 ? "title" : "titles"}</span
        >`
      }
    </div>
    ${error && html`<div class="empty"><h2>${error}</h2></div>`}
    ${!error && empty && html`<div class="empty"><h2>Nothing in ${label} yet</h2></div>`}
    <div class="category-grid">
      ${shows.map((s) => html`<${ShowCard} key=${"show-" + s.id} show=${s} />`)}
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
    let cancelled = false;
    setLoading(true);
    (async () => {
      let cats = [];
      try {
        cats = await fetchCategories();
      } catch {
        /* nav also fails loudly; shelves just show the fixed rows */
      }
      const defs = [
        ...FIXED_ROWS.map((r) => ({
          ...r,
          load: () =>
            get(r.endpoint).then((d) => ({
              items: Array.isArray(d) ? d : d.items || [],
              shows: [],
            })),
        })),
        ...cats.map((c) => ({
          key: c.slug,
          label: c.label,
          load: () => loadCategoryContent(c.slug, 20, 0),
        })),
      ];
      const results = await Promise.all(
        defs.map(async (def) => {
          try {
            const d = await def.load();
            const cards = [
              ...(d.shows || []).map((s) => ({ show: s })),
              ...(d.items || []).map((i) => ({ item: i })),
            ].slice(0, 20);
            return { key: def.key, label: def.label, cards };
          } catch {
            return { key: def.key, label: def.label, cards: [] };
          }
        }),
      );
      if (cancelled) return;
      setRows(results.filter((r) => r.cards.length > 0));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
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
        html`<div class="media-row" key=${r.key}>
          <h2>${r.label}</h2>
          <div class="media-row-items">
            ${r.cards.map((c) =>
              c.show
                ? html`<${ShowCard}
                    key=${"show-" + c.show.id}
                    show=${c.show}
                  />`
                : html`<${MediaCard} key=${c.item.id} item=${c.item} />`,
            )}
          </div>
        </div>`,
    )}
  </div>`;
}
