import { describe, expect, it } from 'vitest';
import { assignLanesByContour, assignLanesByPitch, groupByTick } from './pitchToLanes';

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

describe('assignLanesByPitch', () => {
  const OPEN = 7;

  /** A run of distinct ascending pitches, one per tick. */
  function scale(pitches: number[]) {
    return groupByTick(pitches.map((pitch, i) => ({ tick: i * R, pitch, durationTicks: 0 })));
  }

  it('puts low pitches on green and high pitches on orange', () => {
    const pitches = [40, 44, 48, 52, 56];
    const lanes = assignLanesByPitch(scale(pitches), {
      ...OPTS,
      useOpenNotes: false,
      split: 'even',
    }).map((r) => r.lanes[0]);
    expect(lanes[0]).toBe(0); // lowest -> green
    expect(lanes[lanes.length - 1]).toBe(4); // highest -> orange
  });

  it('never puts a higher pitch on a lower fret', () => {
    // The invariant the whole mapping rests on: it is monotonic in pitch.
    const pitches = Array.from({ length: 40 }, (_, i) => 30 + i);
    for (const split of ['even', 'balanced', 'distinct'] as const) {
      const lanes = assignLanesByPitch(scale(pitches), { ...OPTS, split, useOpenNotes: false }).map(
        (r) => r.lanes[0],
      );
      for (let i = 1; i < lanes.length; i += 1) {
        expect(lanes[i]).toBeGreaterThanOrEqual(lanes[i - 1]);
      }
    }
  });

  it('gives the same pitch the same fret everywhere in the song', () => {
    const result = assignLanesByPitch(scale([40, 60, 40, 80, 40]), {
      ...OPTS,
      useOpenNotes: false,
    });
    const lanesFor40 = [result[0].lanes[0], result[2].lanes[0], result[4].lanes[0]];
    expect(new Set(lanesFor40).size).toBe(1);
  });

  it('inverts so the highest pitches take green', () => {
    const lanes = assignLanesByPitch(scale([40, 44, 48, 52, 56]), {
      ...OPTS,
      useOpenNotes: false,
      split: 'even',
      invert: true,
    }).map((r) => r.lanes[0]);
    expect(lanes[0]).toBe(4);
    expect(lanes[lanes.length - 1]).toBe(0);
  });

  it('reserves the lowest band for open notes when asked', () => {
    const lanes = assignLanesByPitch(scale([30, 40, 50, 60, 70, 80]), {
      ...OPTS,
      useOpenNotes: true,
      split: 'even',
    }).map((r) => r.lanes[0]);
    expect(lanes[0]).toBe(OPEN);
    expect(lanes.slice(1).every((lane) => lane !== OPEN)).toBe(true);
  });

  it('uses no open notes when they are switched off', () => {
    const lanes = assignLanesByPitch(scale([30, 40, 50, 60, 70, 80]), {
      ...OPTS,
      useOpenNotes: false,
    }).flatMap((r) => r.lanes);
    expect(lanes).not.toContain(OPEN);
  });

  it('maps every note of a chord by its own pitch', () => {
    const groups = groupByTick([
      { tick: 0, pitch: 40, durationTicks: 0 },
      { tick: 0, pitch: 80, durationTicks: 0 },
      { tick: R, pitch: 40, durationTicks: 0 },
      { tick: R, pitch: 80, durationTicks: 0 },
    ]);
    const [chord] = assignLanesByPitch(groups, { ...OPTS, useOpenNotes: false, split: 'even' });
    expect(chord.lanes).toHaveLength(2);
    // The chord spans the fretboard because the pitches span the range.
    expect(chord.lanes[0]).toBe(0);
    expect(chord.lanes[1]).toBe(4);
  });

  it('drops the open note when a chord spans the open boundary', () => {
    // Clone Hero cannot play an open note together with frets, so the frets win.
    const groups = groupByTick([
      { tick: 0, pitch: 30, durationTicks: 0 }, // would be open
      { tick: 0, pitch: 80, durationTicks: 0 }, // a fret
      { tick: R, pitch: 55, durationTicks: 0 },
    ]);
    const [chord] = assignLanesByPitch(groups, { ...OPTS, useOpenNotes: true, split: 'even' });
    expect(chord.lanes).not.toContain(OPEN);
    expect(chord.lanes.length).toBeGreaterThan(0);
  });

  it('caps chord size, keeping the outer notes that define its span', () => {
    const groups = groupByTick(
      [30, 45, 55, 65, 80].map((pitch) => ({ tick: 0, pitch, durationTicks: 0 })),
    );
    const [chord] = assignLanesByPitch(groups, {
      ...OPTS,
      useOpenNotes: false,
      split: 'even',
      maxChordSize: 3,
    });
    expect(chord.lanes).toHaveLength(3);
    expect(chord.lanes[0]).toBe(0);
    expect(chord.lanes[chord.lanes.length - 1]).toBe(4);
  });

  it('leaves no fret unused when one pitch dominates the part', () => {
    // A riff camped on its root crosses several fixed band targets at once, which used
    // to collapse those bands and leave whole frets empty.
    const notes: Array<{ tick: number; pitch: number; durationTicks: number }> = [];
    let tick = 0;
    for (let i = 0; i < 200; i += 1) notes.push({ tick: (tick += R), pitch: 40, durationTicks: 0 });
    for (const pitch of [42, 45, 47, 50, 52]) {
      for (let i = 0; i < 10; i += 1) notes.push({ tick: (tick += R), pitch, durationTicks: 0 });
    }
    const lanes = new Set(
      assignLanesByPitch(groupByTick(notes), {
        ...OPTS,
        useOpenNotes: false,
        split: 'balanced',
      }).flatMap((r) => r.lanes),
    );
    expect(lanes.size).toBe(5);
  });

  it('handles a part with only one pitch', () => {
    const result = assignLanesByPitch(scale([40, 40, 40]), { ...OPTS, useOpenNotes: false });
    expect(result).toHaveLength(3);
    expect(new Set(result.flatMap((r) => r.lanes)).size).toBe(1);
  });

  it('handles an empty input', () => {
    expect(assignLanesByPitch([], OPTS)).toEqual([]);
  });
});

