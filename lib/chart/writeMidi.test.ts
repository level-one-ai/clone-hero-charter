import { describe, expect, it } from 'vitest';
import { Midi } from '@tonejs/midi';
import { writeMidi } from './writeMidi';
import { convertParsedMidi, DIFFICULTY_BASE } from './midiToChart';
import { createEmptyProject, type Lane, type Project } from './types';

function project(): Project {
  const p = createEmptyProject('test-id');
  p.meta.name = 'Test Song';
  p.sync.bpms = [{ tick: 0, bpm: 120 }];
  p.sync.timeSignatures = [{ tick: 0, numerator: 4, denominator: 4 }];
  return p;
}

function note(tick: number, lane: Lane, extra: Partial<{ length: number; forced: boolean; tap: boolean }> = {}) {
  return {
    id: `n${tick}-${lane}`,
    tick,
    lane,
    length: extra.length ?? 0,
    forced: extra.forced ?? false,
    tap: extra.tap ?? false,
  };
}

/** Write, then read back through our own importer — the round trip is the real test. */
function roundTrip(p: Project): Project {
  const { data } = writeMidi(p);
  return convertParsedMidi(new Midi(data), 'round-trip', { mode: 'chart' }).project;
}

describe('writeMidi', () => {
  it('produces a file @tonejs/midi can parse', () => {
    const { data } = writeMidi(project());
    const midi = new Midi(data);
    expect(midi.tracks.length).toBeGreaterThanOrEqual(2);
    expect(midi.header.ppq).toBe(192);
  });

  it('starts with the MThd magic bytes', () => {
    const { data } = writeMidi(project());
    expect(String.fromCharCode(...data.slice(0, 4))).toBe('MThd');
  });

  it('names the guitar track PART GUITAR', () => {
    const { data } = writeMidi(project());
    const names = new Midi(data).tracks.map((t) => t.name);
    expect(names).toContain('PART GUITAR');
    expect(names).toContain('EVENTS');
  });

  it('writes the tempo map', () => {
    const p = project();
    p.sync.bpms = [
      { tick: 0, bpm: 140 },
      { tick: 1920, bpm: 90 },
    ];
    const midi = new Midi(writeMidi(p).data);
    const tempos = midi.header.tempos.map((t) => Math.round(t.bpm));
    expect(tempos).toContain(140);
    expect(tempos).toContain(90);
  });

  it('writes the time signature', () => {
    const p = project();
    p.sync.timeSignatures = [{ tick: 0, numerator: 6, denominator: 8 }];
    const midi = new Midi(writeMidi(p).data);
    expect(midi.header.timeSignatures[0].timeSignature).toEqual([6, 8]);
  });

  it('uses the documented note number for each difficulty and lane', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 0)];
    p.tracks.HardSingle.notes = [note(0, 2)];
    p.tracks.MediumSingle.notes = [note(0, 4)];
    p.tracks.EasySingle.notes = [note(0, 1)];

    const guitar = new Midi(writeMidi(p).data).tracks.find((t) => t.name === 'PART GUITAR')!;
    const numbers = guitar.notes.map((n) => n.midi);
    expect(numbers).toContain(DIFFICULTY_BASE.Expert + 0);
    expect(numbers).toContain(DIFFICULTY_BASE.Hard + 2);
    expect(numbers).toContain(DIFFICULTY_BASE.Medium + 4);
    expect(numbers).toContain(DIFFICULTY_BASE.Easy + 1);
  });

  it('writes open notes as base + 7', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 7)];
    const guitar = new Midi(writeMidi(p).data).tracks.find((t) => t.name === 'PART GUITAR')!;
    expect(guitar.notes.map((n) => n.midi)).toContain(DIFFICULTY_BASE.Expert + 7);
  });

  it('writes star power as note 116 and taps as note 104', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 0, { tap: true })];
    p.tracks.ExpertSingle.starPower = [{ tick: 0, length: 768 }];
    const guitar = new Midi(writeMidi(p).data).tracks.find((t) => t.name === 'PART GUITAR')!;
    const numbers = guitar.notes.map((n) => n.midi);
    expect(numbers).toContain(116);
    expect(numbers).toContain(104);
  });

  it('round-trips notes, lanes and ticks exactly', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [
      note(0, 0),
      note(192, 2),
      note(384, 4),
      note(576, 7),
      note(768, 1),
      note(768, 3),
    ];
    const back = roundTrip(p);
    expect(back.tracks.ExpertSingle.notes.map((n) => [n.tick, n.lane])).toEqual([
      [0, 0],
      [192, 2],
      [384, 4],
      [576, 7],
      [768, 1],
      [768, 3],
    ]);
  });

  it('round-trips sustains, and keeps short notes un-sustained', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 0, { length: 384 }), note(960, 1)];
    const back = roundTrip(p).tracks.ExpertSingle.notes;
    expect(back[0].length).toBe(384);
    // A note with no sustain must not come back as one — the blip stays below the
    // importer's resolution/3 cutoff.
    expect(back[1].length).toBe(0);
  });

  it('round-trips forced and tap flags', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [
      note(0, 0, { forced: true }),
      note(192, 1, { tap: true }),
      note(384, 2),
    ];
    const back = roundTrip(p).tracks.ExpertSingle.notes;
    expect(back[0]).toMatchObject({ forced: true });
    expect(back[1]).toMatchObject({ tap: true });
    expect(back[2]).toMatchObject({ forced: false, tap: false });
  });

  it('round-trips star power phrases', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 0), note(384, 1)];
    p.tracks.ExpertSingle.starPower = [{ tick: 0, length: 768 }];
    const back = roundTrip(p);
    expect(back.tracks.ExpertSingle.starPower).toEqual([{ tick: 0, length: 768 }]);
  });

  it('round-trips every difficulty independently', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 0), note(192, 1), note(384, 2)];
    p.tracks.HardSingle.notes = [note(0, 0), note(192, 1)];
    p.tracks.MediumSingle.notes = [note(0, 0)];
    const back = roundTrip(p);
    expect(back.tracks.ExpertSingle.notes).toHaveLength(3);
    expect(back.tracks.HardSingle.notes).toHaveLength(2);
    expect(back.tracks.MediumSingle.notes).toHaveLength(1);
    expect(back.tracks.EasySingle.notes).toHaveLength(0);
  });

  it('round-trips the tempo map', () => {
    const p = project();
    p.sync.bpms = [
      { tick: 0, bpm: 140 },
      { tick: 1920, bpm: 90 },
    ];
    p.tracks.ExpertSingle.notes = [note(0, 0)];
    const back = roundTrip(p);
    expect(back.sync.bpms).toEqual([
      { tick: 0, bpm: 140 },
      { tick: 1920, bpm: 90 },
    ]);
  });

  it('writes section markers as [section Name] text events', () => {
    const p = project();
    p.events = [{ tick: 384, text: 'Chorus' }];
    const { data } = writeMidi(p);
    // Decode the raw bytes: @tonejs/midi does not surface text meta-events.
    expect(new TextDecoder().decode(data)).toContain('[section Chorus]');
  });

  it('does not double-wrap a section that is already bracketed', () => {
    const p = project();
    p.events = [{ tick: 0, text: '[section Intro]' }];
    expect(new TextDecoder().decode(writeMidi(p).data)).not.toContain('[[section');
  });

  it('warns when a lower difficulty has different star power', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 0)];
    p.tracks.ExpertSingle.starPower = [{ tick: 0, length: 768 }];
    p.tracks.HardSingle.notes = [note(0, 0)];
    p.tracks.HardSingle.starPower = [{ tick: 1920, length: 768 }];
    expect(writeMidi(p).warnings.join(' ')).toMatch(/star power/i);
  });

  it('warns when a lower difficulty taps different notes', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 0, { tap: true })];
    p.tracks.HardSingle.notes = [note(0, 0)];
    expect(writeMidi(p).warnings.join(' ')).toMatch(/tap/i);
  });

  it('stays quiet when the difficulties agree', () => {
    const p = project();
    p.tracks.ExpertSingle.notes = [note(0, 0)];
    p.tracks.HardSingle.notes = [note(0, 0)];
    expect(writeMidi(p).warnings).toEqual([]);
  });

  it('handles an empty chart without producing a broken file', () => {
    const { data } = writeMidi(project());
    expect(() => new Midi(data)).not.toThrow();
  });
});
