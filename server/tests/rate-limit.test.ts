// The media data plane (HLS segments, thumbnails, subtitle files, federation
// stream proxy) is exempt from the global rate limiter so background/control
// traffic can never 429 playback.
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { isDataPlanePath, parseTrustProxy } from "../src/rate-limit.js";

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

describe("parseTrustProxy", () => {
  it("defaults to OFF for unset and falsey values", () => {
    // The default is a security boundary: trusting X-Forwarded-For while
    // directly reachable lets anyone spoof it and evade the limiter.
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("   ")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("accepts the boolean words a human actually types", () => {
    // Case and synonyms matter here beyond tidiness: an unrecognised string
    // reaches Fastify, which throws at construction. That throw hits a
    // deliberately non-fatal uncaughtException handler, so the process would
    // survive with no listener and exit 0 — a supervisor reads that as a clean
    // stop and never restarts. "FALSE" must not brick boot.
    for (const off of ["FALSE", "False", "no", "NO", "off", "Off", "0"]) {
      expect(parseTrustProxy(off)).toBe(false);
    }
    for (const on of ["true", " true ", "TRUE", "yes", "on"]) {
      expect(parseTrustProxy(on)).toBe(true);
    }
  });

  it("passes through hop counts and valid address lists", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
    expect(parseTrustProxy("127.0.0.1,::1")).toBe("127.0.0.1,::1");
    // Normalized, not passed through: whitespace and empty entries are stripped
    // because Fastify would choke on them (see the property test below).
    expect(parseTrustProxy("127.0.0.1, ::1")).toBe("127.0.0.1,::1");
    expect(parseTrustProxy("127.0.0.1,")).toBe("127.0.0.1");
    expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(parseTrustProxy("172.16.0.0/12")).toBe("172.16.0.0/12");
    expect(parseTrustProxy("fd00::/8")).toBe("fd00::/8");
  });

  it("refuses anything it cannot validate, rather than passing it to Fastify", () => {
    // "1.5" is the sharp one: ipaddr.js parses it as the inet_aton form of
    // 1.0.0.5, so Fastify constructs happily and silently trusts a bogus host
    // while ignoring X-Forwarded-For. Node's isIP rejects it, so we do too.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of [
      "1.5",
      "garbage",
      "127.0.0.1 ::1",
      "10.0.0.0/99",
      "-1",
    ]) {
      expect(parseTrustProxy(bad)).toBe(false);
    }
    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockRestore();
  });
});

describe("trustProxy restores per-client limits behind a proxy", () => {
  // Takes the RAW env value and runs it through parseTrustProxy, so these cover
  // the parse + wiring rather than just Fastify's own behaviour — if the parser
  // regressed to always-false or always-true, these would fail.
  async function makeApp(rawEnv: string | undefined) {
    const app = Fastify({ trustProxy: parseTrustProxy(rawEnv) });
    await app.register(rateLimit, {
      global: true,
      max: 2,
      timeWindow: "1 minute",
      allowList: (req) => isDataPlanePath(req.url.split("?")[0]),
    });
    app.get("/library/browse", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  // Reproduces the real failure: a same-host reverse proxy makes every request
  // arrive from 127.0.0.1, so distinct clients share one bucket and the third
  // request 429s even though it is the FIRST from that client.
  it("without trustProxy, distinct clients share one bucket", async () => {
    const app = await makeApp(undefined);
    const hdr = (ip: string) => ({ "x-forwarded-for": ip });
    expect(
      (
        await app.inject({
          url: "/library/browse",
          headers: hdr("203.0.113.1"),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/library/browse",
          headers: hdr("203.0.113.2"),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/library/browse",
          headers: hdr("203.0.113.3"),
        })
      ).statusCode,
    ).toBe(429);
    await app.close();
  });

  it("with trustProxy, each forwarded client gets its own budget", async () => {
    const app = await makeApp("true");
    const hdr = (ip: string) => ({ "x-forwarded-for": ip });
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      expect(
        (await app.inject({ url: "/library/browse", headers: hdr(ip) }))
          .statusCode,
      ).toBe(200);
    }
    // The limit still applies per client — same IP past max is still rejected.
    const same = { "x-forwarded-for": "203.0.113.9" };
    expect(
      (await app.inject({ url: "/library/browse", headers: same })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/library/browse", headers: same })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/library/browse", headers: same })).statusCode,
    ).toBe(429);
    await app.close();
  });
});

// The invariant that actually matters, asserted against the REAL downstream
// parser: every value parseTrustProxy is willing to return must be one Fastify
// can construct with. Asserting on the returned value instead (as the cases
// above do) cannot catch a value that passes our validation and then throws
// inside Fastify — which is the exit-0-no-listener failure this module exists to
// prevent, so it gets a property test rather than examples.
describe("parseTrustProxy never returns a value Fastify rejects", () => {
  const inputs = [
    undefined,
    "",
    "   ",
    "false",
    "FALSE",
    "no",
    "off",
    "0",
    "true",
    "TRUE",
    "yes",
    "on",
    "1",
    "2",
    "99",
    "loopback",
    "linklocal",
    "uniquelocal",
    "127.0.0.1",
    "::1",
    "127.0.0.1,::1",
    "127.0.0.1, ::1",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "fd00::/8",
    "10.0.0.0/32",
    "::1/128",
    // Shapes a human actually mistypes or reaches for:
    "127.0.0.1,",
    ",127.0.0.1",
    "127.0.0.1,,::1",
    "loopback,",
    " , ",
    "0.0.0.0/0",
    "10.0.0.0/0",
    "::/0",
    "127.0.0.1/0",
    "1.5",
    "garbage",
    "127.0.0.1 ::1",
    "10.0.0.0/99",
    "-1",
    "10.0.0.0/255.0.0.0",
  ];

  it("holds for every input, valid or malformed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad: string[] = [];
    for (const raw of inputs) {
      const parsed = parseTrustProxy(raw);
      try {
        Fastify({ trustProxy: parsed as never });
      } catch (err) {
        bad.push(
          `${JSON.stringify(raw)} -> ${JSON.stringify(parsed)}: ${(err as Error).message}`,
        );
      }
    }
    spy.mockRestore();
    expect(bad).toEqual([]);
  });
});
