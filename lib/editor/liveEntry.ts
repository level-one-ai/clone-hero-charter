import type { Lane } from '../chart/types';

/**
 * Live note entry from the keyboard.
 *
 * Play the song and play along: A S D F G are the five frets, Space is an open note.
 * Hold a key and the note becomes a sustain that ends when you let go; hold Shift as you
 * press and it becomes a forced HOPO; press several at once for a chord.
 *
 * This module is the state machine only — no React, no DOM — because the awkward parts
 * are the edge cases (auto-repeat, a key still held when playback stops, two keys landing
 * on the same tick) and those are worth testing directly.
 *
 * WHY THESE KEYS: they sit under the left hand in the same left-to-right order as the
 * frets, so the mapping needs no thought once you have played a bar. It does mean Space
 * can no longer be play/pause — that moves to Enter — and that no editor shortcut may be
 * a bare A-G, which is why the tool shortcuts live on Alt.
 */

/** Keyboard key (lowercased `event.key`) to fret lane. */
export const ENTRY_KEYS: Record<string, Lane> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  g: 4,
  // Space is the open note — the whole-fretboard strum, so it gets the widest key.
  ' ': 7,
};

export function isEntryKey(key: string): boolean {
  return key.toLowerCase() in ENTRY_KEYS;
}

export function laneForKey(key: string): Lane | null {
  return ENTRY_KEYS[key.toLowerCase()] ?? null;
}

/** A note currently being held down. */
export interface HeldNote {
  id: string;
  lane: Lane;
  /** Tick the note was placed at. */
  startTick: number;
}

export interface LiveEntryState {
  /** Keyed by the keyboard key, so releasing the right key ends the right note. */
  held: Map<string, HeldNote>;
}

export function createLiveEntryState(): LiveEntryState {
  return { held: new Map() };
}

export interface PressResult {
  /** Null when the press should be ignored — auto-repeat, or the key is already down. */
  place: { lane: Lane; forced: boolean } | null;
}

/**
 * Handle a key going down.
 *
 * Auto-repeat is rejected outright: holding a key to make a sustain would otherwise
 * machine-gun notes across the highway at the OS repeat rate.
 */
export function pressKey(
  state: LiveEntryState,
  key: string,
  options: { repeat: boolean; shift: boolean },
): PressResult {
  const lane = laneForKey(key);
  if (lane === null || options.repeat) return { place: null };
  if (state.held.has(key.toLowerCase())) return { place: null };
  return { place: { lane, forced: options.shift } };
}

/** Record the note a press produced, so its release can find it again. */
export function registerHeld(
  state: LiveEntryState,
  key: string,
  note: HeldNote,
): void {
  state.held.set(key.toLowerCase(), note);
}

export interface ReleaseResult {
  note: HeldNote | null;
  /**
   * Sustain length in ticks, already floored at zero. Zero means "a tap" — the note is
   * left as a plain hit rather than given a stub sustain nobody asked for.
   */
  length: number;
}

/**
 * Handle a key coming up.
 *
 * `minSustainTicks` is the threshold below which a hold counts as a tap. Without it every
 * note would come out as a sustain a few ticks long, because no human releases a key
 * instantly — and the export would be littered with stubs too short to register in game.
 */
export function releaseKey(
  state: LiveEntryState,
  key: string,
  endTick: number,
  minSustainTicks: number,
): ReleaseResult {
  const lower = key.toLowerCase();
  const note = state.held.get(lower) ?? null;
  if (!note) return { note: null, length: 0 };
  state.held.delete(lower);

  const raw = Math.max(0, Math.round(endTick) - note.startTick);
  return { note, length: raw >= minSustainTicks ? raw : 0 };
}

/** Everything still held — used when playback stops with keys down. */
export function releaseAll(state: LiveEntryState): HeldNote[] {
  const notes = [...state.held.values()];
  state.held.clear();
  return notes;
}

export function isHolding(state: LiveEntryState): boolean {
  return state.held.size > 0;
}

/** Label for the on-screen legend, in fret order. */
export const ENTRY_LEGEND: Array<{ key: string; label: string; lane: Lane }> = [
  { key: 'A', label: 'Green', lane: 0 },
  { key: 'S', label: 'Red', lane: 1 },
  { key: 'D', label: 'Yellow', lane: 2 },
  { key: 'F', label: 'Blue', lane: 3 },
  { key: 'G', label: 'Orange', lane: 4 },
  { key: 'Space', label: 'Open', lane: 7 },
];
