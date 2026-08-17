import { MIN_LEAD_IN_BARS, type AudioInfo, type AudioRegion, type LeadIn, type Project } from './types';
import type { TimingMap } from './timing';

/**
 * The one place that knows how chart time relates to the audio file.
 *
 * Three things sit between a tick and a position in the uploaded file, and getting any of
 * them wrong puts the whole chart off by a constant nobody can find later:
 *
 *   1. the LEAD-IN, silence before the music, measured in bars and beats
 *   2. the REGION, the slice of the source file this chart actually covers
 *   3. the TRAILING silence after it
 *
 * Laid out on the chart timeline:
 *
 *     0                leadInSec                      leadInSec + regionSec        end
 *     |---- silence ----|------------ region -----------|------ trailing ------|
 *                       ^
 *                       region.startMs in the source file
 *
 * So chart time and file time differ by a single constant, `regionStartSec - leadInSec`,
 * and every conversion in the app goes through the two methods below rather than doing
 * that arithmetic inline. The editor, the waveform, the metronome and the export all read
 * the same numbers from here, which is what makes what you hear, what you see and what
 * ships identical.
 *
 * WHY LEAD-IN IS BARS AND NOT MILLISECONDS. A lead-in in musical units ends on a downbeat
 * at any tempo. The music therefore starts exactly on beat 1 of a bar, and every barline
 * for the rest of the song lines up with the recording. A lead-in in milliseconds lands
 * mid-beat and puts the entire grid permanently out of phase with the audio — which is
 * the bug this design exists to make impossible.
 */

/** Ticks the lead-in occupies, measured against the time signature at tick 0. */
export function leadInTicks(leadIn: LeadIn, timing: TimingMap): number {
  const normalized = normalizeLeadIn(leadIn);
  const barTicks = timing.ticksPerMeasureAt(0);
  const beatTicks = timing.ticksPerBeatAt(0);
  return Math.round(normalized.bars * barTicks + normalized.beats * beatTicks);
}

/**
 * Lead-in length in seconds.
 *
 * Derived from the tempo map, never stored: change the anchor BPM and the silence changes
 * with it, because "two bars" means two bars at the song's tempo. Storing a millisecond
 * value alongside the bar count would let the two disagree, and one of them would be
 * wrong in the export.
 */
export function leadInSeconds(leadIn: LeadIn, timing: TimingMap): number {
  return timing.tickToSec(leadInTicks(leadIn, timing));
}

/**
 * Clamp a lead-in to whole, sane, at-least-the-minimum values.
 *
 * The floor is applied to the TOTAL, so 1 bar 3 beats is raised to the minimum rather
 * than silently accepted as "nearly two bars".
 */
export function normalizeLeadIn(leadIn: LeadIn | undefined | null, beatsPerBar = 4): LeadIn {
  const bars = Math.max(0, Math.floor(Number(leadIn?.bars) || 0));
  const beats = Math.max(0, Math.floor(Number(leadIn?.beats) || 0));

  // Carry an overflowing beat count into bars so "2 bars 6 beats" in 4/4 reads back as
  // "3 bars 2 beats" rather than staying in a form no bar counter would ever print.
  const perBar = beatsPerBar > 0 ? Math.floor(beatsPerBar) : 4;
  const carried = { bars: bars + Math.floor(beats / perBar), beats: beats % perBar };

  if (carried.bars < MIN_LEAD_IN_BARS) return { bars: MIN_LEAD_IN_BARS, beats: 0 };
  return carried;
}

/** The charted region, defaulting to the whole file when none has been chosen. */
export function resolveRegion(audio: AudioInfo): AudioRegion {
  const duration = Math.max(0, audio.durationMs || 0);
  const region = audio.region;
  if (!region) return { startMs: 0, endMs: duration };

  const startMs = clamp(region.startMs, 0, duration);
  // An end of 0 or one that has drifted past the file means "to the end": better than
  // presenting the charter with an empty region they cannot hear.
  const endMs = region.endMs > startMs ? Math.min(region.endMs, duration) : duration;
  return { startMs, endMs };
}

export interface AudioTimeline {
  /** Chart seconds at which the audio region begins. */
  leadInSec: number;
  leadInTicks: number;
  /** Where the region sits in the SOURCE file. */
  regionStartSec: number;
  regionEndSec: number;
  /** Length of the region itself. */
  regionSec: number;
  trailingSec: number;
  /** Lead-in + region + trailing: the full length of the exported song. */
  totalSec: number;
  /**
   * Chart time at which the music stops — lead-in plus region, without the tail.
   *
   * This, not the source file's length, is what "after the end of the audio" means for a
   * chart. The uploaded file may be far longer than the charted region, or shorter than
   * chart time once a lead-in is added; measuring against it flags notes that are fine and
   * misses notes that are genuinely unreachable.
   */
  musicEndSec: number;
  /** True when the region is a genuine slice rather than the whole file. */
  trimmed: boolean;
  /** Chart seconds -> position in the source audio file. */
  chartToAudio(chartSec: number): number;
  /** Position in the source audio file -> chart seconds. */
  audioToChart(audioSec: number): number;
}

export function buildAudioTimeline(project: Project, timing: TimingMap): AudioTimeline {
  const region = resolveRegion(project.audio);
  const regionStartSec = region.startMs / 1000;
  const regionEndSec = region.endMs / 1000;
  const regionSec = Math.max(0, regionEndSec - regionStartSec);
  const ticks = leadInTicks(project.meta.leadIn, timing);
  const leadInSec = timing.tickToSec(ticks);
  const trailingSec = Math.max(0, (project.meta.trailingSilenceMs ?? 0) / 1000);

  // The single constant that separates the two timelines.
  const shift = regionStartSec - leadInSec;

  return {
    leadInSec,
    leadInTicks: ticks,
    regionStartSec,
    regionEndSec,
    regionSec,
    trailingSec,
    totalSec: leadInSec + regionSec + trailingSec,
    musicEndSec: leadInSec + regionSec,
    trimmed: region.startMs > 0 || region.endMs < (project.audio.durationMs || 0) - 1,
    chartToAudio: (chartSec: number) => chartSec + shift,
    audioToChart: (audioSec: number) => audioSec - shift,
  };
}

/**
 * Total exported length in milliseconds — what song.ini's `song_length` must say.
 *
 * Clone Hero drives its progress bar and its end-of-song detection off this, so it has to
 * describe the packaged audio (lead-in and trailing silence included), not the upload.
 */
export function exportDurationMs(leadInMs: number, regionMs: number, trailingMs: number): number {
  return Math.max(0, Math.round(leadInMs + regionMs + trailingMs));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
