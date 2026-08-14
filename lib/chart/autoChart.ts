import { newNoteId, type Lane, type Note } from './types';

/**
 * Auto-charting a passage from the audio alone.
 *
 * WHAT THIS HONESTLY IS. Transcribing a guitar part out of a finished mix is an open
 * research problem — the guitar is buried under drums, bass and vocals, and distortion
 * smears its harmonics across the spectrum. What is tractable is finding WHEN notes are
 * struck, which is a well-understood signal-processing job, and making a reasonable guess
 * at whether the line moved up or down. So this produces the RHYTHM of a passage
 * accurately and the fret choices approximately.
 *
 * Treat the output as a scaffold to correct, not a finished chart. It is offered only for
 * stretches you explicitly mark as missing, so it can never touch work you have done.
 *
 * HOW IT WORKS. Spectral flux onset detection: take overlapping FFT frames, measure how
 * much the spectrum has RISEN since the previous frame (rises mean new energy — a note
 * starting; falls mean decay, which we ignore), then pick peaks that stand out above a
 * local moving average. That local threshold is what makes it work on real music, where a
 * quiet verse and a loud chorus need completely different absolute thresholds.
 */

export interface OnsetOptions {
  sampleRate: number;
  /** FFT size. 1024 at 44.1kHz is ~23ms — fine enough for fast playing. */
  frameSize?: number;
  hopSize?: number;
  /** How far above the local average a peak must rise to count, as a multiplier. */
  sensitivity?: number;
  /** Shortest gap between two onsets, in seconds. Rejects one strum read twice. */
  minSpacingSec?: number;
}

export interface Onset {
  timeSec: number;
  /** Detection strength, used to rank onsets when thinning a dense passage. */
  strength: number;
  /**
   * Spectral centroid at the onset, in Hz — a cheap "brightness" measure that tracks
   * whether the line moved up or down without attempting real pitch detection.
   */
  centroidHz: number;
}

const DEFAULTS = {
  frameSize: 1024,
  hopSize: 512,
  sensitivity: 1.5,
  minSpacingSec: 0.07,
};

/**
 * Find note attacks in a mono signal.
 *
 * `samples` is expected to be mono; callers mix stereo down first, because a note struck
 * in one channel is still a note.
 */
export function detectOnsets(samples: Float32Array, options: OnsetOptions): Onset[] {
  const frameSize = options.frameSize ?? DEFAULTS.frameSize;
  const hopSize = options.hopSize ?? DEFAULTS.hopSize;
  const sensitivity = options.sensitivity ?? DEFAULTS.sensitivity;
  const minSpacing = options.minSpacingSec ?? DEFAULTS.minSpacingSec;

  if (samples.length < frameSize * 2) return [];

  const window = hannWindow(frameSize);
  const bins = frameSize / 2;

  const flux: number[] = [];
  const centroids: number[] = [];
  let previous: Float32Array = new Float32Array(bins);

  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const magnitudes = magnitudeSpectrum(samples, start, frameSize, window);

    // Spectral flux: only RISES count. Energy falling away is a note decaying, not a new
    // one starting, and counting it would fire an onset at the end of every note.
    let sum = 0;
    for (let i = 0; i < bins; i += 1) {
      const rise = magnitudes[i] - previous[i];
      if (rise > 0) sum += rise;
    }
    flux.push(sum);
    centroids.push(spectralCentroid(magnitudes, options.sampleRate, frameSize));
    previous = magnitudes;
  }

  return pickPeaks(flux, centroids, {
    hopSec: hopSize / options.sampleRate,
    sensitivity,
    minSpacing,
  });
}

/**
 * Peaks that stand above a LOCAL moving average.
 *
 * A global threshold cannot work on real music: whatever value separates notes from noise
 * in a quiet intro will miss everything in a loud chorus, and vice versa.
 */
function pickPeaks(
  flux: number[],
  centroids: number[],
  options: { hopSec: number; sensitivity: number; minSpacing: number },
): Onset[] {
  const windowFrames = 20;
  const onsets: Onset[] = [];
  let lastTime = Number.NEGATIVE_INFINITY;

  for (let i = 1; i < flux.length - 1; i += 1) {
    const from = Math.max(0, i - windowFrames);
    const to = Math.min(flux.length, i + windowFrames);
    let mean = 0;
    for (let j = from; j < to; j += 1) mean += flux[j];
    mean /= to - from;

    const threshold = mean * options.sensitivity;
    const isPeak = flux[i] > threshold && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1];
    if (!isPeak) continue;

    const timeSec = i * options.hopSec;
    // Two detections a few milliseconds apart are one strum seen twice.
    if (timeSec - lastTime < options.minSpacing) continue;
    lastTime = timeSec;

    onsets.push({
      timeSec,
      strength: mean > 0 ? flux[i] / mean : 0,
      centroidHz: centroids[i] ?? 0,
    });
  }

  return onsets;
}

