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
