import { describe, it, expect } from "vitest";
import {
  generateSubtitleToken,
  validateSubtitleToken,
} from "../src/subtitles/tokens.js";

const SECRET = "test-secret-for-subtitle-tokens";

describe("subtitle HMAC tokens", () => {
  it("round-trip: generate then validate returns true", () => {
    const { token } = generateSubtitleToken(SECRET, "42", "7");
    expect(validateSubtitleToken(SECRET, "42", "7", token)).toBe(true);
  });

  it("expired token returns false", () => {
    const { token } = generateSubtitleToken(SECRET, "42", "7");
    // Manually create an expired token
    const parts = token.split(":");
    const expiredToken = `${parts[0]}:${Date.now() - 1000}`;
    expect(validateSubtitleToken(SECRET, "42", "7", expiredToken)).toBe(false);
  });

  it("wrong subtitleId returns false", () => {
    const { token } = generateSubtitleToken(SECRET, "42", "7");
    expect(validateSubtitleToken(SECRET, "99", "7", token)).toBe(false);
  });

  it("wrong mediaId returns false", () => {
    const { token } = generateSubtitleToken(SECRET, "42", "7");
    expect(validateSubtitleToken(SECRET, "42", "99", token)).toBe(false);
  });

  it("tampered token returns false", () => {
    const { token } = generateSubtitleToken(SECRET, "42", "7");
    const tampered = "a" + token.slice(1);
    expect(validateSubtitleToken(SECRET, "42", "7", tampered)).toBe(false);
  });

  it("empty token returns false", () => {
    expect(validateSubtitleToken(SECRET, "42", "7", "")).toBe(false);
  });

  it("token without separator returns false", () => {
    expect(validateSubtitleToken(SECRET, "42", "7", "noseparator")).toBe(false);
  });
});
