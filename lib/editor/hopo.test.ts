import { describe, expect, it } from 'vitest';
import { isHopo } from './useHighwayRenderer';
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
