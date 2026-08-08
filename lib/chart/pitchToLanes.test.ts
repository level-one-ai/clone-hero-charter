import { describe, expect, it } from 'vitest';
import { assignLanesByContour, groupByTick } from './pitchToLanes';

const R = 192;
const OPTS = { sustainCutoff: R, maxChordSize: 2 };

function line(pitches: number[], spacing = R): ReturnType<typeof groupByTick> {
  return groupByTick(
    pitches.map((pitch, i) => ({ tick: i * spacing, pitch, durationTicks: 0 })),
  );
}

describe('assignLanesByContour', () => {
  it('starts mid-neck so the first move has room either way', () => {
    const result = assignLanesByContour(line([60]), OPTS);
    expect(result[0].lanes).toEqual([2]);
  });

  it('keeps a repeated pitch on the same fret', () => {
    const result = assignLanesByContour(line([60, 60, 60]), OPTS);
    expect(result.map((r) => r.lanes[0])).toEqual([2, 2, 2]);
  });

  it('moves up the neck as the melody rises and down as it falls', () => {
    const rising = assignLanesByContour(line([60, 62, 64]), OPTS).map((r) => r.lanes[0]);
    expect(rising[1]).toBeGreaterThan(rising[0]);
    expect(rising[2]).toBeGreaterThan(rising[1]);

    const falling = assignLanesByContour(line([64, 62, 60]), OPTS).map((r) => r.lanes[0]);
    expect(falling[1]).toBeLessThan(falling[0]);
    expect(falling[2]).toBeLessThan(falling[1]);
  });

  it('moves further for a bigger interval', () => {
    const step = assignLanesByContour(line([60, 61]), OPTS).map((r) => r.lanes[0]);
    const leap = assignLanesByContour(line([60, 72]), OPTS).map((r) => r.lanes[0]);
    expect(leap[1] - leap[0]).toBeGreaterThan(step[1] - step[0]);
  });

  it('always changes fret when the pitch changes', () => {
    // Otherwise the player strums one fret repeatedly for what is audibly a different
    // note — the specific failure that made long runs unplayable.
    const pitches = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79];
    const lanes = assignLanesByContour(line(pitches), OPTS).map((r) => r.lanes[0]);
    for (let i = 1; i < lanes.length; i += 1) {
      expect(lanes[i]).not.toBe(lanes[i - 1]);
    }
  });

  it('stays within the five frets however far the melody travels', () => {
    const pitches = Array.from({ length: 60 }, (_, i) => 40 + i * 3);
    for (const { lanes } of assignLanesByContour(line(pitches), OPTS)) {
      for (const lane of lanes) {
        expect(lane).toBeGreaterThanOrEqual(0);
        expect(lane).toBeLessThanOrEqual(4);
      }
    }
  });

  it('reaches the outer frets on a long rise rather than turning back early', () => {
    const lanes = assignLanesByContour(
      line([50, 55, 60, 65, 70, 75, 80]),
      OPTS,
    ).flatMap((r) => r.lanes);
    expect(lanes).toContain(4);
  });

  it('maps simultaneous notes to a chord on adjacent frets', () => {
    const groups = groupByTick([
      { tick: 0, pitch: 60, durationTicks: 0 },
      { tick: 0, pitch: 64, durationTicks: 0 },
    ]);
    const result = assignLanesByContour(groups, OPTS);
    expect(result).toHaveLength(1);
    expect(result[0].lanes).toHaveLength(2);
    expect(Math.abs(result[0].lanes[1] - result[0].lanes[0])).toBe(1);
  });

  it('caps chord size so a dense transcription stays playable', () => {
    const groups = groupByTick(
      [60, 64, 67, 71, 74].map((pitch) => ({ tick: 0, pitch, durationTicks: 0 })),
    );
    expect(assignLanesByContour(groups, { ...OPTS, maxChordSize: 2 })[0].lanes).toHaveLength(2);
  });

  it('only sustains notes at or beyond the cutoff', () => {
    const groups = groupByTick([
      { tick: 0, pitch: 60, durationTicks: 96 }, // an eighth — the rhythm, not a hold
      { tick: 960, pitch: 62, durationTicks: 384 }, // genuinely held
    ]);
    const result = assignLanesByContour(groups, OPTS);
    expect(result[0].length).toBe(0);
    expect(result[1].length).toBe(384);
  });

  it('trims a sustain so it never reaches the next note', () => {
    const groups = groupByTick([
      { tick: 0, pitch: 60, durationTicks: 1000 }, // overruns the next note
      { tick: 384, pitch: 62, durationTicks: 0 },
    ]);
    const [first] = assignLanesByContour(groups, { ...OPTS, minSustainGap: 24 });
    expect(first.length).toBeLessThanOrEqual(384 - 24);
  });

  it('drops a sustain that trimming reduces below the cutoff', () => {
    const groups = groupByTick([
      { tick: 0, pitch: 60, durationTicks: 1000 },
      { tick: 100, pitch: 62, durationTicks: 0 }, // leaves no room for a real sustain
    ]);
    expect(assignLanesByContour(groups, OPTS)[0].length).toBe(0);
  });

  it('handles an empty input', () => {
    expect(assignLanesByContour([], OPTS)).toEqual([]);
  });
});

describe('groupByTick', () => {
  it('collapses notes sharing a tick and keeps the longest duration', () => {
    const groups = groupByTick([
      { tick: 0, pitch: 60, durationTicks: 100 },
      { tick: 0, pitch: 64, durationTicks: 300 },
      { tick: 480, pitch: 67, durationTicks: 50 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].pitches.sort()).toEqual([60, 64]);
    expect(groups[0].durationTicks).toBe(300);
  });

  it('returns groups in tick order regardless of input order', () => {
    const groups = groupByTick([
      { tick: 960, pitch: 60, durationTicks: 0 },
      { tick: 0, pitch: 62, durationTicks: 0 },
    ]);
    expect(groups.map((g) => g.tick)).toEqual([0, 960]);
  });
});
