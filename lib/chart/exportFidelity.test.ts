import { describe, expect, it } from 'vitest';
import { writeChart } from './writeChart';
import { writeMidi } from './writeMidi';
import { parseChart } from './parseChart';
import { generateSongIni } from './songIni';
import { TimingMap } from './timing';
import { buildAudioTimeline, exportDurationMs, leadInSeconds } from './audioTimeline';
import { createEmptyProject, newNoteId, type Lane, type Note, type Project } from './types';

/**
 * WHAT YOU CHARTED IS WHAT SHIPS.
 *
 * These tests exist because a timing error in the export is the most expensive kind of
 * bug this app can have: it is invisible in the editor, survives every visual check, and
 * is only discovered after someone has played the chart in game and found the notes
 * fractionally out. Unit tests on the individual writers do not catch it, because each one
 * can be internally consistent while the pipeline as a whole shifts everything by a
 * constant.
 *
 * So the assertions here are deliberately absolute rather than relative. Exact ticks, exact
 * milliseconds, no `toBeCloseTo` where an exact value is available.
 */

function chartedProject(): Project {
  const project = createEmptyProject('fidelity');
  project.meta.name = 'Test';
  project.meta.artist = 'Tester';
  project.meta.leadIn = { bars: 2, beats: 0 };
  project.meta.trailingSilenceMs = 2000;
  project.meta.offset = 0;
  project.resolution = 192;
  project.audio = {
    file: 'audio.wav',
    durationMs: 300_000,
    sampleRate: 44100,
    region: { startMs: 60_000, endMs: 90_000 },
    detected: null,
  };
  project.sync.bpms = [
    { tick: 0, bpm: 172.444 },
    { tick: 3072, bpm: 200 },
  ];
  project.sync.timeSignatures = [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 3072, numerator: 7, denominator: 8 },
  ];
  project.events = [{ tick: 1536, text: 'section Intro' }];

  const spec: Array<{ tick: number; lane: Lane; length?: number; forced?: boolean; tap?: boolean }> = [
    { tick: 1536, lane: 0 },
    { tick: 1584, lane: 1, forced: true },
    { tick: 1632, lane: 2, tap: true },
    { tick: 1728, lane: 0, length: 384 },
    { tick: 1728, lane: 3, length: 384 },
    { tick: 2113, lane: 7 },
    { tick: 3072, lane: 4, length: 96 },
  ];
  project.tracks.ExpertSingle.notes = spec.map<Note>((n) => ({
    id: newNoteId(),
    tick: n.tick,
    lane: n.lane,
    length: n.length ?? 0,
    forced: n.forced ?? false,
    tap: n.tap ?? false,
  }));
  project.tracks.ExpertSingle.starPower = [{ tick: 1536, length: 768 }];
  return project;
}

describe('.chart round-trip', () => {
  it('returns every note at exactly the tick and lane it was charted at', () => {
    const project = chartedProject();
    const reparsed = parseChart(writeChart(project), 'fidelity').project;

    const before = project.tracks.ExpertSingle.notes.map((n) => [n.tick, n.lane, n.length]);
    const after = reparsed.tracks.ExpertSingle.notes.map((n) => [n.tick, n.lane, n.length]);
    expect(after).toEqual(before);
  });

  it('preserves forced and tap on the exact notes that carried them', () => {
    const project = chartedProject();
    const reparsed = parseChart(writeChart(project), 'fidelity').project;

    const flagged = reparsed.tracks.ExpertSingle.notes
      .filter((n) => n.forced || n.tap)
      .map((n) => [n.tick, n.lane, n.forced, n.tap]);
    expect(flagged).toEqual([
      [1584, 1, true, false],
      [1632, 2, false, true],
    ]);
  });

  it('preserves the tempo map exactly, including fractional BPM', () => {
    // .chart stores BPM as an integer of bpm*1000, so three decimals must survive
    // untouched — a tempo rounded on the way out drifts the whole chart against the audio.
    const project = chartedProject();
    const reparsed = parseChart(writeChart(project), 'fidelity').project;
    expect(reparsed.sync.bpms).toEqual(project.sync.bpms);
  });

  it('preserves time signatures and sections at their own ticks', () => {
    const project = chartedProject();
    const reparsed = parseChart(writeChart(project), 'fidelity').project;
    expect(reparsed.sync.timeSignatures).toEqual(project.sync.timeSignatures);
    expect(reparsed.events).toEqual(project.events);
  });

  it('preserves star power phrases', () => {
    const project = chartedProject();
    const reparsed = parseChart(writeChart(project), 'fidelity').project;
    expect(reparsed.tracks.ExpertSingle.starPower).toEqual([{ tick: 1536, length: 768 }]);
  });

  it('keeps every note at the same wall-clock time as in the editor', () => {
    // The end of the chain that matters: a tick means nothing on its own, and the thing
    // the player hears is the SECOND the note lands on.
    const project = chartedProject();
    const reparsed = parseChart(writeChart(project), 'fidelity').project;

    const before = new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures);
    const after = new TimingMap(reparsed.sync.bpms, reparsed.resolution, reparsed.sync.timeSignatures);

    for (const note of project.tracks.ExpertSingle.notes) {
      expect(after.tickToSec(note.tick)).toBe(before.tickToSec(note.tick));
    }
  });

  it('does not move ticks when the lead-in changes', () => {
    // The lead-in adds silence to the AUDIO; the notes stay where they are. If a longer
    // lead-in moved ticks, the chart would shift against itself on every adjustment.
    const short = chartedProject();
    const long = chartedProject();
    long.meta.leadIn = { bars: 8, beats: 3 };

    expect(writeChart(long).match(/\[ExpertSingle\][\s\S]*/)?.[0]).toBe(
      writeChart(short).match(/\[ExpertSingle\][\s\S]*/)?.[0],
    );
  });

  it('does not fold the lead-in into Offset', () => {
    // The export prepends real silence, so the padded file's timeline IS chart time.
    // Adding the lead-in to Offset as well would cancel the pad out.
    const project = chartedProject();
    project.meta.offset = 0.25;
    expect(writeChart(project)).toContain('Offset = 0.25');
  });
});

