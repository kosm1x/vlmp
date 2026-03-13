import { describe, it, expect } from "vitest";
import {
  rewritePlaylist,
  stripSensitiveFields,
} from "../src/federation/proxy.js";

describe("Federation Stream", () => {
  it("rewritePlaylist rewrites relative segment URLs", () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment_0000.ts
#EXTINF:10.0,
segment_0001.ts
#EXT-X-ENDLIST`;

    const rewritten = rewritePlaylist(playlist, 5, "session123");
    expect(rewritten).toContain(
      "/federation/servers/5/stream/session123/segment_0000.ts",
    );
    expect(rewritten).toContain(
      "/federation/servers/5/stream/session123/segment_0001.ts",
    );
    expect(rewritten).toContain("#EXTM3U");
    expect(rewritten).toContain("#EXT-X-ENDLIST");
  });

  it("rewritePlaylist rewrites absolute URLs", () => {
    const playlist = `#EXTM3U
#EXTINF:10.0,
https://remote.example.com/stream/abc/720p/segment_0000.ts
#EXTINF:10.0,
https://remote.example.com/stream/abc/720p/segment_0001.ts`;

    const rewritten = rewritePlaylist(playlist, 3, "fed-session");
    expect(rewritten).toContain(
      "/federation/servers/3/stream/fed-session/stream/abc/720p/segment_0000.ts",
    );
    expect(rewritten).not.toContain("https://remote.example.com");
  });

  it("rewritePlaylist preserves comment lines", () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment.ts`;

    const rewritten = rewritePlaylist(playlist, 1, "s1");
    const lines = rewritten.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe("#EXT-X-VERSION:3");
    expect(lines[2]).toBe("#EXT-X-TARGETDURATION:10");
    expect(lines[3]).toBe("#EXTINF:10.0,");
  });

  it("rewritePlaylist handles empty content", () => {
    expect(rewritePlaylist("", 1, "s1")).toBe("");
  });

  it("stripSensitiveFields adds server metadata for stream responses", () => {
    const item = {
      session_id: "abc",
      mode: "hls",
      url: "/stream/abc/master.m3u8",
      file_path: "/secret/path.mp4",
    };
    const result = stripSensitiveFields(item, 2, "RemoteServer");
    expect(result.session_id).toBe("abc");
    expect(result).not.toHaveProperty("file_path");
    expect(result.server_id).toBe(2);
  });
});
