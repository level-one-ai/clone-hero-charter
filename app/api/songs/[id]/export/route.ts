import archiver from 'archiver';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { generateSongIni } from '@/lib/chart/songIni';
import { writeChart } from '@/lib/chart/writeChart';
import {
  canTranscodeToOgg,
  hasFfmpeg,
  probeAudio,
  spawnOggTranscode,
  spawnSilencePad,
} from '@/lib/server/audio';
import { exportFolderName, isValidSongId, songDir, songFile } from '@/lib/server/paths';
import { readProject } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/songs/[id]/export — package a Clone Hero song folder as a zip.
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
 * So the zip contains exactly one top-level folder named "Artist - Title", and the
 * user extracts it straight into Songs/.
 *
 * AUDIO FORMAT DECISION: we transcode to OGG Vorbis by default. Clone Hero does load
 * .wav, but a lossless WAV is roughly ten times the size of a q5 Vorbis file and the
 * whole point of the export is a folder that is convenient to move around. Pass
 * `keepOriginalAudio: true` to skip the transcode — and we fall back to the original
 * automatically if ffmpeg is missing, rather than failing the export.
 *
 * PLATFORM NOTE: this produces a PC/Mac/Linux/Android Clone Hero folder. Clone Hero
 * does not run on Xbox 360 — 360 customs are signed CON/STFS packages containing
 * .mid + .mogg + DTA, which is a different toolchain entirely and not what this
 * exports.
 * ---------------------------------------------------------------------------
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const project = await readProject(id);
  if (!project) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  let keepOriginalAudio = false;
  try {
    const body = (await request.json()) as { keepOriginalAudio?: boolean } | null;
    keepOriginalAudio = Boolean(body?.keepOriginalAudio);
  } catch {
    // No body is fine — defaults apply.
  }

  const dir = songDir(id);
  const audioPath = path.join(dir, project.audio.file);
  if (!project.audio.file || !(await exists(audioPath))) {
    return NextResponse.json(
      { error: 'The project has no audio file, so it cannot be exported' },
      { status: 400 },
    );
  }

  // song_length must be accurate — Clone Hero uses it for the progress bar and for
  // deciding when the song ends. Re-measure rather than trusting a stale value.
  let durationMs = project.audio.durationMs;
  if (!durationMs || durationMs <= 0) {
    durationMs = (await probeAudio(audioPath)).durationMs;
  }
  // Any lead-in silence is part of the packaged audio, so song_length has to include
  // it or Clone Hero's progress bar and end-of-song detection are short by that much.
  const leadingSilenceMs = Math.max(0, Math.round(project.meta.leadingSilenceMs ?? 0));
  durationMs += leadingSilenceMs;

  // "ERRA - Gore of Being (enerbewow)" — the Clone Hero library convention.
  const folderName = exportFolderName(project.meta);

  const audioExt = path.extname(project.audio.file).toLowerCase();
  const alreadyOgg = audioExt === '.ogg';
  const wantTranscode = !keepOriginalAudio && !alreadyOgg;
  // Verified BEFORE the response starts streaming — see canTranscodeToOgg. Once the
  // zip is streaming we can no longer change the status code, so a failure detected
  // later can only produce a corrupt download.
  const canTranscode = wantTranscode ? await canTranscodeToOgg(audioPath) : false;

  const archive = archiver('zip', {
    // Level 1: the payload is already-compressed audio, so heavier compression costs
    // CPU and wall-clock for almost no size gain.
    zlib: { level: 1 },
  });

  const warnings: string[] = [];
  if (wantTranscode && !canTranscode) {
    warnings.push(
      (await hasFfmpeg())
        ? 'ffmpeg could not convert this audio to OGG, so the original file was packaged instead. Clone Hero will still load it.'
        : 'ffmpeg is not available, so the original audio was packaged without transcoding.',
    );
  }

  // ---- notes.chart --------------------------------------------------------------
  // Regenerated from the current project rather than reading notes.chart off disk,
  // so an export can never ship a stale chart.
  //
  // Lead-in silence is expressed through the chart's Offset rather than by moving
  // ticks. Offset delays the chart against the audio, which is exactly what padding
  // the front of the audio requires — and it keeps every note, tempo marker and time
  // signature where the editor put it. Shifting ticks instead would mean converting a
  // duration to ticks through the tempo map, which is both lossy and needless.
  const exportProject = {
    ...project,
    meta: { ...project.meta, offset: project.meta.offset + leadingSilenceMs / 1000 },
  };
  archive.append(writeChart(exportProject), { name: `${folderName}/notes.chart` });

  // ---- song.ini -----------------------------------------------------------------
  archive.append(generateSongIni(exportProject, { durationMs }), { name: `${folderName}/song.ini` });

  // ---- audio --------------------------------------------------------------------
  if (canTranscode) {
    const ffmpeg = spawnOggTranscode(audioPath, leadingSilenceMs);
    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 2000);
    });
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        // Abort rather than shipping a truncated ogg, which the user would only
        // discover when the song cuts out mid-play in game. Aborting breaks the
        // response stream, so the download fails visibly instead of silently.
        console.error(`[export ${id}] ffmpeg failed (${code}): ${stderr}`);
        archive.abort();
      }
    });
    ffmpeg.on('error', (error) => {
      console.error(`[export ${id}] could not run ffmpeg:`, error);
      archive.abort();
    });
    // Piped straight into the archive — a large WAV is never written to disk twice.
    archive.append(ffmpeg.stdout, { name: `${folderName}/song.ogg` });
  } else if (leadingSilenceMs > 0 && (await hasFfmpeg())) {
    // Keeping the original format, but the lead-in still has to be baked in or the
    // chart would be out of sync with the audio by exactly that much.
    const format = audioExt.replace('.', '') || 'wav';
    const padder = spawnSilencePad(audioPath, leadingSilenceMs, format);
    padder.on('error', (error) => {
      console.error(`[export ${id}] could not pad the audio:`, error);
      archive.abort();
    });
    archive.append(padder.stdout, { name: `${folderName}/song${audioExt}` });
  } else {
    if (leadingSilenceMs > 0) {
      warnings.push(
        'ffmpeg is not available, so the lead-in silence could not be added to the audio. The chart will be out of sync by that amount.',
      );
    }
    archive.append(fs.createReadStream(audioPath), {
      name: `${folderName}/song${alreadyOgg ? '.ogg' : audioExt}`,
    });
  }

  // ---- album art ----------------------------------------------------------------
  if (project.album) {
    try {
      const albumPath = songFile(id, project.album);
      if (await exists(albumPath)) {
        // Clone Hero accepts album.png or album.jpg; keep whichever the user gave us
        // rather than re-encoding and losing quality.
        const ext = path.extname(project.album).toLowerCase() === '.png' ? '.png' : '.jpg';
        archive.append(fs.createReadStream(albumPath), { name: `${folderName}/album${ext}` });
      }
    } catch {
      warnings.push('Album art could not be read and was left out of the export.');
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
      // RFC 5987 filename* carries non-ASCII titles correctly; the plain filename is
      // an ASCII-only fallback for older clients.
      'Content-Disposition': `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
      'X-Export-Warnings': warnings.length > 0 ? encodeURIComponent(warnings.join(' | ')) : '',
    },
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function asciiFallback(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
}
