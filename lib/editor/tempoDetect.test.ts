import { describe, expect, it } from 'vitest';
import {
  agreement,
  detectTempo,
  foldToSameOctave,
  regionStartForFirstBeat,
  roundBpm,
  type GuessFn,
} from './tempoDetect';

/** A buffer stub: detectTempo only reads `duration`, and the fake guess ignores the rest. */
function buffer(durationSec: number): AudioBuffer {
  return { duration: durationSec } as AudioBuffer;
}

describe('foldToSameOctave', () => {
  it('brings a half-tempo reading up to its partner', () => {
    expect(foldToSameOctave(85, 170)).toBeCloseTo(170, 6);
  });

  it('brings a double-tempo reading down', () => {
    expect(foldToSameOctave(340, 170)).toBeCloseTo(170, 6);
  });

  it('leaves an already-matching reading alone', () => {
    expect(foldToSameOctave(171, 170)).toBeCloseTo(171, 6);
  });
});

describe('agreement', () => {
  it('is total for two readings within tolerance', () => {
    expect(agreement(140, 140)).toBe(1);
    expect(agreement(140, 141)).toBe(1);
  });

  it('treats half and double as the same pulse', () => {
    // A detector that says 85 for one half and 170 for the other has found the beat and
    // named it differently — a far better result than an unstable reading.
    expect(agreement(85, 170)).toBe(1);
  });

  it('falls off as the readings genuinely diverge', () => {
    expect(agreement(140, 160)).toBeLessThan(1);
    expect(agreement(140, 160)).toBeGreaterThan(0);
    // Far enough apart that no octave folding brings them together.
    expect(agreement(140, 190)).toBe(0);
  });

  it('is zero for a missing reading', () => {
    expect(agreement(0, 140)).toBe(0);
    expect(agreement(Number.NaN, 140)).toBe(0);
  });
});

describe('detectTempo', () => {
  const steady: GuessFn = async () => ({ bpm: 172.4, offset: 0.35 });

  it('returns the tempo and the first beat', async () => {
    const result = await detectTempo(buffer(60), steady);
    expect(result?.bpm).toBeCloseTo(172.4, 3);
    expect(result?.firstBeatSec).toBeCloseTo(0.35, 6);
  });

  it('puts the offset back into the FILE timeline, not the window', async () => {
    // The detector reports relative to the window it was given. Forgetting to add the
    // window start back is a silent misalignment of exactly the region start.
    const result = await detectTempo(buffer(300), steady, 90, 150);
    expect(result?.firstBeatSec).toBeCloseTo(90.35, 6);
  });

  it('is confident when the halves agree', async () => {
    const result = await detectTempo(buffer(120), steady);
    expect(result?.confidence).toBe(1);
  });

  it('is not confident when the halves disagree', async () => {
    let call = 0;
    const drifting: GuessFn = async () => {
      call += 1;
      // First call is the whole window; the two after it are the halves.
      return { bpm: call === 2 ? 120 : call === 3 ? 168 : 140, offset: 0 };
    };
    const result = await detectTempo(buffer(120), drifting);
    expect(result?.confidence).toBeLessThan(0.5);
  });

  it('does not punish a short window for having no halves to compare', async () => {
    const result = await detectTempo(buffer(12), steady);
    expect(result?.confidence).toBe(0.5);
  });

  it('reports failure rather than a made-up number', async () => {
    const refusing: GuessFn = async () => {
      throw new Error('no stable tempo');
    };
    expect(await detectTempo(buffer(60), refusing)).toBeNull();
  });

  it('rejects a window too short to hold a tempo', async () => {
    expect(await detectTempo(buffer(0.5), steady)).toBeNull();
  });
});

describe('roundBpm', () => {
  it('rounds to the precision .chart stores, so editor and file agree', () => {
    expect(roundBpm(172.44449)).toBe(172.444);
    expect(roundBpm(120)).toBe(120);
  });
});

describe('regionStartForFirstBeat', () => {
  it('walks back to the earliest beat on the same grid', () => {
    // 120 BPM in 4/4: a bar is 2s. A first beat at 6.5s has bars at 4.5, 2.5 and 0.5.
    expect(regionStartForFirstBeat(6.5, 120, 4)).toBeCloseTo(0.5, 6);
  });

  it('leaves a beat that is already near the start alone', () => {
    expect(regionStartForFirstBeat(0.4, 120, 4)).toBeCloseTo(0.4, 6);
  });

  it('never returns a negative position', () => {
    expect(regionStartForFirstBeat(0.1, 200, 4)).toBeGreaterThanOrEqual(0);
  });

  it('follows the metre', () => {
    // 3/4 at 120: a bar is 1.5s, so 5s walks back to 0.5s.
    expect(regionStartForFirstBeat(5, 120, 3)).toBeCloseTo(0.5, 6);
  });
});
