import { describe, expect, it } from 'vitest';
import { hasNoteNear, mergeIntoGaps, mergeTracksIntoGaps } from './mergeNotes';
import type { Lane, Note, Track } from '@/lib/chart/types';

const WINDOW = 96; // an eighth note at resolution 192

function note(tick: number, lane: Lane = 0, id = `x${tick}-${lane}`): Note {
  return { id, tick, lane, length: 0, forced: false, tap: false };
}

const track = (notes: Note[]): Track => ({ notes, starPower: [] });

describe('hasNoteNear', () => {
  it('is false for an empty chart', () => {
    expect(hasNoteNear([], 500, WINDOW)).toBe(false);
  });

  it('finds a note at the same tick', () => {
    expect(hasNoteNear([0, 500, 1000], 500, WINDOW)).toBe(true);
  });

  it('finds one just inside the window on either side', () => {
    expect(hasNoteNear([500], 500 + WINDOW, WINDOW)).toBe(true);
    expect(hasNoteNear([500], 500 - WINDOW, WINDOW)).toBe(true);
  });

  it('does not find one just outside the window', () => {
    expect(hasNoteNear([500], 500 + WINDOW + 1, WINDOW)).toBe(false);
    expect(hasNoteNear([500], 500 - WINDOW - 1, WINDOW)).toBe(false);
  });

  it('works at both ends of a long chart', () => {
    // A quarter-note run with a bar-long hole in the middle. Note that a continuous run
    // at this spacing covers EVERY tick once the window is half the spacing, which is
    // why the gap has to be a real one for the false case to mean anything.
    const ticks = Array.from({ length: 1000 }, (_, i) => i * 192).filter(
      (t) => t < 500 * 192 || t > 504 * 192,
    );
    expect(hasNoteNear(ticks, 0, WINDOW)).toBe(true);
    expect(hasNoteNear(ticks, 999 * 192, WINDOW)).toBe(true);
    expect(hasNoteNear(ticks, 502 * 192, WINDOW)).toBe(false);
  });
});

describe('mergeIntoGaps', () => {
  it('adds a candidate that falls in a gap', () => {
    const result = mergeIntoGaps([note(0)], [note(1920, 2)], { windowTicks: WINDOW });
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.notes.map((n) => n.tick)).toEqual([0, 1920]);
  });

  it('skips a candidate on top of an existing note', () => {
    const result = mergeIntoGaps([note(960)], [note(960, 3)], { windowTicks: WINDOW });
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.notes).toHaveLength(1);
  });

  it('skips a candidate merely NEAR an existing note', () => {
    // Two transcriptions never agree tick-for-tick; a near-miss copy is worse than a gap.
    const result = mergeIntoGaps([note(960)], [note(960 + 32, 3)], { windowTicks: WINDOW });
    expect(result.skipped).toBe(1);
  });

  it('never modifies the notes already charted', () => {
    const existing = [note(0, 0, 'keep-me')];
    const result = mergeIntoGaps(existing, [note(1920, 1)], { windowTicks: WINDOW });
    expect(result.notes.find((n) => n.id === 'keep-me')).toEqual(existing[0]);
    expect(existing).toHaveLength(1);
  });

  it('gives merged notes fresh ids so they cannot collide', () => {
    const result = mergeIntoGaps([], [note(0, 0, 'dup'), note(1920, 0, 'dup')], {
      windowTicks: WINDOW,
    });
    const ids = result.notes.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('dup');
  });

  it('keeps the result sorted', () => {
    const result = mergeIntoGaps([note(1920)], [note(0, 1), note(960, 2)], {
      windowTicks: WINDOW,
    });
    expect(result.notes.map((n) => n.tick)).toEqual([0, 960, 1920]);
  });

  it('fills everything when the chart is empty', () => {
    const result = mergeIntoGaps([], [note(0), note(192, 1), note(384, 2)], {
      windowTicks: WINDOW,
    });
    expect(result.added).toBe(3);
  });

  it('carries lane, sustain and flags across', () => {
    const candidate: Note = { id: 'c', tick: 1920, lane: 4, length: 384, forced: true, tap: true };
    const result = mergeIntoGaps([], [candidate], { windowTicks: WINDOW });
    expect(result.notes[0]).toMatchObject({ lane: 4, length: 384, forced: true, tap: true });
  });

  it('treats a window of zero as exact-tick only', () => {
    const result = mergeIntoGaps([note(960)], [note(961, 1)], { windowTicks: 0 });
    expect(result.added).toBe(1);
  });
});

describe('mergeTracksIntoGaps', () => {
  it('merges each difficulty independently', () => {
    const existing = { ExpertSingle: track([note(0)]), HardSingle: track([]) };
    const incoming = { ExpertSingle: track([note(1920, 1)]), HardSingle: track([note(0, 2)]) };
    const result = mergeTracksIntoGaps(existing, incoming, { windowTicks: WINDOW });
    expect(result.tracks.ExpertSingle.notes).toHaveLength(2);
    expect(result.tracks.HardSingle.notes).toHaveLength(1);
    expect(result.added).toBe(2);
  });

  it('leaves star power alone', () => {
    const existing = {
      ExpertSingle: { notes: [note(0)], starPower: [{ tick: 0, length: 768 }] },
    };
    const incoming = {
      ExpertSingle: { notes: [note(1920)], starPower: [{ tick: 5000, length: 100 }] },
    };
    const result = mergeTracksIntoGaps(existing, incoming, { windowTicks: WINDOW });
    expect(result.tracks.ExpertSingle.starPower).toEqual([{ tick: 0, length: 768 }]);
  });

  it('ignores a difficulty the incoming chart does not have', () => {
    const existing = { ExpertSingle: track([note(0)]), EasySingle: track([note(0)]) };
    const result = mergeTracksIntoGaps(existing, {}, { windowTicks: WINDOW });
    expect(result.added).toBe(0);
    expect(result.tracks.EasySingle.notes).toHaveLength(1);
  });
});
