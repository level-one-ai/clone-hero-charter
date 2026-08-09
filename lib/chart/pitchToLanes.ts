import { LANE_OPEN, type Lane } from './types';

/**
 * Turn a musical line into fret lanes.
 *
 * This exists for MIDIs that are transcriptions of a song rather than Guitar Hero
 * charts. Those files carry real pitches (note 40 means E2, not "green"), so there is
 * no fret information to import — but the timing, which is the laborious part of
 * charting, is already exact. Deriving the frets turns "place 600 notes by hand" into
 * "adjust the lanes on an already-timed chart".
 *
 * Two strategies, because they suit different music and neither is universally better:
 *
 * PITCH (assignLanesByPitch) — the default. Absolute: low pitches take green, high
 * pitches take orange, and a given pitch always produces the same fret. Literal and
 * predictable; you can read a note's height in the music off the highway. Its weakness
 * is that a part camped on a few pitches concentrates on a few frets, which the band
 * split options exist to soften.
 *
 * CONTOUR (assignLanesByContour) — relative: the fret moves as the melody moves, up
 * for a rise and down for a fall, further for a bigger interval. Spreads across the
 * fretboard more evenly and feels closer to how a human charts, but the same pitch can
 * land on different frets in different places.
 */

/** Notes sharing a tick, as one chord. */
export interface PitchGroup {
  tick: number;
  /** MIDI note numbers sounding at this tick, in any order. */
  pitches: number[];
  /** Longest duration among them, in chart ticks. */
  durationTicks: number;
}

export interface LaneAssignment {
  tick: number;
  lanes: Lane[];
  length: number;
}

export interface PitchMappingOptions {
  /**
   * Sustains shorter than this become plain notes.
   *
   * For a transcription this wants to be MUCH higher than the 1/12-step threshold used
   * when reading a real chart. Transcriptions are written legato, with each note held
   * until the next, so the median note length is simply the rhythm of the part rather
   * than a note that rings out — on a typical file that turns ~80% of the chart into
   * sustains, which plays nothing like the music. A quarter note keeps only the notes
   * that genuinely sustain.
   */
  sustainCutoff: number;
  /** Cap on simultaneous notes. Chords beyond three are rare and awkward to play. */
  maxChordSize?: number;
  /**
   * Gap left between the end of a sustain and the next note, in ticks. Sustains that
   * run into the following note look wrong on the highway and play worse.
   */
  minSustainGap?: number;
}

/**
 * How far to move for a given interval.
 *
 * Deliberately coarse. Mapping every semitone to its own distance would use the full
 * fret span for a chromatic run and leave nothing in reserve for the leaps that
 * actually matter musically.
 */
function laneStepForInterval(semitones: number): number {
  const size = Math.abs(semitones);
  if (size === 0) return 0;
  if (size <= 2) return 1; // step-wise motion
  if (size <= 5) return 2; // third or fourth
  return 3; // fifth or wider — a real leap
}

/**
 * Reflect off the ends of the fretboard rather than piling up against them.
 *
 * Clamping alone makes long ascending runs stick on orange, so distinct notes collapse
 * onto one fret and the passage becomes an unplayable stream of repeated strums.
 * Bouncing back inward keeps successive notes on distinct frets, which is what the
 * music is doing anyway.
 */
function reflectIntoRange(lane: number): number {
  let value = lane;
  // Loop because a large jump can overshoot both ends in turn.
  for (let guard = 0; guard < 8; guard += 1) {
    if (value < 0) value = -value;
    else if (value > 4) value = 8 - value;
    else break;
  }
  return Math.max(0, Math.min(4, value));
}