export interface AutoChartOptions {
  resolution: number;
  /** Snap grid, in ticks — onsets land on the nearest one. */
  snapTicks: number;
  /** Only produce notes inside this range. */
  fromTick: number;
  toTick: number;
  /** Largest chord the generator will place. Kept at 1: guesses do not belong in chords. */
  maxLanes?: number;
}

/**
 * Turn onsets into notes.
 *
 * Frets come from the RELATIVE brightness of each onset — a line that moves up in pitch
 * moves up the fretboard. That is a genuine approximation and it is why the result needs
 * a human pass: it will hold the shape of a riff without knowing the actual notes.
 */
export function onsetsToNotes(
  onsets: Onset[],
  tickAt: (seconds: number) => number,
  options: AutoChartOptions,
): Note[] {
  const inRange = onsets.filter((onset) => {
    const tick = tickAt(onset.timeSec);
    return tick >= options.fromTick && tick <= options.toTick;
  });
  if (inRange.length === 0) return [];

  // Rank brightness across THIS passage rather than in absolute terms: a bass-heavy mix
  // and a bright one should both use the whole fretboard.
  const centroids = inRange.map((o) => o.centroidHz).sort((a, b) => a - b);
  const low = centroids[Math.floor(centroids.length * 0.1)] ?? 0;
  const high = centroids[Math.floor(centroids.length * 0.9)] ?? low + 1;
  const span = Math.max(1, high - low);

  const notes: Note[] = [];
  let lastTick = Number.NEGATIVE_INFINITY;

  for (const onset of inRange) {
    const raw = tickAt(onset.timeSec);
    const tick = Math.round(raw / options.snapTicks) * options.snapTicks;
    if (tick === lastTick) continue; // two onsets snapped onto the same grid point
    lastTick = tick;

    const position = Math.min(1, Math.max(0, (onset.centroidHz - low) / span));
    const lane = Math.min(4, Math.max(0, Math.round(position * 4))) as Lane;

    notes.push({
      id: newNoteId(),
      tick,
      lane,
      length: 0,
      forced: false,
      tap: false,
    });
  }

  return notes;
}

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------

function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

/**
 * Magnitude spectrum of one frame, via a radix-2 FFT.
 *
 * Written out rather than pulled from a library: it is thirty lines, it runs server-side
 * where bundle size is irrelevant, and a dependency for one function that has not changed
 * since 1965 is not worth the supply chain.
 */
function magnitudeSpectrum(
  samples: Float32Array,
  offset: number,
  size: number,
  window: Float32Array,
): Float32Array {
  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  for (let i = 0; i < size; i += 1) real[i] = samples[offset + i] * window[i];

  fftInPlace(real, imag);

  const bins = size / 2;
  const magnitudes = new Float32Array(bins);
  for (let i = 0; i < bins; i += 1) {
    magnitudes[i] = Math.hypot(real[i], imag[i]);
  }
  return magnitudes;
}

/** In-place iterative Cooley-Tukey FFT. `size` must be a power of two. */
function fftInPlace(real: Float32Array, imag: Float32Array): void {
  const n = real.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const aReal = real[i + j];
        const aImag = imag[i + j];
        const bReal = real[i + j + len / 2] * curReal - imag[i + j + len / 2] * curImag;
        const bImag = real[i + j + len / 2] * curImag + imag[i + j + len / 2] * curReal;
        real[i + j] = aReal + bReal;
        imag[i + j] = aImag + bImag;
        real[i + j + len / 2] = aReal - bReal;
        imag[i + j + len / 2] = aImag - bImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/** Amplitude-weighted mean frequency: a cheap stand-in for "how high does this sound". */
function spectralCentroid(
  magnitudes: Float32Array,
  sampleRate: number,
  frameSize: number,
): number {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < magnitudes.length; i += 1) {
    weighted += magnitudes[i] * ((i * sampleRate) / frameSize);
    total += magnitudes[i];
  }
  return total > 0 ? weighted / total : 0;
}
