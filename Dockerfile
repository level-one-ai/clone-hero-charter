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
#
# su-exec lets the entrypoint fix /data ownership as root and then drop to the
# unprivileged `node` user before exec'ing the server.
RUN apk add --no-cache ffmpeg su-exec

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# DO NOT REMOVE THIS LINE, and do not set HOSTNAME to anything else.
#
# Next's standalone server does `server.listen(port, process.env.HOSTNAME || '0.0.0.0')`,
# and Docker sets HOSTNAME in every container to the container's own hostname. Without
# this override Next binds to that hostname rather than all interfaces — failing with
# ENOTFOUND, or binding to a single container IP the reverse proxy is not routing to.
# Either way the container looks healthy while the proxy returns 502 Bad Gateway.
ENV HOSTNAME=0.0.0.0

# Song projects live here. Mount a persistent volume at this path, or every
# redeploy starts from an empty library.
ENV DATA_DIR=/data

# Run as a non-root user. The node:alpine image already provides uid/gid 1000.
RUN mkdir -p /data && chown -R node:node /data /app

# public/ is tracked in git (see public/.gitkeep) precisely so this COPY resolves —
# Docker fails the build outright when a COPY source does not exist.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# No VOLUME declaration on purpose. It would create an anonymous volume whenever no
# mount is configured, so data would appear to persist across restarts but vanish when
# the container is recreated. Better that missing persistent storage is obvious.

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# Starts as root so the entrypoint can chown /data, then drops to `node`.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# server.js is emitted by the standalone build — NOT `next start`, which does
# not work with standalone output.
CMD ["node", "server.js"]
