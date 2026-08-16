/**
 * Tempo and first-beat detection, and what to do with the answer.
 *
 * WHY THIS IS NOT JUST `analyze()`. The chart needs two numbers, not one: a tempo, and a
 * position in the recording for beat one to sit on. A BPM alone gives a grid with the
 * right spacing and the wrong phase — every barline a fixed fraction of a beat away from
 * the music, forever. `guess()` returns both, so this module uses that and treats the
 * offset as a first-class result rather than an afterthought.
 *
 * WHY THERE IS A CONFIDENCE. Beat detection is genuinely unreliable on sparse percussion
 * and on anything with a rubato feel, and it reports half or double the true tempo often
 * enough that trusting it silently would be worse than asking. There is no confidence
 * value in the library, so one is derived here: analyse the two halves of the window
 * separately and see whether they agree. Halves that agree closely mean a steady tempo the
 * detector locked onto; halves that disagree mean the number is a coin toss and the UI
 * should say so instead of quietly anchoring the chart to it.
 *
 * Everything here is pure apart from the calls into the detector, so the interpretation —
 * agreement, half/double folding, how a detected beat becomes a region start — is testable
 * without an AudioContext.
 */

export interface TempoGuess {
  bpm: number;
  /** Seconds into the SOURCE file where the first detected beat falls. */
  firstBeatSec: number;
  /** 0-1, from how well the two halves of the analysed window agree. */
  confidence: number;
}

/** The subset of `web-audio-beat-detector` this module uses, so tests can supply their own. */
export type GuessFn = (
  buffer: AudioBuffer,
  offsetSec?: number,
  durationSec?: number,
) => Promise<{ bpm: number; offset: number }>;

/**
 * Two BPMs agreeing to within this fraction are treated as the same reading.
 *
 * 1.5% is wider than the detector's own jitter on steady material and far tighter than
 * the gap to a half or double reading, so it separates "locked on" from "guessing"
 * without being fooled by rounding.
 */
const AGREEMENT_TOLERANCE = 0.015;

/**
 * How closely two BPM readings agree, as 0-1.
 *
 * Half and double are folded together first: a detector reporting 85 for one half of a
 * 170 BPM track has found the right pulse and named it differently, which is a much
 * better result than a genuinely unstable reading and should not score the same.
 */
export function agreement(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return 0;

  const folded = foldToSameOctave(a, b);
  const relative = Math.abs(folded - b) / b;
  if (relative <= AGREEMENT_TOLERANCE) return 1;
  // Fall off linearly, reaching zero at a 20% disagreement — past that the two halves
  // are describing different music.
  return Math.max(0, 1 - (relative - AGREEMENT_TOLERANCE) / 0.2);
}

/** Move `value` by octaves (x2 / ÷2) until it is as close to `reference` as it can get. */
export function foldToSameOctave(value: number, reference: number): number {
  let folded = value;
  while (folded > reference * 1.4) folded /= 2;
  while (folded < reference / 1.4) folded *= 2;
  return folded;
}

/**
 * Detect tempo and first beat over a window of the buffer.
 *
 * `startSec`/`endSec` window the analysis to the charted region: detecting the tempo of a
 * whole album side when the chart covers one song of it would answer a question nobody
 * asked. Returns null when the detector cannot find a stable pulse at all — the library
 * throws rather than returning a bad number, and that refusal is a real answer worth
 * passing on.
 */
export async function detectTempo(
  buffer: AudioBuffer,
  guess: GuessFn,
  startSec = 0,
  endSec?: number,
): Promise<TempoGuess | null> {
  const from = Math.max(0, startSec);
  const to = Math.min(endSec ?? buffer.duration, buffer.duration);
  const duration = to - from;
  if (!(duration > 1)) return null;

  let whole: { bpm: number; offset: number };
  try {
    whole = await guess(buffer, from, duration);
  } catch {
    return null;
  }
  if (!Number.isFinite(whole.bpm) || whole.bpm <= 0) return null;

  /**
   * The confidence probe. Only attempted on windows long enough for each half to hold
   * enough beats to be worth analysing; below that a disagreement would say more about
   * the window length than about the music, so the reading is passed through with a
   * middling confidence rather than being punished for being short.
   */
  let confidence = 0.5;
  if (duration >= 20) {
    const half = duration / 2;
    try {
      const [first, second] = await Promise.all([
        guess(buffer, from, half),
        guess(buffer, from + half, half),
      ]);
      confidence = agreement(first.bpm, second.bpm);
    } catch {
      confidence = 0.35;
    }
  }

  return {
    bpm: roundBpm(whole.bpm),
    // `offset` is relative to the analysed window, so it is put back into the file's own
    // timeline before anyone uses it as a position.
    firstBeatSec: from + Math.max(0, whole.offset),
    confidence,
  };
}

/**
 * BPM rounded to three decimals — the precision the .chart format stores.
 *
 * Rounding here rather than at write time means the tempo in the editor is exactly the
 * tempo in the file, so the grid the charter places notes against is the grid the game
 * plays them on. A value rounded only on the way out would drift the two apart over the
 * length of a song.
 */
export function roundBpm(bpm: number): number {
  return Math.round(bpm * 1000) / 1000;
}

/**
 * Where the region should start so that the first detected beat becomes beat one.
 *
 * The detector finds BEATS, not barlines — it has no notion of where a bar begins. So the
 * best it can offer is "the pulse starts here", and this walks that back by whole beats to
 * the earliest one still inside the file, which is the beat most likely to be the downbeat
 * of the first full bar. The charter nudges from there by ear, in whole beats, which is
 * why the nudge control exists at all.
 */
export function regionStartForFirstBeat(
  firstBeatSec: number,
  bpm: number,
  beatsPerBar: number,
): number {
  if (!(bpm > 0) || !(beatsPerBar > 0)) return Math.max(0, firstBeatSec);
  const beatSec = 60 / bpm;
  const barSec = beatSec * beatsPerBar;
  // Step back a whole bar at a time while there is still room, so the region starts on a
  // barline of the same grid rather than mid-bar.
  let start = firstBeatSec;
  while (start - barSec >= 0) start -= barSec;
  return Math.max(0, start);
}
