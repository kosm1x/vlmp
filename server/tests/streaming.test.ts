import { describe, it, expect } from "vitest";
import { canDirectPlay, isBrowserSafePixFmt } from "../src/streaming/direct.js";
import {
  getAvailableProfiles,
  generateMasterPlaylist,
  generateVariantPlaylist,
} from "../src/streaming/adaptive.js";

describe("direct play", () => {
  it("allows h264/aac in mp4", () => {
    expect(canDirectPlay("h264", "aac", ".mp4")).toBe(true);
  });
  it("allows vp9/opus in webm", () => {
    expect(canDirectPlay("vp9", "opus", ".webm")).toBe(true);
  });
  it("rejects hevc in mp4", () => {
    expect(canDirectPlay("hevc", "aac", ".mp4")).toBe(false);
  });
  it("rejects h264 in mkv", () => {
    expect(canDirectPlay("h264", "aac", ".mkv")).toBe(false);
  });
  it("rejects dts audio", () => {
    expect(canDirectPlay("h264", "dts", ".mp4")).toBe(false);
  });
  it("allows audio-only mp3", () => {
    expect(canDirectPlay(null, "mp3", ".mp3")).toBe(true);
  });
  it("allows audio-only flac", () => {
    expect(canDirectPlay(null, "flac", ".flac")).toBe(true);
  });
  it("rejects audio-only dts", () => {
    expect(canDirectPlay(null, "dts", ".mkv")).toBe(false);
  });
  // Fail-open on unknown codecs: an mp4/m4v/webm with no codec data passes.
  // This is exactly why the start route re-probes null-codec media before
  // trusting a "direct" decision (a folder scanned without ffprobe stores null,
  // and an undecodable file served direct aborts silently in the browser).
  it("fails OPEN when both codecs are unknown in a browser container", () => {
    expect(canDirectPlay(null, null, ".mp4")).toBe(true);
  });
});

describe("isBrowserSafePixFmt (bit depth)", () => {
  it("accepts 8-bit and unknown", () => {
    expect(isBrowserSafePixFmt("yuv420p")).toBe(true);
    expect(isBrowserSafePixFmt("yuvj420p")).toBe(true);
    expect(isBrowserSafePixFmt(null)).toBe(true);
  });
  it("rejects 10-/12-bit (Hi10P, HDR) the browser can't decode", () => {
    expect(isBrowserSafePixFmt("yuv420p10le")).toBe(false);
    expect(isBrowserSafePixFmt("yuv444p10le")).toBe(false);
    expect(isBrowserSafePixFmt("p010le")).toBe(false);
    expect(isBrowserSafePixFmt("yuv420p12le")).toBe(false);
  });
});

describe("adaptive profiles", () => {
  it("returns profiles up to source", () => {
    const p = getAvailableProfiles(1920, 1080);
    expect(p).toHaveLength(4);
    expect(p[0].name).toBe("1080p");
  });
  it("limits for 720p", () => {
    const p = getAvailableProfiles(1280, 720);
    expect(p).toHaveLength(3);
    expect(p[0].name).toBe("720p");
  });
  it("limits for 480p", () => {
    expect(getAvailableProfiles(854, 480)).toHaveLength(2);
  });
  it("defaults for unknown", () => {
    expect(getAvailableProfiles(null, null).every((p) => p.height <= 720)).toBe(
      true,
    );
  });
  it("never returns empty — a sub-360p source falls back to the lowest rung", () => {
    const p = getAvailableProfiles(320, 240);
    expect(p).toHaveLength(1);
    expect(p[0].name).toBe("360p");
  });
});

describe("variant playlist (synthesized VOD)", () => {
  it("lists the full timeline with a short last segment and VOD markers", () => {
    const pl = generateVariantPlaylist(20, 6); // 6+6+6+2
    expect(pl).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(pl.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
    expect((pl.match(/#EXTINF/g) || []).length).toBe(4);
    expect(pl).toContain("segment_0000.ts");
    expect(pl).toContain("segment_0003.ts");
    expect(pl).not.toContain("segment_0004.ts");
    expect(pl).toContain("#EXTINF:2.000000,");
  });

  it("handles durations that divide evenly", () => {
    const pl = generateVariantPlaylist(12, 6);
    expect((pl.match(/#EXTINF/g) || []).length).toBe(2);
    expect(pl).not.toContain("#EXTINF:0");
  });

  it("emits at least one segment for sub-segment media", () => {
    const pl = generateVariantPlaylist(0.5, 6);
    expect(pl).toContain("segment_0000.ts");
    expect(pl).toContain("#EXTINF:0.500000,");
  });

  it("never advertises tail segments keyframe drift can erase (2h NTSC)", () => {
    // 23.976fps segments really run 6.006s, so a 7200s file yields ~1198-1199
    // real segments — a naive ceil(7200/6)=1200 listing would 404 fatally at
    // the end of every long NTSC-rate file.
    const pl = generateVariantPlaylist(7200, 6);
    const count = (pl.match(/#EXTINF/g) || []).length;
    expect(count).toBeLessThanOrEqual(1198);
    expect(count).toBeGreaterThanOrEqual(1195); // but not over-truncated
  });
});

describe("master playlist", () => {
  it("generates valid m3u8 with relative variant URIs", () => {
    const pl = generateMasterPlaylist(getAvailableProfiles(1920, 1080));
    expect(pl).toContain("#EXTM3U");
    expect(pl).toContain("RESOLUTION=1920x1080");
    // Relative URIs resolve against whichever URL served the master —
    // required for the federation proxy path to work at all.
    expect(pl).toContain("1080p/playlist.m3u8");
    expect(pl).not.toContain("/stream/");
  });
});
