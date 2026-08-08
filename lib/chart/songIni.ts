import { TRACK_NAMES, type Project } from './types';

/**
 * song.ini generator.
 *
 * Clone Hero reads this for everything shown in the song browser. The .chart's own
 * [Song] block is largely ignored by Clone Hero in favour of song.ini, so this file
 * — not the chart metadata — is what the user actually sees in game.
 *
 * `song_length` is in MILLISECONDS and matters: Clone Hero uses it for the progress
 * bar and for deciding when the song ends. Getting it wrong truncates playback.
 */

export interface SongIniOptions {
  /** Audio duration in milliseconds, measured from the actual audio file. */
  durationMs: number;
  /** Filename of the audio as packaged in the zip, used to derive nothing but kept for clarity. */
  audioFileName?: string;
}

export function generateSongIni(project: Project, options: SongIniOptions): string {
  const { meta } = project;

  const lines: string[] = ['[song]'];
  const push = (key: string, value: string | number) => lines.push(`${key} = ${value}`);

  push('name', meta.name || 'Untitled');
  push('artist', meta.artist || 'Unknown Artist');
  push('album', meta.album || '');
  push('year', meta.year ?? '');
  push('genre', meta.genre || '');
  push('charter', meta.charter || 'Unknown');
  push('song_length', Math.max(0, Math.round(options.durationMs)));

  // Per-difficulty ratings, 0-6 in Clone Hero, or -1 for "not charted". We derive a
  // rough number from note density rather than leaving everything at -1, because an
  // all -1 song sorts oddly in the browser. This is a hint, not a claim of accuracy.
  push('diff_guitar', estimateDifficulty(project));

  // Instruments we do not chart must be explicitly -1 or Clone Hero shows them as
  // available and then fails to load them.
  push('diff_bass', -1);
  push('diff_drums', -1);
  push('diff_keys', -1);
  push('diff_guitarghl', -1);
  push('diff_bassghl', -1);

  push('preview_start_time', 0);
  // `delay` is an additional audio offset in ms applied on top of the chart's own
  // Offset. We keep it at 0 and express any offset in the .chart, so there is exactly
  // one place where sync is adjusted.
  push('delay', 0);
  push('icon', '');
  push('loading_phrase', '');

  return `${lines.join('\n')}\n`;
}

/**
 * Estimate a 0-6 difficulty rating from Expert note density (notes per second).
 * Thresholds are eyeballed against real charts — this is cosmetic metadata.
 */
function estimateDifficulty(project: Project): number {
  const expert = project.tracks.ExpertSingle;
  const fallback = TRACK_NAMES.map((t) => project.tracks[t]).find((t) => t && t.notes.length > 0);
  const track = expert && expert.notes.length > 0 ? expert : fallback;
  if (!track || track.notes.length === 0) return -1;

  const seconds = project.audio.durationMs / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return -1;

  const density = track.notes.length / seconds;
  if (density < 1) return 0;
  if (density < 2) return 1;
  if (density < 3) return 2;
  if (density < 4.5) return 3;
  if (density < 6) return 4;
  if (density < 8) return 5;
  return 6;
}
