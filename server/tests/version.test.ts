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

  // MAJOR.MINOR.PATCH[.BUILD[.HOTFIX]] with an optional pre-release suffix,
  // deliberately not semver — see CONTRIBUTING.md § Versioning (the fifth part
  // is a hotfix on a published build, added for v0.1.9.9.1). The suffix must
  // start with a LETTER: that is what separates a real pre-release
  // ("0.2.0.0-rc.1") from npm's prerelease encoding of a build number
  // ("0.1.9-4"), which is exactly the form this scheme replaced. An earlier
  // `-[0-9A-Za-z.]+` suffix accepted "0.1.9-4" and so pinned nothing.
  const SCHEME = /^\d+\.\d+\.\d+(\.\d+){0,2}(-[A-Za-z][0-9A-Za-z.]*)?$/;

  it("keeps package.json on the documented 3-to-5-part scheme", () => {
    expect(pkgVersion).toMatch(SCHEME);
  });

  it("accepts the documented forms and rejects the encodings it replaced", () => {
    // The reject list is the point of this test: without it the pattern above
    // can pass while permitting the drift its comment claims to catch.
    for (const v of [
      "0.1.9.4",
      "0.2.0",
      "0.2.0.0-rc.1",
      "1.0.0.0",
      "0.10.0.1",
      "0.1.9.9.1",
    ]) {
      expect(v, `${v} must be a valid version`).toMatch(SCHEME);
    }
    for (const v of [
      "0.1.9-4",
      "0.1.9-5",
      "0.1.9-0",
      "0.1",
      "0.1.9.4.5.6",
      "v0.1.9.4",
      "0.1.9.4-",
    ]) {
      expect(v, `${v} must NOT be a valid version`).not.toMatch(SCHEME);
    }
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
