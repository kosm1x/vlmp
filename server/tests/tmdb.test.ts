import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchMovie,
  searchTV,
  getMovieDetail,
  getTVDetail,
  fullPosterUrl,
  fullBackdropUrl,
} from "../src/metadata/tmdb.js";

describe("TMDb client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(data: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(data),
    });
  }

  describe("fullPosterUrl / fullBackdropUrl", () => {
    it("should build full URLs from TMDb paths", () => {
      expect(fullPosterUrl("/abc.jpg")).toBe(
        "https://image.tmdb.org/t/p/w500/abc.jpg",
      );
      expect(fullBackdropUrl("/xyz.jpg")).toBe(
        "https://image.tmdb.org/t/p/w1280/xyz.jpg",
      );
    });

    it("should return null for null input", () => {
      expect(fullPosterUrl(null)).toBeNull();
      expect(fullBackdropUrl(null)).toBeNull();
    });
  });

  describe("searchMovie", () => {
    it("should search movies and return results", async () => {
      mockFetch({
        results: [
          {
            id: 123,
            title: "Test Movie",
            original_title: "Test Movie",
            release_date: "2023-01-01",
            overview: "A test movie",
            poster_path: "/poster.jpg",
            backdrop_path: "/backdrop.jpg",
            vote_average: 7.5,
            genre_ids: [28, 12],
          },
        ],
      });
      const results = await searchMovie("Test", null, "testapikey");
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Test Movie");
      expect(results[0].id).toBe(123);
    });

    it("should pass year parameter when provided", async () => {
      mockFetch({ results: [] });
      await searchMovie("Test", 2023, "testapikey");
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(url).toContain("year=2023");
    });

    it("should use api_key query param for v3 keys", async () => {
      mockFetch({ results: [] });
      await searchMovie("Test", null, "abc123key");
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(url).toContain("api_key=abc123key");
    });

    it("should use Bearer token for v4 keys starting with eyJ", async () => {
      mockFetch({ results: [] });
      await searchMovie("Test", null, "eyJhbGciOiJIUzI1NiJ9.test");
      const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as RequestInit;
      expect(opts.headers).toHaveProperty(
        "Authorization",
        "Bearer eyJhbGciOiJIUzI1NiJ9.test",
      );
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(url).not.toContain("api_key=");
    });
  });

  describe("searchTV", () => {
    it("should normalize TV results to common format", async () => {
      mockFetch({
        results: [
          {
            id: 456,
            name: "Test Show",
            original_name: "Test Show Original",
            first_air_date: "2022-06-15",
            overview: "A test show",
            poster_path: "/tv_poster.jpg",
            backdrop_path: null,
            vote_average: 8.0,
            genre_ids: [18],
          },
        ],
      });
      const results = await searchTV("Test", null, "testapikey");
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Test Show");
      expect(results[0].release_date).toBe("2022-06-15");
    });
  });

  describe("getMovieDetail", () => {
    it("should fetch movie detail by ID", async () => {
      mockFetch({
        id: 123,
        title: "Detailed Movie",
        overview: "Full description",
        release_date: "2023-01-01",
        poster_path: "/detail_poster.jpg",
        backdrop_path: "/detail_backdrop.jpg",
        vote_average: 8.5,
        genres: [
          { id: 28, name: "Action" },
          { id: 12, name: "Adventure" },
        ],
        runtime: 120,
      });
      const detail = await getMovieDetail(123, "testapikey");
      expect(detail.title).toBe("Detailed Movie");
      expect(detail.genres).toHaveLength(2);
      expect(detail.runtime).toBe(120);
    });
  });

  describe("getTVDetail", () => {
    it("should fetch TV detail and normalize fields", async () => {
      mockFetch({
        id: 456,
        name: "Detailed Show",
        overview: "Show description",
        first_air_date: "2022-06-15",
        poster_path: "/show_poster.jpg",
        backdrop_path: "/show_backdrop.jpg",
        vote_average: 9.0,
        genres: [{ id: 18, name: "Drama" }],
        number_of_seasons: 3,
      });
      const detail = await getTVDetail(456, "testapikey");
      expect(detail.name).toBe("Detailed Show");
      expect(detail.number_of_seasons).toBe(3);
      expect(detail.genres).toHaveLength(1);
    });
  });

  describe("error handling", () => {
    it("should throw on non-OK responses", async () => {
      mockFetch({}, 401);
      await expect(searchMovie("Test", null, "badkey")).rejects.toThrow(
        "TMDb API error",
      );
    });

    it("should handle empty results gracefully", async () => {
      mockFetch({ results: [] });
      const results = await searchMovie("Nonexistent", null, "testapikey");
      expect(results).toHaveLength(0);
    });
  });
});
