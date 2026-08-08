import type { Lane } from './types';

/**
 * Turn a musical line into fret lanes by following its CONTOUR.
 *
 * This exists for MIDIs that are transcriptions of a song rather than Guitar Hero
 * charts. Those files carry real pitches (note 40 means E2, not "green"), so there is
 * no fret information to import — but the timing, which is the laborious part of
 * charting, is already exact. Deriving the frets from the melody's shape turns "place
 * 600 notes by hand" into "adjust the lanes on an already-timed chart".
 *
 * The rule is the one human charters use: the chart should feel like the tune.
 *
 *   - same pitch      -> same fret
 *   - pitch rises     -> move up the neck, further for a bigger interval
 *   - pitch falls     -> move down, likewise
 *   - chords          -> adjacent frets, anchored on the melody note
 *
 * An absolute pitch-to-fret mapping (split the range into five bands) is the obvious
 * alternative and plays noticeably worse: parts that span a wide range bunch up on the
 * outer frets, and a passage that stays in one octave collapses onto a single fret.
 * Relative motion keeps the hand moving the way the music does.
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
