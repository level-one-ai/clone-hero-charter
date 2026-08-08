import { describe, expect, it } from 'vitest';
import { Midi } from '@tonejs/midi';
import { midiToChart, DIFFICULTY_BASE } from './midiToChart';
import { DEFAULT_RESOLUTION } from './types';

const R = DEFAULT_RESOLUTION; // 192

/**
 * Build a reference .mid in memory so the converter is tested against a real parsed
 * MIDI file rather than a hand-made stub. PPQ 480 is the common real-world value and
 * exercises the tick rescaling (480 -> 192).
 */
function buildReferenceMidi(options: {
  trackName?: string;
  ppq?: number;
  semitoneShift?: number;
} = {}): Uint8Array {
  const midi = new Midi();
  // header.ppq is read-only; fromJSON is the supported way to set it.
  const headerJson = midi.header.toJSON();
  headerJson.ppq = options.ppq ?? 480;
  midi.header.fromJSON(headerJson);

  const ppq = midi.header.ppq;
  const shift = options.semitoneShift ?? 0;

  midi.header.setTempo(120);

  const track = midi.addTrack();
  track.name = options.trackName ?? 'PART GUITAR';

  const add = (midiNote: number, quarterNotes: number, durationQuarters: number) => {
    track.addNote({
      midi: midiNote + shift,
      ticks: Math.round(quarterNotes * ppq),
      durationTicks: Math.round(durationQuarters * ppq),
    });
  };

  const expert = DIFFICULTY_BASE.Expert;
  // Beat 4: a green+red chord, marked forced.
  add(expert + 0, 4, 0.1);
  add(expert + 1, 4, 0.1);
  add(expert + 5, 4, 0.1); // forced flag
  // Beat 5: a yellow with a one-quarter-note sustain.
  add(expert + 2, 5, 1);
  // Beat 6: an open note.
  add(expert + 7, 6, 0.1);
  // Beat 8: orange inside a tap phrase.
  add(expert + 4, 8, 0.1);
  add(104, 8, 0.5); // global tap phrase
  // Star power phrase covering beats 4-8.
  add(116, 4, 4);

  // A sparser Hard chart, to prove difficulties are independent.
  add(DIFFICULTY_BASE.Hard + 0, 4, 0.1);
  add(DIFFICULTY_BASE.Hard + 3, 6, 0.1);

  return new Uint8Array(midi.toArray());
}

describe('midiToChart', () => {
  it('rescales ticks from the file PPQ to the chart resolution', () => {
    const { project } = midiToChart(buildReferenceMidi({ ppq: 480 }), 'test-id');
    const notes = project.tracks.ExpertSingle.notes;
    // Beat 4 at ppq 480 is midi tick 1920; at resolution 192 that is tick 768.
    expect(notes.some((n) => n.tick === R * 4)).toBe(true);
    expect(notes.some((n) => n.tick === R * 5)).toBe(true);
  });

  it('produces identical output from a file with a different PPQ', () => {
    const a = midiToChart(buildReferenceMidi({ ppq: 480 }), 'id').project;
    const b = midiToChart(buildReferenceMidi({ ppq: 96 }), 'id').project;
    const strip = (p: typeof a) =>
      p.tracks.ExpertSingle.notes.map(({ id, ...rest }) => rest);
    expect(strip(b)).toEqual(strip(a));
  });

  it('imports the tempo map', () => {
    const { project, report } = midiToChart(buildReferenceMidi(), 'id');
    expect(project.sync.bpms[0].tick).toBe(0);
    expect(project.sync.bpms[0].bpm).toBeCloseTo(120, 3);
    expect(report.tempoCount).toBeGreaterThanOrEqual(1);
  });

  it('maps fret notes to lanes and folds the forced flag in', () => {
    const { project } = midiToChart(buildReferenceMidi(), 'id');
    const chord = project.tracks.ExpertSingle.notes.filter((n) => n.tick === R * 4);
    expect(chord.map((n) => n.lane).sort()).toEqual([0, 1]); // note 101 is a flag, not a note
    expect(chord.every((n) => n.forced)).toBe(true);
  });

  it('applies the sustain cutoff so short notes are not sustains', () => {
    const { project } = midiToChart(buildReferenceMidi(), 'id');
    const notes = project.tracks.ExpertSingle.notes;
    // 0.1 quarter notes is below resolution/3, so it becomes a plain note.
    expect(notes.find((n) => n.tick === R * 4)!.length).toBe(0);
    // A full quarter note is well above the cutoff and stays a sustain.
    expect(notes.find((n) => n.tick === R * 5)!.length).toBe(R);
  });

  it('reads open notes and global tap phrases', () => {
    const { project } = midiToChart(buildReferenceMidi(), 'id');
    const notes = project.tracks.ExpertSingle.notes;
    expect(notes.find((n) => n.tick === R * 6)!.lane).toBe(7);
    expect(notes.find((n) => n.tick === R * 8)!.tap).toBe(true);
    expect(notes.find((n) => n.tick === R * 4)!.tap).toBe(false);
  });

  it('imports star power phrases', () => {
    const { project } = midiToChart(buildReferenceMidi(), 'id');
    expect(project.tracks.ExpertSingle.starPower).toEqual([{ tick: R * 4, length: R * 4 }]);
  });

  it('keeps difficulties independent', () => {
    const { project, report } = midiToChart(buildReferenceMidi(), 'id');
    expect(report.notesPerDifficulty.Expert).toBe(5);
    expect(report.notesPerDifficulty.Hard).toBe(2);
    expect(report.notesPerDifficulty.Medium).toBe(0);
    expect(project.tracks.MediumSingle.notes).toEqual([]);
  });

  it('reports a note histogram and track summaries for diagnosis', () => {
    const { report } = midiToChart(buildReferenceMidi(), 'id');
    expect(report.selectedTrack).toBe('PART GUITAR');
    expect(report.noteHistogram[96]).toBe(1);
    expect(report.noteHistogram[101]).toBe(1); // the forced flag shows up in the histogram
    expect(report.trackSummaries.length).toBeGreaterThan(0);
    expect(report.trackSummaries[0].range).not.toBeNull();
  });

  it('detects and corrects a non-standard octave offset', () => {
    // A file charted an octave low: everything shifted down 12 semitones.
    const { project, report } = midiToChart(buildReferenceMidi({ semitoneShift: -12 }), 'id');
    expect(report.octaveOffset).toBe(-12);
    expect(report.notesPerDifficulty.Expert).toBe(5);
    expect(project.tracks.ExpertSingle.notes.length).toBe(5);
    expect(report.warnings.some((w) => w.includes('semitones'))).toBe(true);
  });

  it('does not "correct" a standard file', () => {
    expect(midiToChart(buildReferenceMidi(), 'id').report.octaveOffset).toBe(0);
  });

  it('falls back to the densest track when no standard name is present', () => {
    const { report } = midiToChart(buildReferenceMidi({ trackName: 'Lead Gtr' }), 'id');
    expect(report.selectedTrack).toBe('Lead Gtr');
    expect(report.selectionReason).toContain('fell back');
    expect(report.warnings.some((w) => w.includes('PART GUITAR'))).toBe(true);
  });

  it('returns an empty chart rather than throwing on a note-free MIDI', () => {
    const midi = new Midi();
    midi.addTrack().name = 'PART GUITAR';
    const { project, report } = midiToChart(new Uint8Array(midi.toArray()), 'id');
    expect(project.tracks.ExpertSingle.notes).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
