import { describe, expect, it } from 'vitest';
import {
  convertNotes,
  effectiveType,
  flagsForType,
  isNaturalHopo,
  selectByType,
} from './noteTypes';
import type { Lane, Note } from './types';

const R = 192;
const CLOSE = 48; // well inside the 64-tick natural-HOPO threshold
const FAR = 192;

function note(
  tick: number,
  lane: Lane,
  extra: Partial<Pick<Note, 'forced' | 'tap'>> = {},
): Note {
  return {
    id: `${tick}-${lane}`,
    tick,
    lane,
    length: 0,
    forced: extra.forced ?? false,
    tap: extra.tap ?? false,
  };
}

describe('isNaturalHopo', () => {
  it('is false for the first note', () => {
    expect(isNaturalHopo([note(0, 0)], 0, R)).toBe(false);
  });

  it('is true for a close note on a different lane', () => {
    const notes = [note(0, 0), note(CLOSE, 1)];
    expect(isNaturalHopo(notes, 1, R)).toBe(true);
  });

  it('is false when the gap is too wide', () => {
    const notes = [note(0, 0), note(FAR, 1)];
    expect(isNaturalHopo(notes, 1, R)).toBe(false);
  });

  it('is false when the lane repeats — a repeat needs a fresh strum', () => {
    const notes = [note(0, 0), note(CLOSE, 0)];
    expect(isNaturalHopo(notes, 1, R)).toBe(false);
  });

  it('is false for a chord, however close', () => {
    const notes = [note(0, 0), note(CLOSE, 1), note(CLOSE, 3)];
    expect(isNaturalHopo(notes, 1, R)).toBe(false);
    expect(isNaturalHopo(notes, 2, R)).toBe(false);
  });
});

describe('effectiveType', () => {
  it('reads a tap as a tap regardless of anything else', () => {
    const notes = [note(0, 0), note(CLOSE, 1, { tap: true, forced: true })];
    expect(effectiveType(notes, 1, R)).toBe('tap');
  });

  it('reads a natural HOPO as a HOPO', () => {
    expect(effectiveType([note(0, 0), note(CLOSE, 1)], 1, R)).toBe('hopo');
  });

  it('reads a FORCED natural HOPO as a strum — forced inverts', () => {
    expect(effectiveType([note(0, 0), note(CLOSE, 1, { forced: true })], 1, R)).toBe('strum');
  });

  it('reads a forced distant note as a HOPO', () => {
    expect(effectiveType([note(0, 0), note(FAR, 1, { forced: true })], 1, R)).toBe('hopo');
  });
});

describe('flagsForType', () => {
  it('makes a naturally-HOPO note solid by forcing it', () => {
    const notes = [note(0, 0), note(CLOSE, 1)];
    expect(flagsForType(notes, 1, R, 'strum')).toEqual({ forced: true, tap: false });
  });

  it('leaves an already-solid note unforced when asked for solid', () => {
    const notes = [note(0, 0), note(FAR, 1)];
    expect(flagsForType(notes, 1, R, 'strum')).toEqual({ forced: false, tap: false });
  });

  it('makes a distant note a HOPO by forcing it', () => {
    const notes = [note(0, 0), note(FAR, 1)];
    expect(flagsForType(notes, 1, R, 'hopo')).toEqual({ forced: true, tap: false });
  });

  it('leaves a naturally-HOPO note unforced when asked for HOPO', () => {
    const notes = [note(0, 0), note(CLOSE, 1)];
    expect(flagsForType(notes, 1, R, 'hopo')).toEqual({ forced: false, tap: false });
  });

  it('clears forced when making a tap', () => {
    const notes = [note(0, 0), note(CLOSE, 1, { forced: true })];
    expect(flagsForType(notes, 1, R, 'tap')).toEqual({ forced: false, tap: true });
  });

  it('round-trips: converting to a type makes effectiveType report that type', () => {
    for (const target of ['strum', 'hopo', 'tap'] as const) {
      for (const gap of [CLOSE, FAR]) {
        const notes = [note(0, 0), note(gap, 1)];
        const flags = flagsForType(notes, 1, R, target);
        notes[1] = { ...notes[1], ...flags };
        expect(effectiveType(notes, 1, R)).toBe(target);
      }
    }
  });
});

describe('convertNotes', () => {
  it('changes only the selected notes', () => {
    const notes = [note(0, 0), note(CLOSE, 1), note(FAR + CLOSE, 2)];
    const changes = convertNotes(notes, new Set([notes[1].id]), R, 'tap');
    expect(changes).toEqual([{ id: notes[1].id, forced: false, tap: true }]);
  });

  it('reports nothing when the notes are already that type', () => {
    const notes = [note(0, 0), note(CLOSE, 1)];
    expect(convertNotes(notes, new Set([notes[1].id]), R, 'hopo')).toEqual([]);
  });

  it('handles a whole selection of mixed notes', () => {
    const notes = [note(0, 0), note(CLOSE, 1), note(FAR * 2, 2)];
    const ids = new Set(notes.map((n) => n.id));
    const changes = convertNotes(notes, ids, R, 'strum');
    // The naturally-HOPO middle note needs forcing; the other two are already solid.
    expect(changes).toEqual([{ id: notes[1].id, forced: true, tap: false }]);
  });
});

describe('selectByType', () => {
  it('finds every tap', () => {
    const notes = [note(0, 0, { tap: true }), note(FAR, 1), note(FAR * 2, 2, { tap: true })];
    expect(selectByType(notes, R, 'tap')).toEqual([notes[0].id, notes[2].id]);
  });

  it('finds every HOPO, natural or forced', () => {
    const notes = [note(0, 0), note(CLOSE, 1), note(FAR * 2, 2, { forced: true })];
    expect(selectByType(notes, R, 'hopo')).toEqual([notes[1].id, notes[2].id]);
  });

  it('finds every solid note', () => {
    const notes = [note(0, 0), note(CLOSE, 1), note(FAR * 2, 2)];
    expect(selectByType(notes, R, 'strum')).toEqual([notes[0].id, notes[2].id]);
  });

  it('returns nothing for an empty chart', () => {
    expect(selectByType([], R, 'tap')).toEqual([]);
  });
});
