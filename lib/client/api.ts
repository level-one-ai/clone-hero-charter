import type { Project, SongIndex } from '../chart/types';
import type { MidiImportReport } from '../chart/midiToChart';

/** Typed fetch helpers. Every route returns `{ error }` on failure, so unwrap once here. */

async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function fetchSongs(): Promise<SongIndex> {
  return unwrap<SongIndex>(await fetch('/api/songs', { cache: 'no-store' }));
}

export async function fetchProject(id: string): Promise<Project> {
  return unwrap<Project>(await fetch(`/api/songs/${id}`, { cache: 'no-store' }));
}

export interface CreateSongResult {
  id: string;
  project: Project;
  warnings: string[];
  midiReport: MidiImportReport | null;
}

/**
 * Create a project.
 *
 * Uses XMLHttpRequest rather than fetch purely because it exposes upload progress
 * events — audio files are large enough that a progress bar is the difference
 * between "working" and "broken" from the user's point of view.
 */
export function createSong(
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<CreateSongResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/songs');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });

    xhr.addEventListener('load', () => {
      try {
        const body = JSON.parse(xhr.responseText) as CreateSongResult & { error?: string };
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.send(form);
  });
}

export interface ReimportTrackOption {
  index: number;
  name: string;
  noteCount: number;
  range: [number, number] | null;
  /** 0-1 — how well this track's notes fit the Guitar Hero layout. */
  chartFit: number;
  offset: number;
  notesPerDifficulty: Record<'Expert' | 'Hard' | 'Medium' | 'Easy', number>;
}

export type ReimportMode = 'auto' | 'chart' | 'musical';

/** How a transcription's pitches become frets. */
export interface MelodyOptions {
  strategy: 'pitch' | 'contour';
  split: 'even' | 'balanced' | 'distinct';
  useOpenNotes: boolean;
  invert: boolean;
  maxChordSize: number;
}

export interface ReimportAnalysis {
  currentTrack: string;
  selectionReason: string;
  octaveOffset: number;
  /** True when the file was read as a transcription and frets were derived. */
  musicalMode: boolean;
  noteHistogram: Record<number, number>;
  warnings: string[];
  tracks: ReimportTrackOption[];
}

/** Analyse the project's stored source.mid without changing anything. */
export async function analyzeReimport(id: string): Promise<ReimportAnalysis> {
  return unwrap<ReimportAnalysis>(
    await fetch(`/api/songs/${id}/reimport`, { cache: 'no-store' }),
  );
}

/** Re-run the MIDI import with an explicit track and octave offset. Destructive. */
export async function applyReimport(
  id: string,
  options: {
    trackIndex?: number;
    octaveOffset?: number;
    mode?: ReimportMode;
    melody?: MelodyOptions;
  },
): Promise<Project> {
  const body = await unwrap<{ project: Project }>(
    await fetch(`/api/songs/${id}/reimport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    }),
  );
  return body.project;
}

export async function saveChart(id: string, project: Project): Promise<void> {
  await unwrap<{ ok: true }>(
    await fetch(`/api/songs/${id}/chart`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    }),
  );
}

export async function deleteSong(id: string): Promise<void> {
  await unwrap<{ ok: true }>(await fetch(`/api/songs/${id}`, { method: 'DELETE' }));
}

export async function uploadAlbumArt(id: string, file: File): Promise<string> {
  const form = new FormData();
  form.append('albumArt', file);
  const body = await unwrap<{ album: string }>(
    await fetch(`/api/songs/${id}/album`, { method: 'POST', body: form }),
  );
  return body.album;
}

export interface ExportPreflight {
  folderName: string;
  files: string[];
  warnings: string[];
  /** False when ffmpeg is missing or cannot read this audio, so no OGG conversion happens. */
  transcoding: boolean;
  leadingSilenceMs: number;
}

function exportUrl(id: string, keepOriginalAudio: boolean, extra = ''): string {
  return `/api/songs/${id}/export?keepOriginalAudio=${keepOriginalAudio ? '1' : '0'}${extra}`;
}

/**
 * Ask the server what the export would contain, without building it.
 *
 * This is what makes the dialog's preview honest: the file list and the warnings come
 * from the same `planExport` the download uses, so "ffmpeg cannot convert this, you
 * will get the original file" is visible *before* you commit to the download rather
 * than in a header nobody reads afterwards.
 */
export async function exportPreflight(
  id: string,
  keepOriginalAudio: boolean,
): Promise<ExportPreflight> {
  return unwrap<ExportPreflight>(
    await fetch(exportUrl(id, keepOriginalAudio, '&dryRun=1'), { cache: 'no-store' }),
  );
}

/**
 * URL for one file out of the export folder.
 *
 * Used by the dialog's per-file links, which matter when the app is served over plain
 * HTTP: Chrome blocks `.zip` from an insecure origin, but the individual chart, ini and
 * audio files are ordinary text and media. It is also simply the quicker way to re-pull
 * a tweaked notes.chart without the audio attached.
 */
export function exportFileUrl(id: string, name: string, keepOriginalAudio: boolean): string {
  return `/api/songs/${id}/export/file?name=${encodeURIComponent(name)}&keepOriginalAudio=${
    keepOriginalAudio ? '1' : '0'
  }`;
}

/**
 * Start the download.
 *
 * A plain navigation rather than fetch-to-Blob: the browser streams the zip straight to
 * disk instead of the tab holding the whole archive — tens of megabytes for a
 * keep-original-audio export — in memory first. `Content-Disposition` on the response
 * supplies the filename and keeps the current page in place.
 */
export function exportSong(id: string, keepOriginalAudio: boolean): void {
  window.location.href = exportUrl(id, keepOriginalAudio);
}
