import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { startTranscode } from "../src/streaming/transcoder.js";

describe("input validation - JSON schema", () => {
  const app = Fastify();

  beforeAll(async () => {
    app.post("/test/register", {
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string", minLength: 3, maxLength: 50 },
            password: { type: "string", minLength: 8, maxLength: 128 },
          },
          additionalProperties: false,
        },
      },
      handler: async () => ({ ok: true }),
    });

    app.post("/test/folders", {
      schema: {
        body: {
          type: "object",
          required: ["path", "category"],
          properties: {
            path: { type: "string", minLength: 1 },
            category: {
              type: "string",
              enum: [
                "movies",
                "tv",
                "documentaries",
                "doc_series",
                "education",
                "other",
              ],
            },
          },
          additionalProperties: false,
        },
      },
      handler: async () => ({ ok: true }),
    });

    app.put("/test/progress", {
      schema: {
        body: {
          type: "object",
          required: ["position_seconds"],
          properties: {
            position_seconds: { type: "number", minimum: 0 },
            duration_seconds: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      handler: async () => ({ ok: true }),
    });

    await app.ready();
  });

  afterAll(() => app.close());

  it("missing required field returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/register",
      payload: { username: "alice" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("wrong type returns 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/test/progress",
      payload: { position_seconds: "not a number" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("category enum rejects invalid value", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/folders",
      payload: { path: "/media", category: "invalid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("valid category enum is accepted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/folders",
      payload: { path: "/media", category: "movies" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("valid registration payload is accepted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/register",
      payload: { username: "alice", password: "password123" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("password too short returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/register",
      payload: { username: "alice", password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("input validation - transcoder path", () => {
  it("dash-prefix path rejected in transcoder", () => {
    expect(() =>
      startTranscode(
        "-malicious",
        "test-session",
        {
          name: "720p",
          width: 1280,
          height: 720,
          videoBitrate: "2500k",
          maxRate: "3000k",
          bufSize: "5000k",
          audioBitrate: "128k",
        },
        {
          port: 8080,
          host: "0.0.0.0",
          dataDir: "/tmp",
          dbPath: "/tmp/test.db",
          ffmpegPath: "ffmpeg",
          ffprobePath: "ffprobe",
          jwtSecret: "test",
          jwtExpiresIn: "1h",
          tmdbApiKey: "",
          transcodeTmpDir: "/tmp/transcode",
          subtitleDir: "/tmp/subs",
          serverName: "test",
          publicUrl: "",
          serverFingerprint: "",
        },
      ),
    ).toThrow("Invalid input path");
  });
});
