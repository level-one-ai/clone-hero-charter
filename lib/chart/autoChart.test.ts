import { describe, expect, it } from 'vitest';
import { detectOnsets, onsetsToNotes } from './autoChart';

const SAMPLE_RATE = 44100;

/**
 * A synthetic "performance": short bursts of tone separated by silence, at known times.
 * Onset detection should find one attack per burst, which is a far more meaningful test
 * than asserting against a fixed number on a real recording.
 */
function pluckTrack(
  timesSec: number[],
  options: { durationSec: number; freqHz?: number; lengthSec?: number } = { durationSec: 4 },
): Float32Array {
  const total = Math.floor(options.durationSec * SAMPLE_RATE);
  const samples = new Float32Array(total);
  const noteLength = Math.floor((options.lengthSec ?? 0.18) * SAMPLE_RATE);

  for (const [index, time] of timesSec.entries()) {
    const start = Math.floor(time * SAMPLE_RATE);
    const freq = options.freqHz ?? 220 * (1 + index * 0.02);
    for (let i = 0; i < noteLength && start + i < total; i += 1) {
      // Sharp attack, exponential decay — what a plucked string looks like.
      const envelope = Math.exp(-i / (SAMPLE_RATE * 0.06));
      samples[start + i] += Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * envelope;
    }
  }
  return samples;
}

describe('detectOnsets', () => {
  it('returns nothing for silence', () => {
    const silence = new Float32Array(SAMPLE_RATE * 2);
    expect(detectOnsets(silence, { sampleRate: SAMPLE_RATE })).toEqual([]);
  });

  it('returns nothing for a signal too short to analyse', () => {
    expect(detectOnsets(new Float32Array(100), { sampleRate: SAMPLE_RATE })).toEqual([]);
  });

  it('finds one onset per pluck, near the right time', () => {
    const times = [0.5, 1.0, 1.5, 2.0, 2.5];
    const onsets = detectOnsets(pluckTrack(times, { durationSec: 3.5 }), {
      sampleRate: SAMPLE_RATE,
    });

    expect(onsets.length).toBeGreaterThanOrEqual(times.length);
    // Every real pluck should have a detection within 40ms of it.
    for (const time of times) {
      const nearest = Math.min(...onsets.map((o) => Math.abs(o.timeSec - time)));
      expect(nearest).toBeLessThan(0.04);
    }
  });

  it('does not fire twice on one attack', () => {
    const onsets = detectOnsets(pluckTrack([1.0], { durationSec: 2.5 }), {
      sampleRate: SAMPLE_RATE,
    });
    const near = onsets.filter((o) => Math.abs(o.timeSec - 1.0) < 0.15);
    expect(near.length).toBeLessThanOrEqual(1);
  });

  it('reports a higher centroid for a brighter note', () => {
    const low = detectOnsets(pluckTrack([1.0], { durationSec: 2.5, freqHz: 150 }), {
      sampleRate: SAMPLE_RATE,
    });
    const high = detectOnsets(pluckTrack([1.0], { durationSec: 2.5, freqHz: 1200 }), {
      sampleRate: SAMPLE_RATE,
    });
    expect(low[0]?.centroidHz ?? 0).toBeLessThan(high[0]?.centroidHz ?? 0);
  });
});

describe('onsetsToNotes', () => {
  const R = 192;
  // 120bpm: one beat is half a second, so tick = seconds * 384.
  const tickAt = (seconds: number) => Math.round(seconds * 384);

  const onsets = [
    { timeSec: 1.0, strength: 3, centroidHz: 200 },
    { timeSec: 1.5, strength: 3, centroidHz: 800 },
    { timeSec: 2.0, strength: 3, centroidHz: 1500 },
  ];

  it('places one note per onset, snapped to the grid', () => {
    const notes = onsetsToNotes(onsets, tickAt, {
      resolution: R,
      snapTicks: 48,
      fromTick: 0,
      toTick: 10_000,
    });
    expect(notes).toHaveLength(3);
    for (const note of notes) expect(note.tick % 48).toBe(0);
  });

  it('only produces notes inside the marked range', () => {
    const notes = onsetsToNotes(onsets, tickAt, {
      resolution: R,
      snapTicks: 48,
      fromTick: 500,
      toTick: 600,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].tick).toBeGreaterThanOrEqual(500 - 48);
  });

  it('maps brighter onsets to higher lanes', () => {
    const notes = onsetsToNotes(onsets, tickAt, {
      resolution: R,
      snapTicks: 48,
      fromTick: 0,
      toTick: 10_000,
    });
    expect(notes[0].lane).toBeLessThan(notes[2].lane);
  });

  it('never stacks two notes on one grid point', () => {
    const crowded = [
      { timeSec: 1.0, strength: 3, centroidHz: 300 },
      { timeSec: 1.005, strength: 3, centroidHz: 900 },
    ];
    const notes = onsetsToNotes(crowded, tickAt, {
      resolution: R,
      snapTicks: 96,
      fromTick: 0,
      toTick: 10_000,
    });
    expect(notes).toHaveLength(1);
  });

  it('gives every note a fresh id and no sustain', () => {
    const notes = onsetsToNotes(onsets, tickAt, {
      resolution: R,
      snapTicks: 48,
      fromTick: 0,
      toTick: 10_000,
    });
    expect(new Set(notes.map((n) => n.id)).size).toBe(notes.length);
    expect(notes.every((n) => n.length === 0)).toBe(true);
  });

  it('returns nothing when no onset falls in the range', () => {
    expect(
      onsetsToNotes(onsets, tickAt, {
        resolution: R,
        snapTicks: 48,
        fromTick: 100_000,
        toTick: 200_000,
      }),
    ).toEqual([]);
  });

  it('keeps every lane within the fretboard', () => {
    const extreme = [
      { timeSec: 1.0, strength: 3, centroidHz: 0 },
      { timeSec: 2.0, strength: 3, centroidHz: 20_000 },
    ];
    const notes = onsetsToNotes(extreme, tickAt, {
      resolution: R,
      snapTicks: 48,
      fromTick: 0,
      toTick: 10_000,
    });
    for (const note of notes) {
      expect(note.lane).toBeGreaterThanOrEqual(0);
      expect(note.lane).toBeLessThanOrEqual(4);
    }
  });
});
