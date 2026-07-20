# syntax=docker/dockerfile:1

# ── Stage 1: build ──────────────────────────────────────────────────
# Full bookworm image: has the toolchain needed to compile the native
# better-sqlite3 / bcrypt bindings against the exact runtime ABI.
FROM node:22-bookworm AS builder

WORKDIR /app

# Native module build deps (better-sqlite3, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install with dev deps so we can compile TypeScript
COPY package.json package-lock.json ./
RUN npm ci

# Build the server (tsc -> dist/) and keep the client assets
COPY . .
RUN npm run build

# Prune to production dependencies (native bindings stay compiled)
RUN npm prune --omit=dev


# ── Stage 2: runtime ────────────────────────────────────────────────
# Slim runtime on the SAME base (bookworm) so the compiled native
# bindings from the builder are ABI-compatible. Only FFmpeg is added.
FROM node:22-bookworm-slim AS runtime

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

# Simple liveness probe against the HTTP port
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.VLMP_PORT||8080)+'/').then(r=>process.exit(r.ok||r.status<500?0:1)).catch(()=>process.exit(1))"

# tsc (rootDir ".") mirrors the source tree, so the entrypoint lives at
# dist/server/src/index.js — matches package.json "start".
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/src/index.js"]
