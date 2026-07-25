import { isIP } from "node:net";

// The media DATA plane — content DELIVERY that is high-volume by nature (one
// HTTP request per HLS segment, a thumbnail per card, etc.). These paths are
// exempt from the global rate limiter so background/control-plane traffic can
// never 429 the requests playback depends on. The limiter still guards
// everything else (auth keeps its own tighter per-route caps).
//
// Scoped to actual delivery — HLS playlists (`.m3u8`), segments (`.ts`), direct
// play, thumbnails, subtitle files. Deliberately NOT the whole `/stream/*`
// prefix: session lifecycle POSTs (`/start`, `/keepalive`, stop) must stay
// limited, since `/stream/:id/start` on direct-play media has no session cap of
// its own — exempting it would open an unbounded session-creation vector.
const DATA_PLANE = [
  /^\/stream\/.+\.(m3u8|ts)$/,
  /^\/stream\/[^/]+\/direct$/,
  /^\/media\/\d+\/thumb$/,
  /^\/subtitles\/\d+\/\d+\/file$/,
  /^\/federation\/servers\/[^/]+\/stream\/.+\.(m3u8|ts)$/,
  /^\/federation\/servers\/[^/]+\/stream\/[^/]+\/direct$/,
];

// True if the path is media content delivery that must not be rate-limited.
// Pass the path WITHOUT its query string.
export function isDataPlanePath(path: string): boolean {
  return DATA_PLANE.some((re) => re.test(path));
}

// Fastify's `trustProxy` setting, parsed from VLMP_TRUST_PROXY.
//
// Why this lives with the limiter: the limiter keys on `req.ip`, and behind a
// reverse proxy on the same host every request arrives from 127.0.0.1. All users
// then share ONE bucket, so a busy household can 429 itself while the server is
// healthy. Trusting the proxy makes `req.ip` the real client again and restores
// per-client limits.
//
// OFF by default, and that default is load-bearing: if VLMP is reachable
// directly, trusting X-Forwarded-For lets anyone spoof the header and evade the
// limiter entirely. Only enable it when the proxy is the sole route in, and
// prefer naming the proxy or a hop count over a bare `true`.
//
// Accepts the forms Fastify does: a boolean word, a hop count ("1"), the
// keywords proxy-addr understands, or a comma-separated list of addresses and
// CIDR subnets ("127.0.0.1,::1", "172.16.0.0/12").
//
// Anything unrecognised returns false with a loud message rather than being
// passed through. Fastify compiles a bad list into a throw at construction, and
// this server's uncaughtException handler is deliberately non-fatal (see
// index.ts) — so an unvalidated typo like "off" or "FALSE" would leave the
// process alive with NO listener and exit code 0, which supervisors read as a
// clean stop. Refusing to trust is the safe direction anyway.
//
// Note for future callers: enabling this also makes Fastify honour
// X-Forwarded-Host and X-Forwarded-Proto, which Fastify does NOT gate on the
// peer being a trusted proxy. Treat req.hostname/req.protocol as attacker-
// influenced once this is on; today only the log serializer reads them, and
// every generated URL comes from config.publicUrl instead.
const TRUST_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

function isTrustEntry(entry: string): boolean {
  if (TRUST_KEYWORDS.has(entry)) return true;
  const slash = entry.lastIndexOf("/");
  const addr = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(addr);
  if (!family) return false;
  if (slash === -1) return true;
  const prefix = entry.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  // Bounded on BOTH sides: proxy-addr throws on `range <= 0`, so a /0 — the
  // idiomatic "trust everything" spelling from nginx/AWS/UFW — would otherwise
  // pass validation and then throw inside Fastify. `true` is the only way to
  // express trust-all here.
  return bits >= 1 && bits <= (family === 4 ? 32 : 128);
}

export function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string {
  const value = raw?.trim();
  if (!value || /^(false|no|off|0)$/i.test(value)) return false;
  if (/^(true|yes|on)$/i.test(value)) return true;
  if (/^\d+$/.test(value)) return Number(value);

  const entries = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Return the CLEANED list, not the raw string. Fastify re-splits whatever it
  // is given without filtering empties, so passing `value` through would hand it
  // an empty entry for a trailing/leading/doubled comma — a value we just
  // validated as fine, which then throws at construction.
  if (entries.length > 0 && entries.every(isTrustEntry))
    return entries.join(",");

  console.error(
    `VLMP_TRUST_PROXY: "${value}" is not a valid proxy address list — ignoring it, the proxy is NOT trusted. ` +
      `Use "loopback", an address or CIDR ("127.0.0.1,::1", "172.16.0.0/12"), a hop count, or "true".`,
  );
  return false;
}
