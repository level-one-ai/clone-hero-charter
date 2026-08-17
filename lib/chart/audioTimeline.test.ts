import { describe, expect, it } from 'vitest';
import {
  buildAudioTimeline,
  exportDurationMs,
  leadInSeconds,
  leadInTicks,
  normalizeLeadIn,
  resolveRegion,
} from './audioTimeline';
import { TimingMap } from './timing';
import { createEmptyProject, DEFAULT_RESOLUTION, MIN_LEAD_IN_BARS } from './types';

function timingAt(bpm: number, numerator = 4, denominator = 4): TimingMap {
  return new TimingMap([{ tick: 0, bpm }], DEFAULT_RESOLUTION, [
    { tick: 0, numerator, denominator },
  ]);
}

describe('normalizeLeadIn', () => {
  it('enforces the two-bar minimum', () => {
    expect(normalizeLeadIn({ bars: 0, beats: 0 })).toEqual({ bars: MIN_LEAD_IN_BARS, beats: 0 });
    expect(normalizeLeadIn({ bars: 1, beats: 3 })).toEqual({ bars: MIN_LEAD_IN_BARS, beats: 0 });
  });

  it('keeps anything at or above the minimum', () => {
    expect(normalizeLeadIn({ bars: 2, beats: 0 })).toEqual({ bars: 2, beats: 0 });
    expect(normalizeLeadIn({ bars: 4, beats: 2 })).toEqual({ bars: 4, beats: 2 });
  });

  it('carries overflowing beats into bars', () => {
    expect(normalizeLeadIn({ bars: 2, beats: 6 }, 4)).toEqual({ bars: 3, beats: 2 });
    // A 3/4 bar holds three beats, so the carry has to follow the metre.
    expect(normalizeLeadIn({ bars: 2, beats: 4 }, 3)).toEqual({ bars: 3, beats: 1 });
  });

  it('repairs junk rather than propagating it', () => {
    expect(normalizeLeadIn(null)).toEqual({ bars: MIN_LEAD_IN_BARS, beats: 0 });
    expect(normalizeLeadIn({ bars: Number.NaN, beats: -5 })).toEqual({
      bars: MIN_LEAD_IN_BARS,
      beats: 0,
    });
  });
});

describe('leadInTicks', () => {
  it('is whole bars of the time signature at tick 0', () => {
    // 4/4 at 192 ticks per quarter: one bar is 768 ticks.
    expect(leadInTicks({ bars: 2, beats: 0 }, timingAt(120))).toBe(1536);
    expect(leadInTicks({ bars: 2, beats: 2 }, timingAt(120))).toBe(1536 + 384);
  });

  it('follows the metre, not a fixed bar length', () => {
    // 3/4: a bar is three quarters, 576 ticks.
    expect(leadInTicks({ bars: 2, beats: 0 }, timingAt(120, 3, 4))).toBe(1152);
    // 6/8: a beat is an eighth (96 ticks), six to a bar.
    expect(leadInTicks({ bars: 2, beats: 0 }, timingAt(120, 6, 8))).toBe(1152);
  });

  it('lands the music on a downbeat whatever the tempo', () => {
    // This is the property the whole design exists for: the lead-in is a whole number of
    // bars, so the first beat of the song is beat one of a bar at any tempo.
    for (const bpm of [77, 120, 138.5, 200]) {
      const timing = timingAt(bpm);
      const ticks = leadInTicks({ bars: 2, beats: 0 }, timing);
      expect(ticks % timing.ticksPerMeasureAt(0)).toBe(0);
    }
  });
});

describe('leadInSeconds', () => {
  it('shortens as the tempo rises', () => {
    // Two 4/4 bars is eight beats: 4s at 120, 2s at 240.
    expect(leadInSeconds({ bars: 2, beats: 0 }, timingAt(120))).toBeCloseTo(4, 6);
    expect(leadInSeconds({ bars: 2, beats: 0 }, timingAt(240))).toBeCloseTo(2, 6);
  });
});

