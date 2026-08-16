import { describe, expect, it } from 'vitest';
import { isHopo } from './useHighwayRenderer';
import { effectiveType, flagsForType } from '../chart/noteTypes';
import { DEFAULT_RESOLUTION, type Lane, type Note } from '../chart/types';

/**
 * HOPO status is DERIVED, not stored — the .chart format only records the `forced`
 * flag, which inverts whatever the derivation produces. These tests pin the rules
 * Clone Hero applies, because the gem shapes on the highway are only useful if they
 * show what a note will actually do in game.
 */

const R = DEFAULT_RESOLUTION; // 192
const THRESHOLD = R / 3; // 64 ticks — a 1/12 step

function chart(
  spec: Array<{ tick: number; lane: Lane; forced?: boolean }>,
): Note[] {
  return spec
    .map((n, i) => ({
      id: `n${i}`,
      tick: n.tick,
      lane: n.lane,
      length: 0,
      forced: n.forced ?? false,
      tap: false,
    }))
    .sort((a, b) => a.tick - b.tick || a.lane - b.lane);
}

describe('isHopo', () => {
  it('treats the first note of a chart as a strum', () => {
    const notes = chart([{ tick: 0, lane: 0 }]);
    expect(isHopo(notes, 0, THRESHOLD)).toBe(false);
  });

  it('makes a close note on a different fret a natural HOPO', () => {
    const notes = chart([
      { tick: 0, lane: 0 },
      { tick: 48, lane: 1 }, // within a 1/12 step
    ]);
    expect(isHopo(notes, 1, THRESHOLD)).toBe(true);
  });

  it('does not make a close note on the SAME fret a HOPO', () => {
    // Repeated notes on one fret must be strummed; this is the rule people most often
    // get wrong, and getting it wrong makes a chart unplayable as written.
    const notes = chart([
      { tick: 0, lane: 2 },
      { tick: 48, lane: 2 },
    ]);
    expect(isHopo(notes, 1, THRESHOLD)).toBe(false);
  });

  it('does not make a distant note a HOPO', () => {
    const notes = chart([
      { tick: 0, lane: 0 },
      { tick: 96, lane: 1 }, // an 1/8 step, beyond the threshold
    ]);
    expect(isHopo(notes, 1, THRESHOLD)).toBe(false);
  });

  it('includes a note exactly on the threshold', () => {
    const notes = chart([
      { tick: 0, lane: 0 },
      { tick: THRESHOLD, lane: 1 },
    ]);
    expect(isHopo(notes, 1, THRESHOLD)).toBe(true);
  });

  it('never makes a chord a natural HOPO', () => {
    const notes = chart([
      { tick: 0, lane: 0 },
      { tick: 48, lane: 1 },
      { tick: 48, lane: 2 },
    ]);
    // Both notes of the chord at tick 48 are strums despite being close.
    expect(isHopo(notes, 1, THRESHOLD)).toBe(false);
    expect(isHopo(notes, 2, THRESHOLD)).toBe(false);
  });

  it('allows a single note after a chord to be a HOPO', () => {
    const notes = chart([
      { tick: 0, lane: 0 },
      { tick: 0, lane: 1 },
      { tick: 48, lane: 0 }, // same fret as part of the chord, but the chord differs
    ]);
    expect(isHopo(notes, 2, THRESHOLD)).toBe(true);
  });

  it('inverts the natural result when forced', () => {
    const naturalHopo = chart([
      { tick: 0, lane: 0 },
      { tick: 48, lane: 1, forced: true },
    ]);
    expect(isHopo(naturalHopo, 1, THRESHOLD)).toBe(false); // forced strum

    const naturalStrum = chart([
      { tick: 0, lane: 0 },
      { tick: 192, lane: 1, forced: true },
    ]);
    expect(isHopo(naturalStrum, 1, THRESHOLD)).toBe(true); // forced HOPO
  });

  it('uses only the forced flag for open notes', () => {
    const notes = chart([
      { tick: 0, lane: 0 },
      { tick: 48, lane: 7 },
    ]);
    expect(isHopo(notes, 1, THRESHOLD)).toBe(false);

    const forcedOpen = chart([
      { tick: 0, lane: 0 },
      { tick: 48, lane: 7, forced: true },
    ]);
    expect(isHopo(forcedOpen, 1, THRESHOLD)).toBe(true);
  });

  it('measures the gap from the previous tick, not the previous array entry', () => {
    // The predecessor is a chord, so the walk-back must skip its second note rather
    // than measuring a zero-tick gap against it.
    const notes = chart([
      { tick: 0, lane: 0 },
      { tick: 0, lane: 1 },
      { tick: 240, lane: 2 },
    ]);
    expect(isHopo(notes, 2, THRESHOLD)).toBe(false);
  });
});

