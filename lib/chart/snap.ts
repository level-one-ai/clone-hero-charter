import type { TimingMap } from './timing';

/**
 * Grid snapping.
 *
 * A "snap division" D means 1/D notes: D=4 is quarter notes, D=16 is sixteenths,
 * D=12 is eighth-note triplets, D=24 is sixteenth-note triplets. Ticks per division
 * is resolution * 4 / D, so at the standard resolution of 192:
 *
 *   1/4  -> 192      1/8  -> 96      1/16 -> 48
 *   1/12 -> 64       1/24 -> 32      1/32 -> 24
 *
 * Triplet divisions divide evenly at 192, which is exactly why 192 is the standard
 * resolution: it is 2^6 * 3, so both binary and ternary subdivisions land on whole
 * ticks with no rounding drift.
 */

export const SNAP_DIVISIONS = [4, 8, 12, 16, 24, 32, 48, 0] as const;
export type SnapDivision = (typeof SNAP_DIVISIONS)[number];

/** 0 means "no snap" — free placement at tick precision. */
export function snapLabel(division: SnapDivision): string {
  return division === 0 ? 'Free' : `1/${division}`;
}

export function ticksPerDivision(resolution: number, division: SnapDivision): number {
  if (division === 0) return 1;
  return (resolution * 4) / division;
}

/**
 * Snap a (possibly fractional) tick to the nearest gridline.
 *
 * Snapping is anchored to the last time-signature change rather than to tick 0, so a
 * mid-song TS change re-phases the grid instead of leaving notes offset against the
 * visible barlines.
 */
export function snapTick(
  tick: number,
  resolution: number,
  division: SnapDivision,
  timing?: TimingMap,
): number {
  if (division === 0) return Math.max(0, Math.round(tick));
  const step = ticksPerDivision(resolution, division);
  if (step <= 0) return Math.max(0, Math.round(tick));

  const anchor = timing ? timing.timeSignatureAt(tick).tick : 0;
  const snapped = anchor + Math.round((tick - anchor) / step) * step;
  return Math.max(0, Math.round(snapped));
}

/** Snap toward zero — used when resizing a sustain so it never overshoots. */
export function snapTickFloor(
  tick: number,
  resolution: number,
  division: SnapDivision,
  timing?: TimingMap,
): number {
  if (division === 0) return Math.max(0, Math.round(tick));
  const step = ticksPerDivision(resolution, division);
  if (step <= 0) return Math.max(0, Math.round(tick));
  const anchor = timing ? timing.timeSignatureAt(tick).tick : 0;
  const snapped = anchor + Math.floor((tick - anchor) / step) * step;
  return Math.max(0, Math.round(snapped));
}
