import archiver from 'archiver';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { generateSongIni } from '@/lib/chart/songIni';
import { writeChart } from '@/lib/chart/writeChart';
import { isValidSongId } from '@/lib/server/paths';
import {
  attachmentDisposition,
  exportAudioName,
  exportProjectFor,
  openExportAudio,
  planExport,
  type ExportPlan,
} from '@/lib/server/exportPlan';
import fs from 'node:fs';
import { songFile } from '@/lib/server/paths';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Export a Clone Hero song folder as a zip.
 *
 * ---------------------------------------------------------------------------
 * WHAT CLONE HERO ACTUALLY EXPECTS
 * ---------------------------------------------------------------------------
 * A song is a FOLDER (not an archive) inside Clone Hero's Songs directory,
 * containing:
 *
 *     notes.chart   the chart          (notes.mid also works; .chart is ours)
 *     song.ogg      the audio          (.mp3/.opus/.wav also load)
 *     album.png     cover art          (optional, .jpg also works)
 *     song.ini      metadata           (this, not the chart's [Song] block, is
 *                                       what the in-game song browser reads)
 *
 * So the zip contains exactly one top-level folder named "Artist - Title (Charter)",
 * and the user extracts it straight into Songs/.
 *
 * AUDIO FORMAT DECISION: we transcode to OGG Vorbis by default. Clone Hero does load
 * .wav, but a lossless WAV is roughly ten times the size of a q5 Vorbis file and the
 * whole point of the export is a folder that is convenient to move around. Pass
 * `keepOriginalAudio` to skip the transcode — and we fall back to the original
 * automatically if ffmpeg is missing, rather than failing the export.
 *
 * PLATFORM NOTE: this produces a PC/Mac/Linux/Android Clone Hero folder. Clone Hero
 * does not run on Xbox 360 — 360 customs are signed CON/STFS packages containing
 * .mid + .mogg + DTA, which is a different toolchain entirely and not what this
 * exports.
 *
 * ---------------------------------------------------------------------------
 * GET vs POST
 * ---------------------------------------------------------------------------
 * GET is the download the browser navigates to, so the zip streams straight to disk.
 * The client used to POST, read the whole response into a Blob and click a synthetic
 * anchor at an object URL — which buffered the entire archive in the tab first, tens of
 * megabytes for a keep-original-WAV export of a long song.
 *
 * `?dryRun=1` resolves everything and returns JSON without building the archive, so the
 * export dialog can show the real file list and any warnings BEFORE the download starts
 * rather than after it has finished.
 *
 * POST is kept for compatibility with anything already calling it.
 */

function buildArchive(id: string, plan: ExportPlan): Response {
  const { folderName, alreadyOgg, audioExt, canTranscode, durationMs, warnings } = plan;
  const project = plan.project;

  const archive = archiver('zip', {
    // Level 1: the payload is already-compressed audio, so heavier compression costs
    // CPU and wall-clock for almost no size gain.
    zlib: { level: 1 },
  });

  // ---- notes.chart --------------------------------------------------------------
  // Regenerated from the current project rather than reading notes.chart off disk,
  // so an export can never ship a stale chart. exportProjectFor folds the lead-in
  // into Offset — see its comment for why that beats moving ticks.
  const exportProject = exportProjectFor(plan);
  archive.append(writeChart(exportProject), { name: `${folderName}/notes.chart` });

  // ---- song.ini -----------------------------------------------------------------
  archive.append(generateSongIni(exportProject, { durationMs }), {
    name: `${folderName}/song.ini`,
  });

  // ---- audio --------------------------------------------------------------------
  // Piped straight into the archive — a large WAV is never written to disk twice.
  // On an ffmpeg failure the archive is ABORTED rather than finished: a truncated ogg
  // would only be discovered when the song cuts out mid-play in game, whereas aborting
  // breaks the response stream so the download fails visibly.
  const audio = openExportAudio(plan, (reason) => {
    console.error(`[export ${id}] ${reason}`);
    archive.abort();
  });
  archive.append(audio, {
    name: `${folderName}/${exportAudioName(canTranscode, alreadyOgg, audioExt)}`,
  });

  // ---- album art ----------------------------------------------------------------
  if (project.album) {
    try {
      const albumPath = songFile(id, project.album);
      // Clone Hero accepts album.png or album.jpg; keep whichever the user gave us
      // rather than re-encoding and losing quality.
      const ext = path.extname(project.album).toLowerCase() === '.png' ? '.png' : '.jpg';
      archive.append(fs.createReadStream(albumPath), { name: `${folderName}/album${ext}` });
    } catch {
      // planExport already reported this; the zip is still valid without art.
    }
  }

  archive.on('warning', (error) => {
    console.warn(`[export ${id}] archiver warning:`, error);
  });
  archive.on('error', (error) => {
    console.error(`[export ${id}] archiver error:`, error);
  });

  void archive.finalize();

  const filename = `${folderName}.zip`;
  return new Response(Readable.toWeb(archive as unknown as Readable) as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': attachmentDisposition(filename),
      'Cache-Control': 'no-store',
      'X-Export-Warnings': warnings.length > 0 ? encodeURIComponent(warnings.join(' | ')) : '',
    },
  });
}

/** GET — the download itself, or `?dryRun=1` for what it would contain. */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const url = new URL(request.url);
  const keepOriginalAudio = url.searchParams.get('keepOriginalAudio') === '1';
  const dryRun = url.searchParams.get('dryRun') === '1';

  const plan = await planExport(id, keepOriginalAudio);
  if ('error' in plan) {
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }

  if (dryRun) {
    return NextResponse.json({
      folderName: plan.folderName,
      files: plan.files,
      warnings: plan.warnings,
      transcoding: plan.canTranscode,
      leadingSilenceMs: plan.leadingSilenceMs,
    });
  }

  return buildArchive(id, plan);
}

/** POST — same download, options in the body. Kept for existing callers. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  let keepOriginalAudio = false;
  try {
    const body = (await request.json()) as { keepOriginalAudio?: boolean } | null;
    keepOriginalAudio = Boolean(body?.keepOriginalAudio);
  } catch {
    // No body is fine — defaults apply.
  }

  const plan = await planExport(id, keepOriginalAudio);
  if ('error' in plan) {
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }
  return buildArchive(id, plan);
}
