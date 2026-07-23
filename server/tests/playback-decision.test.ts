// The play route re-probes never-probed rows (a folder scanned before ffprobe
// existed stores NULL codecs, and canDirectPlay fails open), persists the
// result including pix_fmt + probed_at, and decides direct-vs-transcode from
// the truth — durably (no reprobe-every-start, no 10-bit regression).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";
import { loadConfig } from "../src/config.js";

vi.mock("../src/scanner/probe.js", () => ({ probeFile: vi.fn() }));
import { probeFile } from "../src/scanner/probe.js";
import { resolvePlayback } from "../src/streaming/playback-decision.js";

const config = loadConfig();
const log = { info: () => {}, warn: () => {} };
let db: Database.Database;

function seed(codecs: {
  codec_video?: string | null;
  codec_audio?: string | null;
  pix_fmt?: string | null;
  probed_at?: number | null;
}): number {
  db.prepare(
    "INSERT INTO library_folders (id, path, category) VALUES (1, '/m', 'movies')",
  ).run();
  return (
    db
      .prepare(
        "INSERT INTO media_items (library_folder_id, type, file_path, title, codec_video, codec_audio, pix_fmt, probed_at) VALUES (1, 'movie', '/m/x.mp4', 'X', ?, ?, ?, ?) RETURNING id",
      )
      .get(
        codecs.codec_video ?? null,
        codecs.codec_audio ?? null,
        codecs.pix_fmt ?? null,
        codecs.probed_at ?? null,
      ) as { id: number }
  ).id;
}

function row(id: number) {
  return db.prepare("SELECT * FROM media_items WHERE id = ?").get(id) as never;
}

beforeEach(() => {
  vi.clearAllMocks(); // reset probeFile call history between tests
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe("resolvePlayback re-probe", () => {
  it("re-probes a null-codec row, persists, and transcodes HEVC", async () => {
    const id = seed({ probed_at: null });
    vi.mocked(probeFile).mockResolvedValue({
      duration: 120,
      codecVideo: "hevc",
      codecAudio: "aac",
      pixFmt: "yuv420p",
      width: 1920,
      height: 1080,
      bitrate: null,
      audioTracks: [],
      subtitleTracks: [],
    });
    const d = await resolvePlayback(db, row(id), ".mp4", config, log);
    expect(d.direct).toBe(false); // HEVC → transcode
    const after = db
      .prepare(
        "SELECT codec_video, pix_fmt, probed_at FROM media_items WHERE id = ?",
      )
      .get(id) as { codec_video: string; pix_fmt: string; probed_at: number };
    expect(after.codec_video).toBe("hevc");
    expect(after.probed_at).toBeGreaterThan(0);
  });

  it("does NOT re-probe once probed_at is set (idempotent)", async () => {
    const id = seed({ codec_video: "hevc", probed_at: 100 });
    const d = await resolvePlayback(db, row(id), ".mp4", config, log);
    expect(d.direct).toBe(false);
    expect(vi.mocked(probeFile)).not.toHaveBeenCalled();
  });

  it("durably transcodes 10-bit H.264 — persists pix_fmt so it doesn't regress", async () => {
    const id = seed({ probed_at: null });
    vi.mocked(probeFile).mockResolvedValue({
      duration: 120,
      codecVideo: "h264",
      codecAudio: "aac",
      pixFmt: "yuv420p10le",
      width: 1920,
      height: 1080,
      bitrate: null,
      audioTracks: [],
      subtitleTracks: [],
    });
    const first = await resolvePlayback(db, row(id), ".mp4", config, log);
    expect(first.direct).toBe(false); // 10-bit → transcode
    // Second play uses the now-STORED pix_fmt (no reprobe) and must not regress.
    vi.mocked(probeFile).mockClear();
    const second = await resolvePlayback(db, row(id), ".mp4", config, log);
    expect(vi.mocked(probeFile)).not.toHaveBeenCalled();
    expect(second.direct).toBe(false);
  });

  it("direct-plays 8-bit H.264 after re-probe", async () => {
    const id = seed({ probed_at: null });
    vi.mocked(probeFile).mockResolvedValue({
      duration: 120,
      codecVideo: "h264",
      codecAudio: "aac",
      pixFmt: "yuv420p",
      width: 1280,
      height: 720,
      bitrate: null,
      audioTracks: [],
      subtitleTracks: [],
    });
    const d = await resolvePlayback(db, row(id), ".mp4", config, log);
    expect(d.direct).toBe(true);
  });

  it("marks a stream-less file probed so it isn't re-probed forever", async () => {
    const id = seed({ probed_at: null });
    vi.mocked(probeFile).mockResolvedValue({
      duration: 0,
      codecVideo: null,
      codecAudio: null,
      pixFmt: null,
      width: null,
      height: null,
      bitrate: null,
      audioTracks: [],
      subtitleTracks: [],
    });
    await resolvePlayback(db, row(id), ".mp4", config, log);
    expect(
      (
        db
          .prepare("SELECT probed_at FROM media_items WHERE id = ?")
          .get(id) as {
          probed_at: number | null;
        }
      ).probed_at,
    ).toBeGreaterThan(0);
    vi.mocked(probeFile).mockClear();
    await resolvePlayback(db, row(id), ".mp4", config, log);
    expect(vi.mocked(probeFile)).not.toHaveBeenCalled(); // no infinite re-probe
  });

  it("falls back to the optimistic guess when re-probe fails (no ffprobe)", async () => {
    const id = seed({ probed_at: null });
    vi.mocked(probeFile).mockRejectedValue(new Error("ENOENT ffprobe"));
    const d = await resolvePlayback(db, row(id), ".mp4", config, log);
    expect(d.direct).toBe(true); // fail-open last resort, unchanged behavior
    // Probe failed → probed_at stays null so a later working ffprobe retries.
    expect(
      (
        db
          .prepare("SELECT probed_at FROM media_items WHERE id = ?")
          .get(id) as {
          probed_at: number | null;
        }
      ).probed_at,
    ).toBeNull();
  });
});
