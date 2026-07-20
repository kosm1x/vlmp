import { describe, it, expect, afterEach } from "vitest";
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
