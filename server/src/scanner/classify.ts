import { basename, relative, sep } from "node:path";

export type MediaCategory =
  "movies" | "tv" | "documentaries" | "doc_series" | "education" | "other";
export type MediaType =
  "movie" | "episode" | "documentary" | "education" | "other";

export interface ClassifiedMedia {
  type: MediaType;
  title: string;
  year: number | null;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

const EPISODE_PATTERN = /[Ss](\d{1,2})[Ee](\d{1,3})|(\d{1,2})x(\d{1,3})/;
const NUMBERED_EPISODE = /^(\d{1,3})\s*[-\u2013.]\s*/;
// Everything from the first release-junk token onward is not title. Tokens
// kept high-precision on purpose (no bare "web"/"dvd"/"cam" \u2014 those collide
// with real titles).
const RELEASE_JUNK =
  /\b(2160p|1080p|720p|576p|480p|4k|uhd|blu-?ray|bd-?rip|br-?rip|web-?rip|web-?dl|hdtv|hd-?rip|dvd-?rip|dvdscr|screener|remux|x26[45]|h\.?26[45]|hevc|xvid|divx|aac(?:2?\.?\d)?|ac-?3|e-?ac-?3|dts(?:-?hd)?|truehd|atmos|extended|unrated|remastered|theatrical|proper|repack|imax|hdr10\+?|hdr|dovi|10-?bit|8-?bit)\b/i;

export function classifyByFolder(
  filePath: string,
  libraryRoot: string,
  folderCategory: MediaCategory,
): ClassifiedMedia {
  const rel = relative(libraryRoot, filePath);
  const fileName = basename(filePath).replace(/\.[^.]+$/, "");
  const parts = rel.split(sep);
  switch (folderCategory) {
    case "tv":
      return classifyTV(fileName, parts);
    case "doc_series":
      return classifyDocSeries(fileName, parts);
    case "education":
      return classifyEducation(fileName, parts);
    case "documentaries":
      return classifyDocumentary(fileName);
    case "movies":
      return classifyMovie(fileName);
    default:
      return classifyOther(fileName);
  }
}

function classifyTV(fileName: string, pathParts: string[]): ClassifiedMedia {
  const epMatch = fileName.match(EPISODE_PATTERN);
  const seasonNumber = epMatch
    ? parseInt(epMatch[1] || epMatch[3], 10)
    : guessSeasonFromPath(pathParts);
  const episodeNumber = epMatch ? parseInt(epMatch[2] || epMatch[4], 10) : null;
  const { title, year } = parseTitleYear(fileName, {
    stripEpisode: true,
    stripNumbered: true,
  });
  return {
    type: "episode",
    title,
    year,
    showTitle: guessShowTitle(pathParts),
    seasonNumber,
    episodeNumber,
  };
}

function classifyDocSeries(
  fileName: string,
  pathParts: string[],
): ClassifiedMedia {
  const epMatch = fileName.match(EPISODE_PATTERN);
  const numMatch = fileName.match(NUMBERED_EPISODE);
  const episodeNumber = epMatch
    ? parseInt(epMatch[2] || epMatch[4], 10)
    : numMatch
      ? parseInt(numMatch[1], 10)
      : null;
  const { title, year } = parseTitleYear(fileName, {
    stripEpisode: true,
    stripNumbered: true,
  });
  return {
    type: "episode",
    title,
    year,
    showTitle: pathParts.length > 1 ? pathParts[0] : null,
    seasonNumber: epMatch ? parseInt(epMatch[1] || epMatch[3], 10) : 1,
    episodeNumber,
  };
}

function classifyEducation(
  fileName: string,
  pathParts: string[],
): ClassifiedMedia {
  const numMatch = fileName.match(NUMBERED_EPISODE);
  const { title, year } = parseTitleYear(fileName, {
    stripEpisode: true,
    stripNumbered: true,
  });
  return {
    type: "education",
    title,
    year,
    showTitle: pathParts.length > 1 ? pathParts[0] : null,
    seasonNumber: null,
    episodeNumber: numMatch ? parseInt(numMatch[1], 10) : null,
  };
}

function classifyDocumentary(fileName: string): ClassifiedMedia {
  const { title, year } = parseTitleYear(fileName, { stripEpisode: true });
  return {
    type: "documentary",
    title,
    year,
    showTitle: null,
    seasonNumber: null,
    episodeNumber: null,
  };
}

function classifyMovie(fileName: string): ClassifiedMedia {
  const { title, year } = parseTitleYear(fileName, { stripEpisode: true });
  return {
    type: "movie",
    title,
    year,
    showTitle: null,
    seasonNumber: null,
    episodeNumber: null,
  };
}

function classifyOther(fileName: string): ClassifiedMedia {
  const { title, year } = parseTitleYear(fileName, { stripEpisode: true });
  return {
    type: "other",
    title,
    year,
    showTitle: null,
    seasonNumber: null,
    episodeNumber: null,
  };
}

interface CleanOptions {
  // Numbered-prefix stripping is only semantic where numbering means episode
  // order (tv/doc_series/education). On movies it ate leading-number TITLES:
  // "300.2006.720P.BRRIP" lost "300." as an "episode number".
  stripNumbered?: boolean;
  stripEpisode?: boolean;
}

function parseTitleYear(
  raw: string,
  opts: CleanOptions = {},
): { title: string; year: number | null } {
  let s = raw;
  if (opts.stripEpisode) s = s.replace(EPISODE_PATTERN, " ");
  if (opts.stripNumbered) s = s.replace(NUMBERED_EPISODE, " ");
  // A bracketed year is a year, not a group tag — normalize [1999] → (1999)
  // BEFORE the tag strip destroys it.
  s = s.replace(/\[\s*((?:19|20)\d{2})\s*\]/g, " ($1) ");
  s = s.replace(/\[[^\]]*\]/g, " "); // [YTS.MX]-style group tags
  s = s.replace(/[._]/g, " ");
  const junk = s.match(RELEASE_JUNK);
  if (junk && junk.index !== undefined) s = s.slice(0, junk.index);

  // Year: a bracketed (2019) is unambiguous. Otherwise take the LAST bare
  // year-like token, and never one at position 0 unless others follow —
  // leading years are usually titles ("1917", "2012"): "1917 2019 …" is the
  // film 1917 released 2019, not the reverse.
  let year: number | null = null;
  const bracketed = s.match(/\(\s*((?:19|20)\d{2})\s*\)/);
  if (bracketed) {
    year = parseInt(bracketed[1], 10);
    s = s.replace(bracketed[0], " ");
  } else {
    const all = [...s.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)];
    const last = all[all.length - 1];
    if (last && (all.length > 1 || last.index! > 0)) {
      year = parseInt(last[1], 10);
      s = s.slice(0, last.index!) + s.slice(last.index! + 4);
    }
  }

  const title = s
    .replace(/\(\s*\)/g, " ")
    .replace(/[-–\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { title: title || raw.replace(/[._]/g, " ").trim(), year };
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
