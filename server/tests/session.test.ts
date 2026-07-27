import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscodeJob } from "../src/streaming/transcoder.js";
import {
  createSession,
  getSession,
  destroySession,
  getActiveSessions,
  getSessionCount,
  destroyAllSessions,
} from "../src/streaming/session.js";
import { getAvailableProfiles } from "../src/streaming/adaptive.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();

afterEach(() => {
  destroyAllSessions();
});

describe("stream sessions", () => {
  it("creates with unique id", () => {
    const s = createSession(
      config,
      1,
      "/test/movie.mp4",
      "1",
      getAvailableProfiles(1920, 1080),
      false,
    );
    expect(s).not.toBeNull();
    expect(s!.id).toHaveLength(32);
    expect(s!.mediaId).toBe(1);
    expect(s!.profiles).toHaveLength(4);
  });
  it("creates direct play", () => {
    const s = createSession(config, 1, "/test.mp4", "1", [], true);
    expect(s!.directPlay).toBe(true);
  });
  it("stores transcode options for lazy profile starts", () => {
    const s = createSession(
      config,
      1,
      "/t.mp4",
      "1",
      [],
      false,
      { audioTrack: 1 },
      5400,
    );
    expect(s!.transcodeOptions).toEqual({ audioTrack: 1 });
    expect(s!.duration).toBe(5400);
  });
  it("caps concurrent transcode sessions but not direct play", () => {
    for (let i = 0; i < config.maxTranscodeSessions; i++) {
      expect(
        createSession(config, i, `/m${i}.mp4`, "1", [], false),
      ).not.toBeNull();
    }
    expect(createSession(config, 99, "/over.mp4", "1", [], false)).toBeNull();
    expect(
      createSession(config, 100, "/direct.mp4", "1", [], true),
    ).not.toBeNull();
  });
  it("retrieves by id", () => {
    const s = createSession(config, 1, "/t.mp4", "1", [], true);
    expect(getSession(s!.id)!.id).toBe(s!.id);
  });
  it("returns undefined for unknown", () => {
    expect(getSession("nope")).toBeUndefined();
  });
  it("destroys session", () => {
    const s = createSession(config, 1, "/t.mp4", "1", [], true);
    destroySession(s!.id);
    expect(getSessionCount()).toBe(0);
  });
  it("tracks active sessions", () => {
    createSession(config, 1, "/a.mp4", "1", [], true);
    createSession(config, 2, "/b.mp4", "2", [], true);
    expect(getActiveSessions()).toHaveLength(2);
  });
  it("destroys all", () => {
    createSession(config, 1, "/a.mp4", "1", [], true);
    createSession(config, 2, "/b.mp4", "2", [], true);
    destroyAllSessions();
    expect(getSessionCount()).toBe(0);
  });
});

describe("teardown never signals a dead child", () => {
  // `ChildProcess.killed` means "a signal was sent", not "the process is
  // alive" — it stays false for a child that exited on its own. Calling kill()
  // then targets a reaped PID, which the kernel may have recycled, so the
  // signal lands on an unrelated process. In CI the recycled PID was the test
  // runner: `npm test` died ~1s in with exit 137.
  // Models the real ChildProcess fields teardown inspects. `killed` stays false
  // in BOTH cases on purpose — that is the whole point: it records that a signal
  // was sent, so it cannot distinguish a running child from a reaped one. Only
  // exitCode does.
  const fakeJob = (exited: boolean, onKill: () => void) =>
    ({
      exited,
      lastAccessed: Date.now(),
      outputDir: join(dir, "720p"),
      process: {
        pid: 424242,
        killed: false,
        exitCode: exited ? 0 : null,
        signalCode: null,
        kill: () => {
          onKill();
          return true;
        },
      },
    }) as unknown as TranscodeJob;

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vlmp-session-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not signal a job that already exited", () => {
    const s = createSession(config, 1, "/m.mp4", "1", [], false)!;
    let kills = 0;
    s.jobs.set(
      "720p",
      fakeJob(true, () => kills++),
    );
    destroySession(s.id);
    expect(
      kills,
      "signalling an exited child targets a PID the kernel may have reassigned",
    ).toBe(0);
  });

  it("still signals a job that is genuinely running", () => {
    // The other half: the guard must not turn teardown into a no-op, or
    // real encoders leak.
    const s = createSession(config, 1, "/m.mp4", "1", [], false)!;
    let kills = 0;
    s.jobs.set(
      "720p",
      fakeJob(false, () => kills++),
    );
    destroySession(s.id);
    expect(kills, "a live encoder must still be torn down").toBe(1);
  });
});
