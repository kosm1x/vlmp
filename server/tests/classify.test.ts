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
