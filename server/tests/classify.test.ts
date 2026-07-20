import { describe, it, expect } from 'vitest';
import { classifyByFolder } from '../src/scanner/classify.js';

describe('classify', () => {
  it('parses movie with year', () => {
    const r = classifyByFolder('/media/Movies/The Matrix (1999)/The Matrix (1999).mkv', '/media/Movies', 'movies');
    expect(r.type).toBe('movie'); expect(r.title).toBe('The Matrix'); expect(r.year).toBe(1999);
  });
  it('parses movie without year', () => {
    const r = classifyByFolder('/media/Movies/Inception/Inception.mp4', '/media/Movies', 'movies');
    expect(r.type).toBe('movie'); expect(r.title).toBe('Inception'); expect(r.year).toBeNull();
  });
  it('parses S01E01 format', () => {
    const r = classifyByFolder('/media/TV/Breaking Bad/Season 01/Breaking Bad S01E05.mkv', '/media/TV', 'tv');
    expect(r.type).toBe('episode'); expect(r.showTitle).toBe('Breaking Bad'); expect(r.seasonNumber).toBe(1); expect(r.episodeNumber).toBe(5);
  });
  it('parses 1x01 format', () => {
    const r = classifyByFolder('/media/TV/Lost/Season 2/Lost 2x10.mkv', '/media/TV', 'tv');
    expect(r.type).toBe('episode'); expect(r.seasonNumber).toBe(2); expect(r.episodeNumber).toBe(10);
  });
  it('detects season from path', () => {
    const r = classifyByFolder('/media/TV/The Office/Season 03/Episode 7.mkv', '/media/TV', 'tv');
    expect(r.showTitle).toBe('The Office'); expect(r.seasonNumber).toBe(3);
  });
  it('classifies documentary', () => {
    const r = classifyByFolder('/media/Docs/Planet Earth (2006).mkv', '/media/Docs', 'documentaries');
    expect(r.type).toBe('documentary'); expect(r.year).toBe(2006);
  });
  it('classifies doc series episode', () => {
    const r = classifyByFolder('/media/DocSeries/Cosmos/Cosmos S01E03.mkv', '/media/DocSeries', 'doc_series');
    expect(r.type).toBe('episode'); expect(r.showTitle).toBe('Cosmos'); expect(r.episodeNumber).toBe(3);
  });
  it('parses education file', () => {
    const r = classifyByFolder('/media/Education/TypeScript Course/01 - Introduction.mp4', '/media/Education', 'education');
    expect(r.type).toBe('education'); expect(r.showTitle).toBe('TypeScript Course'); expect(r.episodeNumber).toBe(1);
  });
  it('classifies other', () => {
    const r = classifyByFolder('/media/Other/random_video.mp4', '/media/Other', 'other');
    expect(r.type).toBe('other'); expect(r.title).toBe('random video');
  });
});

// Field cases from the first Windows library (2026-07-20): release junk kept
// in titles broke TMDb matching, leading-number titles were eaten as episode
// numbers, and the FIRST year-like token won over the real release year.
describe('classify — release-name cleaning', () => {
  const movie = (name: string) =>
    classifyByFolder(`/m/${name}.mkv`, '/m', 'movies');

  it('does not eat a leading-number movie title as an episode number', () => {
    const r = movie('300.2006.720P.BRRIP.XViD.AC3-MAJESTIC');
    expect(r.title).toBe('300'); expect(r.year).toBe(2006);
  });
  it('prefers the LAST year when a leading year is the title', () => {
    const r = movie('1917.2019.1080p.SCREENER.x264');
    expect(r.title).toBe('1917'); expect(r.year).toBe(2019);
  });
  it('keeps a lone leading year as the title with no year', () => {
    const r = movie('1917');
    expect(r.title).toBe('1917'); expect(r.year).toBeNull();
  });
  it('strips release junk after the year', () => {
    const r = movie('12.Angry.Men.1957.1080p.BluRay.x264-GROUP');
    expect(r.title).toBe('12 Angry Men'); expect(r.year).toBe(1957);
  });
  it('cuts from the first junk token when no year exists', () => {
    const r = movie('The.A-Team.EXTENDED.1080p.BluRay');
    expect(r.title).toBe('The A-Team'); expect(r.year).toBeNull();
  });
  it('strips bracket group tags', () => {
    const r = movie('Mary.and.Max.2009.1080p.[YTS.MX]');
    expect(r.title).toBe('Mary and Max'); expect(r.year).toBe(2009);
  });
  it('keeps numbers that are part of the title', () => {
    const r = movie('Blade.Runner.2049.2017.2160p.WEB-DL');
    expect(r.title).toBe('Blade Runner 2049'); expect(r.year).toBe(2017);
    const r2 = movie('2001.A.Space.Odyssey.1968.REMASTERED');
    expect(r2.title).toBe('2001 A Space Odyssey'); expect(r2.year).toBe(1968);
  });
  it('bracketed year wins over bare tokens', () => {
    const r = movie('The Matrix (1999) 2160p');
    expect(r.title).toBe('The Matrix'); expect(r.year).toBe(1999);
  });
  it('doc_series numbered prefixes still parse as episode order', () => {
    const r = classifyByFolder('/d/Cosmos/03. The Harmony of Worlds.mkv', '/d', 'doc_series');
    expect(r.episodeNumber).toBe(3);
    expect(r.title).toBe('The Harmony of Worlds');
  });
});

describe('classify — bracketed year survives group-tag stripping', () => {
  it('[1999] parses as the year, [YTS.MX] still strips', () => {
    const r = classifyByFolder('/m/The.Matrix.[1999].1080p.[YTS.MX].mkv', '/m', 'movies');
    expect(r.title).toBe('The Matrix'); expect(r.year).toBe(1999);
  });
});
