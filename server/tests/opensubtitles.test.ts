// OpenSubtitles integration: srt→vtt conversion, language sanitizing, and the
// search/apply routes with the external API mocked at the fetch seam (per
// testing conventions: real DB, mock only the external HTTP service).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/db/schema.js";
import { srtToVtt, sanitizeLanguages } from "../src/subtitles/opensubtitles.js";
import { registerSubtitleRoutes } from "../src/routes/subtitles.js";
import { issueToken } from "../src/auth/jwt.js";
import { loadConfig } from "../src/config.js";

const baseConfig = loadConfig();

describe("srtToVtt", () => {
  it("converts timestamps and prepends the header", () => {
    const srt =
      "1\r\n00:00:01,000 --> 00:00:04,200\r\nHello there.\r\n\r\n2\r\n00:00:05,500 --> 00:00:07,000\r\nSecond line.\r\n";
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.200");
    expect(vtt).toContain("00:00:05.500 --> 00:00:07.000");
    expect(vtt).not.toContain(",000");
  });

  it("strips a BOM and passes through content already in VTT form", () => {
    expect(srtToVtt("﻿WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx")).toBe(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx",
    );
  });

  it("does not touch commas inside cue text", () => {
    const vtt = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nWell, yes, ok\n");
    expect(vtt).toContain("Well, yes, ok");
  });
});

describe("sanitizeLanguages", () => {
  it("defaults, dedupes, sorts, and drops junk", () => {
    expect(sanitizeLanguages(undefined)).toBe("en,es");
    expect(sanitizeLanguages("ES, en , es")).toBe("en,es");
    expect(sanitizeLanguages("pt-BR,en")).toBe("en,pt-br");
    expect(sanitizeLanguages("../../etc,<script>,")).toBe("en");
  });
});

