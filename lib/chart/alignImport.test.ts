import { describe, expect, it } from 'vitest';
import { alignImportToLeadIn, shiftImport } from './alignImport';
import { TimingMap } from './timing';
import { createEmptyProject, newNoteId, type Project } from './types';

function imported(): Project {
  const project = createEmptyProject('imp');
  project.sync.bpms = [
    { tick: 0, bpm: 180 },
    { tick: 768, bpm: 200 },
  ];
  project.sync.timeSignatures = [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 1536, numerator: 7, denominator: 8 },
  ];
  project.events = [{ tick: 0, text: 'section Intro' }];
  project.tracks.ExpertSingle.notes = [
    { id: newNoteId(), tick: 0, lane: 0, length: 0, forced: false, tap: false },
    { id: newNoteId(), tick: 384, lane: 2, length: 192, forced: true, tap: false },
  ];
  project.tracks.ExpertSingle.starPower = [{ tick: 0, length: 768 }];
  return project;
}

describe('alignImportToLeadIn', () => {
  it('moves notes past the lead-in', () => {
    // Two bars of 4/4 at 192 ticks per quarter.
    const aligned = alignImportToLeadIn(imported(), { bars: 2, beats: 0 });
    expect(aligned.tracks.ExpertSingle.notes.map((n) => n.tick)).toEqual([1536, 1920]);
  });

  it('keeps note flags and sustains intact', () => {
    const aligned = alignImportToLeadIn(imported(), { bars: 2, beats: 0 });
    const second = aligned.tracks.ExpertSingle.notes[1];
    expect(second).toMatchObject({ lane: 2, length: 192, forced: true, tap: false });
  });

  it('moves star power and events with the notes', () => {
    const aligned = alignImportToLeadIn(imported(), { bars: 2, beats: 0 });
    expect(aligned.tracks.ExpertSingle.starPower[0].tick).toBe(1536);
    expect(aligned.events[0].tick).toBe(1536);
  });

  it('anchors tick 0 to the score tempo so the count-in is in time', () => {
    // The whole point: two bars of silence at the SONG'S tempo, not at a default.
    const aligned = alignImportToLeadIn(imported(), { bars: 2, beats: 0 });
    expect(aligned.sync.bpms[0]).toEqual({ tick: 0, bpm: 180 });
    expect(aligned.sync.timeSignatures[0]).toMatchObject({ tick: 0, numerator: 4, denominator: 4 });
  });

  it('moves later tempo and metre changes with the music', () => {
    const aligned = alignImportToLeadIn(imported(), { bars: 2, beats: 0 });
    expect(aligned.sync.bpms.map((b) => b.tick)).toEqual([0, 768 + 1536]);
    expect(aligned.sync.timeSignatures.map((t) => t.tick)).toEqual([0, 1536 + 1536]);
  });

  it('preserves the interval between a note and its tempo change', () => {
    // The failure this guards: shifting notes but not the tempo map re-times the whole
    // score against its own tempo changes, which is worse than not shifting at all.
    const before = imported();
    const after = alignImportToLeadIn(before, { bars: 2, beats: 0 });

    const beforeMap = new TimingMap(before.sync.bpms, before.resolution, before.sync.timeSignatures);
    const afterMap = new TimingMap(after.sync.bpms, after.resolution, after.sync.timeSignatures);
    const shiftSec = afterMap.tickToSec(1536);

    for (let i = 0; i < before.tracks.ExpertSingle.notes.length; i += 1) {
      const original = beforeMap.tickToSec(before.tracks.ExpertSingle.notes[i].tick);
      const moved = afterMap.tickToSec(after.tracks.ExpertSingle.notes[i].tick);
      expect(moved - shiftSec).toBeCloseTo(original, 6);
    }
  });

  it('does nothing when there is no lead-in to make room for', () => {
    const project = imported();
    expect(shiftImport(project, 0)).toBe(project);
  });

  it('measures the lead-in in the imported metre', () => {
    const project = imported();
    project.sync.timeSignatures = [{ tick: 0, numerator: 3, denominator: 4 }];
    // Two 3/4 bars is six quarters: 1152 ticks, not 1536.
    const aligned = alignImportToLeadIn(project, { bars: 2, beats: 0 });
    expect(aligned.tracks.ExpertSingle.notes[0].tick).toBe(1152);
  });
});
