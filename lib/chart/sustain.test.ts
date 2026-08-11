import { describe, expect, it } from 'vitest';
import { sustainSelectionToNext, sustainToNext } from './sustain';
import type { Lane, Note } from './types';

const R = 192;

function note(id: string, tick: number, lane: Lane, length = 0): Note {
  return { id, tick, lane, length, forced: false, tap: false };
}

describe('sustainToNext', () => {
  it('extends to just before the next note on the same lane', () => {
    const a = note('a', 0, 0);
    const b = note('b', 768, 0);
    // 768 minus a 1/8-of-a-beat gap (24 ticks at resolution 192).
    expect(sustainToNext(a, [a, b], { resolution: R })).toBe(768 - 24);
  });

  it('leaves a gap so the next note is still hittable', () => {
    const a = note('a', 0, 0);
    const b = note('b', 384, 0);
    expect(sustainToNext(a, [a, b], { resolution: R })).toBeLessThan(384);
  });

  it('ignores notes on other lanes', () => {
    const a = note('a', 0, 0);
    const other = note('b', 192, 3);
    const same = note('c', 960, 0);
    expect(sustainToNext(a, [a, other, same], { resolution: R })).toBe(960 - 24);
  });

  it('treats open notes as their own lane', () => {
    const open = note('a', 0, 7);
    const fret = note('b', 192, 0);
    const nextOpen = note('c', 768, 7);
    expect(sustainToNext(open, [open, fret, nextOpen], { resolution: R })).toBe(768 - 24);
  });

  it('uses a beat for the last note on a lane', () => {
    const a = note('a', 0, 0);
    expect(sustainToNext(a, [a], { resolution: R })).toBe(R);
  });

  it('keeps an existing longer sustain on the last note', () => {
    const a = note('a', 0, 0, 960);
    expect(sustainToNext(a, [a], { resolution: R })).toBe(960);
  });

  it('leaves notes too close together alone rather than making a negative sustain', () => {
    const a = note('a', 0, 0);
    const b = note('b', 12, 0);
    expect(sustainToNext(a, [a, b], { resolution: R })).toBe(0);
  });

  it('picks the NEAREST next note, not the last one', () => {
    const a = note('a', 0, 0);
    const near = note('b', 384, 0);
    const far = note('c', 1920, 0);
    expect(sustainToNext(a, [a, near, far], { resolution: R })).toBe(384 - 24);
  });

  it('ignores notes before it', () => {
    const earlier = note('a', 0, 0);
    const target = note('b', 384, 0);
    expect(sustainToNext(target, [earlier, target], { resolution: R })).toBe(R);
  });
});

describe('sustainSelectionToNext', () => {
  it('reports only the notes whose length actually changes', () => {
    const a = note('a', 0, 0);
    const b = note('b', 768, 0, R);
    const changes = sustainSelectionToNext([a, b], [a, b], { resolution: R });
    expect(changes).toEqual([{ id: 'a', length: 744 }]);
  });

  it('returns nothing for an empty selection', () => {
    expect(sustainSelectionToNext([], [], { resolution: R })).toEqual([]);
  });
});
