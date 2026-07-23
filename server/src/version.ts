import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The app version, read from the nearest package.json. Layout varies: tsx and
// the installer place package.json two levels up from this module, `npm start`
// (dist) three. The npm-required 3-part prerelease form (e.g. "0.1.9-2") is
// normalized to the 4-part release label ("0.1.9.2") the tags/UI use.
export function readAppVersion(): string {
  const candidates = [
    resolve(import.meta.dirname, "../../package.json"),
    resolve(import.meta.dirname, "../../../package.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version.replace("-", ".");
    } catch {
      /* try the next candidate */
    }
  }
  return "unknown";
}