describe("opensubtitles routes", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let userToken: string;
  let dataDir: string;
  let config: typeof baseConfig;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "vlmp-os-"));
    config = {
      ...baseConfig,
      opensubtitlesApiKey: "test-key",
      subtitleDir: join(dataDir, "subtitles"),
    };
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (2, 'viewer', 'x', 'user')",
    ).run();
    db.prepare(
      "INSERT INTO library_folders (id, path, category) VALUES (1, '/m', 'movies')",
    ).run();
    db.prepare(
      "INSERT INTO media_items (id, library_folder_id, type, file_path, title, sort_title, year) VALUES (5, 1, 'movie', '/m/Heat.mkv', 'Heat', 'heat', 1995)",
    ).run();
    userToken = await issueToken(
      { sub: "2", username: "viewer", role: "user" },
      config,
    );
    app = Fastify();
    registerSubtitleRoutes(app, db, config);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const auth = () => ({ authorization: `Bearer ${userToken}` });

  it("503s with a setup hint when no API key is configured", async () => {
    const bare = Fastify();
    registerSubtitleRoutes(bare, db, {
      ...config,
      opensubtitlesApiKey: "",
    });
    await bare.ready();
    const res = await bare.inject({
      method: "GET",
      url: "/subtitles/5/opensubtitles/search",
      headers: auth(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("VLMP_OPENSUBTITLES_API_KEY");
    await bare.close();
  });

  it("search maps results, uses the TMDb id when cached, sends the Api-Key", async () => {
    db.prepare(
      "INSERT INTO metadata_cache (media_id, provider, external_id, data_json) VALUES (5, 'tmdb', '949', '{}')",
    ).run();
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: [
              {
                attributes: {
                  language: "es",
                  release: "Heat.1995.BluRay",
                  download_count: 4200,
                  from_trusted: true,
                  hearing_impaired: false,
                  files: [{ file_id: 111, file_name: "heat-es.srt" }],
                },
              },
              { attributes: { language: "en", files: [] } },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "GET",
      url: "/subtitles/5/opensubtitles/search?languages=es,en",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    // The empty-files result is dropped; the real one is mapped.
    expect(results).toEqual([
      {
        file_id: 111,
        file_name: "heat-es.srt",
        language: "es",
        release: "Heat.1995.BluRay",
        download_count: 4200,
        from_trusted: true,
        hearing_impaired: false,
      },
    ]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("tmdb_id=949");
    expect(url).toContain("languages=en%2Ces");
    const init = fetchMock.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)["Api-Key"]).toBe(
      "test-key",
    );
  });

  it("search falls back to title+year without a TMDb id", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "GET",
      url: "/subtitles/5/opensubtitles/search",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("query=Heat");
    expect(url).toContain("year=1995");
  });

  it("upstream failures surface as 502 with the real message (quota case)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Download limit reached" }), {
            status: 406,
          }),
      ),
    );
    const res = await app.inject({
      method: "GET",
      url: "/subtitles/5/opensubtitles/search",
      headers: auth(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("Download limit reached");
  });

  it("apply downloads, converts to VTT, persists, and replaces same-language rows", async () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHola\n";
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/download"))
        return new Response(
          JSON.stringify({ link: "https://dl.example/f.srt", remaining: 42 }),
          { status: 200 },
        );
      return new Response(srt, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "POST",
      url: "/subtitles/5/opensubtitles/apply",
      headers: auth(),
      payload: { file_id: 111, language: "es" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.remaining).toBe(42);
    expect(body.subtitle.language).toBe("es");
    expect(body.subtitle.source).toBe("opensubtitles");
    expect(body.subtitle.format).toBe("vtt");
    const written = readFileSync(body.subtitle.file_path, "utf-8");
    expect(written.startsWith("WEBVTT")).toBe(true);
    expect(written).toContain("00:00:01.000 --> 00:00:02.000");

    // Applying a different file for the same language replaces row + file.
    const res2 = await app.inject({
      method: "POST",
      url: "/subtitles/5/opensubtitles/apply",
      headers: auth(),
      payload: { file_id: 222, language: "es" },
    });
    expect(res2.statusCode).toBe(200);
    const rows = db
      .prepare(
        "SELECT * FROM subtitles WHERE media_id = 5 AND source = 'opensubtitles'",
      )
      .all() as { file_path: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toContain("os_222.vtt");
    expect(existsSync(body.subtitle.file_path)).toBe(false);
  });

  it("apply rejects oversized subtitle bodies before buffering them", async () => {
    const big = "x".repeat(1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).endsWith("/download"))
          return new Response(
            JSON.stringify({ link: "https://dl.example/f.srt" }),
            { status: 200 },
          );
        return new Response(big, {
          status: 200,
          headers: { "content-length": String(20 * 1024 * 1024) },
        });
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/subtitles/5/opensubtitles/apply",
      headers: auth(),
      payload: { file_id: 111, language: "es" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("too large");
  });

  it("apply caps a streamed body that declares no content-length", async () => {
    const sixMb = "x".repeat(6 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).endsWith("/download"))
          return new Response(
            JSON.stringify({ link: "https://dl.example/f.srt" }),
            { status: 200 },
          );
        // Stream chunks with no content-length header — only the byte
        // counter inside readBodyCapped can stop this one.
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            for (let i = 0; i < 6; i++)
              controller.enqueue(enc.encode(sixMb.slice(0, 1024 * 1024)));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/subtitles/5/opensubtitles/apply",
      headers: auth(),
      payload: { file_id: 111, language: "es" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("too large");
  });

  it("apply rejects a non-https download link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ link: "http://169.254.169.254/latest" }),
            { status: 200 },
          ),
      ),
    );
    const res = await app.inject({
      method: "POST",
      url: "/subtitles/5/opensubtitles/apply",
      headers: auth(),
      payload: { file_id: 111, language: "es" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("non-https");
  });

  it("apply validates the body shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/subtitles/5/opensubtitles/apply",
      headers: auth(),
      payload: { file_id: "abc", language: "../es" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("non-admin cannot search subtitles for media in a hidden library", async () => {
    db.prepare("UPDATE library_folders SET is_visible = 0 WHERE id = 1").run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const res = await app.inject({
      method: "GET",
      url: "/subtitles/5/opensubtitles/search",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
