import { describe, it, expect } from "vitest";
import { join, sep } from "node:path";
import { isPathInside } from "../src/paths.js";

// Absolute root so resolve() inside the helper is deterministic regardless of cwd.
const root = join(process.cwd(), "sandbox");

describe("isPathInside", () => {
  it("accepts a direct child", () => {
    expect(isPathInside(root, join(root, "a.vtt"))).toBe(true);
  });

  it("accepts a nested descendant", () => {
    expect(isPathInside(root, join(root, "1", "en_0.vtt"))).toBe(true);
  });

  it("rejects the root itself", () => {
    expect(isPathInside(root, root)).toBe(false);
    expect(isPathInside(root, root + sep)).toBe(false);
  });

  it("rejects a sibling whose name shares the root as a prefix", () => {
    // The old startsWith(root) guard accepted this.
    expect(isPathInside(root, `${root}-evil${sep}a.vtt`)).toBe(false);
  });

  it("rejects traversal escaping the root", () => {
    expect(isPathInside(root, join(root, "..", "outside.vtt"))).toBe(false);
    expect(isPathInside(root, join(root, "a", "..", "..", "b"))).toBe(false);
  });

  it("rejects an unrelated absolute path", () => {
    expect(isPathInside(root, join(process.cwd(), "elsewhere", "x"))).toBe(
      false,
    );
  });

  it("normalizes redundant segments that stay inside", () => {
    expect(isPathInside(root, join(root, "a", "..", "b.vtt"))).toBe(true);
  });

  it("accepts a file legitimately named with a leading double-dot", () => {
    // split(sep) guard, not startsWith("..") — "..foo" is a valid child name.
    expect(isPathInside(root, join(root, "..foo.vtt"))).toBe(true);
  });
});
