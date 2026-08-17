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
  /**
   * Length of the PACKAGED audio in milliseconds — lead-in, music and tail together.
   * This is what `song_length` reports, so it has to describe the file that ships rather
   * than the file that was uploaded.
   */
  durationMs: number;
  /**
   * Length of the music alone, for the difficulty estimate. Defaults to `durationMs`.
   *
   * These differ whenever a section is charted out of a longer upload. The estimate is
   * notes per second, so measuring against the whole upload rates a dense 30-second
   * breakdown cut from a five-minute recording as if it were nearly empty.
   */
  musicDurationMs?: number;
  /** Filename of the audio as packaged in the zip, used to derive nothing but kept for clarity. */
  audioFileName?: string;
}

export function generateSongIni(project: Project, options: SongIniOptions): string {
  const { meta } = project;

  const lines: string[] = ['[song]'];
  const push = (key: string, value: string | number) => lines.push(`${key} = ${value}`);
  /**
   * Optional fields are omitted when empty rather than written blank. Clone Hero
   * treats an absent key and an empty one identically, and `genre = ` in a file is
   * just noise that makes real values harder to spot when reading it by hand.
   */
  const pushIfSet = (key: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text.length > 0) push(key, text);
  };

  push('name', meta.name.trim() || 'Untitled');
  push('artist', meta.artist.trim() || 'Unknown Artist');
  pushIfSet('album', meta.album);
  pushIfSet('year', meta.year);
  pushIfSet('genre', meta.genre);
  push('charter', meta.charter.trim() || 'Unknown');
  // Always emitted: this is the one field that changes playback, driving the progress
  // bar and end-of-song detection.
  push('song_length', Math.max(0, Math.round(options.durationMs)));

  // Per-difficulty ratings, 0-6 in Clone Hero, or -1 for "not charted". We derive a
  // rough number from note density rather than leaving everything at -1, because an
  // all -1 song sorts oddly in the browser. This is a hint, not a claim of accuracy.
  push('diff_guitar', estimateDifficulty(project, options.musicDurationMs ?? options.durationMs));

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
  // `icon` (charter badge) and `loading_phrase` are deliberately not written. Both are
  // purely cosmetic, and an empty `icon` makes Clone Hero look for a missing badge.

  return `${lines.join('\n')}\n`;
}

/**
 * Estimate a 0-6 difficulty rating from Expert note density (notes per second).
 * Thresholds are eyeballed against real charts — this is cosmetic metadata.
 */
function estimateDifficulty(project: Project, musicDurationMs: number): number {
  const expert = project.tracks.ExpertSingle;
  const fallback = TRACK_NAMES.map((t) => project.tracks[t]).find((t) => t && t.notes.length > 0);
  const track = expert && expert.notes.length > 0 ? expert : fallback;
  if (!track || track.notes.length === 0) return -1;

  const seconds = musicDurationMs / 1000;
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
