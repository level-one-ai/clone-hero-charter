import { describe, expect, it } from 'vitest';
import {
  createLiveEntryState,
  isEntryKey,
  isHolding,
  laneForKey,
  pressKey,
  registerHeld,
  releaseAll,
  releaseKey,
} from './liveEntry';

const MIN_SUSTAIN = 48; // an eighth note at resolution 192

describe('key mapping', () => {
  it('maps A-G left to right across the frets', () => {
    expect(laneForKey('a')).toBe(0);
    expect(laneForKey('s')).toBe(1);
    expect(laneForKey('d')).toBe(2);
    expect(laneForKey('f')).toBe(3);
    expect(laneForKey('g')).toBe(4);
  });

  it('maps Space to the open note', () => {
    expect(laneForKey(' ')).toBe(7);
  });

  it('is case-insensitive, so Shift-held entry still works', () => {
    expect(laneForKey('A')).toBe(0);
    expect(laneForKey('G')).toBe(4);
  });

  it('ignores keys that are not entry keys', () => {
    for (const key of ['h', 'z', 'Enter', 'ArrowLeft', '1']) {
      expect(laneForKey(key)).toBeNull();
      expect(isEntryKey(key)).toBe(false);
    }
  });
});

describe('pressKey', () => {
  it('places a note on a fresh press', () => {
    const state = createLiveEntryState();
    expect(pressKey(state, 'a', { repeat: false, shift: false }).place).toEqual({
      lane: 0,
      forced: false,
    });
  });

  it('marks the note forced when Shift is held', () => {
    const state = createLiveEntryState();
    expect(pressKey(state, 'd', { repeat: false, shift: true }).place).toEqual({
      lane: 2,
      forced: true,
    });
  });

  it('ignores auto-repeat — holding for a sustain must not machine-gun notes', () => {
    const state = createLiveEntryState();
    expect(pressKey(state, 'a', { repeat: true, shift: false }).place).toBeNull();
  });

  it('ignores a key that is already down', () => {
    const state = createLiveEntryState();
    registerHeld(state, 'a', { id: 'n1', lane: 0, startTick: 0 });
    expect(pressKey(state, 'a', { repeat: false, shift: false }).place).toBeNull();
  });

  it('allows several different keys at once, for chords', () => {
    const state = createLiveEntryState();
    registerHeld(state, 'a', { id: 'n1', lane: 0, startTick: 384 });
    expect(pressKey(state, 'd', { repeat: false, shift: false }).place).toEqual({
      lane: 2,
      forced: false,
    });
  });
});

describe('releaseKey', () => {
  it('turns a long hold into a sustain', () => {
    const state = createLiveEntryState();
    registerHeld(state, 'g', { id: 'n1', lane: 4, startTick: 192 });
    const result = releaseKey(state, 'g', 576, MIN_SUSTAIN);
    expect(result.note?.id).toBe('n1');
    expect(result.length).toBe(384);
  });

  it('treats a quick tap as no sustain at all', () => {
    // Nobody releases a key instantly; without a threshold every note would come out
    // with a stub sustain too short to register in game.
    const state = createLiveEntryState();
    registerHeld(state, 'a', { id: 'n1', lane: 0, startTick: 192 });
    expect(releaseKey(state, 'a', 200, MIN_SUSTAIN).length).toBe(0);
  });

  it('keeps a hold exactly at the threshold', () => {
    const state = createLiveEntryState();
    registerHeld(state, 'a', { id: 'n1', lane: 0, startTick: 0 });
    expect(releaseKey(state, 'a', MIN_SUSTAIN, MIN_SUSTAIN).length).toBe(MIN_SUSTAIN);
  });

  it('never produces a negative length if the playhead moved backwards', () => {
    const state = createLiveEntryState();
    registerHeld(state, 'a', { id: 'n1', lane: 0, startTick: 960 });
    expect(releaseKey(state, 'a', 0, MIN_SUSTAIN).length).toBe(0);
  });

  it('returns nothing for a key that was never held', () => {
    const state = createLiveEntryState();
    expect(releaseKey(state, 'f', 500, MIN_SUSTAIN)).toEqual({ note: null, length: 0 });
  });

  it('releases only the key that came up', () => {
    const state = createLiveEntryState();
    registerHeld(state, 'a', { id: 'n1', lane: 0, startTick: 0 });
    registerHeld(state, 's', { id: 'n2', lane: 1, startTick: 0 });
    expect(releaseKey(state, 'a', 100, MIN_SUSTAIN).note?.id).toBe('n1');
    expect(isHolding(state)).toBe(true);
    expect(releaseKey(state, 's', 100, MIN_SUSTAIN).note?.id).toBe('n2');
    expect(isHolding(state)).toBe(false);
  });
});

describe('releaseAll', () => {
  it('hands back everything still down and clears the state', () => {
    const state = createLiveEntryState();
    registerHeld(state, 'a', { id: 'n1', lane: 0, startTick: 0 });
    registerHeld(state, 'g', { id: 'n2', lane: 4, startTick: 0 });
    expect(releaseAll(state).map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    expect(isHolding(state)).toBe(false);
  });

  it('is safe with nothing held', () => {
    expect(releaseAll(createLiveEntryState())).toEqual([]);
  });
});
