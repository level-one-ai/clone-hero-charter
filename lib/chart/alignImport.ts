import { TimingMap } from './timing';
import { leadInTicks } from './audioTimeline';
import { TRACK_NAMES, type LeadIn, type Project } from './types';

/**
 * Slide an imported chart into place behind the lead-in.
 *
 * A Guitar Pro score, or a transcription MIDI, starts at its own bar 1 — tick 0. The chart
 * does not: tick 0 is the start of the count-in silence, and the music begins bars later.
 * Dropping an import in unshifted therefore puts every note exactly one lead-in early, and
 * because the error is a constant it reads as "the whole chart is off" rather than as
 * anything an editor would point at.
 *
 * So the import is moved bodily to the first musical bar, and the tempo map is moved with
 * it — with one exception. The tick-0 tempo and time signature stay at tick 0, set to the
 * import's own opening values, because the lead-in has to be counted in the song's own
 * tempo. Two bars of silence at 120 BPM in front of a 180 BPM song is not a count-in, it
 * is a wait.
 *
 * This runs AFTER conversion rather than inside it, so the pitch mapping, track scoring
 * and difficulty generation are all untouched by the question of where zero is.
 */
export function alignImportToLeadIn(project: Project, leadIn: LeadIn): Project {
  const timing = new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures);
  return shiftImport(project, leadInTicks(leadIn, timing));
}

/**
 * The shift itself, in ticks.
 *
 * Separate from the lead-in calculation because merging into an existing chart has to
 * measure the lead-in against the TARGET's tempo map, not the incoming file's — the two
 * can disagree, and the notes have to land on the grid they are joining.
 */
export function shiftImport(project: Project, shift: number): Project {
  if (shift <= 0) return project;

  /**
   * Anchor values first, from the import's own opening tempo and metre, then every
   * marker moved. A marker already at tick 0 would collide with the anchor after the
   * shift is applied, so the anchor is written from it rather than beside it.
   */
  const anchorBpm = project.sync.bpms.find((b) => b.tick === 0)?.bpm ?? project.sync.bpms[0]?.bpm ?? 120;
  const anchorTs =
    project.sync.timeSignatures.find((t) => t.tick === 0) ??
    project.sync.timeSignatures[0] ?? { tick: 0, numerator: 4, denominator: 4 };

  const bpms = [
    { tick: 0, bpm: anchorBpm },
    ...project.sync.bpms
      .filter((marker) => marker.tick > 0)
      .map((marker) => ({ ...marker, tick: marker.tick + shift })),
  ];

  const timeSignatures = [
    { tick: 0, numerator: anchorTs.numerator, denominator: anchorTs.denominator },
    ...project.sync.timeSignatures
      .filter((marker) => marker.tick > 0)
      .map((marker) => ({ ...marker, tick: marker.tick + shift })),
  ];

  const tracks = { ...project.tracks };
  for (const trackName of TRACK_NAMES) {
    const track = project.tracks[trackName];
    tracks[trackName] = {
      notes: track.notes.map((note) => ({ ...note, tick: note.tick + shift })),
      starPower: track.starPower.map((phrase) => ({ ...phrase, tick: phrase.tick + shift })),
    };
  }

  return {
    ...project,
    sync: { bpms, timeSignatures },
    events: project.events.map((event) => ({ ...event, tick: event.tick + shift })),
    tracks,
  };
}
