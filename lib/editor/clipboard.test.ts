import { describe, expect, it } from 'vitest';
import { copyNotes, describeBlock, pasteAt } from './clipboard';
import type { Lane, Note } from '../chart/types';

function note(
  tick: number,
  lane: Lane,
  extra: Partial<Pick<Note, 'length' | 'forced' | 'tap'>> = {},
): Note {
  return {
    id: `n${tick}-${lane}`,
    tick,
    lane,
    length: extra.length ?? 0,
    forced: extra.forced ?? false,
    tap: extra.tap ?? false,
  };
}

describe('copyNotes', () => {
  it('returns null for an empty selection', () => {
    expect(copyNotes([])).toBeNull();
  });

  it('stores ticks relative to the first note', () => {
    const block = copyNotes([note(960, 0), note(1152, 2), note(768, 1)]);
    expect(block?.notes.map((n) => n.deltaTick)).toEqual([0, 192, 384]);
  });

  it('measures the span to the end of the last sustain', () => {
    const block = copyNotes([note(768, 0), note(960, 1, { length: 384 })]);
    expect(block?.spanTicks).toBe(576);
  });

  it('keeps every flag', () => {
    const block = copyNotes([note(768, 3, { length: 192, forced: true, tap: true })]);
    expect(block?.notes[0]).toMatchObject({ lane: 3, length: 192, forced: true, tap: true });
  });
});

describe('pasteAt', () => {
  it('re-anchors the block to the target tick', () => {
    const block = copyNotes([note(960, 0), note(1152, 2)])!;
    expect(pasteAt(block, 1920).map((n) => n.tick)).toEqual([1920, 2112]);
  });

  it('preserves chord shape — notes sharing a tick stay together', () => {
    const block = copyNotes([note(768, 0), note(768, 2), note(768, 4)])!;
    const pasted = pasteAt(block, 384);
    expect(pasted.map((n) => n.tick)).toEqual([384, 384, 384]);
    expect(pasted.map((n) => n.lane).sort()).toEqual([0, 2, 4]);
  });

  it('round-trips lanes, sustains and flags', () => {
    const source = [
      note(768, 0, { length: 192 }),
      note(768, 7),
      note(1152, 4, { forced: true, tap: true }),
    ];
    const pasted = pasteAt(copyNotes(source)!, 0);
    expect(pasted.map(({ tick, lane, length, forced, tap }) => ({ tick, lane, length, forced, tap })))
      .toEqual([
        { tick: 0, lane: 0, length: 192, forced: false, tap: false },
        { tick: 0, lane: 7, length: 0, forced: false, tap: false },
        { tick: 384, lane: 4, length: 0, forced: true, tap: true },
      ]);
  });

  it('gives every paste fresh, unique ids', () => {
    const block = copyNotes([note(768, 0), note(960, 1)])!;
    const first = pasteAt(block, 0);
    const second = pasteAt(block, 1920);
    const ids = [...first, ...second].map((n) => n.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('never produces a negative tick', () => {
    const block = copyNotes([note(768, 0)])!;
    expect(pasteAt(block, -500)[0].tick).toBe(0);
  });
});

describe('describeBlock', () => {
  it('says so when nothing is copied', () => {
    expect(describeBlock(null, 192)).toMatch(/empty/i);
  });

  it('counts notes and beats', () => {
    const block = copyNotes([note(0, 0), note(384, 1)])!;
    expect(describeBlock(block, 192)).toBe('2 notes over 2.0 beats');
  });

  it('drops the span for a block with no width', () => {
    const block = copyNotes([note(768, 0), note(768, 2)])!;
    expect(describeBlock(block, 192)).toBe('2 notes copied');
  });
});
