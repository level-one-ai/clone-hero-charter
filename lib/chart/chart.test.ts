import { describe, expect, it } from 'vitest';
import { TimingMap } from './timing';
import { parseChart } from './parseChart';
import { writeChart } from './writeChart';
import { snapTick, ticksPerDivision } from './snap';
import { DEFAULT_RESOLUTION } from './types';

const R = DEFAULT_RESOLUTION; // 192

describe('TimingMap', () => {
  it('converts ticks to seconds at a constant tempo', () => {
    const t = new TimingMap([{ tick: 0, bpm: 120 }], R);
    // At 120 BPM a quarter note is 0.5s, and a quarter note is `R` ticks.
    expect(t.tickToSec(0)).toBeCloseTo(0, 9);
    expect(t.tickToSec(R)).toBeCloseTo(0.5, 9);
    expect(t.tickToSec(R * 4)).toBeCloseTo(2, 9);
  });

  it('is exactly invertible across multiple tempo changes', () => {
    const t = new TimingMap(
      [
        { tick: 0, bpm: 120 },
        { tick: R * 8, bpm: 90 },
        { tick: R * 20, bpm: 174.5 },
        { tick: R * 33, bpm: 60 },
      ],
      R,
    );
    for (const tick of [0, 1, 191, R * 8, R * 8 + 5, R * 19, R * 20, R * 25, R * 33, R * 100]) {
      expect(t.secToTick(t.tickToSec(tick))).toBeCloseTo(tick, 6);
    }
  });

  it('accumulates time correctly across a tempo change', () => {
    const t = new TimingMap(
      [
        { tick: 0, bpm: 120 }, // 8 quarter notes at 0.5s = 4s
        { tick: R * 8, bpm: 60 }, // then 1s per quarter note
      ],
      R,
    );
    expect(t.tickToSec(R * 8)).toBeCloseTo(4, 9);
    expect(t.tickToSec(R * 10)).toBeCloseTo(6, 9);
  });

  it('repairs a BPM map with no tick-0 anchor', () => {
    const t = new TimingMap([{ tick: R * 4, bpm: 100 }], R);
    expect(t.segments[0].tick).toBe(0);
    expect(t.bpmAt(0)).toBe(100);
  });

  it('derives beat and measure spans from the time signature', () => {
    const t = new TimingMap([{ tick: 0, bpm: 120 }], R, [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: R * 8, numerator: 6, denominator: 8 },
    ]);
    expect(t.ticksPerBeatAt(0)).toBe(R);
    expect(t.ticksPerMeasureAt(0)).toBe(R * 4);
    // 6/8: an eighth-note beat is R/2 ticks, six of them per measure.
    expect(t.ticksPerBeatAt(R * 8)).toBe(R / 2);
    expect(t.ticksPerMeasureAt(R * 8)).toBe(R * 3);
  });

  it('emits measure lines on barlines and beat lines between them', () => {
    const t = new TimingMap([{ tick: 0, bpm: 120 }], R, [{ tick: 0, numerator: 4, denominator: 4 }]);
    const lines = t.gridLines(0, R * 8);
    const measures = lines.filter((l) => l.kind === 'measure').map((l) => l.tick);
    expect(measures).toEqual([0, R * 4, R * 8]);
    expect(lines.filter((l) => l.kind === 'beat').length).toBe(6);
  });
});

describe('snap', () => {
  it('computes tick spans for binary and triplet divisions', () => {
    // 192 = 2^6 * 3, so both binary and ternary divisions land on whole ticks.
    expect(ticksPerDivision(R, 4)).toBe(192);
    expect(ticksPerDivision(R, 8)).toBe(96);
    expect(ticksPerDivision(R, 16)).toBe(48);
    expect(ticksPerDivision(R, 12)).toBe(64);
    expect(ticksPerDivision(R, 24)).toBe(32);
  });

  it('snaps to the nearest gridline', () => {
    expect(snapTick(100, R, 4)).toBe(192); // past the halfway point, rounds up
    expect(snapTick(95, R, 4)).toBe(0); // short of it, rounds back down to 0
    expect(snapTick(50, R, 16)).toBe(48);
    expect(snapTick(70, R, 12)).toBe(64);
    expect(snapTick(-40, R, 16)).toBe(0); // never negative
  });

  it('passes ticks through unchanged when snapping is off', () => {
    expect(snapTick(12345.6, R, 0)).toBe(12346);
  });
});

const SAMPLE_CHART = `[Song]
{
  Name = "Test Song"
  Artist = "Test Artist"
  Album = "Test Album"
  Year = ", 2024"
  Charter = "dean"
  Offset = 0
  Resolution = 192
  Genre = "Rock"
  MediaType = "cd"
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
  1536 = B 90500
  3072 = TS 6 3
}
[Events]
{
  0 = E "section Intro"
}
[ExpertSingle]
{
  768 = N 0 0
  768 = N 1 0
  768 = N 5 0
  960 = N 2 192
  1152 = N 7 0
  1344 = N 3 0
  1344 = N 6 0
  1536 = S 2 768
}
[HardSingle]
{
  768 = N 0 0
}
`;

