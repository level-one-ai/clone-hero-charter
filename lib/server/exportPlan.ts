import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { generateSongIni } from '@/lib/chart/songIni';
import {
  canTranscodeTo,
  hasFfmpeg,
  probeAudio,
  transcodeToFile,
  type ExportAudioFormat,
} from '@/lib/server/audio';
import { TMP_DIR } from '@/lib/server/paths';
import { writeMidi } from '@/lib/chart/writeMidi';
import { writeChart } from '@/lib/chart/writeChart';
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

/**
 * Chart file the folder will contain.
 *
 * `.chart` is the default because it is what Clone Hero song folders overwhelmingly use
 * and what the game's own parser is most reliable with. `.mid` is offered for tools that
 * prefer it (EOF, the Rock Band lineage), but if a chart will not load in game, `.chart`
 * is the format to try first.
 */
export type ChartFormat = 'chart' | 'mid';

export interface ExportPlan {
  project: Project;
  folderName: string;
  chartFormat: ChartFormat;
  audioPath: string;
  audioExt: string;
  /** Format the packaged audio will be in. */
  audioFormat: ExportAudioFormat;
  /** True when the source file can be copied as-is, with no ffmpeg involved. */
  copyAudioVerbatim: boolean;
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
  audioFormat: ExportAudioFormat = 'wav',
  chartFormat: ChartFormat = 'chart',
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
  const warnings: string[] = [];

  /**
   * The audio can be copied byte-for-byte only when it is already the target format AND
   * nothing has to be done to it. Any lead-in means re-encoding, since the silence has to
   * be baked into the file.
   */
  const copyAudioVerbatim = audioExt === `.${audioFormat}` && leadingSilenceMs === 0;
  // Verified BEFORE the response starts streaming. Once the zip is on the wire the status
  // code is fixed, so a failure discovered later can only produce a corrupt download.
  const canTranscode = copyAudioVerbatim ? true : await canTranscodeTo(audioPath, audioFormat);

  if (!copyAudioVerbatim && !canTranscode) {
    warnings.push(
      (await hasFfmpeg())
        ? `ffmpeg could not convert this audio to ${audioFormat.toUpperCase()}, so the original ${audioExt.replace('.', '').toUpperCase()} will be packaged instead. Clone Hero still loads it.`
        : `ffmpeg is not available, so the original ${audioExt.replace('.', '').toUpperCase()} will be packaged without converting.`,
    );
    if (leadingSilenceMs > 0) {
      warnings.push(
        'The lead-in silence also needs ffmpeg, so it cannot be added. The chart will be out of sync by that amount.',
      );
    }
  }

  const files = [
    `notes.${chartFormat}`,
    exportAudioName(canTranscode, audioFormat, audioExt),
    'song.ini',
  ];

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
    chartFormat,
    audioPath,
    audioExt,
    audioFormat,
    copyAudioVerbatim,
    canTranscode,
    leadingSilenceMs,
    durationMs,
    warnings,
    files,
  };
}

/**
 * The audio filename inside the folder.
 *
 * Falls back to the source extension only when ffmpeg cannot produce the target format —
 * shipping the original is better than shipping nothing, and Clone Hero loads .wav, .ogg,
 * .mp3 and .opus alike.
 */
export function exportAudioName(
  canTranscode: boolean,
  audioFormat: ExportAudioFormat,
  audioExt: string,
): string {
  return canTranscode ? `song.${audioFormat}` : `song${audioExt}`;
}

/** The audio filename this plan will produce, e.g. "song.wav". */
export function exportAudioFileName(plan: ExportPlan): string {
  return exportAudioName(plan.canTranscode, plan.audioFormat, plan.audioExt);
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
 * Prepare the export's audio and return a stream of it, plus a cleanup to call when the
 * stream has been consumed.
 *
 * Anything that needs ffmpeg is written to a TEMP FILE first rather than piped. WAV is
 * why: its RIFF header states the size of the data that follows, and ffmpeg cannot know
 * that while writing to a pipe — it emits a placeholder and hopes the reader copes. A
 * seekable file lets it go back and correct the header, so what ships is an ordinary WAV
 * rather than one that merely usually works.
 *
 * When the source is already the target format and there is no lead-in, nothing is
 * re-encoded at all: the file is streamed straight from disk.
 */
export async function prepareExportAudio(
  plan: ExportPlan,
  id: string,
): Promise<{ stream: Readable; cleanup: () => Promise<void> }> {
  const noop = async () => {};

  if (plan.copyAudioVerbatim || !plan.canTranscode) {
    // Either it is already what we want, or ffmpeg cannot help and planExport has
    // already warned that the original is going out as-is.
    return { stream: fs.createReadStream(plan.audioPath), cleanup: noop };
  }

  await fsp.mkdir(TMP_DIR, { recursive: true });
  const scratch = path.join(TMP_DIR, `export-${id}-${Date.now()}.${plan.audioFormat}`);
  await transcodeToFile(plan.audioPath, scratch, plan.audioFormat, plan.leadingSilenceMs);

  return {
    stream: fs.createReadStream(scratch),
    cleanup: async () => {
      try {
        await fsp.unlink(scratch);
      } catch {
        // Already gone, or the directory was swept — either way there is nothing to do.
      }
    },
  };
}

/** What a single requested filename resolves to. */
export type ExportFile =
  | { kind: 'text'; body: string; contentType: string }
  | { kind: 'binary'; body: Uint8Array; contentType: string }
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
      body: writeChart(exportProjectFor(plan), { musicStream: exportAudioFileName(plan) }),
      // text/plain rather than a made-up type: browsers handle it predictably, and
      // Content-Disposition is what actually names the file.
      contentType: 'text/plain; charset=utf-8',
    };
  }

  if (name === 'notes.mid') {
    return {
      kind: 'binary',
      body: writeMidi(exportProjectFor(plan)).data,
      contentType: 'audio/midi',
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
  const ext = plan.canTranscode ? `.${plan.audioFormat}` : plan.audioExt;
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
