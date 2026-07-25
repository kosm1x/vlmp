import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The app version, read from the nearest package.json.
//
// Returned verbatim. package.json now carries the 4-part scheme directly
// ("0.1.9.4" — see CONTRIBUTING.md), so there is nothing to normalize: the
// string here, the git tag minus its "v", and the published image tag are the
// same characters. Rewriting it would only corrupt a pre-release ("0.2.0-rc.1").
// Layout varies: tsx and the installer place package.json two levels up from
// this module, `npm start` (dist) three.
const DEFAULT_CANDIDATES = [
  resolve(import.meta.dirname, "../../package.json"),
  resolve(import.meta.dirname, "../../../package.json"),
];

// `candidates` is a test seam, not configuration: the verbatim contract above is
// only observable against a package.json whose version would change if rewritten
// (a pre-release), and the real one never holds that at rest.
export function readAppVersion(
  candidates: readonly string[] = DEFAULT_CANDIDATES,
): string {
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return "unknown";
}
