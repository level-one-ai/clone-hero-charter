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
 * THE CANONICAL DERIVATION. The renderer draws from this and the conversion tools decide
 * `forced` from it, which is not a tidiness point: the two used to derive it separately
 * and disagreed about a note following a chord. Converting such a note to a hammer-on set
 * `forced` against one rule while the highway drew it against the other, so the note came
 * out looking — and playing — like a strum. Anything that needs to know whether a note
 * hammers on calls this.
 *
 * The rules Clone Hero applies:
 *   - a chord (more than one note on a tick) is never a natural HOPO
 *   - a single note within the threshold of the previous note is a natural HOPO, unless
 *     it repeats the previous note's fret — a repeat needs a fresh strum
 *   - a note following a CHORD is a natural HOPO whatever fret it lands on, because there
 *     is no single previous fret for it to be repeating
 *
 * `notes` must be sorted by tick; every caller in the app keeps its tracks that way.
 */
export function isNaturalHopo(notes: Note[], index: number, resolution: number): boolean {
  const note = notes[index];
  if (!note || index === 0) return false;
  // Open notes have no fret to hammer from, so they have no natural status either.
  if (note.lane === 7) return false;

  const threshold = resolution / HOPO_THRESHOLD_DIVISOR;

  // Chord test against the immediate neighbours; the array is tick-sorted, so any note
  // sharing this tick is adjacent.
  const isChord =
    (index > 0 && notes[index - 1].tick === note.tick) ||
    (index + 1 < notes.length && notes[index + 1].tick === note.tick);
  if (isChord) return false;

  // Walk back past anything sharing this tick to the real predecessor.
  let previousIndex = index - 1;
  while (previousIndex >= 0 && notes[previousIndex].tick === note.tick) previousIndex -= 1;
  if (previousIndex < 0) return false;

  const previous = notes[previousIndex];
  const previousIsChord = previousIndex > 0 && notes[previousIndex - 1].tick === previous.tick;
  const gap = note.tick - previous.tick;

  return gap > 0 && gap <= threshold && (previousIsChord || previous.lane !== note.lane);
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
