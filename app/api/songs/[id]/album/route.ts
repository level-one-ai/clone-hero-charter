import { NextResponse } from 'next/server';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isValidSongId, songDir, songFile } from '@/lib/server/paths';
import { readProject, saveProject } from '@/lib/server/storage';
import {
  IMAGE_EXTENSIONS,
  UploadError,
  cleanupUpload,
  commitUploadedFile,
  extensionOf,
  parseMultipart,
} from '@/lib/server/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/** GET /api/songs/[id]/album — serve the cover art for the editor and song list. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return new Response('Invalid song id', { status: 400 });

  const project = await readProject(id);
  if (!project?.album) return new Response('No album art', { status: 404 });

  let filePath: string;
  try {
    filePath = songFile(id, project.album);
  } catch {
    return new Response('Invalid album path', { status: 400 });
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return new Response('Album art missing from the project folder', { status: 404 });
  }

  const ext = path.extname(project.album).toLowerCase();
  return new Response(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream, {
    headers: {
      'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg',
      'Content-Length': String(stat.size),
      // Cover art can be replaced, so revalidate rather than caching immutably.
      'Cache-Control': 'private, no-cache',
      ETag: `"${stat.size}-${Math.floor(stat.mtimeMs)}"`,
    },
  });
}

/** POST /api/songs/[id]/album — upload or replace the cover art. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const project = await readProject(id);
  if (!project) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  let upload;
  try {
    // 24 MB is far more than any reasonable cover image.
    upload = await parseMultipart(request, { maxFileSize: 24 * 1024 * 1024, maxFiles: 1 });
  } catch (error) {
    const status = error instanceof UploadError ? error.status : 400;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }

  try {
    const file = upload.files.find((f) => f.field === 'albumArt') ?? upload.files[0];
    if (!file) return NextResponse.json({ error: 'No image was uploaded' }, { status: 400 });

    const ext = extensionOf(file.filename);
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: `Album art must be .png or .jpg, got "${ext || file.filename}"` },
        { status: 400 },
      );
    }

    const albumName = `album${ext === '.jpeg' ? '.jpg' : ext}`;
    // Replacing png with jpg (or vice versa) would otherwise leave the old file
    // behind, and the export would have to guess which one is current.
    if (project.album && project.album !== albumName) {
      await fsp.rm(path.join(songDir(id), project.album), { force: true }).catch(() => {});
    }

    await commitUploadedFile(file.tempPath, path.join(songDir(id), albumName));
    project.album = albumName;
    await saveProject(project);

    return NextResponse.json({ ok: true, album: albumName });
  } catch (error) {
    console.error(`Failed to save album art for ${id}:`, error);
    return NextResponse.json({ error: 'Could not save the album art' }, { status: 500 });
  } finally {
    await cleanupUpload(upload);
  }
}
