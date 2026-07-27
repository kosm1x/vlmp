import { createHmac } from "node:crypto";
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
    // Sign the past expiry with the REAL HMAC. Splicing a new expiry onto an
    // old signature also invalidates the signature, so that variant passed via
    // the timingSafeEqual branch and proved nothing about the expiry guard —
    // deleting `Date.now() > expires` from tokens.ts left it green. This form
    // is rejected ONLY if the expiry branch does its job.
    const expires = Date.now() - 1000;
    const signature = createHmac("sha256", SECRET)
      .update(`42:7:${expires}`)
      .digest("hex");
    expect(
      validateSubtitleToken(SECRET, "42", "7", `${signature}:${expires}`),
    ).toBe(false);
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
    // Flip the first char to one guaranteed different (the signature is hex, so
    // a blind "a"+slice was a no-op whenever it already started with 'a').
    const tampered = (token[0] === "a" ? "b" : "a") + token.slice(1);
    expect(validateSubtitleToken(SECRET, "42", "7", tampered)).toBe(false);
  });

  it("empty token returns false", () => {
    expect(validateSubtitleToken(SECRET, "42", "7", "")).toBe(false);
  });

  it("token without separator returns false", () => {
    expect(validateSubtitleToken(SECRET, "42", "7", "noseparator")).toBe(false);
  });
});
