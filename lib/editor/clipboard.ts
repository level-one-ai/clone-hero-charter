import { newNoteId, type Lane, type Note } from '../chart/types';

/**
 * Copy and paste for a block of notes.
 *
 * A block is stored RELATIVE to its own first note rather than at absolute ticks, which
 * is the whole trick: the same block can then land anywhere in the song, and in any
 * difficulty, without the caller doing arithmetic. Copying a chorus and pasting it over
 * the second chorus is the obvious use; copying Expert into Hard as a starting point for
 * thinning is the one that saves an afternoon.
 *
 * Notes carry their flags — lane, sustain length, tap and forced — so a pasted block is
 * structurally identical to the one copied, chord shapes included. Star power, sections
 * and tempo are deliberately NOT part of a block: they are properties of the song rather
 * than of a run of notes, and pasting should never quietly alter phrasing somewhere the
 * user is not looking.
 */

export interface ClipboardNote {
  /** Ticks after the block's start. The first note is always 0. */
  deltaTick: number;
  lane: Lane;
  length: number;
  forced: boolean;
  tap: boolean;
}

export interface ClipboardBlock {
  notes: ClipboardNote[];
  /** First note to the end of the last sustain — what the block occupies. */
  spanTicks: number;
}

/** Snapshot notes as a block. Returns null for an empty selection. */
export function copyNotes(notes: Note[]): ClipboardBlock | null {
  if (notes.length === 0) return null;

  const start = Math.min(...notes.map((n) => n.tick));
  const end = Math.max(...notes.map((n) => n.tick + n.length));

  const copied = notes
    .map((note) => ({
      deltaTick: note.tick - start,
      lane: note.lane,
      length: note.length,
      forced: note.forced,
      tap: note.tap,
    }))
    .sort((a, b) => a.deltaTick - b.deltaTick || a.lane - b.lane);

  return { notes: copied, spanTicks: end - start };
}

/**
 * Materialise a block at `tick`, with fresh ids.
 *
 * New ids matter: pasting the same block twice must produce two independent sets of
 * notes, and the reducer identifies notes by id for selection, dragging and undo.
 */
export function pasteAt(block: ClipboardBlock, tick: number): Note[] {
  const anchor = Math.max(0, Math.round(tick));
  return block.notes.map((note) => ({
    id: newNoteId(),
    tick: anchor + note.deltaTick,
    lane: note.lane,
    length: note.length,
    forced: note.forced,
    tap: note.tap,
  }));
}

/** Human summary for the toolbar — "12 notes over 2 bars" is more use than a count alone. */
export function describeBlock(block: ClipboardBlock | null, resolution: number): string {
  if (!block) return 'Clipboard empty';
  const beats = block.spanTicks / resolution;
  const noteWord = block.notes.length === 1 ? 'note' : 'notes';
  if (beats < 0.01) return `${block.notes.length} ${noteWord} copied`;
  return `${block.notes.length} ${noteWord} over ${beats.toFixed(beats < 10 ? 1 : 0)} beats`;
}
