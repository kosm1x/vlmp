import { h } from "preact";
import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import htm from "htm";
import { get, post, getUserRole, getUserId } from "../api.js";
import { fetchCategories } from "../categories.js";
import { MediaCard } from "./MediaCard.js";
import { ShowCard } from "./ShowCard.js";
import { invalidateThumbCache } from "./ThumbImg.js";
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
const SHELF_SIZE = 20;

// Sort modes for the full category grid. Applied client-side over the fully
// loaded + cached card list, so switching is instant and never refetches.
const SORT_MODES = [
  { key: "title", label: "Title (A–Z)" },
  { key: "recent", label: "Recently added" },
  { key: "random", label: "Random" },
  { key: "liked", label: "Liked first" },
];
const SORT_STORAGE_KEY = "vlmp:categorySort";
function initialSort() {
  try {
    const s = localStorage.getItem(SORT_STORAGE_KEY);
    if (s && SORT_MODES.some((m) => m.key === s)) return s;
  } catch {
    /* storage disabled (private mode) — fall through to the default */
  }
  return "title";
}

// One entry per (user, category slug): the ENTIRE category, loaded once and
// kept for the session so later browsing is instant (no refetch, no paging).
// Keyed by user so a session change on the same tab (401-expiry has no reload)
// can never serve one user another's cards — an admin's includeHidden listing
// or a per-user liked flag. Cleared wholesale on login/logout/scan-settle.
const fullCache = new Map();
const cacheKey = (slug) => `${getUserId()}:${slug}`;
export function invalidateLibraryCache() {
  fullCache.clear();
  // Media ids can be recycled across a folder delete + rescan, so stale
  // id-keyed thumbs must die together with the library cache.
  invalidateThumbCache();
}

function showSortTitle(title) {
  return (title || "").replace(/^(?:the|a|an)\s+/i, "").toLowerCase();
}

// Fold shows + loose items into one uniform card list the sorter can order
// together — a series is a single card sitting wherever its title/date/like
// places it, never split from its own episodes.
function toCards(shows, items) {
  return [
    ...shows.map((s) => ({
      key: "show-" + s.id,
      kind: "show",
      show: s,
      sortTitle: showSortTitle(s.title),
      addedAt: s.added_at || 0,
      liked: s.liked ? 1 : 0,
    })),
    ...items.map((i) => ({
      key: "item-" + i.id,
      kind: "item",
      item: i,
      sortTitle: i.sort_title || showSortTitle(i.title),
      addedAt: i.added_at || 0,
      liked: i.liked ? 1 : 0,
    })),
  ];
}

// A category's contents = its shows (episodes grouped as one card each) + its
// loose items (browse with exclude_episodes so nothing appears twice). `all=1`
// pulls the whole category in one shot; the result is cached by slug.
//
// The cache stores the fetch PROMISE, set synchronously at call time. Caching
// the resolved data had a late-write race: an invalidation landing between
// fetch start and finish was silently overwritten by the stale result — which
// then outlived the server's rescan cooldown. With the promise IN the cache,
// deleting the key orphans any in-flight fetch: it can never write back.
function loadCategoryFull(slug) {
  const key = cacheKey(slug);
  if (fullCache.has(key)) return fullCache.get(key);
  const enc = encodeURIComponent(slug);
  const p = Promise.all([
    get(`/library/shows?category=${enc}`),
    get(`/library/browse?category=${enc}&exclude_episodes=1&all=1`),
  ]).then(([shows, browse]) => {
    const data = {
      shows: shows || [],
      items: (browse && browse.items) || [],
    };
    data.cards = toCards(data.shows, data.items);
    return data;
  });
  fullCache.set(key, p);
  p.catch(() => {
    // Never cache a failure — but only clear OUR entry, not a successor's.
    if (fullCache.get(key) === p) fullCache.delete(key);
  });
  return p;
}

// Home shelves want only a handful per category — a light capped fetch, never
// the whole library.
async function loadCategoryShelf(slug, limit) {
  const enc = encodeURIComponent(slug);
  const [shows, browse] = await Promise.all([
    get(`/library/shows?category=${enc}`),
    get(
      `/library/browse?category=${enc}&exclude_episodes=1&limit=${limit}&offset=0`,
    ),
  ]);
  return { shows: shows || [], items: (browse && browse.items) || [] };
}

