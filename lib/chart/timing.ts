import type { BpmMarker, TimeSignature } from './types';

/**
 * Tick <-> time conversion across a BPM map.
 *
 * A chart's tempo is piecewise-constant: constant between BPM markers, discontinuous
 * at them. So tick->seconds is piecewise-linear, not linear, and you cannot convert
 * with a single multiply once the song has a single tempo change.
 *
 * The math, for a marker i at tick_i with bpm_i and a resolution of R ticks per
 * quarter note:
 *
 *     secondsPerTick(bpm) = 60 / (bpm * R)
 *     startSec_0          = 0
 *     startSec_{i+1}      = startSec_i + (tick_{i+1} - tick_i) * secondsPerTick(bpm_i)
 *
 * Converting then means finding the last segment starting at or before the input and
 * interpolating linearly within it. We precompute startSec once per BPM edit and
 * binary-search on lookup, because the editor calls these thousands of times per
 * frame while rendering the highway.
 *
 * NOTE: this operates purely in chart time. The song's `offset` (which shifts the
 * chart against the audio file) is applied by the caller at the audio boundary, not
 * here — mixing it in would corrupt beat-grid math.
 */

export interface TempoSegment {
  tick: number;
  bpm: number;
  /** Chart-time seconds at which this segment begins. */
  startSec: number;
  /** Cached 60 / (bpm * resolution). */
  secPerTick: number;
}

export class TimingMap {
  readonly resolution: number;
  readonly segments: TempoSegment[];
  private readonly timeSignatures: TimeSignature[];

  constructor(bpms: BpmMarker[], resolution: number, timeSignatures: TimeSignature[] = []) {
    this.resolution = resolution > 0 ? resolution : 192;

    // Defensive: sort, drop non-positive BPMs, collapse duplicate ticks (last wins),
    // and guarantee a tick-0 anchor. A chart missing its tick-0 tempo is malformed
    // but common enough in the wild that silently repairing it beats throwing.
    const cleaned = [...bpms]
      .filter((b) => Number.isFinite(b.tick) && Number.isFinite(b.bpm) && b.bpm > 0)
      .sort((a, b) => a.tick - b.tick);

    const deduped: BpmMarker[] = [];
    for (const marker of cleaned) {
      const tick = Math.max(0, Math.round(marker.tick));
      if (deduped.length > 0 && deduped[deduped.length - 1].tick === tick) {
        deduped[deduped.length - 1] = { tick, bpm: marker.bpm };
      } else {
        deduped.push({ tick, bpm: marker.bpm });
      }
    }
    if (deduped.length === 0 || deduped[0].tick !== 0) {
      deduped.unshift({ tick: 0, bpm: deduped[0]?.bpm ?? 120 });
    }

    this.segments = [];
    let startSec = 0;
    for (let i = 0; i < deduped.length; i += 1) {
      const { tick, bpm } = deduped[i];
      const secPerTick = 60 / (bpm * this.resolution);
      if (i > 0) {
        const prev = this.segments[i - 1];
        startSec = prev.startSec + (tick - prev.tick) * prev.secPerTick;
      }
      this.segments.push({ tick, bpm, startSec, secPerTick });
    }

    this.timeSignatures = [...timeSignatures].sort((a, b) => a.tick - b.tick);
    if (this.timeSignatures.length === 0 || this.timeSignatures[0].tick !== 0) {
      this.timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
    }
  }

