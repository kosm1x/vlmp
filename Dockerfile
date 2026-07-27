# syntax=docker/dockerfile:1

# ── Stage 1: build ──────────────────────────────────────────────────
# Full trixie image: has the toolchain needed to compile the native
# better-sqlite3 / bcrypt bindings against the exact runtime ABI.
#
# Trixie (Debian 13) rather than bookworm (12) because of FFmpeg, which the
# runtime stage inherits: bookworm's newest is 5.1, and transcode pacing wants
# -readrate_initial_burst, which needs >= 6.1 (see streaming/ffmpeg-caps.ts).
# On bookworm that flag silently never applies. Both stages move together — the
# runtime note below explains why they must match.
FROM node:26-trixie AS builder

WORKDIR /app

# No toolchain install here on purpose: node:22-bookworm already ships gcc, g++,
# make and python3 (verified: `apt-get install -s python3 make g++` reports "0
# newly installed"), so the apt round-trip that used to sit here cost ~2s and
# ~19MB of package indexes per architecture to install nothing. The toolchain is
# still present for the fallback path described below.

# Install with dev deps so we can compile TypeScript.
#
# Neither native module normally compiles here, but for different reasons:
#   * better-sqlite3 DOWNLOADS a prebuild matching node 22's ABI (127), via an
#     install script of `prebuild-install || node-gyp rebuild` — a silent
#     fallback: if the download ever 404s it compiles instead, adding minutes
#     (far more under arm64 emulation) with no failure to explain the delay.
#   * bcrypt SHIPS N-API prebuilds inside its npm tarball (prebuildify --napi,
#     install script `node-gyp-build`), so it is not ABI-tagged and never
#     downloads. A Node major bump does not need a new bcrypt release.
# --foreground-scripts surfaces a fallback compile in the build log.
COPY package.json package-lock.json ./
RUN npm ci --foreground-scripts

# Build the server (tsc -> dist/) and keep the client assets
COPY . .
RUN npm run build

# Prune to production dependencies (native bindings stay compiled)
RUN npm prune --omit=dev

# Drop build inputs the runtime never reads. better-sqlite3 ships the sqlite
# amalgamation in deps/ plus its C++ sources; bcrypt ships its sources too. At
# runtime only the compiled .node under build/Release is loaded (via `bindings`).
# Measured inside the image: node_modules 36MB -> 26MB, better-sqlite3 12MB ->
# 2.1MB, per architecture.
#
# Left alone deliberately: bcrypt/prebuilds/ carries every platform's binding
# (~1MB where ~76KB on arm64 / ~85KB on amd64 is used), but pruning it to just
# this arch needs TARGETARCH plumbing for ~940KB — not worth the moving part.
RUN rm -rf \
        node_modules/better-sqlite3/deps \
        node_modules/better-sqlite3/src \
        node_modules/bcrypt/src


# ── Stage 2: runtime ────────────────────────────────────────────────
# Slim runtime on the SAME base (trixie) so the compiled native bindings from
# the builder are ABI-compatible. Only FFmpeg is added. Keep these two stages on
# the same Debian release: building against a NEWER glibc than the runtime
# provides fails at load time, and the pair drifting apart is precisely what the
# image job in ci.yml exists to catch.
FROM node:26-trixie-slim AS runtime

# FFmpeg + FFprobe (the whole point of the app) and tini for clean PID 1
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    VLMP_PORT=8080 \
    VLMP_HOST=0.0.0.0 \
    VLMP_DATA_DIR=/data \
    VLMP_FFMPEG_PATH=ffmpeg \
    VLMP_FFPROBE_PATH=ffprobe

# Copy only what runtime needs
COPY --from=builder /app/dist            ./dist
COPY --from=builder /app/node_modules    ./node_modules
COPY --from=builder /app/client          ./client
COPY --from=builder /app/package.json    ./package.json

# Data dir is a volume; make it writable by the unprivileged user
RUN mkdir -p /data && chown -R node:node /data /app

USER node

VOLUME ["/data"]
EXPOSE 8080

# Liveness probe against the unauthenticated /api/info endpoint. Deliberately
# lenient (<500, not r.ok): this asks "is the process serving?", so a 429 from
# the global rate limiter — which /api/info is subject to — must NOT mark a
# perfectly live container unhealthy. Only a 5xx or a dead socket counts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.VLMP_PORT||8080)+'/api/info').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

# tsc (rootDir ".") mirrors the source tree, so the entrypoint lives at
# dist/server/src/index.js — matches package.json "start".
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/src/index.js"]
