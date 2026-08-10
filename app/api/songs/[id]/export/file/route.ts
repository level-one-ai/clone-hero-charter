import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { isValidSongId } from '@/lib/server/paths';
import {
  attachmentDisposition,
  exportAudioContentType,
  planExport,
  prepareExportAudio,
  resolveExportFile,
} from '@/lib/server/exportPlan';
import type { ExportAudioFormat } from '@/lib/server/audio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Download ONE file from the export, instead of the whole folder as a zip.
 *
 * Why this exists: Chrome refuses to download archives over a plain-HTTP origin
 * ("Insecure download blocked"), and that refusal is correct — over HTTP the archive can
 * be rewritten in transit. The real fix is serving the app over HTTPS. But until a
 * certificate is in place, a self-hosted instance on plain HTTP would otherwise have NO
 * way to get a chart out of the editor at all, which is a bad place for a tool to leave
 * someone. Chrome's block targets archives and executables; the files themselves are
 * ordinary text and audio.
 *
 * It is not only a workaround. A Clone Hero song IS a folder of these files — the zip is
 * a convenience wrapper — so fetching them individually is a legitimate way to use the
 * export, and it means re-pulling a tweaked notes.chart without re-downloading forty
 * megabytes of audio alongside it.
 *
 * Every file comes from the same `planExport` the zip uses, so a file fetched here is
 * identical to the one inside the archive, lead-in offset and all.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const url = new URL(request.url);
  const name = url.searchParams.get('name') ?? '';
  const audioFormat: ExportAudioFormat =
    url.searchParams.get('audioFormat') === 'ogg' ? 'ogg' : 'wav';

  const plan = await planExport(id, audioFormat);
  if ('error' in plan) {
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }

  const resolved = resolveExportFile(plan, id, name);
  if (!resolved) {
    return NextResponse.json(
      { error: `"${name}" is not part of this export. Expected one of: ${plan.files.join(', ')}` },
      { status: 400 },
    );
  }

  const headers = {
    'Content-Disposition': attachmentDisposition(name),
    'Cache-Control': 'no-store',
  };

  if (resolved.kind === 'text') {
    return new Response(resolved.body, {
      headers: { ...headers, 'Content-Type': resolved.contentType },
    });
  }

  if (resolved.kind === 'binary') {
    return new Response(resolved.body as BodyInit, {
      headers: { ...headers, 'Content-Type': resolved.contentType },
    });
  }

  if (resolved.kind === 'file') {
    const stream = Readable.toWeb(fs.createReadStream(resolved.path)) as ReadableStream;
    return new Response(stream, {
      headers: { ...headers, 'Content-Type': resolved.contentType },
    });
  }

  // Any conversion finishes before the response starts, so a failure is a clean 500
  // rather than a truncated download.
  let audio;
  try {
    audio = await prepareExportAudio(plan, id);
  } catch (error) {
    console.error(`[export ${id}] audio preparation failed:`, error);
    return NextResponse.json(
      { error: `Could not prepare the audio: ${(error as Error).message}` },
      { status: 500 },
    );
  }
  audio.stream.on('close', () => void audio.cleanup());

  return new Response(Readable.toWeb(audio.stream) as ReadableStream, {
    headers: { ...headers, 'Content-Type': exportAudioContentType(plan) },
  });
}
