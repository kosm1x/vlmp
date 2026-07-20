import { isAbsolute, relative, resolve, sep } from "node:path";

// Separator- and case-robust "is target strictly inside root" check.
// `resolved.startsWith(root)` breaks on Windows (mixed separators,
// case-insensitive NTFS drive letters) and matches sibling dirs sharing a
// prefix (/data/subs vs /data/subs-evil) on every OS. path.relative handles
// normalization and (on win32) case-insensitive comparison for us.
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}
