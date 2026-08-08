import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { isValidSongId, songFile } from '@/lib/server/paths';
import { readProject } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

const MIME_BY_EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
};

/**
 * GET /api/songs/[id]/audio — stream the song audio.
 *
 * HTTP Range support is NOT optional here. `<audio>` seeking and wavesurfer's
 * partial loading both issue Range requests, and a server that ignores them and
 * always returns 200 with the full body makes seeking either fail outright or
 * re-download the whole file on every scrub. Chrome in particular refuses to seek
 * at all unless it sees `Accept-Ranges: bytes` and a correct 206 response.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return new Response('Invalid song id', { status: 400 });

  const project = await readProject(id);
  if (!project || !project.audio.file) return new Response('Song not found', { status: 404 });

  let filePath: string;
  try {
    filePath = songFile(id, project.audio.file);
  } catch {
    return new Response('Invalid audio path', { status: 400 });
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return new Response('Audio file missing from the project folder', { status: 404 });
  }

  const ext = project.audio.file.slice(project.audio.file.lastIndexOf('.')).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const total = stat.size;

  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // The audio never changes after upload, so it is safe to cache hard. This keeps
    // seeking snappy instead of re-fetching on every editor reload.
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: `"${stat.size}-${Math.floor(stat.mtimeMs)}"`,
  };

  const range = request.headers.get('range');
  if (!range) {
    return new Response(toWebStream(fs.createReadStream(filePath)), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) },
    });
  }

  // Only the single-range form `bytes=start-end` is handled; multi-range is legal but
  // no browser uses it for media playback.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    return new Response('Malformed Range header', {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}` },
    });
  }

  const [, startRaw, endRaw] = match;
  let start: number;
  let end: number;

  if (startRaw === '') {
    // Suffix form `bytes=-N`: the LAST N bytes. Used by some decoders to read
    // trailing metadata, and getting it backwards returns the wrong audio entirely.
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return new Response('Malformed Range header', {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` },
      });
    }
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === '' ? total - 1 : Number.parseInt(endRaw, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return new Response('Requested range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}` },
    });
  }
  end = Math.min(end, total - 1);

  return new Response(toWebStream(fs.createReadStream(filePath, { start, end })), {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

function toWebStream(stream: fs.ReadStream): ReadableStream {
  return Readable.toWeb(stream) as ReadableStream;
}
