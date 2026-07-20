// v0.1.4 CPU fix: transcodes are paced with -readrate instead of racing the
// whole file at max speed, which means segments past the encode frontier are
// produced on demand (wait when imminent, restart ffmpeg at the position when
// not). These tests pin the spawn args and the restart decision logic.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import {
  parseFfmpegCaps,
  primeFfmpegCaps,
  resetFfmpegCapsCache,
} from "../src/streaming/ffmpeg-caps.js";
import {
  startTranscode,
  SEGMENT_SECONDS,
} from "../src/streaming/transcoder.js";
import {
  createSession,
  startProfileTranscode,
  ensureSegmentReady,
  destroyAllSessions,
  type StreamSession,
} from "../src/streaming/session.js";
import { getAvailableProfiles } from "../src/streaming/adaptive.js";
import { primeHwEncoder } from "../src/streaming/hw-encoders.js";

// Spawning this fails with ENOENT — the job dies almost immediately.
const DEAD_FFMPEG = "/nonexistent/ffmpeg-for-args-test";
const baseConfig = loadConfig();
let tmp: string;
let cfgDead: Config; // jobs die at spawn — for restart-decision assertions
let cfgAlive: Config; // jobs stay running — for wait-don't-restart assertions

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vlmp-pacing-"));
  const alive = join(tmp, "fake-ffmpeg.sh");
  writeFileSync(alive, "#!/bin/sh\nsleep 30\n");
  chmodSync(alive, 0o755);
  cfgDead = { ...baseConfig, ffmpegPath: DEAD_FFMPEG, transcodeTmpDir: tmp };
  cfgAlive = { ...baseConfig, ffmpegPath: alive, transcodeTmpDir: tmp };
  const caps = { readrate: true, readrateInitialBurst: true };
  primeFfmpegCaps(DEAD_FFMPEG, caps);
  primeFfmpegCaps(alive, caps);
});

afterEach(() => {
  destroyAllSessions();
  resetFfmpegCapsCache();
  primeHwEncoder(null);
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseFfmpegCaps", () => {
  it.each([
    ["ffmpeg version 7.1-full_build-www.gyan.dev", true, true],
    ["ffmpeg version 6.1.1-3ubuntu5", true, true],
    ["ffmpeg version 6.0.1", true, false],
    ["ffmpeg version n5.1.4", true, false],
    ["ffmpeg version 4.4.2-0ubuntu0.22.04.1", false, false],
    ["ffmpeg version N-113005-g8d1e2b8f7a", false, false],
    ["not ffmpeg at all", false, false],
  ])("%s", (banner, readrate, burst) => {
    expect(parseFfmpegCaps(banner)).toEqual({
      readrate,
      readrateInitialBurst: burst,
    });
  });
});

describe("startTranscode pacing args", () => {
  const profile = getAvailableProfiles(1280, 720)[0];

  function argsOf(job: ReturnType<typeof startTranscode>): string[] {
    const args = job.process.spawnargs;
    job.process.kill("SIGKILL");
    return args;
  }

  it("paces with -readrate and initial burst when ffmpeg supports both", () => {
    const args = argsOf(startTranscode("/in.mkv", "s1", profile, cfgDead));
    const i = args.indexOf("-readrate");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("1.5");
    expect(args.indexOf("-readrate_initial_burst")).toBeGreaterThan(-1);
    // Input options must precede -i to apply to the input
    expect(i).toBeLessThan(args.indexOf("-i"));
  });

  it("omits the burst flag on ffmpeg 5.x-6.0", () => {
    primeFfmpegCaps(DEAD_FFMPEG, {
      readrate: true,
      readrateInitialBurst: false,
    });
    const args = argsOf(startTranscode("/in.mkv", "s2", profile, cfgDead));
    expect(args).toContain("-readrate");
    expect(args).not.toContain("-readrate_initial_burst");
  });

  it("stays unpaced on pre-5.0 ffmpeg", () => {
    primeFfmpegCaps(DEAD_FFMPEG, {
      readrate: false,
      readrateInitialBurst: false,
    });
    const args = argsOf(startTranscode("/in.mkv", "s3", profile, cfgDead));
    expect(args).not.toContain("-readrate");
  });

  it("numbers segments from startNumber for seek restarts", () => {
    const args = argsOf(
      startTranscode("/in.mkv", "s4", profile, cfgDead, { startNumber: 25 }),
    );
    const i = args.indexOf("-start_number");
    expect(args[i + 1]).toBe("25");
  });

  it("defaults to segment 0", () => {
    const args = argsOf(startTranscode("/in.mkv", "s5", profile, cfgDead));
    const i = args.indexOf("-start_number");
    expect(args[i + 1]).toBe("0");
  });

  it("forces keyframes on the segment grid (synthetic playlist alignment)", () => {
    const args = argsOf(startTranscode("/in.mkv", "s6", profile, cfgDead));
    const i = args.indexOf("-force_key_frames");
    expect(args[i + 1]).toBe("expr:gte(t,n_forced*6)");
  });

  it("uses the probed hardware encoder with GPU decode, no x264 flags", () => {
    primeHwEncoder("h264_nvenc");
    const args = argsOf(startTranscode("/in.mkv", "s7", profile, cfgDead));
    expect(args).toContain("h264_nvenc");
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("-tune"); // x264-only flag would error on nvenc
    // -hwaccel is an input option — must precede -i
    expect(args.indexOf("-hwaccel")).toBeGreaterThan(-1);
    expect(args.indexOf("-hwaccel")).toBeLessThan(args.indexOf("-i"));
    // shared flags survive
    expect(args).toContain("-force_key_frames");
    expect(args).toContain("-readrate");
  });

  it("stays on software x264 when no hardware encoder is selected", () => {
    const args = argsOf(startTranscode("/in.mkv", "s8", profile, cfgDead));
    expect(args).toContain("libx264");
    expect(args).toContain("-tune");
    expect(args).not.toContain("-hwaccel");
  });
});

