import { describe, expect, it } from 'vitest';
import { migrateProject } from './migrate';
import { TimingMap } from './timing';
import { leadInTicks } from './audioTimeline';
import { createEmptyProject, DEFAULT_TRAILING_SILENCE_MS, type Project } from './types';

/** A project as an older version wrote it: milliseconds of lead-in, no region. */
function legacy(leadingSilenceMs: number, bpm = 120): Project {
  const project = createEmptyProject('old') as Project & {
    meta: Project['meta'] & { leadingSilenceMs?: number };
  };
  project.sync.bpms = [{ tick: 0, bpm }];
  delete (project.meta as Partial<Project['meta']>).leadIn;
  delete (project.meta as Partial<Project['meta']>).trailingSilenceMs;
  delete (project.audio as Partial<Project['audio']>).region;
  delete (project.audio as Partial<Project['audio']>).detected;
  project.meta.leadingSilenceMs = leadingSilenceMs;
  return project;
}

describe('migrateProject', () => {
  it('converts a millisecond lead-in to whole bars', () => {
    // 4s at 120 BPM in 4/4 is exactly two bars.
    expect(migrateProject(legacy(4000)).meta.leadIn).toEqual({ bars: 2, beats: 0 });
  });

  it('rounds up rather than to nearest', () => {
    // Giving a charter more run-up than they had never breaks a chart; giving them less
    // can clip the first note off the top of the highway.
    expect(migrateProject(legacy(4500)).meta.leadIn).toEqual({ bars: 3, beats: 0 });
  });

  it('still enforces the minimum for a project that had no lead-in at all', () => {
    expect(migrateProject(legacy(0)).meta.leadIn).toEqual({ bars: 2, beats: 0 });
  });

  it('measures bars at the project tempo, not a default', () => {
    // At 240 BPM a 4/4 bar is 1s, so 4s of silence is four bars.
    expect(migrateProject(legacy(4000, 240)).meta.leadIn).toEqual({ bars: 4, beats: 0 });
  });

  it('drops the old field so the two cannot disagree later', () => {
    const migrated = migrateProject(legacy(2000)) as Project & {
      meta: { leadingSilenceMs?: number };
    };
    expect(migrated.meta.leadingSilenceMs).toBeUndefined();
  });

  it('fills in the fields added since, without inventing a region', () => {
    const migrated = migrateProject(legacy(2000));
    expect(migrated.meta.trailingSilenceMs).toBe(DEFAULT_TRAILING_SILENCE_MS);
    expect(migrated.audio.region).toBeNull();
    expect(migrated.audio.detected).toBeNull();
  });

  it('leaves a current project alone', () => {
    const current = createEmptyProject('new');
    const migrated = migrateProject(current);
    expect(migrated).toBe(current);
  });

  it('is idempotent', () => {
    const once = migrateProject(legacy(3000));
    expect(migrateProject(once)).toEqual(once);
  });
});

/**
 * A migration that changes the lead-in MUST move the chart with it.
 *
 * The lead-in is silence before the music. Growing it — which rounding up to whole bars
 * and the two-bar floor both do — pushes the music later against notes that have not
 * moved. A project saved with no lead-in at all gains two bars of silence, so without the
 * shift it would play two full bars ahead of its own chart the first time it was opened.
 */
describe('migration keeps notes aligned with the music', () => {
  function withNotes(leadingSilenceMs: number, ticks: number[]): Project {
    const project = legacy(leadingSilenceMs);
    project.tracks.ExpertSingle.notes = ticks.map((tick, i) => ({
      id: `n${i}`,
      tick,
      lane: 0,
      length: 0,
      forced: false,
      tap: false,
    }));
    project.events = [{ tick: ticks[0], text: 'section Intro' }];
    project.tracks.ExpertSingle.starPower = [{ tick: ticks[0], length: 192 }];
    return project;
  }

  it('moves every note by the silence it gained', () => {
    // No lead-in before, two bars (1536 ticks at 4/4, 192 res) after.
    const migrated = migrateProject(withNotes(0, [0, 768, 1920]));
    expect(migrated.tracks.ExpertSingle.notes.map((n) => n.tick)).toEqual([1536, 2304, 3456]);
  });

  it('moves sections and star power with the notes', () => {
    const migrated = migrateProject(withNotes(0, [768]));
    expect(migrated.events[0].tick).toBe(768 + 1536);
    expect(migrated.tracks.ExpertSingle.starPower[0].tick).toBe(768 + 1536);
  });

  it('moves only by the GROWTH, not by the whole new lead-in', () => {
    // 4s at 120 BPM is exactly two bars, so the lead-in is unchanged and nothing moves.
    const migrated = migrateProject(withNotes(4000, [1536, 2304]));
    expect(migrated.meta.leadIn).toEqual({ bars: 2, beats: 0 });
    expect(migrated.tracks.ExpertSingle.notes.map((n) => n.tick)).toEqual([1536, 2304]);
  });

  it('moves by the rounding when the old lead-in was not a whole bar', () => {
    // 3s at 120 BPM rounds up to two bars (4s): one second more silence, which at 120 BPM
    // in 4/4 is two beats, or 384 ticks.
    const migrated = migrateProject(withNotes(3000, [2000]));
    expect(migrated.tracks.ExpertSingle.notes[0].tick).toBe(2000 + 384);
  });

  it('keeps every note at the same distance from the start of the music', () => {
    // The property the shift exists to preserve, stated directly.
    const before = withNotes(0, [0, 768, 1920]);
    const beforeTiming = new TimingMap(before.sync.bpms, before.resolution, before.sync.timeSignatures);
    const musicStartsBefore = 0; // no lead-in

    const after = migrateProject(withNotes(0, [0, 768, 1920]));
    const afterTiming = new TimingMap(after.sync.bpms, after.resolution, after.sync.timeSignatures);
    const musicStartsAfter = afterTiming.tickToSec(leadInTicks(after.meta.leadIn, afterTiming));

    before.tracks.ExpertSingle.notes.forEach((note, i) => {
      const intoMusicBefore = beforeTiming.tickToSec(note.tick) - musicStartsBefore;
      const intoMusicAfter =
        afterTiming.tickToSec(after.tracks.ExpertSingle.notes[i].tick) - musicStartsAfter;
      expect(intoMusicAfter).toBeCloseTo(intoMusicBefore, 6);
    });
  });
});
