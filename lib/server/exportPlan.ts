import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { generateSongIni } from '@/lib/chart/songIni';
import { writeChart } from '@/lib/chart/writeChart';
import {
  canTranscodeToOgg,
  hasFfmpeg,
  probeAudio,
  spawnOggTranscode,
  spawnSilencePad,
} from '@/lib/server/audio';
import { exportFolderName, songDir, songFile } from '@/lib/server/paths';
import { readProject } from '@/lib/server/storage';
import type { Project } from '@/lib/chart/types';

/**
 * Everything the export needs, resolved before a single byte is written.
 *
 * This lives outside the route because a Next.js `route.ts` may only export HTTP method
 * handlers — and two routes need it: the zip (`export/route.ts`) and the single-file
 * download (`export/file/route.ts`). Sharing the plan is what keeps those two honest:
 * the file list, the lead-in handling and the transcode decision are computed once, so a
 * file fetched on its own is byte-identical to the same file inside the archive.
 */

export interface ExportPlan {
  project: Project;
  folderName: string;
  audioPath: string;
  audioExt: string;
  alreadyOgg: boolean;
  canTranscode: boolean;
  leadingSilenceMs: number;
  durationMs: number;
  warnings: string[];
  /** Names as they appear inside the folder, in archive order. */
  files: string[];
}

export interface ExportPlanError {
  error: string;
  status: number;
}

export async function planExport(
  id: string,
  keepOriginalAudio: boolean,
): Promise<ExportPlan | ExportPlanError> {
  const project = await readProject(id);
  if (!project) return { error: 'Song not found', status: 404 };

  const dir = songDir(id);
  const audioPath = path.join(dir, project.audio.file);
  if (!project.audio.file || !(await exists(audioPath))) {
    return { error: 'The project has no audio file, so it cannot be exported', status: 400 };
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

  const folderName = exportFolderName(project.meta);
  const audioExt = path.extname(project.audio.file).toLowerCase();
  const alreadyOgg = audioExt === '.ogg';
  const wantTranscode = !keepOriginalAudio && !alreadyOgg;
  // Verified BEFORE the response starts streaming — see canTranscodeToOgg. Once the
  // zip is streaming we can no longer change the status code, so a failure detected
  // later can only produce a corrupt download.
  const canTranscode = wantTranscode ? await canTranscodeToOgg(audioPath) : false;

  const warnings: string[] = [];
  if (wantTranscode && !canTranscode) {
    warnings.push(
      (await hasFfmpeg())
        ? 'ffmpeg could not convert this audio to OGG, so the original file will be packaged instead. Clone Hero will still load it.'
        : 'ffmpeg is not available, so the original audio will be packaged without transcoding.',
    );
  }

  const padOriginal = !canTranscode && leadingSilenceMs > 0 && (await hasFfmpeg());
  if (leadingSilenceMs > 0 && !canTranscode && !padOriginal) {
    warnings.push(
      'ffmpeg is not available, so the lead-in silence cannot be added to the audio. The chart would be out of sync by that amount.',
    );
  }

  const files = ['notes.chart', exportAudioName(
    canTranscode,
    alreadyOgg,
    audioExt,
  ), 'song.ini'];

  if (project.album) {
    try {
      if (await exists(songFile(id, project.album))) {
        files.push(path.extname(project.album).toLowerCase() === '.png' ? 'album.png' : 'album.jpg');
      }
    } catch {
      warnings.push('Album art could not be read and will be left out of the export.');
    }
  }

  return {
    project,
    folderName,
    audioPath,
    audioExt,
    alreadyOgg,
    canTranscode,
    leadingSilenceMs,
    durationMs,
    warnings,
    files,
  };
}

/** The audio filename inside the folder, given the transcode decision. */
export function exportAudioName(
  canTranscode: boolean,
  alreadyOgg: boolean,
  audioExt: string,
): string {
  return canTranscode ? 'song.ogg' : `song${alreadyOgg ? '.ogg' : audioExt}`;
}

/**
 * The project as it should be written out, with the lead-in folded into `offset`.
 *
 * Lead-in silence is expressed through the chart's Offset rather than by moving ticks.
 * Offset delays the chart against the audio, which is exactly what padding the front of
 * the audio requires — and it keeps every note, tempo marker and time signature where
 * the editor put it. Shifting ticks instead would mean converting a duration to ticks
 * through the tempo map, which is both lossy and needless.
 */
export function exportProjectFor(plan: ExportPlan): Project {
  return {
    ...plan.project,
    meta: {
      ...plan.project.meta,
      offset: plan.project.meta.offset + plan.leadingSilenceMs / 1000,
    },
  };
}

/**
 * Open the export's audio as a stream, applying the same transcode / pad / copy decision
 * the archive uses.
 *
 * `onFailure` fires when ffmpeg dies mid-stream. The zip must abort on that — a
 * truncated OGG would only be discovered when the song cuts out in game — while a
 * single-file download can only break the connection, which the browser reports as a
 * failed download. Either way the caller decides, because only it knows what it can
 * still do about it.
 */
export function openExportAudio(
  plan: ExportPlan,
  onFailure: (reason: string) => void,
): Readable {
  const { audioPath, audioExt, canTranscode, leadingSilenceMs } = plan;

  if (canTranscode) {
    const ffmpeg = spawnOggTranscode(audioPath, leadingSilenceMs);
    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 2000);
    });
    ffmpeg.on('close', (code) => {
      if (code !== 0) onFailure(`ffmpeg failed (${code}): ${stderr}`);
    });
    ffmpeg.on('error', (error) => onFailure(`could not run ffmpeg: ${error}`));
    return ffmpeg.stdout;
  }

  if (leadingSilenceMs > 0) {
    // Keeping the original format, but the lead-in still has to be baked in or the
    // chart would be out of sync with the audio by exactly that much. planExport has
    // already warned when ffmpeg is missing, in which case this falls through to the
    // plain copy below.
    const format = audioExt.replace('.', '') || 'wav';
    const padder = spawnSilencePad(audioPath, leadingSilenceMs, format);
    let spawned = false;
    padder.on('spawn', () => {
      spawned = true;
    });
    padder.on('error', (error) => {
      if (spawned) onFailure(`could not pad the audio: ${error}`);
    });
    return padder.stdout;
  }

  return fs.createReadStream(audioPath);
}

