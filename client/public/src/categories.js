import { get } from "./api.js";

// Categories are user data (Settings can create/delete them) but change
// rarely — one fetch per page load, shared by nav, home rows, and the
// category grid. invalidate() after a Settings mutation.
let cache = null;
let inflight = null;

export function fetchCategories() {
  if (cache) return Promise.resolve(cache);
  if (!inflight)
    inflight = get("/categories")
      .then((cats) => {
        cache = cats;
        return cats;
      })
      .finally(() => {
        inflight = null;
      });
  return inflight;
}

export function invalidateCategories() {
  cache = null;
}
