import { describe, it, expect } from 'vitest';
import { canDirectPlay } from '../src/streaming/direct.js';
import { getAvailableProfiles, selectInitialProfile, generateMasterPlaylist } from '../src/streaming/adaptive.js';

describe('direct play', () => {
  it('allows h264/aac in mp4', () => { expect(canDirectPlay('h264', 'aac', '.mp4')).toBe(true); });
  it('allows vp9/opus in webm', () => { expect(canDirectPlay('vp9', 'opus', '.webm')).toBe(true); });
  it('rejects hevc in mp4', () => { expect(canDirectPlay('hevc', 'aac', '.mp4')).toBe(false); });
  it('rejects h264 in mkv', () => { expect(canDirectPlay('h264', 'aac', '.mkv')).toBe(false); });
  it('rejects dts audio', () => { expect(canDirectPlay('h264', 'dts', '.mp4')).toBe(false); });
  it('allows audio-only mp3', () => { expect(canDirectPlay(null, 'mp3', '.mp3')).toBe(true); });
  it('allows audio-only flac', () => { expect(canDirectPlay(null, 'flac', '.flac')).toBe(true); });
  it('rejects audio-only dts', () => { expect(canDirectPlay(null, 'dts', '.mkv')).toBe(false); });
});

describe('adaptive profiles', () => {
  it('returns profiles up to source', () => { const p = getAvailableProfiles(1920, 1080); expect(p).toHaveLength(4); expect(p[0].name).toBe('1080p'); });
  it('limits for 720p', () => { const p = getAvailableProfiles(1280, 720); expect(p).toHaveLength(3); expect(p[0].name).toBe('720p'); });
  it('limits for 480p', () => { expect(getAvailableProfiles(854, 480)).toHaveLength(2); });
  it('defaults for unknown', () => { expect(getAvailableProfiles(null, null).every(p => p.height <= 720)).toBe(true); });
  it('selects by bandwidth', () => { expect(selectInitialProfile(getAvailableProfiles(1920, 1080), 5000).name).toBe('720p'); });
  it('selects lowest for low bw', () => { expect(selectInitialProfile(getAvailableProfiles(1920, 1080), 500).name).toBe('360p'); });
  it('selects 1080p for high bw', () => { expect(selectInitialProfile(getAvailableProfiles(1920, 1080), 20000).name).toBe('1080p'); });
});

describe('master playlist', () => {
  it('generates valid m3u8', () => {
    const pl = generateMasterPlaylist(getAvailableProfiles(1920, 1080), 'test-session');
    expect(pl).toContain('#EXTM3U'); expect(pl).toContain('RESOLUTION=1920x1080'); expect(pl).toContain('/stream/test-session/1080p/playlist.m3u8');
  });
});