describe.skipIf(process.platform === "win32")("ensureSegmentReady", () => {
  function makeSession(): StreamSession {
    const s = createSession(
      cfgAlive,
      1,
      "/in.mkv",
      "1",
      getAvailableProfiles(1280, 720),
      false,
      undefined,
      7200,
    );
    expect(s).not.toBeNull();
    return s!;
  }

  it("spawns the encoder at the requested position on first demand", async () => {
    // No job exists yet (playlists are synthetic and never start ffmpeg) —
    // the first segment request creates the job right at the resume point.
    const session = makeSession();
    await expect(
      ensureSegmentReady(session, "720p", "segment_0050.ts", cfgDead),
    ).rejects.toThrow();
    const job = session.jobs.get("720p")!;
    expect(job.startNumber).toBe(50);
    const args = job.process.spawnargs;
    expect(args[args.indexOf("-ss") + 1]).toBe(String(50 * SEGMENT_SECONDS));
  });

  it("serves a segment that is already on disk without touching the job", async () => {
    const session = makeSession();
    const job = startProfileTranscode(session, "720p", cfgAlive)!;
    writeFileSync(join(job.outputDir, "segment_0003.ts"), "TS");
    const path = await ensureSegmentReady(
      session,
      "720p",
      "segment_0003.ts",
      cfgAlive,
    );
    expect(path).toBe(join(job.outputDir, "segment_0003.ts"));
    expect(session.jobs.get("720p")).toBe(job); // no restart
  });

  it("waits (not restarts) for a segment just past the encode frontier", async () => {
    const session = makeSession();
    const job = startProfileTranscode(session, "720p", cfgAlive)!;
    writeFileSync(join(job.outputDir, "segment_0004.ts"), "TS");
    // frontier=4, request 6 (within slack of 3) — encoder is about to write it
    const pending = ensureSegmentReady(
      session,
      "720p",
      "segment_0006.ts",
      cfgAlive,
    );
    setTimeout(
      () => writeFileSync(join(job.outputDir, "segment_0006.ts"), "TS"),
      500,
    );
    await expect(pending).resolves.toContain("segment_0006.ts");
    expect(session.jobs.get("720p")).toBe(job);
  });

  it("restarts the encoder at the requested position on a far-forward seek", async () => {
    const session = makeSession();
    const old = startProfileTranscode(session, "720p", cfgAlive)!;
    // Age the job past the freshness grace so the restart logic engages
    old.startedAt -= 60_000;
    writeFileSync(join(old.outputDir, "segment_0000.ts"), "TS");
    // Segment 100 is far beyond frontier 0 → kill + respawn at the position.
    // The respawn uses the dead binary so the wait rejects fast — the restart
    // itself is what's asserted. Timeline is absolute: -ss is n * 6 exactly.
    await expect(
      ensureSegmentReady(session, "720p", "segment_0100.ts", cfgDead),
    ).rejects.toThrow();
    const fresh = session.jobs.get("720p")!;
    expect(fresh).not.toBe(old);
    expect(fresh.startNumber).toBe(100);
    const args = fresh.process.spawnargs;
    expect(args[args.indexOf("-ss") + 1]).toBe(String(100 * SEGMENT_SECONDS));
    expect(args[args.indexOf("-start_number") + 1]).toBe("100");
  });

  it("restarts when rewinding past a previous restart point", async () => {
    const session = makeSession();
    const old = startProfileTranscode(session, "720p", cfgAlive, 50)!;
    old.startedAt -= 60_000;
    writeFileSync(join(old.outputDir, "segment_0055.ts"), "TS");
    // Segment 10 predates the job's window and is not on disk → restart at 10
    await expect(
      ensureSegmentReady(session, "720p", "segment_0010.ts", cfgDead),
    ).rejects.toThrow();
    expect(session.jobs.get("720p")!.startNumber).toBe(10);
  });

  it("rejects segments beyond the playlist's own end without spawning", async () => {
    // Session duration 60 → playlist lists segments 0..9. A request for 10+
    // (stale playlist or probe) must reject instantly with NO ffmpeg spawn —
    // first-demand spawns past EOF burned two throwaway runs per retry.
    const session = makeSession(); // duration 7200 → max index 1197
    await expect(
      ensureSegmentReady(session, "720p", "segment_1198.ts", cfgDead),
    ).rejects.toThrow("past end of stream");
    expect(session.jobs.size).toBe(0); // nothing spawned
  });

  it("fails fast past EOF after a clean encoder exit (no restart churn)", async () => {
    const session = makeSession();
    const job = startProfileTranscode(session, "720p", cfgAlive)!;
    job.startedAt -= 60_000;
    job.exited = true;
    job.exitCode = 0; // encoder ran to the real end of stream
    writeFileSync(join(job.outputDir, "segment_0004.ts"), "TS");
    // Segment 6 is beyond everything the finished encoder produced — a
    // restart would seek past EOF and produce nothing, so reject instantly.
    const before = Date.now();
    await expect(
      ensureSegmentReady(session, "720p", "segment_0006.ts", cfgDead),
    ).rejects.toThrow("past end of stream");
    expect(Date.now() - before).toBeLessThan(1000); // no wait, no respawn
    expect(session.jobs.get("720p")).toBe(job);
  });

  it("restarts a dead job even for a segment in its own range", async () => {
    const session = makeSession();
    const old = startProfileTranscode(session, "720p", cfgAlive)!;
    old.startedAt -= 60_000;
    old.exited = true; // reaped or crashed encoder
    await expect(
      ensureSegmentReady(session, "720p", "segment_0001.ts", cfgDead),
    ).rejects.toThrow();
    expect(session.jobs.get("720p")).not.toBe(old);
  });

  it("restarts a wedged encoder after a producible wait times out", async () => {
    // The encoder is alive and the segment is in the wait zone, but the
    // frontier never advances (wedged ffmpeg). The reaper can't rescue —
    // these very requests keep refreshing lastAccessed — so the timed-out
    // wait itself must trigger one restart at the position.
    const session = makeSession();
    const old = startProfileTranscode(session, "720p", cfgAlive)!;
    old.startedAt -= 60_000;
    writeFileSync(join(old.outputDir, "segment_0004.ts"), "TS");
    // Segment 6 is producible (frontier 4 + wait zone), but never appears.
    // The rescue respawn uses the dead binary so the second wait also fails —
    // the restart itself is what's asserted, and it must happen only once.
    await expect(
      ensureSegmentReady(session, "720p", "segment_0006.ts", cfgDead, 400),
    ).rejects.toThrow();
    const fresh = session.jobs.get("720p")!;
    expect(fresh).not.toBe(old);
    expect(fresh.startNumber).toBe(6);
  });

  it("does not thrash-restart a freshly restarted job", async () => {
    const session = makeSession();
    const job = startProfileTranscode(session, "720p", cfgAlive, 100)!;
    // No segments on disk yet, but the job is seconds old and 101 is within
    // its startup window — wait for it instead of kill/respawn thrash.
    const pending = ensureSegmentReady(
      session,
      "720p",
      "segment_0101.ts",
      cfgAlive,
    );
    setTimeout(
      () => writeFileSync(join(job.outputDir, "segment_0101.ts"), "TS"),
      300,
    );
    await expect(pending).resolves.toContain("segment_0101.ts");
    expect(session.jobs.get("720p")).toBe(job); // waited, no second respawn
  });
});