// Split a category's items into folder groups (course/collection subfolders,
// carried by the server as group_title/group_position) and loose items. A
// group needs at least 2 members — a per-movie folder is not a section.
// Group key includes the folder id so same-named subfolders in different
// library folders stay separate sections.
function partitionGroups(items) {
  const byKey = new Map();
  for (const i of items) {
    if (!i.group_title) continue;
    const key = `${i.library_folder_id ?? 0}:${i.group_title}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(i);
  }
  const groups = [];
  const groupedIds = new Set();
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    members.sort(
      (a, b) =>
        (a.group_position ?? Infinity) - (b.group_position ?? Infinity) ||
        (a.sort_title || "").localeCompare(b.sort_title || ""),
    );
    groups.push({ key, title: members[0].group_title, items: members });
    for (const m of members) groupedIds.add(m.id);
  }
  groups.sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
  return { groups, loose: items.filter((i) => !groupedIds.has(i.id)) };
}

function sortCards(cards, mode) {
  const out = cards.slice();
  const byTitle = (a, b) => a.sortTitle.localeCompare(b.sortTitle);
  if (mode === "recent") {
    out.sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b));
  } else if (mode === "liked") {
    out.sort((a, b) => b.liked - a.liked || byTitle(a, b));
  } else if (mode === "random") {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
  } else {
    out.sort(byTitle);
  }
  return out;
}

// Full-category view: the whole category loaded once, cached, and sorted
// client-side. The home page's horizontal rows are a shelf, not the library.
function CategoryGrid({ category }) {
  const [cat, setCat] = useState(undefined); // undefined=loading, null=unknown
  const [data, setData] = useState(null); // { shows, items, cards }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sortMode, setSortMode] = useState(initialSort);
  const [shuffleSeed, setShuffleSeed] = useState(0);
  // Category switches reconcile the SAME component instance — a slow response
  // for the old category must not land in the new one's grid.
  const genRef = useRef(0);
  // Mirror of `data` for async closures: the settle path decides between an
  // error banner (nothing rendered yet) and staying quiet (grid already on
  // screen) — the closure's `data` binding is frozen at first render.
  const dataRef = useRef(null);

  useEffect(() => {
    const gen = ++genRef.current;
    setCat(undefined);
    setData(null);
    dataRef.current = null;
    setError("");
    setLoading(true);
    fetchCategories()
      .then((cats) => cats.find((c) => c.slug === category) || null)
      // Category list unavailable — try the browse anyway with the slug as its
      // own label rather than dead-ending the page.
      .catch(() => ({ slug: category, label: category }))
      .then((found) => {
        if (gen !== genRef.current) return;
        setCat(found);
        if (found === null) {
          setLoading(false);
          return;
        }
        return loadCategoryFull(category)
          .then((d) => {
            if (gen === genRef.current) {
              setData(d);
              dataRef.current = d;
            }
          })
          .catch((err) => {
            if (gen === genRef.current)
              setError(err.message || "Failed to load library");
          })
          .finally(() => {
            if (gen === genRef.current) setLoading(false);
          });
      });
  }, [category]);

  // View-triggered rescan: opening a category asks the server to refresh
  // exactly this category's folders (server enforces a per-folder cooldown,
  // so most visits are a no-op). While a scan runs, poll cheaply; when it
  // settles, drop only this slug's cache and re-render with what it found.
  useEffect(() => {
    const gen = genRef.current;
    const enc = encodeURIComponent(category);
    let timer;
    let stopped = false;
    // Time-boxed, not attempt-boxed: multi-folder categories scan their
    // folders SEQUENTIALLY server-side, so legitimate refreshes can run for
    // minutes — an attempt cap sized for one folder expired before settle
    // and left the stale snapshot cached past the cooldown. Back off to
    // 10s after the first minute; a wedged folder costs ~6 req/min, capped.
    const startedAt = Date.now();
    const MAX_POLL_MS = 10 * 60_000;
    // Refetch which ALWAYS runs when polling ends — on completion or on the
    // time cap — so a finished scan can never leave pre-scan data cached.
    // Residual: the cap path caches a MID-scan snapshot; it converges on the
    // next visit because the default cooldown (300s) is shorter than this
    // cap. An operator setting the cooldown far above 10 min accepts that a
    // >10-min scan's tail shows up one cooldown later.
    // The rescan may have deleted + reinserted rows onto recycled ids, so
    // stale id-keyed thumbs go too; bumping the generation kills any
    // still-in-flight pre-scan state write from this mount's initial load.
    const settle = async () => {
      fullCache.delete(cacheKey(category));
      invalidateThumbCache();
      const myGen = ++genRef.current;
      try {
        const d = await loadCategoryFull(category);
        if (!stopped && myGen === genRef.current) {
          setData(d);
          dataRef.current = d;
        }
      } catch (err) {
        // The generation bump disarmed the initial load's error/loading
        // handlers — but only a BLANK page earns the error banner. A settle
        // refetch failing over an already-rendered grid must stay quiet:
        // the grid is intact and nothing would ever clear the banner.
        if (!stopped && myGen === genRef.current && !dataRef.current)
          setError(err.message || "Failed to load library");
      } finally {
        if (!stopped && myGen === genRef.current) setLoading(false);
      }
    };
    const poll = async () => {
      if (stopped || gen !== genRef.current) return;
      try {
        const s = await get(`/library/categories/${enc}/scan-status`);
        if (stopped || gen !== genRef.current) return;
        if (s && s.scanning && Date.now() - startedAt < MAX_POLL_MS) {
          timer = setTimeout(
            poll,
            Date.now() - startedAt < 60_000 ? 3000 : 10_000,
          );
          return;
        }
        await settle();
      } catch {
        /* scan-status blip — best-effort; manual Scan in Settings remains */
      }
    };
    post(`/library/categories/${enc}/refresh`)
      .then((res) => {
        if (!stopped && res && res.scanning) timer = setTimeout(poll, 2000);
      })
      .catch(() => {});
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [category]);

  // Folder sections come first, mirroring the on-disk structure in their
  // numbered sequence; only the remaining loose cards obey the sort selector.
  const { groups, loose } = useMemo(
    () => (data ? partitionGroups(data.items) : { groups: [], loose: [] }),
    [data],
  );
  const looseCards = useMemo(
    () => (data ? sortCards(toCards(data.shows, loose), sortMode) : []),
    // shuffleSeed forces a fresh shuffle when Random is (re)selected.
    [data, loose, sortMode, shuffleSeed],
  );

  function changeSort(mode) {
    setSortMode(mode);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, mode);
    } catch {
      /* storage disabled — the choice just won't persist */
    }
    if (mode === "random") setShuffleSeed((s) => s + 1);
  }

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
  const showCount = data ? data.shows.length : 0;
  const total = data ? data.cards.length : 0;
  const empty = !loading && data && total === 0;
  const folderCount = groups.length;
  return html`<div class="browse">
    <div class="category-header">
      <div class="category-heading">
        <h1 class="category-title">${label}</h1>
        ${
          data &&
          html`<span class="category-count"
            >${showCount > 0 ? `${showCount} series · ` : ""}${
              folderCount > 0
                ? `${folderCount} ${folderCount === 1 ? "folder" : "folders"} · `
                : ""
            }${total}
            ${total === 1 ? "title" : "titles"}</span
          >`
        }
      </div>
      ${
        data &&
        looseCards.length > 1 &&
        html`<div class="category-sort">
          <label class="sort-label"
            >Sort
            <select
              class="sort-select"
              value=${sortMode}
              onChange=${(e) => changeSort(e.target.value)}
            >
              ${SORT_MODES.map(
                (m) =>
                  html`<option value=${m.key} selected=${m.key === sortMode}>
                    ${m.label}
                  </option>`,
              )}
            </select>
          </label>
          ${
            sortMode === "random" &&
            html`<button
              class="sort-reshuffle"
              title="Shuffle again"
              onClick=${() => setShuffleSeed((s) => s + 1)}
            >
              ⟳
            </button>`
          }
        </div>`
      }
    </div>
    ${error && html`<div class="empty"><h2>${error}</h2></div>`}
    ${
      !error &&
      empty &&
      html`<div class="empty"><h2>Nothing in ${label} yet</h2></div>`
    }
    ${loading && !data && html`<div class="loading">Loading...</div>`}
    ${groups.map(
      (g) =>
        html`<div class="category-group" key=${g.key}>
          <h2>${g.title}</h2>
          <div class="category-grid">
            ${g.items.map(
              (i) => html`<${MediaCard} key=${"item-" + i.id} item=${i} />`,
            )}
          </div>
        </div>`,
    )}
    ${
      groups.length > 0 &&
      looseCards.length > 0 &&
      html`<h2 class="category-loose-heading">Other</h2>`
    }
    <div class="category-grid">
      ${looseCards.map((c) =>
        c.kind === "show"
          ? html`<${ShowCard} key=${c.key} show=${c.show} />`
          : html`<${MediaCard} key=${c.key} item=${c.item} />`,
      )}
    </div>
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
          load: () => loadCategoryShelf(c.slug, SHELF_SIZE),
        })),
      ];
      const results = await Promise.all(
        defs.map(async (def) => {
          try {
            const d = await def.load();
            const cards = [
              ...(d.shows || []).map((s) => ({ show: s })),
              ...(d.items || []).map((i) => ({ item: i })),
            ].slice(0, SHELF_SIZE);
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
