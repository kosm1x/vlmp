import { basename, relative, sep } from 'node:path';

export type MediaCategory = 'movies' | 'tv' | 'documentaries' | 'doc_series' | 'education' | 'other';
export type MediaType = 'movie' | 'episode' | 'documentary' | 'education' | 'other';

export interface ClassifiedMedia {
  type: MediaType;
  title: string;
  year: number | null;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

const EPISODE_PATTERN = /[Ss](\d{1,2})[Ee](\d{1,3})|(\d{1,2})x(\d{1,3})/;
const YEAR_PATTERN = /[\(\[]?((?:19|20)\d{2})[\)\]]?/;
const NUMBERED_EPISODE = /^(\d{1,3})\s*[-\u2013.]\s*/;

export function classifyByFolder(filePath: string, libraryRoot: string, folderCategory: MediaCategory): ClassifiedMedia {
  const rel = relative(libraryRoot, filePath);
  const fileName = basename(filePath).replace(/\.[^.]+$/, '');
  const parts = rel.split(sep);
  switch (folderCategory) {
    case 'tv': return classifyTV(fileName, parts);
    case 'doc_series': return classifyDocSeries(fileName, parts);
    case 'education': return classifyEducation(fileName, parts);
    case 'documentaries': return classifyDocumentary(fileName);
    case 'movies': return classifyMovie(fileName);
    default: return classifyOther(fileName);
  }
}

function classifyTV(fileName: string, pathParts: string[]): ClassifiedMedia {
  const epMatch = fileName.match(EPISODE_PATTERN);
  const seasonNumber = epMatch ? parseInt(epMatch[1] || epMatch[3], 10) : guessSeasonFromPath(pathParts);
  const episodeNumber = epMatch ? parseInt(epMatch[2] || epMatch[4], 10) : null;
  return { type: 'episode', title: cleanTitle(fileName), year: extractYear(fileName), showTitle: guessShowTitle(pathParts), seasonNumber, episodeNumber };
}

function classifyDocSeries(fileName: string, pathParts: string[]): ClassifiedMedia {
  const epMatch = fileName.match(EPISODE_PATTERN);
  const numMatch = fileName.match(NUMBERED_EPISODE);
  const episodeNumber = epMatch ? parseInt(epMatch[2] || epMatch[4], 10) : numMatch ? parseInt(numMatch[1], 10) : null;
  return { type: 'episode', title: cleanTitle(fileName), year: extractYear(fileName), showTitle: pathParts.length > 1 ? pathParts[0] : null, seasonNumber: epMatch ? parseInt(epMatch[1] || epMatch[3], 10) : 1, episodeNumber };
}

function classifyEducation(fileName: string, pathParts: string[]): ClassifiedMedia {
  const numMatch = fileName.match(NUMBERED_EPISODE);
  return { type: 'education', title: cleanTitle(fileName), year: extractYear(fileName), showTitle: pathParts.length > 1 ? pathParts[0] : null, seasonNumber: null, episodeNumber: numMatch ? parseInt(numMatch[1], 10) : null };
}

function classifyDocumentary(fileName: string): ClassifiedMedia {
  return { type: 'documentary', title: cleanTitle(fileName), year: extractYear(fileName), showTitle: null, seasonNumber: null, episodeNumber: null };
}

function classifyMovie(fileName: string): ClassifiedMedia {
  return { type: 'movie', title: cleanTitle(fileName), year: extractYear(fileName), showTitle: null, seasonNumber: null, episodeNumber: null };
}

function classifyOther(fileName: string): ClassifiedMedia {
  return { type: 'other', title: cleanTitle(fileName), year: extractYear(fileName), showTitle: null, seasonNumber: null, episodeNumber: null };
}

function cleanTitle(name: string): string {
  return name.replace(EPISODE_PATTERN, '').replace(YEAR_PATTERN, '').replace(NUMBERED_EPISODE, '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

function extractYear(name: string): number | null {
  const match = name.match(YEAR_PATTERN);
  return match ? parseInt(match[1], 10) : null;
}

function guessShowTitle(pathParts: string[]): string | null {
  return pathParts.length > 1 ? pathParts[0] : null;
}

function guessSeasonFromPath(pathParts: string[]): number | null {
  for (const part of pathParts) {
    const match = part.match(/[Ss]eason\s*(\d+)|[Ss](\d+)/);
    if (match) return parseInt(match[1] || match[2], 10);
  }
  return null;
}
