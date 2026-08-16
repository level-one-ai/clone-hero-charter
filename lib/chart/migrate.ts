import { TimingMap } from './timing';
import { normalizeLeadIn } from './audioTimeline';
import {
  DEFAULT_TRAILING_SILENCE_MS,
  MIN_LEAD_IN_BARS,
  type Project,
} from './types';

/**
 * Bring a project saved by an older version up to the current shape.
 *
 * Run on every read rather than as a one-off script: a project.json can arrive from a
 * backup, a copied folder or a volume that predates any migration run, so "the file on
 * disk is old" has to stay a supported state rather than a corrupt one. The migration is
 * idempotent and only ever adds — nothing an older field held is thrown away silently.
 */

/** The lead-in as it used to be stored, before bars and beats. */
interface LegacyMeta {
  leadingSilenceMs?: number;
}

export function migrateProject(input: Project): Project {
  const project = input;
  const meta = project.meta as Project['meta'] & LegacyMeta;
  let changed = false;

  if (!meta.leadIn) {
    // Convert the old millisecond lead-in to the nearest whole beat at the anchor tempo,
    // then round UP to a whole bar. Rounding up rather than to nearest is deliberate: the
    // old value was chosen by ear against the music, and giving a charter slightly more
    // run-up than they had never breaks a chart, while giving them less can clip the
    // first note off the top of the highway.
    const timing = new TimingMap(
      project.sync?.bpms ?? [{ tick: 0, bpm: 120 }],
      project.resolution || 192,
      project.sync?.timeSignatures ?? [],
    );
    const legacyMs = Math.max(0, Number(meta.leadingSilenceMs) || 0);
    const barSec = timing.tickToSec(timing.ticksPerMeasureAt(0));
    const bars = barSec > 0 ? Math.ceil(legacyMs / 1000 / barSec) : MIN_LEAD_IN_BARS;
    meta.leadIn = normalizeLeadIn({ bars, beats: 0 }, timing.timeSignatureAt(0).numerator);
    changed = true;
  }
  delete meta.leadingSilenceMs;

  if (typeof meta.trailingSilenceMs !== 'number' || !Number.isFinite(meta.trailingSilenceMs)) {
    meta.trailingSilenceMs = DEFAULT_TRAILING_SILENCE_MS;
    changed = true;
  }

  if (project.audio && project.audio.region === undefined) {
    // No region means the whole file, which is exactly what these projects charted.
    project.audio.region = null;
    changed = true;
  }
  if (project.audio && project.audio.detected === undefined) {
    project.audio.detected = null;
    changed = true;
  }

  return changed ? { ...project, meta, audio: project.audio } : project;
}
