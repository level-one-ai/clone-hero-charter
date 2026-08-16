import { describe, expect, it } from 'vitest';
import { migrateProject } from './migrate';
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
