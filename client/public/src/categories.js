import { get } from "./api.js";

// Categories are user data (Settings can create/delete them) but change
// rarely — one fetch per page load, shared by nav, home rows, and the
// category grid. invalidate() after a Settings mutation.
let cache = null;
let inflight = null;

export function fetchCategories() {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    const p = get("/categories")
      .then((cats) => {
        // Identity check: a request orphaned by invalidateCategories()
        // predates the mutation and must not re-populate the cache (the
        // same late-write race the browse fullCache had).
        if (inflight === p) cache = cats;
        return cats;
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
  }
  return inflight;
}

export function invalidateCategories() {
  cache = null;
  inflight = null; // orphan any pre-mutation request still in flight
}
