import type Database from "better-sqlite3";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { Subtitle } from "./service.js";

// opensubtitles.com REST API v1. Search needs only the Api-Key; downloads
// draw from the key's daily quota (the API reports `remaining` — surfaced to
// the client). Errors from upstream are wrapped in OpenSubtitlesError so the
// routes can map them to 502 with the real message instead of a blind 500.

const OS_API = "https://api.opensubtitles.com/api/v1";
const FETCH_TIMEOUT_MS = 15_000;
// Downloads run against a third-party quota — cap the payload defensively
// (subtitle files are ~100 KB; 5 MB is already absurd).
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

export class OpenSubtitlesError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface OsSearchResult {
  file_id: number;
  file_name: string;
  language: string;
  release: string;
  download_count: number;
  from_trusted: boolean;
  hearing_impaired: boolean;
}

function osHeaders(config: Config): Record<string, string> {
  return {
    "Api-Key": config.opensubtitlesApiKey,
    "User-Agent": "VLMP v0.1",
    Accept: "application/json",
  };
}

async function osFetch(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OpenSubtitlesError(
      `OpenSubtitles unreachable: ${err instanceof Error ? err.message : err}`,
      502,
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as {
        message?: string;
        errors?: string[];
      };
      detail = body.message || body.errors?.join("; ") || "";
    } catch {
      /* non-JSON error body */
    }
    throw new OpenSubtitlesError(
      `OpenSubtitles error ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }
  return res;
}

// Language codes are forwarded into a third-party query string — allow only
// ISO-639-ish tokens ("en", "es", "pt-br"), comma-separated.
export function sanitizeLanguages(raw: string | undefined): string {
  const langs = (raw || "en,es")
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(l));
  return langs.length > 0 ? [...new Set(langs)].sort().join(",") : "en";
}

export async function searchOpenSubtitles(
  config: Config,
  media: { title: string; year: number | null; tmdbId: string | null },
  languages: string,
): Promise<OsSearchResult[]> {
  const params = new URLSearchParams({ languages });
  // A TMDb id (from the metadata matcher) beats fuzzy title search — exact
  // entity match, no "similar title from the wrong year" results.
  if (media.tmdbId) params.set("tmdb_id", media.tmdbId);
  else {
    params.set("query", media.title);
    if (media.year) params.set("year", String(media.year));
  }
  const res = await osFetch(`${OS_API}/subtitles?${params}`, {
    headers: osHeaders(config),
  });
  const body = (await res.json()) as {
    data?: {
      attributes?: {
        language?: string;
        release?: string;
        download_count?: number;
        from_trusted?: boolean;
        hearing_impaired?: boolean;
        files?: { file_id: number; file_name?: string }[];
      };
    }[];
  };
  const results: OsSearchResult[] = [];
  for (const item of body.data || []) {
    const a = item.attributes;
    const file = a?.files?.[0];
    if (!a || !file) continue;
    results.push({
      file_id: file.file_id,
      file_name: file.file_name || "",
      language: a.language || "",
      release: a.release || "",
      download_count: a.download_count || 0,
      from_trusted: !!a.from_trusted,
      hearing_impaired: !!a.hearing_impaired,
    });
  }
  return results;
}

// SRT and VTT share cue structure; the conversion is header + comma→dot in
// timestamps. Anything else (ASS/SSA/sub) is rejected upstream by requesting
// the file OpenSubtitles serves for file_id, which is always SRT.
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})(\s*-->\s*)(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2$3$4.$5",
    );
  if (/^WEBVTT/.test(body)) return body;
  return `WEBVTT\n\n${body}`;
}

// Enforce the size cap WHILE reading — `.text()` would buffer the whole body
// before any check, so an oversized response could OOM the process first.
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const declared = parseInt(res.headers.get("content-length") || "0", 10);
  if (declared > maxBytes)
    throw new OpenSubtitlesError("Subtitle file too large", 502);
  if (!res.body) return "";
  let received = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk as Uint8Array);
      received += buf.length;
      if (received > maxBytes) {
        throw new OpenSubtitlesError("Subtitle file too large", 502);
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof OpenSubtitlesError) throw err;
    // A timeout/abort DURING body streaming is still an upstream failure —
    // map it like osFetch does so the route answers 502, not 500.
    throw new OpenSubtitlesError(
      `OpenSubtitles download interrupted: ${err instanceof Error ? err.message : err}`,
      502,
    );
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function downloadAndPersistSubtitle(
  db: Database.Database,
  config: Config,
  mediaId: number,
  fileId: number,
  language: string,
): Promise<{ subtitle: Subtitle; remaining: number | null }> {
  const dl = await osFetch(`${OS_API}/download`, {
    method: "POST",
    headers: { ...osHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId, sub_format: "srt" }),
  });
  const dlBody = (await dl.json()) as { link?: string; remaining?: number };
  if (!dlBody.link)
    throw new OpenSubtitlesError(
      "OpenSubtitles returned no download link",
      502,
    );
  // The link is third-party-controlled input to a server-side fetch — require
  // https so a poisoned response can't point us at internal plaintext hosts.
  let linkUrl: URL;
  try {
    linkUrl = new URL(dlBody.link);
  } catch {
    throw new OpenSubtitlesError("OpenSubtitles returned an invalid link", 502);
  }
  if (linkUrl.protocol !== "https:")
    throw new OpenSubtitlesError(
      "OpenSubtitles returned a non-https download link",
      502,
    );

  const fileRes = await osFetch(dlBody.link, { headers: {} });
  const raw = await readBodyCapped(fileRes, MAX_SUBTITLE_BYTES);
  const vtt = srtToVtt(raw);

  const dir = resolve(config.subtitleDir, String(mediaId));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `os_${fileId}.vtt`);
  await writeFile(filePath, vtt, "utf-8");

  // One OpenSubtitles subtitle per (media, language): applying a better one
  // replaces the previous download, file included.
  const previous = db
    .prepare(
      "SELECT * FROM subtitles WHERE media_id = ? AND language = ? AND source = 'opensubtitles'",
    )
    .get(mediaId, language) as Subtitle | undefined;
  if (previous) {
    db.prepare("DELETE FROM subtitles WHERE id = ?").run(previous.id);
    if (previous.file_path !== filePath)
      await unlink(previous.file_path).catch(() => {});
  }
  const subtitle = db
    .prepare(
      "INSERT INTO subtitles (media_id, language, label, format, file_path, source) VALUES (?, ?, ?, 'vtt', ?, 'opensubtitles') RETURNING *",
    )
    .get(
      mediaId,
      language,
      `${language.toUpperCase()} (OpenSubtitles)`,
      filePath,
    ) as Subtitle;
  return { subtitle, remaining: dlBody.remaining ?? null };
}
