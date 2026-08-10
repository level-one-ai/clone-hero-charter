import { describe, expect, it } from 'vitest';
import { countBySeverity, summariseIssues, validateChart } from './validateChart';
import { createEmptyProject, type Lane, type Project } from './types';

/** A minimal valid chart: 120bpm, a few quarter notes on Expert, 60s of audio. */
function healthyProject(): Project {
  const project = createEmptyProject('test-id');
  project.tracks.ExpertSingle.notes = [0, 192, 384, 576].map((tick, i) => ({
    id: `n${i}`,
    tick,
    lane: (i % 5) as Lane,
    length: 0,
    forced: false,
    tap: false,
  }));
  return project;
}

const OPTIONS = { durationMs: 60_000 };
const messages = (project: Project) => validateChart(project, OPTIONS).map((i) => i.message);

describe('validateChart', () => {
  it('finds nothing wrong with a healthy chart', () => {
    expect(validateChart(healthyProject(), OPTIONS)).toEqual([]);
  });

  it('flags an empty Expert chart', () => {
    const project = createEmptyProject('test-id');
    expect(messages(project).join(' ')).toMatch(/Expert is empty/i);
  });

  it('flags a missing BPM at the start', () => {
    const project = healthyProject();
    project.sync.bpms = [{ tick: 960, bpm: 120 }];
    expect(messages(project).join(' ')).toMatch(/no BPM marker at the start/i);
  });

  it('flags notes past the end of the audio', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.notes.push({
      id: 'late',
      // 60s at 120bpm and resolution 192 is 23040 ticks; this is well past it.
      tick: 100_000,
      lane: 0,
      length: 0,
      forced: false,
      tap: false,
    });
    expect(messages(project).join(' ')).toMatch(/after the end of the audio/i);
  });

  it('flags an open note sharing a tick with fret notes', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.notes.push({
      id: 'open',
      tick: 0,
      lane: 7,
      length: 0,
      forced: false,
      tap: false,
    });
    expect(messages(project).join(' ')).toMatch(/open note shares a tick/i);
  });

  it('flags two notes stacked on one fret at one tick', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.notes.push({
      id: 'dup',
      tick: 0,
      lane: 0,
      length: 0,
      forced: false,
      tap: false,
    });
    expect(messages(project).join(' ')).toMatch(/stacked on the same fret/i);
  });

  it('flags sustains too short to register', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.notes[0].length = 4; // resolution 192 → minimum is 16
    expect(messages(project).join(' ')).toMatch(/too short to register/i);
  });

  it('accepts a sustain at exactly the threshold', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.notes[0].length = 16;
    expect(messages(project).join(' ')).not.toMatch(/too short/i);
  });

  it('flags a sustain running into the next note on the same fret', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.notes = [
      { id: 'a', tick: 0, lane: 0, length: 400, forced: false, tap: false },
      { id: 'b', tick: 192, lane: 0, length: 0, forced: false, tap: false },
    ];
    expect(messages(project).join(' ')).toMatch(/runs into the next note/i);
  });

  it('does not flag a sustain that ends before the next note', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.notes = [
      { id: 'a', tick: 0, lane: 0, length: 96, forced: false, tap: false },
      { id: 'b', tick: 192, lane: 0, length: 0, forced: false, tap: false },
    ];
    expect(messages(project).join(' ')).not.toMatch(/runs into/i);
  });

  it('flags a star power phrase with no notes in it', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.starPower = [{ tick: 5000, length: 768 }];
    expect(messages(project).join(' ')).toMatch(/contains no notes/i);
  });

  it('accepts a star power phrase that covers notes', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.starPower = [{ tick: 0, length: 768 }];
    expect(messages(project).join(' ')).not.toMatch(/contains no notes/i);
  });

  it('reports issues in song order', () => {
    const project = healthyProject();
    project.tracks.ExpertSingle.starPower = [
      { tick: 9000, length: 10 },
      { tick: 3000, length: 10 },
    ];
    const ticks = validateChart(project, OPTIONS).map((i) => i.tick ?? 0);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  });

  it('skips the audio-length check when the duration is unknown', () => {
    const project = healthyProject();
    expect(validateChart(project, { durationMs: 0 })).toEqual([]);
  });
});

describe('countBySeverity and summariseIssues', () => {
  it('says so when a chart is clean', () => {
    expect(summariseIssues([])).toMatch(/no problems/i);
  });

  it('counts errors and warnings separately', () => {
    const issues = validateChart(
      (() => {
        const project = healthyProject();
        project.tracks.ExpertSingle.notes[0].length = 4;
        project.tracks.ExpertSingle.notes.push({
          id: 'dup',
          tick: 0,
          lane: 0,
          length: 0,
          forced: false,
          tap: false,
        });
        return project;
      })(),
      OPTIONS,
    );
    const counts = countBySeverity(issues);
    expect(counts.errors).toBeGreaterThan(0);
    expect(counts.warnings).toBeGreaterThan(0);
    expect(summariseIssues(issues)).toMatch(/problem.* and .*warning/);
  });
});