export function assignLanesByContour(
  groups: PitchGroup[],
  options: PitchMappingOptions,
): LaneAssignment[] {
  const maxChordSize = Math.max(1, Math.min(3, options.maxChordSize ?? 2));
  const sorted = [...groups].sort((a, b) => a.tick - b.tick);

  const minSustainGap = options.minSustainGap ?? 24; // a 1/32 note at resolution 192

  const result: LaneAssignment[] = [];
  // Start mid-neck so the first move has room in either direction.
  let lane = 2;
  let previousPitch: number | null = null;

  for (const [index, group] of sorted.entries()) {
    if (group.pitches.length === 0) continue;

    // The melody note anchors the chord. The top note is what the ear follows, so
    // shaping the chart around it is what makes the chart track the tune.
    const pitch = Math.max(...group.pitches);

    if (previousPitch !== null) {
      const delta = pitch - previousPitch;
      const step = laneStepForInterval(delta);
      if (step > 0) {
        const direction = delta > 0 ? 1 : -1;
        const target = lane + direction * step;

        // Clamp first, reflect only at the edge.
        //
        // Reflecting first is wrong, and subtly so: a wide leap from mid-neck would
        // bounce off the end and land NEARER than a single step would, so the biggest
        // intervals in the music produced the smallest fret movements. Clamping sends
        // a big rise to orange, which is what the music is doing. Reflection is then
        // only for when we are already at the end of the neck and still have to move.
        let moved = Math.max(0, Math.min(4, target));
        if (moved === lane) {
          moved = reflectIntoRange(target);
          // A pitch change must produce a fret change, or the player strums one fret
          // repeatedly for what is audibly a different note.
          if (moved === lane) moved = reflectIntoRange(lane - direction);
        }
        lane = moved;
      }
    }
    previousPitch = pitch;

    const size = Math.min(group.pitches.length, maxChordSize);
    const lanes: Lane[] = [lane as Lane];
    for (let extra = 1; extra < size; extra += 1) {
      // Build chords upward where there is room, downward at the top of the neck.
      const candidate = lane + extra <= 4 ? lane + extra : lane - extra;
      const clamped = Math.max(0, Math.min(4, candidate));
      if (!lanes.includes(clamped as Lane)) lanes.push(clamped as Lane);
    }

    // Trim so a sustain never reaches the next note, then re-test against the cutoff —
    // a sustain trimmed down to a stub is better expressed as a plain note.
    const nextTick = sorted[index + 1]?.tick;
    let length = group.durationTicks;
    if (nextTick !== undefined) {
      length = Math.min(length, Math.max(0, nextTick - group.tick - minSustainGap));
    }
    if (length < options.sustainCutoff) length = 0;

    result.push({
      tick: group.tick,
      lanes: lanes.sort((a, b) => a - b),
      length,
    });
  }

  return result;
}

