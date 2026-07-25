import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAppVersion } from "../src/version.js";

const pkgVersion = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf-8"),
  ) as { version: string }
).version;

describe("readAppVersion", () => {
  it("reads the real package.json", () => {
    expect(readAppVersion()).toBe(pkgVersion);
  });

  it("keeps package.json on the 4-part scheme", () => {
    // MAJOR.MINOR.PATCH[.BUILD] with an optional pre-release suffix, deliberately
    // not semver — see CONTRIBUTING.md § Versioning. This is the assertion that
    // pins the decision: drift back to npm's "0.1.9-4" prerelease encoding fails
    // here, while the tags, installer filename and image tags stayed 4-part.
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+(\.\d+)?(-[0-9A-Za-z.]+)?$/);
  });

  describe("with a fixture package.json", () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "vlmp-version-"));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const write = (version: unknown) => {
      const p = join(dir, "package.json");
      writeFileSync(p, JSON.stringify({ name: "vlmp", version }));
      return [p];
    };

    // The load-bearing case. A pre-release is the only version whose characters
    // change under rewriting, so it is the only input that can catch a
    // reintroduced normalizer (there used to be a "-"→"." one, which would turn
    // this into "0.2.0.0.rc.1" and skew /api/info from the git tag).
    it("returns a pre-release verbatim", () => {
      expect(readAppVersion(write("0.2.0.0-rc.1"))).toBe("0.2.0.0-rc.1");
    });

    it("falls through to the next candidate when one is missing", () => {
      const real = write("1.2.3.4");
      expect(
        readAppVersion([join(dir, "absent", "package.json"), ...real]),
      ).toBe("1.2.3.4");
    });

    it("reports 'unknown' rather than throwing on unusable input", () => {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{not json");
      expect(readAppVersion([bad])).toBe("unknown");
      expect(readAppVersion(write(42))).toBe("unknown");
      expect(readAppVersion([])).toBe("unknown");
    });
  });
});