/** What a single requested filename resolves to. */
export type ExportFile =
  | { kind: 'text'; body: string; contentType: string }
  | { kind: 'audio' }
  | { kind: 'file'; path: string; contentType: string };

/**
 * Resolve one name from the export folder.
 *
 * The name is matched against `plan.files`, which planExport built itself — so it is a
 * whitelist by construction and a traversal attempt simply is not in the list. Returns
 * null for anything else, which the route turns into a 400.
 */
export function resolveExportFile(
  plan: ExportPlan,
  id: string,
  name: string,
): ExportFile | null {
  if (!plan.files.includes(name)) return null;

  if (name === 'notes.chart') {
    return {
      kind: 'text',
      body: writeChart(exportProjectFor(plan)),
      // text/plain rather than a made-up type: browsers handle it predictably, and
      // Content-Disposition is what actually names the file.
      contentType: 'text/plain; charset=utf-8',
    };
  }

  if (name === 'song.ini') {
    return {
      kind: 'text',
      body: generateSongIni(exportProjectFor(plan), { durationMs: plan.durationMs }),
      contentType: 'text/plain; charset=utf-8',
    };
  }

  if (name.startsWith('album.')) {
    const album = plan.project.album;
    if (!album) return null;
    return {
      kind: 'file',
      path: songFile(id, album),
      contentType: name.endsWith('.png') ? 'image/png' : 'image/jpeg',
    };
  }

  return { kind: 'audio' };
}

/** Content type for the export's audio, matching whatever openExportAudio produces. */
export function exportAudioContentType(plan: ExportPlan): string {
  const ext = plan.canTranscode ? '.ogg' : plan.alreadyOgg ? '.ogg' : plan.audioExt;
  return AUDIO_MIME[ext] ?? 'application/octet-stream';
}

const AUDIO_MIME: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
};

export async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Content-Disposition with both an ASCII fallback and an RFC 5987 filename*, so titles
 * with non-ASCII characters survive.
 */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function asciiFallback(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
}
