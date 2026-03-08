import { describe, it, expect, afterEach } from 'vitest';
import { createSession, getSession, destroySession, getActiveSessions, getSessionCount, destroyAllSessions } from '../src/streaming/session.js';
import { getAvailableProfiles } from '../src/streaming/adaptive.js';

afterEach(() => { destroyAllSessions(); });

describe('stream sessions', () => {
  it('creates with unique id', () => {
    const s = createSession(1, '/test/movie.mp4', '1', getAvailableProfiles(1920, 1080), false);
    expect(s.id).toHaveLength(16); expect(s.mediaId).toBe(1); expect(s.profiles).toHaveLength(4);
  });
  it('creates direct play', () => { const s = createSession(1, '/test.mp4', '1', [], true); expect(s.directPlay).toBe(true); });
  it('retrieves by id', () => { const s = createSession(1, '/t.mp4', '1', [], true); expect(getSession(s.id)!.id).toBe(s.id); });
  it('returns undefined for unknown', () => { expect(getSession('nope')).toBeUndefined(); });
  it('destroys session', () => { const s = createSession(1, '/t.mp4', '1', [], true); destroySession(s.id); expect(getSessionCount()).toBe(0); });
  it('tracks active sessions', () => { createSession(1, '/a.mp4', '1', [], true); createSession(2, '/b.mp4', '2', [], true); expect(getActiveSessions()).toHaveLength(2); });
  it('destroys all', () => { createSession(1, '/a.mp4', '1', [], true); createSession(2, '/b.mp4', '2', [], true); destroyAllSessions(); expect(getSessionCount()).toBe(0); });
});
