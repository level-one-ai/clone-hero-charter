import archiver from 'archiver';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { generateSongIni } from '@/lib/chart/songIni';
import { writeMidi } from '@/lib/chart/writeMidi';
import { writeChart } from '@/lib/chart/writeChart';
import { isValidSongId } from '@/lib/server/paths';
import {
  attachmentDisposition,
  exportAudioFileName,
  exportAudioName,
  exportProjectFor,
  planExport,
  prepareExportAudio,
  type ChartFormat,
  type ExportPlan,
} from '@/lib/server/exportPlan';
import type { ExportAudioFormat } from '@/lib/server/audio';
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

async function buildArchive(id: string, plan: ExportPlan): Promise<Response> {
  const { folderName, audioExt, audioFormat, canTranscode, durationMs, warnings } = plan;
  const project = plan.project;

  const archive = archiver('zip', {
    // Level 1: the payload is already-compressed audio, so heavier compression costs
    // CPU and wall-clock for almost no size gain.
    zlib: { level: 1 },
  });

  // ---- the chart ------------------------------------------------------------------
  // Regenerated from the current project rather than read off disk, so an export can
  // never ship a stale chart. exportProjectFor folds the lead-in into Offset — see its
  // comment for why that beats moving ticks.
  const exportProject = exportProjectFor(plan);
  if (plan.chartFormat === 'mid') {
    const midi = writeMidi(exportProject);
    archive.append(Buffer.from(midi.data), { name: `${folderName}/notes.mid` });
    warnings.push(...midi.warnings);
  } else {
    archive.append(writeChart(exportProject, { musicStream: exportAudioFileName(plan) }), {
      name: `${folderName}/notes.chart`,
    });
  }

  // ---- song.ini -----------------------------------------------------------------
  archive.append(generateSongIni(exportProject, { durationMs }), {
    name: `${folderName}/song.ini`,
  });

  // ---- audio --------------------------------------------------------------------
  // Any conversion happens BEFORE the archive starts, so a failure here still returns a
  // clean 500 rather than a half-written zip. See prepareExportAudio for why WAV in
  // particular cannot be piped.
  let audio: { stream: Readable; cleanup: () => Promise<void> };
  try {
    audio = await prepareExportAudio(plan, id);
  } catch (error) {
    console.error(`[export ${id}] audio preparation failed:`, error);
    return NextResponse.json(
      { error: `Could not prepare the audio: ${(error as Error).message}` },
      { status: 500 },
    );
  }
  archive.append(audio.stream, {
    name: `${folderName}/${exportAudioName(canTranscode, audioFormat, audioExt)}`,
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

  // The scratch file, if there was one, is only safe to remove once the archive has
  // finished reading it.
  archive.on('end', () => void audio.cleanup());
  archive.on('error', () => void audio.cleanup());

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
  const audioFormat = parseAudioFormat(url.searchParams.get('audioFormat'));
  const chartFormat = parseChartFormat(url.searchParams.get('chartFormat'));
  const dryRun = url.searchParams.get('dryRun') === '1';

  const plan = await planExport(id, audioFormat, chartFormat);
  if ('error' in plan) {
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }

  if (dryRun) {
    return NextResponse.json({
      folderName: plan.folderName,
      files: plan.files,
      warnings: plan.warnings,
      transcoding: plan.canTranscode && !plan.copyAudioVerbatim,
      audioFormat: plan.audioFormat,
      chartFormat: plan.chartFormat,
      leadingSilenceMs: plan.leadingSilenceMs,
      trailingSilenceMs: plan.trailingSilenceMs,
      durationMs: plan.durationMs,
      trimmed: plan.trimmed,
      region: plan.region,
    });
  }

  return await buildArchive(id, plan);
}

/** POST — same download, options in the body. Kept for existing callers. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  let audioFormat: ExportAudioFormat = 'wav';
  let chartFormat: ChartFormat = 'chart';
  try {
    const body = (await request.json()) as {
      audioFormat?: string;
      chartFormat?: string;
    } | null;
    audioFormat = parseAudioFormat(body?.audioFormat ?? null);
    chartFormat = parseChartFormat(body?.chartFormat ?? null);
  } catch {
    // No body is fine — defaults apply.
  }

  const plan = await planExport(id, audioFormat, chartFormat);
  if ('error' in plan) {
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }
  return await buildArchive(id, plan);
}

/** WAV unless OGG is asked for explicitly — see the module comment. */
function parseAudioFormat(value: string | null): ExportAudioFormat {
  return value === 'ogg' ? 'ogg' : 'wav';
}

/** .chart unless .mid is asked for explicitly — see ChartFormat in exportPlan. */
function parseChartFormat(value: string | null): ChartFormat {
  return value === 'mid' ? 'mid' : 'chart';
}