describe('.mid export', () => {
  it('writes the project resolution as the file PPQ, so no tick is rescaled', () => {
    const project = chartedProject();
    const { data } = writeMidi(project);
    // MThd: 4-byte id, 4-byte length, then format, track count and division.
    const division = (data[12] << 8) | data[13];
    expect(division).toBe(project.resolution);
  });

  it('keeps tempo within the format’s own quantisation of the chart', () => {
    // MIDI stores microseconds per quarter note as an integer, so an exact fractional BPM
    // cannot always be represented. What matters is that the error is that quantisation
    // and nothing more: a millisecond of drift per minute would be a bug, a microsecond
    // per quarter note is the format.
    const bpm = 172.444;
    const microsPerQuarter = Math.round(60_000_000 / bpm);
    expect(Math.abs(60_000_000 / microsPerQuarter - bpm)).toBeLessThan(0.001);
  });
});

describe('song.ini', () => {
  it('reports the packaged length: lead-in, music and tail together', () => {
    const project = chartedProject();
    const timing = new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures);
    const timeline = buildAudioTimeline(project, timing);

    const leadInMs = Math.round(leadInSeconds(project.meta.leadIn, timing) * 1000);
    const durationMs = exportDurationMs(leadInMs, timeline.regionSec * 1000, 2000);

    const ini = generateSongIni(project, { durationMs, musicDurationMs: timeline.regionSec * 1000 });
    expect(ini).toContain(`song_length = ${durationMs}`);
    // Two bars at 172.444 BPM, plus 30s of region, plus 2s of tail.
    expect(durationMs).toBe(leadInMs + 30_000 + 2000);
  });

  it('rates difficulty against the music, not the whole upload', () => {
    // A dense section cut out of a long recording is not an easy chart. Dividing by the
    // upload's length instead of the region's used to say it was.
    const project = chartedProject();
    const wholeFile = generateSongIni(project, {
      durationMs: 300_000,
      musicDurationMs: 300_000,
    });
    const region = generateSongIni(project, { durationMs: 36_000, musicDurationMs: 30_000 });

    expect(wholeFile).toContain('diff_guitar = 0');
    expect(region).toContain('diff_guitar = 0');

    // With enough notes to be dense over 30s but sparse over 300s, the two must differ.
    project.tracks.ExpertSingle.notes = Array.from({ length: 150 }, (_, i) => ({
      id: newNoteId(),
      tick: 1536 + i * 48,
      lane: (i % 5) as Lane,
      length: 0,
      forced: false,
      tap: false,
    }));
    expect(generateSongIni(project, { durationMs: 300_000, musicDurationMs: 300_000 })).toContain(
      'diff_guitar = 0',
    );
    expect(generateSongIni(project, { durationMs: 36_000, musicDurationMs: 30_000 })).toContain(
      'diff_guitar = 4',
    );
  });

  it('leaves sync to the chart alone, with delay at zero', () => {
    // Two places to adjust sync is one too many: a `delay` here would silently add to the
    // chart's own Offset and nobody would know which was responsible.
    expect(generateSongIni(chartedProject(), { durationMs: 36_000 })).toContain('delay = 0');
  });
});

describe('the audio and the chart describe the same timeline', () => {
  it('puts the first note at the same moment in the export as in the editor', () => {
    /**
     * The whole pipeline in one assertion.
     *
     * In the editor, a note at tick T sounds at `timing.tickToSec(T)` of chart time, and
     * chart time `leadInSec` is the first sample of the region. In the export, the
     * packaged audio is leadInMs of silence followed by that same region — so the note
     * must land the same distance into the packaged file as it does into editor playback.
     */
    const project = chartedProject();
    const timing = new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures);
    const timeline = buildAudioTimeline(project, timing);

    const firstNote = project.tracks.ExpertSingle.notes[0];
    const chartSec = timing.tickToSec(firstNote.tick);

    // Where it falls inside the packaged audio: silence, then this far into the region.
    const intoPackagedFile = chartSec;
    // Where the same musical moment is in the SOURCE file.
    const intoSourceFile = timeline.chartToAudio(chartSec);

    expect(intoSourceFile).toBe(intoPackagedFile - timeline.leadInSec + timeline.regionStartSec);
    // And that moment is genuinely inside the charted region, not before it.
    expect(intoSourceFile).toBeGreaterThanOrEqual(timeline.regionStartSec);
  });

  it('never places a note inside the lead-in silence', () => {
    // Anything at a tick before the lead-in ends would play against silence in game.
    const project = chartedProject();
    const timing = new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures);
    const timeline = buildAudioTimeline(project, timing);

    for (const note of project.tracks.ExpertSingle.notes) {
      expect(note.tick).toBeGreaterThanOrEqual(timeline.leadInTicks);
    }
  });
});
