import { describe, it, expect } from "vitest";
import { readAppVersion } from "../src/version.js";

describe("readAppVersion", () => {
  it("reads a normalized version from package.json (no '-' prerelease dash)", () => {
    const v = readAppVersion();
    expect(v).not.toBe("unknown");
    expect(v).toMatch(/^\d+\.\d+\.\d+(\.\d+)?$/);
    expect(v).not.toContain("-");
  });
});
