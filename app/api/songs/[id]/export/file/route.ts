import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { isValidSongId } from '@/lib/server/paths';
import {
  attachmentDisposition,
  exportAudioContentType,
  openExportAudio,
  planExport,
  resolveExportFile,
} from '@/lib/server/exportPlan';

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
  const keepOriginalAudio = url.searchParams.get('keepOriginalAudio') === '1';

  const plan = await planExport(id, keepOriginalAudio);
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

  if (resolved.kind === 'file') {
    const stream = Readable.toWeb(fs.createReadStream(resolved.path)) as ReadableStream;
    return new Response(stream, {
      headers: { ...headers, 'Content-Type': resolved.contentType },
    });
  }

  // Audio may be transcoded or padded on the fly, so it streams. A mid-stream ffmpeg
  // failure can only break the connection at this point — the browser reports that as a
  // failed download, which is the honest outcome and better than a truncated file.
  const audio = openExportAudio(plan, (reason) => {
    console.error(`[export ${id}] ${reason}`);
    audio.destroy(new Error(reason));
  });

  return new Response(Readable.toWeb(audio) as ReadableStream, {
    headers: { ...headers, 'Content-Type': exportAudioContentType(plan) },
  });
}
