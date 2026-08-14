import type { Note } from './types';

/**
 * Converting notes between strum, HOPO and tap.
 *
 * THE THING THAT MAKES THIS NON-OBVIOUS: whether a note is a HOPO is not stored. It is
 * DERIVED — a note close enough behind a different single note plays as a hammer-on
 * automatically — and the `forced` flag *inverts* whatever that derivation produced. So
 * "make this a HOPO" is not "set a flag"; it is "set forced to whatever makes the
 * derivation come out as HOPO", which depends on the note's neighbours.
 *
 * Get that wrong and a bulk conversion appears to work while silently turning half the
 * selection into the opposite of what was asked for.
 */

/** Ticks within which a following note becomes a natural HOPO: a 1/12 step. */
const HOPO_THRESHOLD_DIVISOR = 3;

export type NoteType = 'strum' | 'hopo' | 'tap';

/**
 * Would this note play as a HOPO with no `forced` flag?
 *
 * Natural HOPO: close behind the previous note, on a different lane, and not part of a
 * chord. Mirrors the rule the renderer draws with, so what you see is what converts.
 */
export function isNaturalHopo(notes: Note[], index: number, resolution: number): boolean {
  const note = notes[index];
  if (!note || index === 0) return false;

  const threshold = resolution / HOPO_THRESHOLD_DIVISOR;

  // A chord is never a natural HOPO, however close it is.
  const sameTick = notes.filter((n) => n.tick === note.tick);
  if (sameTick.length > 1) return false;

  // Nearest strictly-earlier note.
  let previous: Note | null = null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (notes[i].tick < note.tick) {
      previous = notes[i];
      break;
    }
  }
  if (!previous) return false;

  if (note.tick - previous.tick > threshold) return false;
  // Repeating the same lane needs a fresh strum, so it is never a natural HOPO.
  return previous.lane !== note.lane;
}

/** How a note actually plays, taking the derivation and `forced` together. */
export function effectiveType(notes: Note[], index: number, resolution: number): NoteType {
  const note = notes[index];
  if (!note) return 'strum';
  if (note.tap) return 'tap';
  const natural = isNaturalHopo(notes, index, resolution);
  return natural !== note.forced ? 'hopo' : 'strum';
}

/**
 * Flags that make `note` play as `target`.
 *
 * `forced` is chosen against the natural derivation rather than set blindly — that is
 * the whole point of this module.
 */
export function flagsForType(
  notes: Note[],
  index: number,
  resolution: number,
  target: NoteType,
): { forced: boolean; tap: boolean } {
  if (target === 'tap') {
    // A tap overrides the strum/HOPO distinction entirely, so `forced` is irrelevant and
    // is cleared to keep the data honest.
    return { forced: false, tap: true };
  }

  const natural = isNaturalHopo(notes, index, resolution);
  // forced inverts the natural result, so: want HOPO -> forced = !natural.
  return { forced: target === 'hopo' ? !natural : natural, tap: false };
}

/** Apply a conversion to the given ids, returning only the notes that actually change. */
export function convertNotes(
  notes: Note[],
  ids: Set<string>,
  resolution: number,
  target: NoteType,
): Array<{ id: string; forced: boolean; tap: boolean }> {
  const changes: Array<{ id: string; forced: boolean; tap: boolean }> = [];

  notes.forEach((note, index) => {
    if (!ids.has(note.id)) return;
    const flags = flagsForType(notes, index, resolution, target);
    if (flags.forced !== note.forced || flags.tap !== note.tap) {
      changes.push({ id: note.id, ...flags });
    }
  });

  return changes;
}

/** Ids of every note that currently plays as `target` — for "select all taps" and friends. */
export function selectByType(notes: Note[], resolution: number, target: NoteType): string[] {
  return notes
    .filter((_, index) => effectiveType(notes, index, resolution) === target)
    .map((n) => n.id);
}

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  strum: 'Solid',
  hopo: 'Hammer-on',
  tap: 'Tap',
};
