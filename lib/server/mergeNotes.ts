import { newNoteId, type Note, type Track } from '@/lib/chart/types';

/**
 * Fill the gaps in a chart from another source, without touching what is already there.
 *
 * The use case: a MIDI export covers part of a song — one guitar part, or a file that
 * drops out through the bridge — and a second file has the missing stretch. Merging them
 * should add the parts you are missing and leave every note you have already charted or
 * hand-corrected exactly as it is.
 *
 * "Already covered" is deliberately generous. A candidate is skipped when ANY existing
 * note sits within a window of it, not only when one lands on the same tick — two
 * transcriptions of the same passage will never agree tick-for-tick, and adding a second
 * copy of a riff a thirty-second out of step produces an unplayable mess that is tedious
 * to clean up. Erring towards skipping means the worst case is a gap you fill by hand,
 * rather than a chart you have to unpick.
 */

export interface MergeOptions {
  /**
   * How close an existing note has to be, in ticks, for a candidate to count as already
   * covered. An eighth note at the project's resolution is the sensible default.
   */
  windowTicks: number;
}

export interface MergeResult {
  notes: Note[];
  added: number;
  /** Candidates dropped because that part of the song is already charted. */
  skipped: number;
}

/**
 * Merge `candidates` into `existing`, keeping every existing note.
 *
 * Returns a new array; neither input is mutated, so a caller can preview a merge before
 * committing it.
 */
export function mergeIntoGaps(
  existing: Note[],
  candidates: Note[],
  options: MergeOptions,
): MergeResult {
  const window = Math.max(0, options.windowTicks);

  // Sorted ticks of what is already charted, so each candidate is a binary search rather
  // than a scan — a full song against a full song is otherwise quadratic.
  const occupied = existing.map((n) => n.tick).sort((a, b) => a - b);

  const added: Note[] = [];
  let skipped = 0;

  for (const candidate of [...candidates].sort((a, b) => a.tick - b.tick || a.lane - b.lane)) {
    if (hasNoteNear(occupied, candidate.tick, window)) {
      skipped += 1;
      continue;
    }
    added.push({ ...candidate, id: newNoteId() });
  }

  const notes = [...existing, ...added].sort((a, b) => a.tick - b.tick || a.lane - b.lane);
  return { notes, added: added.length, skipped };
}

/** True when `ticks` contains any value within `window` of `tick`. */
export function hasNoteNear(ticks: number[], tick: number, window: number): boolean {
  if (ticks.length === 0) return false;

  // First index whose value is >= tick - window.
  let low = 0;
  let high = ticks.length;
  const lowerBound = tick - window;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ticks[mid] < lowerBound) low = mid + 1;
    else high = mid;
  }

  return low < ticks.length && ticks[low] <= tick + window;
}

/** Merge every difficulty of one chart into another, gap-filling each independently. */
export function mergeTracksIntoGaps(
  existing: Record<string, Track>,
  incoming: Record<string, Track>,
  options: MergeOptions,
): { tracks: Record<string, Track>; added: number; skipped: number } {
  const tracks: Record<string, Track> = {};
  let added = 0;
  let skipped = 0;

  for (const [name, track] of Object.entries(existing)) {
    const candidates = incoming[name]?.notes ?? [];
    const result = mergeIntoGaps(track.notes, candidates, options);
    added += result.added;
    skipped += result.skipped;
    tracks[name] = {
      notes: result.notes,
      // Star power is left entirely alone. Phrases are a judgement about the whole song,
      // not something to accumulate from every file you happen to merge in.
      starPower: track.starPower,
    };
  }

  return { tracks, added, skipped };
}
