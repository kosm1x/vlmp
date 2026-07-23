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
