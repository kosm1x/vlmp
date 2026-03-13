import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all VLMP_ env vars to get clean state
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("VLMP_")) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("invalid port throws", () => {
    process.env.VLMP_PORT = "99999";
    expect(() => loadConfig()).toThrow("Invalid port");
  });

  it("non-numeric port throws", () => {
    process.env.VLMP_PORT = "abc";
    expect(() => loadConfig()).toThrow("Invalid port");
  });

  it("valid port is accepted", () => {
    process.env.VLMP_PORT = "3000";
    const config = loadConfig();
    expect(config.port).toBe(3000);
  });

  it("invalid publicUrl throws", () => {
    process.env.VLMP_PUBLIC_URL = "not-a-url";
    expect(() => loadConfig()).toThrow("Invalid VLMP_PUBLIC_URL");
  });

  it("valid publicUrl is accepted", () => {
    process.env.VLMP_PUBLIC_URL = "https://vlmp.example.com";
    const config = loadConfig();
    expect(config.publicUrl).toBe("https://vlmp.example.com");
  });

  it("missing TMDB key logs warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.VLMP_TMDB_API_KEY;
    loadConfig();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("VLMP_TMDB_API_KEY not set"),
    );
    warnSpy.mockRestore();
  });

  it("present TMDB key does not log warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.VLMP_TMDB_API_KEY = "abc123";
    loadConfig();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
