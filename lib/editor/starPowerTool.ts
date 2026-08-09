/**
 * The two-click star power tool.
 *
 * Star power used to be "select some notes, press the button", which meant a phrase
 * could only ever cover notes that already existed and you had to marquee them first.
 * In game a phrase is a REGION of the song, not a set of notes — so it is defined here
 * the way it behaves: click where it starts, click where it ends.
 *
 * The state machine is kept out of the component so the awkward cases (a second click
 * on the same tick, clicking end before start) can be tested directly.
 */

export interface StarPowerToolState {
  active: boolean;
  /** Tick of the first click; null while waiting for it. */
  startTick: number | null;
}

export const STAR_POWER_TOOL_OFF: StarPowerToolState = { active: false, startTick: null };
export const STAR_POWER_TOOL_ARMED: StarPowerToolState = { active: true, startTick: null };

export type StarPowerClickResult =
  /** First click landed; the tool now waits for the end point. */
  | { kind: 'start'; state: StarPowerToolState }
  /** Both points landed on the same tick — nothing is created and the tool disarms. */
  | { kind: 'cancelled'; state: StarPowerToolState }
  /** A phrase to dispatch. The tool disarms itself; arm it again for another. */
  | { kind: 'phrase'; tick: number; length: number; state: StarPowerToolState };

/**
 * Advance the tool by one click on the highway.
 *
 * `tick` is already snapped by the caller, so a start and an end that visually coincide
 * really are equal here, and a zero-length phrase — which would not register in game —
 * is rejected rather than written.
 */
export function starPowerClick(
  state: StarPowerToolState,
  tick: number,
): StarPowerClickResult {
  const clicked = Math.max(0, Math.round(tick));

  if (state.startTick === null) {
    return { kind: 'start', state: { active: true, startTick: clicked } };
  }

  if (clicked === state.startTick) {
    return { kind: 'cancelled', state: STAR_POWER_TOOL_OFF };
  }

  // Working backwards through a song is normal, so an end before the start is
  // normalised rather than refused.
  return {
    kind: 'phrase',
    tick: Math.min(state.startTick, clicked),
    length: Math.abs(clicked - state.startTick),
    state: STAR_POWER_TOOL_OFF,
  };
}

/** What the toolbar should say about the tool's current step. */
export function starPowerHint(state: StarPowerToolState): string | null {
  if (!state.active) return null;
  return state.startTick === null
    ? 'Click the start of the phrase on the highway'
    : 'Click the end of the phrase — Esc to cancel';
}