describe('resolveRegion', () => {
  it('is the whole file when no region is set', () => {
    expect(resolveRegion({ file: 'a.wav', durationMs: 5000, sampleRate: null, region: null })).toEqual(
      { startMs: 0, endMs: 5000 },
    );
  });

  it('clamps a region that runs past the file', () => {
    expect(
      resolveRegion({
        file: 'a.wav',
        durationMs: 5000,
        sampleRate: null,
        region: { startMs: 1000, endMs: 9000 },
      }),
    ).toEqual({ startMs: 1000, endMs: 5000 });
  });

  it('treats an inverted region as running to the end of the file', () => {
    // Better than an empty region, which would export a zero-length song.
    expect(
      resolveRegion({
        file: 'a.wav',
        durationMs: 5000,
        sampleRate: null,
        region: { startMs: 3000, endMs: 1000 },
      }),
    ).toEqual({ startMs: 3000, endMs: 5000 });
  });
});

describe('buildAudioTimeline', () => {
  function projectWith(region: { startMs: number; endMs: number } | null) {
    const project = createEmptyProject('t1');
    project.audio = { file: 'a.wav', durationMs: 300_000, sampleRate: 44100, region, detected: null };
    project.meta.trailingSilenceMs = 2000;
    return project;
  }

  it('puts the region start at the end of the lead-in', () => {
    const project = projectWith({ startMs: 60_000, endMs: 90_000 });
    const timeline = buildAudioTimeline(project, timingAt(120));

    // Chart time 4s (two bars at 120) is the first sample of the region.
    expect(timeline.leadInSec).toBeCloseTo(4, 6);
    expect(timeline.chartToAudio(4)).toBeCloseTo(60, 6);
    expect(timeline.audioToChart(60)).toBeCloseTo(4, 6);
  });

  it('round-trips any position', () => {
    const timeline = buildAudioTimeline(projectWith({ startMs: 60_000, endMs: 90_000 }), timingAt(137));
    for (const chartSec of [0, 1.5, 4, 12.25, 99]) {
      expect(timeline.audioToChart(timeline.chartToAudio(chartSec))).toBeCloseTo(chartSec, 9);
    }
  });

  it('totals lead-in, region and tail', () => {
    const timeline = buildAudioTimeline(projectWith({ startMs: 60_000, endMs: 90_000 }), timingAt(120));
    expect(timeline.regionSec).toBeCloseTo(30, 6);
    expect(timeline.totalSec).toBeCloseTo(4 + 30 + 2, 6);
    expect(timeline.trimmed).toBe(true);
  });

  it('covers the whole file when there is no region', () => {
    const timeline = buildAudioTimeline(projectWith(null), timingAt(120));
    expect(timeline.trimmed).toBe(false);
    expect(timeline.regionStartSec).toBe(0);
    // Chart time still starts behind the lead-in, region or not.
    expect(timeline.chartToAudio(4)).toBeCloseTo(0, 6);
  });

  it('follows the tempo: a faster anchor means less silence and an earlier handover', () => {
    const project = projectWith({ startMs: 10_000, endMs: 20_000 });
    const slow = buildAudioTimeline(project, timingAt(60));
    const fast = buildAudioTimeline(project, timingAt(240));
    expect(slow.leadInSec).toBeCloseTo(8, 6);
    expect(fast.leadInSec).toBeCloseTo(2, 6);
    // Both still hand over at exactly the region start.
    expect(slow.chartToAudio(slow.leadInSec)).toBeCloseTo(10, 6);
    expect(fast.chartToAudio(fast.leadInSec)).toBeCloseTo(10, 6);
  });
});

describe('exportDurationMs', () => {
  it('is what song.ini must report: everything in the packaged file', () => {
    expect(exportDurationMs(4000, 30_000, 2000)).toBe(36_000);
  });
});
