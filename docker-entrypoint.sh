#!/bin/sh
set -e

# Make the data directory writable by the app user, then drop privileges.
#
# The app runs as the non-root `node` user. That works out of the box for a Docker
# NAMED volume, because Docker copies the image directory's ownership onto a fresh
# volume. It does NOT work for a BIND MOUNT: the host directory is created root-owned,
# so the app cannot write to it.
#
# The failure mode is quietly misleading. ensureDataDirs() throws, /api/health returns
# 500, the container is marked unhealthy, and the reverse proxy stops routing to it —
# so a permissions problem presents as a 502 Bad Gateway from a "running" container.
#
# Fixing it here means either storage type works, whichever one gets picked in a
# hosting UI. If we are already unprivileged (some platforms force a fixed UID), skip
# the chown and carry on rather than failing to boot.

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only chown when it is actually needed — on a large existing library a recursive
  # chown every boot would add real startup time.
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec su-exec node "$@"
fi

# Already running as a non-root user; nothing to drop.
mkdir -p "$DATA_DIR" 2>/dev/null || true
exec "$@"
