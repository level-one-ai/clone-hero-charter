import { describe, expect, it } from 'vitest';
import {
  STAR_POWER_TOOL_ARMED,
  starPowerClick,
  starPowerHint,
  type StarPowerToolState,
} from './starPowerTool';

/** Walk the tool through a sequence of clicks and return the last result. */
function clicks(...ticks: number[]) {
  let state: StarPowerToolState = STAR_POWER_TOOL_ARMED;
  let last = starPowerClick(state, ticks[0]);
  state = last.state;
  for (const tick of ticks.slice(1)) {
    last = starPowerClick(state, tick);
    state = last.state;
  }
  return last;
}

describe('starPowerClick', () => {
  it('records the start on the first click and stays armed', () => {
    const result = starPowerClick(STAR_POWER_TOOL_ARMED, 768);
    expect(result.kind).toBe('start');
    expect(result.state).toEqual({ active: true, startTick: 768 });
  });

  it('creates a phrase on the second click and disarms itself', () => {
    const result = clicks(768, 1536);
    expect(result).toMatchObject({ kind: 'phrase', tick: 768, length: 768 });
    expect(result.state.active).toBe(false);
  });

  it('creates nothing when both clicks land on the same tick', () => {
    const result = clicks(768, 768);
    expect(result.kind).toBe('cancelled');
    expect(result.state.active).toBe(false);
  });

  it('treats end-before-start the same as start-before-end', () => {
    const forwards = clicks(768, 1536);
    const backwards = clicks(1536, 768);
    expect(backwards).toMatchObject({ kind: 'phrase', tick: 768, length: 768 });
    expect(backwards.kind === 'phrase' && forwards.kind === 'phrase').toBe(true);
    if (forwards.kind === 'phrase' && backwards.kind === 'phrase') {
      expect(backwards.tick).toBe(forwards.tick);
      expect(backwards.length).toBe(forwards.length);
    }
  });

  it('never produces a negative start tick', () => {
    const result = starPowerClick(STAR_POWER_TOOL_ARMED, -50);
    expect(result.state.startTick).toBe(0);
  });
});

describe('starPowerHint', () => {
  it('says nothing while the tool is off', () => {
    expect(starPowerHint({ active: false, startTick: null })).toBeNull();
  });

  it('changes between the two clicks', () => {
    const first = starPowerHint(STAR_POWER_TOOL_ARMED);
    const second = starPowerHint({ active: true, startTick: 100 });
    expect(first).toMatch(/start/i);
    expect(second).toMatch(/end/i);
  });
});
