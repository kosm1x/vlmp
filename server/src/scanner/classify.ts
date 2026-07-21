import { basename, relative, sep } from "node:path";
import type { CategoryKind } from "../media/categories.js";

export type MediaType =
  "movie" | "episode" | "documentary" | "education" | "other";

export interface ClassifiedMedia {
  type: MediaType;
  title: string;
  year: number | null;
  /** Cleaned display title of the show this file belongs to (episodes only). */
  showTitle: string | null;
  showYear: number | null;
  /**
   * Library-relative path of the show's root directory — the stable identity
   * episodes group under. "" means the library root itself; null means no
   * directory evidence (bare SxxEyy file in the root — group by showTitle).
   */
  showRootRel: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

// Digit boundaries matter: without them "1920x1080" parses as season 20
// episode 108 ("20x108" inside the resolution), and any movie filename
// carrying a resolution token would be misfiled as an episode.
const EPISODE_PATTERN =
  /(?<![0-9a-z])[Ss](\d{1,2})[Ee](\d{1,3})(?![0-9])|(?<![0-9])(\d{1,2})x(\d{1,3})(?![0-9])/;
// NxM tokens that are aspect ratios, not episodes ("Movie.21x9.mkv").
const ASPECT_RATIOS = new Set(["4x3", "16x9", "21x9", "16x10"]);

function matchEpisode(fileName: string): RegExpMatchArray | null {
  const m = fileName.match(EPISODE_PATTERN);
  // Compare the RAW groups: numeric normalization would turn the zero-padded
  // episode convention "4x03" (S4E3) into "4x3" and misfile it as an aspect
  // ratio. Real aspect tokens are never zero-padded.
  if (m && m[3] !== undefined && ASPECT_RATIOS.has(`${m[3]}x${m[4]}`))
    return null;
  return m;
}
const NUMBERED_EPISODE = /^(\d{1,3})\s*[-–.]\s*/;
// A directory literally named "Season N"/"Series N" (or Spanish "Temporada N")
// is unambiguous series evidence — strong enough to override a movie-kind
// category. Deliberately anchored: the loose [Ss](\d+) fallback used INSIDE
// series categories would misread "Mars2020" as season 2020 here.
const SEASON_DIR = /^(?:season|series|temporada)[ ._-]*(\d{1,3})$/i;
// Everything from the first release-junk token onward is not title. Tokens
// kept high-precision on purpose (no bare "web"/"dvd"/"cam" — those collide
// with real titles).
const RELEASE_JUNK =
  /\b(\d{3,4}x\d{3,4}|2160p|1080p|720p|576p|480p|4k|uhd|blu-?ray|bd-?rip|br-?rip|web-?rip|web-?dl|hdtv|hd-?rip|dvd-?rip|dvdscr|screener|remux|x26[45]|h\.?26[45]|hevc|xvid|divx|aac(?:2?\.?\d)?|ac-?3|e-?ac-?3|dts(?:-?hd)?|truehd|atmos|extended|unrated|remastered|theatrical|proper|repack|imax|hdr10\+?|hdr|dovi|10-?bit|8-?bit)\b/i;

export function classifyMedia(
  filePath: string,
  libraryRoot: string,
  category: { slug: string; kind: CategoryKind },
): ClassifiedMedia {
  const rel = relative(libraryRoot, filePath);
  const fileName = basename(filePath).replace(/\.[^.]+$/, "");
  const parts = rel.split(sep);
  const dirParts = parts.slice(0, -1);

  if (category.kind === "series")
    return classifyEpisode(fileName, dirParts, { loose: true });

  // Movie-kind category, but the path carries explicit series evidence — a
  // "Season N"/"Series N" directory or an SxxEyy/NxMM filename. Treat it as an
  // episode so a Docs library can mix single documentaries with doc series.
  const seasonDirIdx = dirParts.findIndex((p) => SEASON_DIR.test(p));
  if (seasonDirIdx !== -1 || matchEpisode(fileName))
    return classifyEpisode(fileName, dirParts, { loose: false });

  const { title, year } = parseTitleYear(fileName, {
    stripEpisode: true,
    stripNumbered: category.slug === "education",
  });
  return {
    type: typeForSlug(category.slug),
    title,
    year,
    // Education keeps its course-folder name as a display grouping (legacy
    // behavior; these rows are type "education", never linked as episodes).
    showTitle:
      category.slug === "education" && dirParts.length > 0 ? dirParts[0] : null,
    showYear: null,
    showRootRel: null,
    seasonNumber: null,
    episodeNumber:
      category.slug === "education" ? numberedPrefix(fileName) : null,
  };
}

// Legacy per-slug types kept for the built-in categories (browse filters and
// TMDb matching key off them); custom movie-kind categories get "movie".
function typeForSlug(slug: string): MediaType {
  switch (slug) {
    case "documentaries":
      return "documentary";
    case "education":
      return "education";
    case "other":
      return "other";
    default:
      return "movie";
  }
}

function numberedPrefix(fileName: string): number | null {
  const m = fileName.match(NUMBERED_EPISODE);
  return m ? parseInt(m[1], 10) : null;
}

function classifyEpisode(
  fileName: string,
  dirParts: string[],
  opts: { loose: boolean },
): ClassifiedMedia {
  const epMatch = matchEpisode(fileName);
  const seasonDirIdx = dirParts.findIndex((p) => SEASON_DIR.test(p));

  let seasonNumber: number | null = null;
  if (epMatch) seasonNumber = parseInt(epMatch[1] || epMatch[3], 10);
  if (seasonNumber == null && seasonDirIdx !== -1) {
    const m = dirParts[seasonDirIdx].match(SEASON_DIR)!;
    seasonNumber = parseInt(m[1], 10);
  }
  if (seasonNumber == null && opts.loose)
    seasonNumber = guessSeasonLoose(dirParts);

  const episodeNumber = epMatch
    ? parseInt(epMatch[2] || epMatch[4], 10)
    : numberedPrefix(fileName);

  const { title, year } = parseTitleYear(fileName, {
    stripEpisode: true,
    stripNumbered: true,
  });

  // Show root: the directory chain above the Season dir when one exists,
  // otherwise the top-level directory. "" = the library root itself is the
  // show; null = bare file in the root with no directory to group under.
  let showRootRel: string | null;
  let showDirName: string | null;
  if (seasonDirIdx !== -1) {
    showRootRel = dirParts.slice(0, seasonDirIdx).join(sep);
    showDirName = seasonDirIdx > 0 ? dirParts[seasonDirIdx - 1] : null;
  } else if (dirParts.length > 0) {
    showRootRel = dirParts[0];
    showDirName = dirParts[0];
  } else {
    showRootRel = null;
    showDirName = null;
  }

  let showTitle: string | null;
  let showYear: number | null = null;
  if (showDirName) {
    const parsed = parseTitleYear(showDirName);
    showTitle = parsed.title;
    showYear = parsed.year;
  } else {
    // No usable directory name (library root or bare file): the cleaned
    // episode title is the best show identity available.
    showTitle = title || null;
  }

  return {
    type: "episode",
    title,
    year,
    showTitle,
    showYear,
    showRootRel,
    seasonNumber,
    episodeNumber,
  };
}

interface CleanOptions {
  // Numbered-prefix stripping is only semantic where numbering means episode
  // order (series categories / education). On movies it ate leading-number
  // TITLES: "300.2006.720P.BRRIP" lost "300." as an "episode number".
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

// Inside a declared series category the season hint can be sloppier: a path
// part like "S2" or "season2". Kept out of the movie-kind override on purpose.
function guessSeasonLoose(dirParts: string[]): number | null {
  for (const part of dirParts) {
    const match = part.match(
      /[Ss]eason\s*(\d+)|(?<![0-9a-z])[Ss](\d{1,3})(?![0-9])/,
    );
    if (match) return parseInt(match[1] || match[2], 10);
  }
  return null;
}
