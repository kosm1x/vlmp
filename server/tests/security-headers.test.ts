import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";

describe("security headers", () => {
  const app = Fastify();

  beforeAll(async () => {
    app.addHook("onSend", async (_request, reply, payload) => {
      const ct = reply.getHeader("content-type") as string | undefined;
      if (ct && ct.includes("video/mp2t")) return payload;
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://esm.sh https://cdn.jsdelivr.net https://unpkg.com 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
      );
      reply.header("X-Frame-Options", "DENY");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
      reply.header(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
      );
      return payload;
    });
    app.get("/test", async () => ({ ok: true }));
    app.get("/segment", async (_req, reply) => {
      reply.header("content-type", "video/mp2t");
      return reply.send(Buffer.from("fake-segment"));
    });
    await app.ready();
  });

  afterAll(() => app.close());

  it("sets all 5 security headers on normal response", async () => {
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(res.headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("CSP script-src includes CDN domains", async () => {
    const res = await app.inject({ method: "GET", url: "/test" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("https://esm.sh");
    expect(csp).toContain("https://unpkg.com");
  });

  it("CSP contains frame-ancestors 'none'", async () => {
    const res = await app.inject({ method: "GET", url: "/test" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("skips CSP for HLS segments", async () => {
    const res = await app.inject({ method: "GET", url: "/segment" });
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-frame-options"]).toBeUndefined();
  });
});
