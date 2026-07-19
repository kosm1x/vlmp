import { describe, it, expect, afterEach, vi } from "vitest";
import {
  proxyStreamStart,
  stripSensitiveFields,
  cleanupFedStreamSession,
} from "../src/federation/proxy.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const server = {
  id: 5,
  name: "Remote",
  url: "http://remote.test",
  shared_secret: "s".repeat(64),
  public_key: "remote-key",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubRemoteStart(payload: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

describe("Federation Stream", () => {
  it("proxyStreamStart rewrites HLS url to the master playlist the remote actually serves", async () => {
    stubRemoteStart({
      session_id: "remote1",
      mode: "hls",
      url: "/federation/api/stream/remote1/master.m3u8",
    });
    const data = await proxyStreamStart(server, config, "42", {}, "user1");
    expect(data.url).toMatch(
      /^\/federation\/servers\/5\/stream\/fed-[a-f0-9]{32}\/master\.m3u8$/,
    );
    cleanupFedStreamSession(data.session_id as string);
  });

  it("proxyStreamStart rewrites direct url through the local proxy (browser has no HMAC)", async () => {
    stubRemoteStart({
      session_id: "remote2",
      mode: "direct",
      url: "/federation/api/stream/remote2/direct",
    });
    const data = await proxyStreamStart(server, config, "43", {}, "user1");
    expect(data.url).toMatch(
      /^\/federation\/servers\/5\/stream\/fed-[a-f0-9]{32}\/direct$/,
    );
    cleanupFedStreamSession(data.session_id as string);
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
