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

/**
 * Export and trigger a download.
 *
 * The zip is streamed as a blob rather than navigating to the URL, because the route
 * is a POST (it takes options) and because a failed export should surface as an error
 * in the UI instead of a broken page.
 */
export async function exportSong(id: string, keepOriginalAudio: boolean): Promise<string[]> {
  const response = await fetch(`/api/songs/${id}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keepOriginalAudio }),
  });

  if (!response.ok) {
    let message = `Export failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Body was the zip stream or empty.
    }
    throw new Error(message);
  }

  const rawWarnings = response.headers.get('X-Export-Warnings') ?? '';
  const warnings = rawWarnings ? decodeURIComponent(rawWarnings).split(' | ').filter(Boolean) : [];

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const asciiMatch = /filename="([^"]+)"/i.exec(disposition);
  const filename = utf8Match
    ? decodeURIComponent(utf8Match[1])
    : (asciiMatch?.[1] ?? 'song.zip');

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in Safari; one tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return warnings;
}
