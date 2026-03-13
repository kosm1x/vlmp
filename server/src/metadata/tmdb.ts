export interface TMDbSearchResult {
  id: number;
  title: string;
  original_title: string;
  release_date: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  genre_ids: number[];
}

export interface TMDbMovieDetail {
  id: number;
  title: string;
  overview: string;
  release_date: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  genres: { id: number; name: string }[];
  runtime: number | null;
}

export interface TMDbTVDetail {
  id: number;
  name: string;
  overview: string;
  first_air_date: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  genres: { id: number; name: string }[];
  number_of_seasons: number;
}

const BASE_URL = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
const BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280";

function buildHeaders(apiKey: string): Record<string, string> {
  if (apiKey.startsWith("eyJ")) {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }
  return { "Content-Type": "application/json" };
}

function buildUrl(
  path: string,
  apiKey: string,
  params: Record<string, string> = {},
): string {
  const url = new URL(`${BASE_URL}${path}`);
  if (!apiKey.startsWith("eyJ")) {
    url.searchParams.set("api_key", apiKey);
  }
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function tmdbFetch<T>(
  path: string,
  apiKey: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = buildUrl(path, apiKey, params);
  const res = await fetch(url, {
    headers: buildHeaders(apiKey),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`TMDb API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function fullPosterUrl(path: string | null): string | null {
  return path ? `${POSTER_BASE}${path}` : null;
}

export function fullBackdropUrl(path: string | null): string | null {
  return path ? `${BACKDROP_BASE}${path}` : null;
}

export async function searchMovie(
  query: string,
  year: number | null,
  apiKey: string,
): Promise<TMDbSearchResult[]> {
  const params: Record<string, string> = { query };
  if (year) params.year = String(year);
  const data = await tmdbFetch<{ results: TMDbSearchResult[] }>(
    "/search/movie",
    apiKey,
    params,
  );
  return data.results || [];
}

export async function searchTV(
  query: string,
  year: number | null,
  apiKey: string,
): Promise<TMDbSearchResult[]> {
  const params: Record<string, string> = { query };
  if (year) params.first_air_date_year = String(year);
  const data = await tmdbFetch<{ results: Array<Record<string, unknown>> }>(
    "/search/tv",
    apiKey,
    params,
  );
  // TV results use 'name' instead of 'title'
  return (data.results || []).map((r) => ({
    id: r.id as number,
    title: (r.name || r.original_name || "") as string,
    original_title: (r.original_name || "") as string,
    release_date: (r.first_air_date || "") as string,
    overview: (r.overview || "") as string,
    poster_path: r.poster_path as string | null,
    backdrop_path: r.backdrop_path as string | null,
    vote_average: (r.vote_average || 0) as number,
    genre_ids: (r.genre_ids || []) as number[],
  }));
}

export async function getMovieDetail(
  tmdbId: number,
  apiKey: string,
): Promise<TMDbMovieDetail> {
  return tmdbFetch<TMDbMovieDetail>(`/movie/${tmdbId}`, apiKey);
}

export async function getTVDetail(
  tmdbId: number,
  apiKey: string,
): Promise<TMDbTVDetail> {
  const raw = await tmdbFetch<Record<string, unknown>>(`/tv/${tmdbId}`, apiKey);
  return {
    id: raw.id as number,
    name: (raw.name || "") as string,
    overview: (raw.overview || "") as string,
    first_air_date: (raw.first_air_date || "") as string,
    poster_path: raw.poster_path as string | null,
    backdrop_path: raw.backdrop_path as string | null,
    vote_average: (raw.vote_average || 0) as number,
    genres: (raw.genres || []) as { id: number; name: string }[],
    number_of_seasons: (raw.number_of_seasons || 0) as number,
  };
}
