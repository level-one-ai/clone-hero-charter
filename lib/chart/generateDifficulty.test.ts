import { describe, expect, it } from 'vitest';
import { REDUCTION_RULES, describeReduction, reduceNotes } from './generateDifficulty';
import type { Lane, Note } from './types';

const R = 192; // ticks per quarter note

function note(tick: number, lane: Lane, extra: Partial<Note> = {}): Note {
  return {
    id: `${tick}-${lane}`,
    tick,
    lane,
    length: extra.length ?? 0,
    forced: extra.forced ?? false,
    tap: extra.tap ?? false,
  };
}

/** A quarter-note run of single notes — nothing here should be thinned on any level. */
const quarters = [0, 192, 384, 576, 768].map((t, i) => note(t, (i % 5) as Lane));

describe('reduceNotes', () => {
  it('returns nothing for an empty chart', () => {
    expect(reduceNotes([], R, 'Hard')).toEqual([]);
  });

  it('only ever removes — every output note exists in the source at the same tick', () => {
    const source = [
      ...quarters,
      note(96, 3),
      note(288, 4),
      note(480, 0),
      note(480, 2),
      note(480, 4),
    ];
    for (const level of ['Hard', 'Medium', 'Easy'] as const) {
      const sourceTicks = new Set(source.map((n) => n.tick));
      for (const out of reduceNotes(source, R, level)) {
        expect(sourceTicks.has(out.tick)).toBe(true);
      }
    }
  });

  it('respects the chord limit for each level', () => {
    const chord = [note(0, 0), note(0, 1), note(0, 2), note(0, 3)];
    for (const level of ['Hard', 'Medium', 'Easy'] as const) {
      const out = reduceNotes(chord, R, level);
      expect(out.length).toBeLessThanOrEqual(REDUCTION_RULES[level].maxChordSize);
    }
  });

  it('reduces a chord from the lowest lanes up', () => {
    const out = reduceNotes([note(0, 4), note(0, 2), note(0, 0)], R, 'Hard');
    expect(out.map((n) => n.lane)).toEqual([0, 2]);
  });

  it('keeps Easy to a single note per tick', () => {
    const out = reduceNotes([note(0, 0), note(0, 2), note(0, 4)], R, 'Easy');
    expect(out).toHaveLength(1);
  });

  it('folds lanes above the level ceiling downward', () => {
    // Easy tops out at lane 2, so an orange note becomes yellow rather than vanishing.
    const out = reduceNotes([note(0, 4)], R, 'Easy');
    expect(out[0].lane).toBe(2);
  });

  it('enforces the minimum gap between notes', () => {
    // Sixteenth notes: 48 ticks apart at resolution 192.
    const sixteenths = [0, 48, 96, 144, 192, 240, 288, 336, 384].map((t) => note(t, 0));
    for (const level of ['Hard', 'Medium', 'Easy'] as const) {
      const out = reduceNotes(sixteenths, R, level);
      const ticks = [...new Set(out.map((n) => n.tick))].sort((a, b) => a - b);
      const minGap = REDUCTION_RULES[level].minGapBeats * R;
      for (let i = 1; i < ticks.length; i += 1) {
        // On-beat notes are allowed to survive at half the gap, by design.
        expect(ticks[i] - ticks[i - 1]).toBeGreaterThanOrEqual(minGap / 2);
      }
    }
  });

  it('leaves a quarter-note run untouched on Hard', () => {
    expect(reduceNotes(quarters, R, 'Hard')).toHaveLength(quarters.length);
  });

  it('produces progressively fewer notes as difficulty drops', () => {
    const dense = Array.from({ length: 64 }, (_, i) => note(i * 48, (i % 5) as Lane));
    const hard = reduceNotes(dense, R, 'Hard').length;
    const medium = reduceNotes(dense, R, 'Medium').length;
    const easy = reduceNotes(dense, R, 'Easy').length;
    expect(hard).toBeGreaterThanOrEqual(medium);
    expect(medium).toBeGreaterThanOrEqual(easy);
    expect(easy).toBeLessThan(dense.length);
  });

  it('keeps open notes whole rather than folding them onto a fret', () => {
    const out = reduceNotes([note(0, 7)], R, 'Easy');
    expect(out).toHaveLength(1);
    expect(out[0].lane).toBe(7);
  });

  it('keeps sustains', () => {
    const out = reduceNotes([note(0, 0, { length: 384 })], R, 'Easy');
    expect(out[0].length).toBe(384);
  });

  it('keeps flags on Hard but strips them lower down', () => {
    const flagged = [note(0, 0, { forced: true, tap: true })];
    expect(reduceNotes(flagged, R, 'Hard')[0]).toMatchObject({ forced: true, tap: true });
    expect(reduceNotes(flagged, R, 'Medium')[0]).toMatchObject({ forced: false, tap: false });
    expect(reduceNotes(flagged, R, 'Easy')[0]).toMatchObject({ forced: false, tap: false });
  });

  it('never puts two notes on the same lane at the same tick', () => {
    // Blue and orange both fold to lane 2 on Easy; one must be dropped, not duplicated.
    const out = reduceNotes([note(0, 3), note(0, 4)], R, 'Medium');
    const keys = out.map((n) => `${n.tick}:${n.lane}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns notes sorted and with fresh ids', () => {
    const out = reduceNotes([note(384, 1), note(0, 0)], R, 'Hard');
    expect(out.map((n) => n.tick)).toEqual([0, 384]);
    expect(new Set(out.map((n) => n.id)).size).toBe(out.length);
    expect(out.every((n) => n.id !== '0-0' && n.id !== '384-1')).toBe(true);
  });
});

describe('describeReduction', () => {
  it('reports the note counts and the share kept', () => {
    expect(describeReduction(100, 40, 'Medium')).toBe('Medium: 40 notes from 100 (40% kept)');
  });

  it('does not divide by zero on an empty source', () => {
    expect(describeReduction(0, 0, 'Easy')).toContain('0%');
  });
});
