import type { Note } from './types';

/**
 * "Extend to the next note" — the sustain operation charters actually want.
 *
 * Dragging a tail by hand is fine for one note and miserable for fifty. Almost every
 * sustain in a real chart runs up to just before the next note on the same lane, so that
 * is what a double-click (or the toolbar button) does.
 *
 * The gap matters: a sustain that touches the next note reads as one continuous hold in
 * game and the next note can be missed entirely, so the tail stops a hair short.
 */

/** Fraction of a quarter note left between a sustain's end and the next note. */
const GAP_DIVISOR = 8;

export interface SustainOptions {
  resolution: number;
  /** Length to use when there is no next note on the lane. Defaults to one beat. */
  fallbackTicks?: number;
}

/**
 * New length for `note` so it runs to just before the next note on its lane.
 *
 * Returns the existing length when there is no room to extend, so callers can skip
 * no-op edits rather than dirtying the project.
 */
export function sustainToNext(
  note: Note,
  allNotes: Note[],
  options: SustainOptions,
): number {
  const { resolution } = options;
  const gap = Math.max(1, Math.round(resolution / GAP_DIVISOR));
  const fallback = options.fallbackTicks ?? resolution;

  // Same lane only. A blue note does not care what the yellow lane is doing, and open
  // notes form their own lane.
  let nextTick = Number.POSITIVE_INFINITY;
  for (const other of allNotes) {
    if (other.id === note.id || other.lane !== note.lane) continue;
    if (other.tick > note.tick && other.tick < nextTick) nextTick = other.tick;
  }

  if (!Number.isFinite(nextTick)) return Math.max(note.length, fallback);

  const length = nextTick - note.tick - gap;
  // Notes closer together than the gap cannot sustain at all; leave them as hits.
  return length > 0 ? length : note.length;
}

/** Apply sustainToNext across a selection, returning only the notes that changed. */
export function sustainSelectionToNext(
  selected: Note[],
  allNotes: Note[],
  options: SustainOptions,
): Array<{ id: string; length: number }> {
  const changes: Array<{ id: string; length: number }> = [];
  for (const note of selected) {
    const length = sustainToNext(note, allNotes, options);
    if (length !== note.length) changes.push({ id: note.id, length });
  }
  return changes;
}
