# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Multi-stage build. The runtime stage carries only the standalone server
# output and ffmpeg, not the full node_modules tree or the build toolchain.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` for a reproducible install from the lockfile. Dev dependencies are
# needed here because the build runs TypeScript and Tailwind.
RUN npm ci


FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Produces .next/standalone (a self-contained server.js plus only the modules it
# actually imports) because next.config.ts sets output: 'standalone'.
RUN npm run build


FROM node:22-alpine AS runner
WORKDIR /app

# ffmpeg and ffprobe are runtime dependencies, not optional extras:
#   ffprobe  -> song_length for song.ini on non-WAV audio
#   ffmpeg   -> WAV/MP3 -> OGG Vorbis transcode on export
# The app degrades gracefully without them (it packages the original audio and
# warns), but the export is meaningfully worse, so they ship in the image.
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Song projects live here. docker-compose mounts a named volume at this path.
ENV DATA_DIR=/data

# Run as a non-root user. The node:alpine image already provides uid/gid 1000.
RUN mkdir -p /data && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# server.js is emitted by the standalone build — NOT `next start`, which does
# not work with standalone output.
CMD ["node", "server.js"]
