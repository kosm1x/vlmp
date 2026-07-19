/**
 * Parse a route parameter as a positive integer.
 * Returns the parsed number, or throws a Fastify 400 error.
 */
export function parseIntParam(val: string, name: string): number {
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 1) {
    const err = new Error(`Invalid ${name}`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return n;
}

/**
 * Parse a JSON TEXT column, returning the fallback on malformed content —
 * one bad scanner-written row must not make a title permanently unplayable.
 */
export function parseJsonColumn<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