/** Collapse notes sharing a tick into chord groups. */
export function groupByTick(
  notes: Array<{ tick: number; pitch: number; durationTicks: number }>,
): PitchGroup[] {
  const byTick = new Map<number, PitchGroup>();
  for (const note of notes) {
    const existing = byTick.get(note.tick);
    if (existing) {
      existing.pitches.push(note.pitch);
      existing.durationTicks = Math.max(existing.durationTicks, note.durationTicks);
    } else {
      byTick.set(note.tick, {
        tick: note.tick,
        pitches: [note.pitch],
        durationTicks: note.durationTicks,
      });
    }
  }
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

// ---------------------------------------------------------------------------
// Absolute pitch mapping
// ---------------------------------------------------------------------------

/**
 * How to draw the boundaries between fret bands.
 *
 *   even      equal slices of the pitch range. Truest to the notes, but a part that
 *             sits mostly on a few low pitches piles almost everything onto one fret.
 *   balanced  boundaries placed so each fret gets a similar SHARE OF NOTES. Still
 *             strictly pitch-ordered, so a higher pitch never lands on a lower fret,
 *             but the whole fretboard gets used.
 *   distinct  equal numbers of DISTINCT pitches per band, ignoring how often each is
 *             played. A middle ground.
 */
export type BandSplit = 'even' | 'balanced' | 'distinct';

export interface PitchMapOptions extends PitchMappingOptions {
  split?: BandSplit;
  /** Reserve the lowest pitch band for open notes, giving six bands instead of five. */
  useOpenNotes?: boolean;
  /** Flip the mapping so the highest pitches take green rather than orange. */
  invert?: boolean;
}

/**
 * Band boundaries as upper bounds — a pitch belongs to the first band whose bound it
 * falls under, and to the last band otherwise.
 */
function bandBoundaries(
  pitchCounts: Map<number, number>,
  bandCount: number,
  split: BandSplit,
): number[] {
  const distinct = [...pitchCounts.keys()].sort((a, b) => a - b);
  if (distinct.length === 0 || bandCount < 2) return [];

  const lowest = distinct[0];
  const highest = distinct[distinct.length - 1];

  if (split === 'even') {
    const width = (highest - lowest + 1) / bandCount;
    return Array.from({ length: bandCount - 1 }, (_, i) => lowest + width * (i + 1));
  }

  if (split === 'distinct') {
    const perBand = distinct.length / bandCount;
    return Array.from({ length: bandCount - 1 }, (_, i) => {
      const index = Math.min(distinct.length - 1, Math.round((i + 1) * perBand));
      return distinct[index] - 0.5;
    });
  }

  /**
   * balanced: walk the pitches in order, closing a band once it holds roughly its
   * share of the notes — with the share RECOMPUTED from what is left each time.
   *
   * Fixed targets (total * i / bands) look equivalent and are not. A single dominant
   * pitch — and riffs routinely have one, sitting on the root a third of the time —
   * crosses several fixed targets at once, and every target it crosses collapses onto
   * the same boundary, leaving those frets with no notes at all. Recomputing spreads
   * the remaining pitches over the remaining frets instead.
   *
   * A band always takes at least one distinct pitch, and never so many that the frets
   * above it run out of pitches to use.
   */
  const total = [...pitchCounts.values()].reduce((sum, count) => sum + count, 0);
  const bounds: number[] = [];
  let index = 0;
  let remainingNotes = total;

  for (let band = 0; band < bandCount - 1; band += 1) {
    const remainingBands = bandCount - band;
    const target = remainingNotes / remainingBands;
    let accumulated = 0;

    while (index < distinct.length) {
      const pitch = distinct[index];
      const count = pitchCounts.get(pitch) ?? 0;
      accumulated += count;
      remainingNotes -= count;
      index += 1;
      // Stop once this band has its share, or once the pitches left are only just
      // enough to give every remaining band one each.
      const bandsAfterThis = bandCount - band - 2;
      if (accumulated >= target || distinct.length - index <= bandsAfterThis) break;
    }

    bounds.push((distinct[index - 1] ?? highest) + 0.5);
  }
  return bounds;
}

function bandOf(pitch: number, bounds: number[]): number {
  for (let i = 0; i < bounds.length; i += 1) {
    if (pitch < bounds[i]) return i;
  }
  return bounds.length;
}

/**
 * Map notes to frets by ABSOLUTE PITCH: low pitches to green, high pitches to orange,
 * with the same pitch always producing the same fret.
 *
 * This is the alternative to contour mapping. It is more literal — you can look at a
 * note on the highway and know roughly how high it is in the music — at the cost of
 * following the melody's movement less closely.
 *
 * The one invariant worth stating: the mapping is MONOTONIC. A higher pitch never
 * lands on a lower fret, whichever band split is used, because every split only ever
 * moves the boundaries between pitch-ordered bands.
 */
export function assignLanesByPitch(
  groups: PitchGroup[],
  options: PitchMapOptions,
): LaneAssignment[] {
  const split = options.split ?? 'balanced';
  const useOpenNotes = options.useOpenNotes ?? true;
  const invert = options.invert ?? false;
  const maxChordSize = Math.max(1, Math.min(5, options.maxChordSize ?? 3));
  const minSustainGap = options.minSustainGap ?? 24;

  const sorted = [...groups].sort((a, b) => a.tick - b.tick);

  // Band boundaries come from the whole part, so the same pitch maps to the same fret
  // everywhere in the song rather than drifting with the local range.
  const pitchCounts = new Map<number, number>();
  for (const group of sorted) {
    for (const pitch of group.pitches) {
      pitchCounts.set(pitch, (pitchCounts.get(pitch) ?? 0) + 1);
    }
  }

  const bandCount = useOpenNotes ? 6 : 5;
  const bounds = bandBoundaries(pitchCounts, bandCount, split);

  const laneForPitch = (pitch: number): Lane => {
    let band = bandOf(pitch, bounds);
    if (invert) band = bandCount - 1 - band;
    if (useOpenNotes) {
      // Band 0 is the open note; the five frets sit above it.
      return band === 0 ? (LANE_OPEN as Lane) : ((band - 1) as Lane);
    }
    return band as Lane;
  };

  const result: LaneAssignment[] = [];

  for (const [index, group] of sorted.entries()) {
    if (group.pitches.length === 0) continue;

    // Every note of a chord is mapped by its own pitch — the same rule as single
    // notes, so a chord's shape on the fretboard mirrors its shape in the music.
    const uniquePitches = [...new Set(group.pitches)].sort((a, b) => a - b);
    let lanes = [...new Set(uniquePitches.map(laneForPitch))];

    // An open note cannot be played together with frets, so when a chord spans the
    // boundary the frets win: they carry more of the chord's shape than the open does.
    if (lanes.length > 1 && lanes.includes(LANE_OPEN as Lane)) {
      lanes = lanes.filter((lane) => lane !== LANE_OPEN);
    }

    if (lanes.length > maxChordSize) {
      // Keep the outer two — they define the chord's span — then fill inward.
      lanes.sort((a, b) => a - b);
      const kept: Lane[] = [lanes[0], lanes[lanes.length - 1]];
      for (let i = 1; kept.length < maxChordSize && i < lanes.length - 1; i += 1) {
        kept.push(lanes[i]);
      }
      lanes = kept;
    }
    lanes.sort((a, b) => a - b);

    // Trim so a sustain never reaches the next note, then re-test against the cutoff.
    const nextTick = sorted[index + 1]?.tick;
    let length = group.durationTicks;
    if (nextTick !== undefined) {
      length = Math.min(length, Math.max(0, nextTick - group.tick - minSustainGap));
    }
    if (length < options.sustainCutoff) length = 0;

    result.push({ tick: group.tick, lanes, length });
  }

  return result;
}
