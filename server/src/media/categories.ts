import type Database from "better-sqlite3";

export type CategoryKind = "movie" | "series";

export interface Category {
  id: number;
  slug: string;
  label: string;
  kind: CategoryKind;
  created_at: number;
}

// Slugs are URL path segments (client routes on #/<slug>) and the value stored
// in library_folders.category — keep them boring: lowercase alnum + _ / -.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// Path segments the client router owns; a category slug shadowing one would
// make that category unreachable (or worse, hijack the page).
const RESERVED_SLUGS = new Set([
  "login",
  "search",
  "detail",
  "show",
  "play",
  "playlists",
  "servers",
  "health",
  "settings",
]);

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function listCategories(db: Database.Database): Category[] {
  return db.prepare("SELECT * FROM categories ORDER BY id").all() as Category[];
}

export function getCategoryBySlug(
  db: Database.Database,
  slug: string,
): Category | undefined {
  return db.prepare("SELECT * FROM categories WHERE slug = ?").get(slug) as
    Category | undefined;
}

export type CreateCategoryResult =
  { ok: true; category: Category } | { ok: false; error: string };

export function createCategory(
  db: Database.Database,
  input: { label: string; kind: CategoryKind; slug?: string },
): CreateCategoryResult {
  const label = input.label.trim();
  if (!label) return { ok: false, error: "Label is required" };
  const slug = input.slug?.trim() || slugify(label);
  if (!SLUG_PATTERN.test(slug))
    return {
      ok: false,
      error:
        "Slug must be 1-40 chars: lowercase letters, digits, _ or - (starting with a letter or digit)",
    };
  if (RESERVED_SLUGS.has(slug))
    return { ok: false, error: `"${slug}" is a reserved name` };
  if (getCategoryBySlug(db, slug))
    return { ok: false, error: `Category "${slug}" already exists` };
  const category = db
    .prepare(
      "INSERT INTO categories (slug, label, kind) VALUES (?, ?, ?) RETURNING *",
    )
    .get(slug, label, input.kind) as Category;
  return { ok: true, category };
}

export type DeleteCategoryResult =
  { ok: true } | { ok: false; status: 404 | 409; error: string };

// Defaults are deletable like any other category — the only guard is
// referential: a category still assigned to library folders can't go, or its
// folders (and their media) would silently drop out of every browse surface.
export function deleteCategory(
  db: Database.Database,
  id: number,
): DeleteCategoryResult {
  const category = db
    .prepare("SELECT * FROM categories WHERE id = ?")
    .get(id) as Category | undefined;
  if (!category) return { ok: false, status: 404, error: "Category not found" };
  const inUse = db
    .prepare("SELECT COUNT(*) as count FROM library_folders WHERE category = ?")
    .get(category.slug) as { count: number };
  if (inUse.count > 0)
    return {
      ok: false,
      status: 409,
      error: `Category is used by ${inUse.count} library folder${inUse.count === 1 ? "" : "s"} — remove or reassign them first`,
    };
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
  return { ok: true };
}