describe('parseChart', () => {
  it('reads metadata, stripping quotes and the Year comma', () => {
    const { project } = parseChart(SAMPLE_CHART, 'test-id');
    expect(project.meta.name).toBe('Test Song');
    expect(project.meta.artist).toBe('Test Artist');
    expect(project.meta.year).toBe(2024);
    expect(project.meta.charter).toBe('dean');
    expect(project.resolution).toBe(192);
  });

  it('reads the sync track, dividing BPM by 1000 and expanding the TS exponent', () => {
    const { project } = parseChart(SAMPLE_CHART, 'test-id');
    expect(project.sync.bpms).toEqual([
      { tick: 0, bpm: 120 },
      { tick: 1536, bpm: 90.5 },
    ]);
    expect(project.sync.timeSignatures).toEqual([
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 3072, numerator: 6, denominator: 8 }, // exponent 3 -> /8
    ]);
  });

  it('folds N 5 / N 6 flag lines into the notes at their tick', () => {
    const { project } = parseChart(SAMPLE_CHART, 'test-id');
    const notes = project.tracks.ExpertSingle.notes;

    const chord = notes.filter((n) => n.tick === 768);
    expect(chord).toHaveLength(2); // the N 5 line is a flag, not a third note
    expect(chord.every((n) => n.forced)).toBe(true);
    expect(chord.every((n) => n.tap)).toBe(false);

    const tapped = notes.find((n) => n.tick === 1344)!;
    expect(tapped.tap).toBe(true);
    expect(tapped.forced).toBe(false);
  });

  it('keeps sustains, open notes and star power', () => {
    const { project } = parseChart(SAMPLE_CHART, 'test-id');
    const notes = project.tracks.ExpertSingle.notes;
    expect(notes.find((n) => n.tick === 960)!.length).toBe(192);
    expect(notes.find((n) => n.tick === 1152)!.lane).toBe(7);
    expect(project.tracks.ExpertSingle.starPower).toEqual([{ tick: 1536, length: 768 }]);
  });

  it('keeps difficulties independent', () => {
    const { project } = parseChart(SAMPLE_CHART, 'test-id');
    expect(project.tracks.ExpertSingle.notes.length).toBe(5);
    expect(project.tracks.HardSingle.notes.length).toBe(1);
    expect(project.tracks.MediumSingle.notes.length).toBe(0);
  });

  it('survives a chart with no sync track', () => {
    const { project, warnings } = parseChart('[Song]\n{\nName = "x"\n}\n', 'id');
    expect(project.sync.bpms).toEqual([{ tick: 0, bpm: 120 }]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('writeChart round trip', () => {
  it('reparses to an identical model', () => {
    const first = parseChart(SAMPLE_CHART, 'id').project;
    const text = writeChart(first);
    const second = parseChart(text, 'id').project;

    expect(second.meta).toEqual(first.meta);
    expect(second.resolution).toBe(first.resolution);
    expect(second.sync).toEqual(first.sync);
    expect(second.events).toEqual(first.events);

    // Note ids are regenerated on each parse, so compare on content only.
    const strip = (p: typeof first, track: 'ExpertSingle' | 'HardSingle') =>
      p.tracks[track].notes.map(({ id, ...rest }) => rest);
    expect(strip(second, 'ExpertSingle')).toEqual(strip(first, 'ExpertSingle'));
    expect(strip(second, 'HardSingle')).toEqual(strip(first, 'HardSingle'));
    expect(second.tracks.ExpertSingle.starPower).toEqual(first.tracks.ExpertSingle.starPower);
  });

  it('is stable across a second serialization', () => {
    const project = parseChart(SAMPLE_CHART, 'id').project;
    const once = writeChart(project);
    const twice = writeChart(parseChart(once, 'id').project);
    expect(twice).toBe(once);
  });

  it('emits one flag line per tick, not one per note in a chord', () => {
    const project = parseChart(SAMPLE_CHART, 'id').project;
    const text = writeChart(project);
    const forcedLines = text.split('\r\n').filter((l) => l.trim() === '768 = N 5 0');
    expect(forcedLines).toHaveLength(1);
  });

  it('omits the TS denominator exponent for 4/4 and writes it otherwise', () => {
    const project = parseChart(SAMPLE_CHART, 'id').project;
    const text = writeChart(project);
    expect(text).toContain('0 = TS 4\r\n');
    expect(text).toContain('3072 = TS 6 3');
  });

  it('skips difficulty sections that have no notes', () => {
    const project = parseChart(SAMPLE_CHART, 'id').project;
    const text = writeChart(project);
    expect(text).toContain('[ExpertSingle]');
    expect(text).not.toContain('[MediumSingle]');
  });
});
