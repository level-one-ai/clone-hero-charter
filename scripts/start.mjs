#!/usr/bin/env node
/**
 * Production start for the standalone build.
 *
 * `next start` does not support `output: 'standalone'`, so we run the emitted
 * server.js directly. It expects `static/` and `public/` to sit beside it, which the
 * Dockerfile does as build steps — this script does the same for anyone running
 * `npm start` on a host, or for a PaaS build pack (Nixpacks, Heroku, Railway) that
 * runs the start script rather than the Dockerfile.
 *
 * THE HOSTNAME TRAP
 * -----------------
 * Next's standalone server does:
 *
 *     const hostname = process.env.HOSTNAME || '0.0.0.0'
 *     server.listen(port, hostname)
 *
 * and Docker sets HOSTNAME in EVERY container, to the container's own hostname. So in
 * a container Next binds to that hostname instead of all interfaces — either failing
 * outright with ENOTFOUND, or binding to a single container IP that the reverse proxy
 * may not be routing to. Both show up as a 502 Bad Gateway from the proxy, with a
 * container that looks perfectly healthy.
 *
 * So we always overwrite HOSTNAME with an explicit bind address. Anyone who genuinely
 * needs to bind to one interface sets BIND_HOST; the container's own hostname must
 * never reach Next.
 */

import { cp, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standalone = path.join(root, '.next', 'standalone');

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const serverEntry = path.join(standalone, 'server.js');
if (!(await exists(serverEntry))) {
  console.error(
    `No standalone build found at ${serverEntry}.\nRun "npm run build" first.`,
  );
  process.exit(1);
}

// public/ is optional; static/ is not — without it every stylesheet and client chunk
// 404s and the app renders unstyled.
if (await exists(path.join(root, 'public'))) {
  await mkdir(path.join(standalone, 'public'), { recursive: true });
  await cp(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });
}

const staticSource = path.join(root, '.next', 'static');
if (!(await exists(staticSource))) {
  console.error('No .next/static directory found. Run "npm run build" first.');
  process.exit(1);
}
await mkdir(path.join(standalone, '.next'), { recursive: true });
await cp(staticSource, path.join(standalone, '.next', 'static'), { recursive: true });

// See THE HOSTNAME TRAP above. This assignment is the whole point of the script.
process.env.HOSTNAME = process.env.BIND_HOST || '0.0.0.0';
process.env.PORT = process.env.PORT || '3000';

await import(path.join(standalone, 'server.js'));
