import { describe, expect, it } from 'vitest';
import { currentTime, type PlaybackClock } from './useHighwayRenderer';

/**
 * Regression tests for the sync bug.
 *
 * The highway interpolates between the audio element's readings, which arrive roughly
 * four times a second. Interpolating at 1× while the audio plays at 0.5× ran the chart
 * at twice the music's speed for up to 250ms before snapping back — the editor "lagging"
 * and losing sync. These pin the arithmetic.
 */

function clock(overrides: Partial<PlaybackClock> = {}): PlaybackClock {
  return {
    audioTime: 10,
    wallClock: 1000,
    playing: true,
    rate: 1,
    preRoll: false,
    ...overrides,
  };
}

describe('currentTime', () => {
  it('returns the reading unchanged while paused', () => {
    // A paused clock must not creep, however long ago the reading was taken.
    expect(currentTime(clock({ playing: false }), 999_999)).toBe(10);
  });

  it('advances in real time at 1x', () => {
    expect(currentTime(clock(), 1250)).toBeCloseTo(10.25, 6);
  });

  it('advances at half speed at 0.5x — the bug', () => {
    // 250ms of wall time is 125ms of song at half speed. The old code returned 10.25
    // here, putting the highway an eighth of a second ahead of the music.
    expect(currentTime(clock({ rate: 0.5 }), 1250)).toBeCloseTo(10.125, 6);
  });

  it('handles every speed the transport offers', () => {
    for (const rate of [0.25, 0.5, 0.75, 1]) {
      expect(currentTime(clock({ rate }), 2000)).toBeCloseTo(10 + rate, 6);
    }
  });

  it('never runs ahead of the music over a long stretch between readings', () => {
    // A full second without a reading at quarter speed: a quarter second of song.
    expect(currentTime(clock({ rate: 0.25 }), 2000)).toBeCloseTo(10.25, 6);
  });

  it('re-anchors exactly to a fresh reading', () => {
    // What a seek does: audioTime and wallClock are rewritten together, so the very
    // next frame reads the seeked position rather than drifting from the old one.
    const seeked = clock({ audioTime: 42, wallClock: 5000, rate: 0.5 });
    expect(currentTime(seeked, 5000)).toBe(42);
  });

  it('counts pre-roll in chart seconds like any other playback', () => {
    // During the lead-in there is no audio, but the clock is still chart time and still
    // scaled by the rate, so the highway scrolls at the speed the transport says.
    const rolling = clock({ audioTime: 0, wallClock: 0, preRoll: true, rate: 0.5 });
    expect(currentTime(rolling, 1000)).toBeCloseTo(0.5, 6);
  });
});
