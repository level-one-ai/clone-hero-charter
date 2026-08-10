import { newNoteId, type Difficulty, type Lane, type Note } from './types';

/**
 * Generate a lower difficulty from a higher one.
 *
 * Charting the same song four times is the least rewarding part of the job, and it is
 * mostly mechanical: Hard is Expert with the hardest chords opened up, Easy is the same
 * line reduced to its bones. Doing that pass automatically turns four charts into one
 * plus a review.
 *
 * THE ONE RULE THAT MATTERS: reduction only ever REMOVES. Every generated note exists in
 * the source at the same tick, on a lane the source used (or folded inward from it), so
 * a generated difficulty is always in time with the song and with Expert. Nothing is
 * invented, so nothing can drift.
 *
 * This is a starting point, not a finished chart — the same as Moonscraper's generator.
 * A human still wants to look over the result.
 */

export interface ReductionRules {
  /** Most notes allowed in a chord. */
  maxChordSize: number;
  /** Closest two consecutive notes may be, as a fraction of a quarter note. */
  minGapBeats: number;
  /** Highest lane available; higher lanes fold down onto it. */
  maxLane: Lane;
  /** Whether tap and forced-HOPO flags survive. */
  keepFlags: boolean;
}

/**
 * Gaps widen and chords thin as the difficulty drops. The lane counts follow the
 * convention players expect: five frets on Hard, four on Medium, three on Easy.
 */
export const REDUCTION_RULES: Record<Exclude<Difficulty, 'Expert'>, ReductionRules> = {
  Hard: { maxChordSize: 2, minGapBeats: 1 / 4, maxLane: 4, keepFlags: true },
  Medium: { maxChordSize: 2, minGapBeats: 1 / 2, maxLane: 3, keepFlags: false },
  Easy: { maxChordSize: 1, minGapBeats: 1, maxLane: 2, keepFlags: false },
};

/**
 * Thin `notes` down to `level`.
 *
 * `resolution` is ticks per quarter note, so `minGapBeats` becomes a tick distance.
 */
export function reduceNotes(
  notes: Note[],
  resolution: number,
  level: Exclude<Difficulty, 'Expert'>,
): Note[] {
  const rules = REDUCTION_RULES[level];
  if (notes.length === 0) return [];

  const minGap = Math.max(1, Math.round(rules.minGapBeats * resolution));

  // ---- group into chords ------------------------------------------------------------
  const byTick = new Map<number, Note[]>();
  for (const note of notes) {
    const group = byTick.get(note.tick);
    if (group) group.push(note);
    else byTick.set(note.tick, [note]);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);

  // ---- drop notes that fall too close together --------------------------------------
  /**
   * Walk forward keeping a note only once `minGap` has passed. Notes on a strong beat
   * survive a near-miss, because losing the downbeat is what makes a reduced chart feel
   * wrong — the rhythm should still be recognisable at half the density.
   */
  const beat = resolution;
  const kept: number[] = [];
  let lastKept = Number.NEGATIVE_INFINITY;
  for (const tick of ticks) {
    const onBeat = tick % beat === 0;
    const gap = tick - lastKept;
    if (gap >= minGap || (onBeat && gap >= minGap / 2)) {
      kept.push(tick);
      lastKept = tick;
    }
  }

  // ---- reduce each surviving chord ---------------------------------------------------
  const out: Note[] = [];
  for (const tick of kept) {
    const group = byTick.get(tick)!;

    // An open note is a whole chord by itself and is easy to play, so it passes through
    // untouched — and it can never be mixed with frets, which addNote already enforces.
    const open = group.find((n) => n.lane === 7);
    if (open) {
      out.push(makeNote(open, 7, rules));
      continue;
    }

    // Keep the LOWEST lanes. Consistently choosing one end keeps the reduced line
    // melodically coherent instead of hopping around inside the original chords.
    const sorted = [...group].sort((a, b) => a.lane - b.lane);
    const chosen = sorted.slice(0, rules.maxChordSize);

    // Fold lanes above the level's ceiling downward, then drop anything that collides
    // with a note already placed at this tick.
    const usedLanes = new Set<Lane>();
    for (const note of chosen) {
      const lane = Math.min(note.lane, rules.maxLane) as Lane;
      if (usedLanes.has(lane)) continue;
      usedLanes.add(lane);
      out.push(makeNote(note, lane, rules));
    }
  }

  return out.sort((a, b) => a.tick - b.tick || a.lane - b.lane);
}

function makeNote(source: Note, lane: Lane, rules: ReductionRules): Note {
  return {
    id: newNoteId(),
    tick: source.tick,
    lane,
    length: source.length,
    forced: rules.keepFlags ? source.forced : false,
    tap: rules.keepFlags ? source.tap : false,
  };
}

/** One-line summary of what a reduction did, for the confirmation message. */
export function describeReduction(
  from: number,
  to: number,
  level: Exclude<Difficulty, 'Expert'>,
): string {
  const percent = from === 0 ? 0 : Math.round((to / from) * 100);
  return `${level}: ${to} notes from ${from} (${percent}% kept)`;
}