/**
 * The highway and the conversion tools MUST agree about what a hammer-on is.
 *
 * They used to derive it separately and disagreed about a note following a chord:
 * converting such a note to a hammer-on set `forced` against one rule while the highway
 * drew it against the other, so the note came out looking — and playing — like a strum.
 * These tests pin the agreement rather than either implementation, so a future change to
 * one that does not reach the other fails here.
 */
describe('what you convert is what you see', () => {
  const cases: Array<{ name: string; spec: Array<{ tick: number; lane: Lane }> ; index: number }> = [
    {
      name: 'a close note on a different fret',
      spec: [
        { tick: 0, lane: 0 },
        { tick: 48, lane: 1 },
      ],
      index: 1,
    },
    {
      name: 'a note repeating the previous fret',
      spec: [
        { tick: 0, lane: 0 },
        { tick: 48, lane: 0 },
      ],
      index: 1,
    },
    {
      /**
       * The case the two derivations actually disagreed on. The chord's highest note is
       * the array's immediate predecessor, so a following note on THAT fret looked like a
       * repeated fret to the conversion layer (never a HOPO) and like a post-chord note to
       * the renderer (always a HOPO). Converting it to a hammer-on produced a strum.
       */
      name: 'a note following a chord, on the chord’s upper fret',
      spec: [
        { tick: 0, lane: 0 },
        { tick: 0, lane: 1 },
        { tick: 48, lane: 1 },
      ],
      index: 2,
    },
    {
      name: 'a note far from its predecessor',
      spec: [
        { tick: 0, lane: 0 },
        { tick: 384, lane: 1 },
      ],
      index: 1,
    },
    {
      name: 'a note inside a chord',
      spec: [
        { tick: 0, lane: 0 },
        { tick: 48, lane: 1 },
        { tick: 48, lane: 2 },
      ],
      index: 1,
    },
  ];

  for (const { name, spec, index } of cases) {
    it(`draws ${name} as a hammer-on once converted to one`, () => {
      const notes = chart(spec);
      const flags = flagsForType(notes, index, R, 'hopo');
      const converted = notes.map((note, i) => (i === index ? { ...note, ...flags } : note));

      expect(isHopo(converted, index, THRESHOLD)).toBe(true);
      expect(effectiveType(converted, index, R)).toBe('hopo');
    });

    it(`draws ${name} as a strum once converted to one`, () => {
      const notes = chart(spec);
      const flags = flagsForType(notes, index, R, 'strum');
      const converted = notes.map((note, i) => (i === index ? { ...note, ...flags } : note));

      expect(isHopo(converted, index, THRESHOLD)).toBe(false);
      expect(effectiveType(converted, index, R)).toBe('strum');
    });
  }

  it('agrees with the conversion layer on every unforced note', () => {
    const notes = chart([
      { tick: 0, lane: 0 },
      { tick: 48, lane: 1 },
      { tick: 96, lane: 1 },
      { tick: 144, lane: 2 },
      { tick: 144, lane: 3 },
      { tick: 192, lane: 0 },
      { tick: 600, lane: 4 },
    ]);
    notes.forEach((_, index) => {
      expect(isHopo(notes, index, THRESHOLD)).toBe(effectiveType(notes, index, R) === 'hopo');
    });
  });
});
