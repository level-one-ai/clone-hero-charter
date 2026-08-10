import { TimingMap } from './timing';
import { DIFFICULTIES, trackNameFor, type Difficulty, type Project } from './types';

/**
 * Chart linting.
 *
 * Every check here is for something that produces a chart which LOADS but plays wrong —
 * the worst kind of bug, because Clone Hero says nothing and you only find out mid-song.
 * A chart that fails to load at all is easy to diagnose; a star power phrase containing
 * no notes is not.
 *
 * Deliberately advisory. Errors do not block the export: it is the user's chart, and a
 * tool that refuses to give you your own work because it disagrees about a sustain length
 * is worse than one that tells you and gets out of the way.
 */

export interface ChartIssue {
  severity: 'error' | 'warning';
  message: string;
  /** Where to send the playhead when the issue is clicked. */
  tick?: number;
  difficulty?: Difficulty;
}

export interface ValidateOptions {
  /** Audio length, so notes past the end can be spotted. Includes any lead-in. */
  durationMs: number;
}

/** Below this a sustain does not register in game and just looks like a rendering stub. */
const MIN_SUSTAIN_DIVISOR = 12;

export function validateChart(project: Project, options: ValidateOptions): ChartIssue[] {
  const issues: ChartIssue[] = [];
  const timing = new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures);
  const minSustain = project.resolution / MIN_SUSTAIN_DIVISOR;

  // ---- sync ---------------------------------------------------------------------
  if (project.sync.bpms.length === 0) {
    issues.push({ severity: 'error', message: 'The chart has no tempo at all.', tick: 0 });
  } else if (project.sync.bpms[0].tick !== 0) {
    issues.push({
      severity: 'error',
      message: 'There is no BPM marker at the start of the song, so everything before the first one is guesswork.',
      tick: 0,
    });
  }

  const audioEndTick =
    options.durationMs > 0 ? timing.secToTick(options.durationMs / 1000) : Number.POSITIVE_INFINITY;

  // ---- per difficulty -------------------------------------------------------------
  const expert = project.tracks[trackNameFor('Expert')];
  if (expert.notes.length === 0) {
    issues.push({
      severity: 'error',
      message: 'Expert is empty. Clone Hero shows the song but there is nothing to play.',
      difficulty: 'Expert',
    });
  }

  for (const difficulty of DIFFICULTIES) {
    const track = project.tracks[trackNameFor(difficulty)];
    const notes = track.notes;
    if (notes.length === 0) continue;

    // Notes past the end of the audio: unreachable, and they stretch the song's length
    // in the browser's song list.
    const past = notes.filter((n) => n.tick > audioEndTick);
    if (past.length > 0) {
      issues.push({
        severity: 'error',
        message: `${difficulty}: ${past.length} note${past.length === 1 ? '' : 's'} after the end of the audio — they can never be hit.`,
        tick: past[0].tick,
        difficulty,
      });
    }

    // Group by tick once; three of the checks below need it.
    const byTick = new Map<number, typeof notes>();
    for (const note of notes) {
      const group = byTick.get(note.tick);
      if (group) group.push(note);
      else byTick.set(note.tick, [note]);
    }

    for (const [tick, group] of byTick) {
      // An open note is the whole chord. Mixed with frets, Clone Hero has no way to
      // play the result and the behaviour is undefined.
      if (group.length > 1 && group.some((n) => n.lane === 7)) {
        issues.push({
          severity: 'error',
          message: `${difficulty}: an open note shares a tick with fret notes — invalid, Clone Hero cannot play both.`,
          tick,
          difficulty,
        });
      }

      // Two notes on one lane at one tick: one of them is unplayable.
      const lanes = group.map((n) => n.lane);
      if (new Set(lanes).size !== lanes.length) {
        issues.push({
          severity: 'error',
          message: `${difficulty}: two notes stacked on the same fret at the same moment.`,
          tick,
          difficulty,
        });
      }
    }

    const shortSustains = notes.filter((n) => n.length > 0 && n.length < minSustain);
    if (shortSustains.length > 0) {
      issues.push({
        severity: 'warning',
        message: `${difficulty}: ${shortSustains.length} sustain${shortSustains.length === 1 ? '' : 's'} shorter than a 1/${MIN_SUSTAIN_DIVISOR * 4} note — too short to register, they just look like stubs.`,
        tick: shortSustains[0].tick,
        difficulty,
      });
    }

    // Overlapping sustains on one lane: the second note starts before the first ends,
    // which reads as a held note that cannot be re-struck.
    const byLane = new Map<number, typeof notes>();
    for (const note of notes) {
      const list = byLane.get(note.lane);
      if (list) list.push(note);
      else byLane.set(note.lane, [note]);
    }
    for (const list of byLane.values()) {
      const sorted = [...list].sort((a, b) => a.tick - b.tick);
      for (let i = 1; i < sorted.length; i += 1) {
        const previous = sorted[i - 1];
        if (previous.length > 0 && previous.tick + previous.length > sorted[i].tick) {
          issues.push({
            severity: 'warning',
            message: `${difficulty}: a sustain runs into the next note on the same fret.`,
            tick: previous.tick,
            difficulty,
          });
          break; // one report per lane is enough to send them looking
        }
      }
    }

    // A phrase with no notes can never be activated, so the star power it promises is
    // simply missing from the song.
    for (const phrase of track.starPower) {
      const covered = notes.some(
        (n) => n.tick >= phrase.tick && n.tick < phrase.tick + phrase.length,
      );
      if (!covered) {
        issues.push({
          severity: 'warning',
          message: `${difficulty}: a star power phrase contains no notes, so it can never be earned.`,
          tick: phrase.tick,
          difficulty,
        });
      }
    }
  }

  // Sorted by position so working through the list is a single pass along the song.
  return issues.sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0));
}

export function countBySeverity(issues: ChartIssue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
  };
}

/** One-line summary for the export dialog. */
export function summariseIssues(issues: ChartIssue[]): string {
  const { errors, warnings } = countBySeverity(issues);
  if (errors === 0 && warnings === 0) return 'No problems found.';
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} problem${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return parts.join(' and ');
}
