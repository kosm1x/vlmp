// The media data plane (HLS segments, thumbnails, subtitle files, federation
// stream proxy) is exempt from the global rate limiter so background/control
// traffic can never 429 playback.
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { isDataPlanePath } from "../src/rate-limit.js";

describe("isDataPlanePath", () => {
  it("matches content-delivery routes", () => {
    expect(isDataPlanePath("/stream/abc123/720p/segment_0001.ts")).toBe(true);
    expect(isDataPlanePath("/stream/abc/master.m3u8")).toBe(true);
    expect(isDataPlanePath("/stream/abc/720p/playlist.m3u8")).toBe(true);
    expect(isDataPlanePath("/stream/abc/direct")).toBe(true);
    expect(isDataPlanePath("/media/42/thumb")).toBe(true);
    expect(isDataPlanePath("/subtitles/42/7/file")).toBe(true);
    expect(
      isDataPlanePath("/federation/servers/3/stream/9/720p/segment_1.ts"),
    ).toBe(true);
    expect(isDataPlanePath("/federation/servers/3/stream/9/master.m3u8")).toBe(
      true,
    );
    expect(isDataPlanePath("/federation/servers/3/stream/9/direct")).toBe(true);
  });

  it("does NOT exempt session-lifecycle or control-plane routes", () => {
    // Session creation must stay limited — direct play has no session cap.
    expect(isDataPlanePath("/stream/5/start")).toBe(false);
    expect(isDataPlanePath("/stream/guest/abc/start")).toBe(false);
    expect(isDataPlanePath("/stream/sess1/keepalive")).toBe(false);
    expect(isDataPlanePath("/stream/sessions")).toBe(false);
    expect(isDataPlanePath("/federation/servers/3/stream/9/start")).toBe(false);
    expect(isDataPlanePath("/federation/servers/3/stream/9/keepalive")).toBe(
      false,
    );
    // Control plane.
    expect(isDataPlanePath("/library/browse")).toBe(false);
    expect(isDataPlanePath("/subtitles/42")).toBe(false);
    expect(isDataPlanePath("/subtitles/42/7/token")).toBe(false);
    expect(isDataPlanePath("/media/42")).toBe(false);
    expect(isDataPlanePath("/admin/metadata/scan/status")).toBe(false);
    expect(isDataPlanePath("/auth/login")).toBe(false);
  });
});

describe("global limiter exempts the data plane", () => {
  async function makeApp() {
    const app = Fastify();
    await app.register(rateLimit, {
      global: true,
      max: 2,
      timeWindow: "1 minute",
      allowList: (req) => isDataPlanePath(req.url.split("?")[0]),
    });
    app.get("/library/browse", async () => ({ ok: true }));
    app.get("/stream/:sid/:profile/:seg", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it("429s the control plane past the limit but never the data plane", async () => {
    const app = await makeApp();
    // Control plane: third request in the window is rejected.
    expect((await app.inject({ url: "/library/browse" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/library/browse" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/library/browse" })).statusCode).toBe(429);
    // Data plane: many requests, never limited (well past max).
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        url: `/stream/s1/720p/segment_${i}.ts`,
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});