describe('local pitch mapping', () => {
  it('uses the whole fretboard in each section, not just the loudest one', () => {
    // Two sections in different registers. A global mapping lets the first decide the
    // bands for the whole song, so the second collapses onto a couple of frets.
    const notes: Array<{ tick: number; pitch: number; durationTicks: number }> = [];
    let tick = 0;
    for (let i = 0; i < 60; i += 1) {
      notes.push({ tick: (tick += R), pitch: 40 + (i % 4), durationTicks: 0 });
    }
    for (let i = 0; i < 60; i += 1) {
      notes.push({ tick: (tick += R), pitch: 70 + (i % 4), durationTicks: 0 });
    }
    const groups = groupByTick(notes);

    const lanesIn = (result: ReturnType<typeof assignLanesByPitch>, from: number, to: number) =>
      new Set(result.slice(from, to).flatMap((r) => r.lanes));

    const global = assignLanesByPitch(groups, { ...OPTS, split: 'balanced', useOpenNotes: false });
    const local = assignLanesByPitch(groups, { ...OPTS, split: 'local', useOpenNotes: false });

    // The second section is where a global mapping runs out of frets.
    expect(lanesIn(local, 60, 120).size).toBeGreaterThan(lanesIn(global, 60, 120).size);
  });

  it('still puts higher pitches on higher frets within a phrase', () => {
    const groups = groupByTick(
      [40, 45, 50, 55, 60].map((pitch, i) => ({ tick: i * R, pitch, durationTicks: 0 })),
    );
    const lanes = assignLanesByPitch(groups, {
      ...OPTS,
      split: 'local',
      useOpenNotes: false,
    }).map((r) => r.lanes[0]);
    for (let i = 1; i < lanes.length; i += 1) {
      expect(lanes[i]).toBeGreaterThanOrEqual(lanes[i - 1]);
    }
  });

  it('places an isolated note mid-fretboard rather than at an edge', () => {
    const lanes = assignLanesByPitch(groupByTick([{ tick: 0, pitch: 60, durationTicks: 0 }]), {
      ...OPTS,
      split: 'local',
      useOpenNotes: false,
    }).map((r) => r.lanes[0]);
    expect(lanes[0]).toBeGreaterThan(0);
    expect(lanes[0]).toBeLessThan(4);
  });
});