  /** Index of the last segment starting at or before `tick`. */
  private segmentIndexByTick(tick: number): number {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Index of the last segment starting at or before `sec`. */
  private segmentIndexBySec(sec: number): number {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].startSec <= sec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Chart-time seconds at a tick position. Extrapolates linearly past the end. */
  tickToSec(tick: number): number {
    const seg = this.segments[this.segmentIndexByTick(tick)];
    return seg.startSec + (tick - seg.tick) * seg.secPerTick;
  }

  /** Tick position at a chart-time offset in seconds. May return a fractional tick. */
  secToTick(sec: number): number {
    const seg = this.segments[this.segmentIndexBySec(sec)];
    return seg.tick + (sec - seg.startSec) / seg.secPerTick;
  }

  /** BPM in effect at a tick. */
  bpmAt(tick: number): number {
    return this.segments[this.segmentIndexByTick(tick)].bpm;
  }

  /** Time signature in effect at a tick. */
  timeSignatureAt(tick: number): TimeSignature {
    let result = this.timeSignatures[0];
    for (const ts of this.timeSignatures) {
      if (ts.tick <= tick) result = ts;
      else break;
    }
    return result;
  }

  /** Ticks spanned by one beat (one denominator-unit) under the TS at `tick`. */
  ticksPerBeatAt(tick: number): number {
    const ts = this.timeSignatureAt(tick);
    // A quarter note is `resolution` ticks; a 1/N note is resolution * 4 / N.
    return (this.resolution * 4) / ts.denominator;
  }

  /** Ticks spanned by one full measure under the TS at `tick`. */
  ticksPerMeasureAt(tick: number): number {
    const ts = this.timeSignatureAt(tick);
    return this.ticksPerBeatAt(tick) * ts.numerator;
  }

  /**
   * Beat and measure gridlines across [startTick, endTick], honouring time-signature
   * changes. Walks measure by measure so a mid-song TS change re-anchors the barline
   * grid at the change tick, which is what Moonscraper does and what charters expect.
   */
  gridLines(startTick: number, endTick: number, subdivisions = 1): GridLine[] {
    const lines: GridLine[] = [];
    if (endTick <= startTick) return lines;

    // Walk from the last TS change at or before startTick so measure numbering and
    // barline phase are correct rather than restarting at the viewport edge.
    let tsIndex = 0;
    for (let i = 0; i < this.timeSignatures.length; i += 1) {
      if (this.timeSignatures[i].tick <= startTick) tsIndex = i;
      else break;
    }

    let cursor = this.timeSignatures[tsIndex].tick;
    let measureNumber = 0;
    // Count measures elapsed before the current TS anchor so labels stay meaningful.
    for (let i = 1; i <= tsIndex; i += 1) {
      const span = this.timeSignatures[i].tick - this.timeSignatures[i - 1].tick;
      const prevMeasure =
        ((this.resolution * 4) / this.timeSignatures[i - 1].denominator) *
        this.timeSignatures[i - 1].numerator;
      measureNumber += Math.max(0, Math.round(span / prevMeasure));
    }

    // `<=` so a line landing exactly on the trailing viewport edge is still emitted;
    // dropping it makes the last barline flicker out as the highway scrolls.
    // Hard iteration cap: a corrupt TS (numerator 0) would otherwise spin forever.
    let guard = 0;
    while (cursor <= endTick && guard < 100000) {
      guard += 1;
      const ts = this.timeSignatureAt(cursor);
      const beatTicks = (this.resolution * 4) / ts.denominator;
      const measureTicks = beatTicks * ts.numerator;
      if (!Number.isFinite(measureTicks) || measureTicks <= 0) break;

      // Stop early at the next TS change so we do not overshoot a partial measure.
      const nextTs = this.timeSignatures.find((t) => t.tick > cursor);
      const measureEnd = Math.min(cursor + measureTicks, nextTs ? nextTs.tick : Infinity);

      for (let beat = 0; beat < ts.numerator; beat += 1) {
        const beatTick = cursor + beat * beatTicks;
        if (beatTick >= measureEnd) break;
        if (beatTick >= startTick && beatTick <= endTick) {
          lines.push({ tick: beatTick, kind: beat === 0 ? 'measure' : 'beat', measureNumber });
        }
        if (subdivisions > 1) {
          const step = beatTicks / subdivisions;
          for (let s = 1; s < subdivisions; s += 1) {
            const subTick = beatTick + s * step;
            if (subTick >= measureEnd) break;
            if (subTick >= startTick && subTick <= endTick) {
              lines.push({ tick: subTick, kind: 'sub', measureNumber });
            }
          }
        }
      }

      measureNumber += 1;
      cursor = measureEnd;
    }

    return lines;
  }
}

export interface GridLine {
  tick: number;
  kind: 'measure' | 'beat' | 'sub';
  measureNumber: number;
}

/** Format seconds as m:ss.mmm for the transport readout. */
export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  return `${minutes}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}
