import { describe, expect, it } from 'vitest';
import {
  exportAudioContentType,
  exportAudioName,
  exportProjectFor,
  resolveExportFile,
  type ExportPlan,
} from './exportPlan';
import { createEmptyProject } from '../chart/types';

function planWith(overrides: Partial<ExportPlan> = {}): ExportPlan {
  const project = createEmptyProject('abc123');
  project.meta.name = 'Bad Habit';
  project.meta.artist = 'Volumes';
  project.meta.charter = 'MilfMilker';
  return {
    project,
    folderName: 'Volumes - Bad Habit (MilfMilker)',
    chartFormat: 'chart',
    audioPath: '/data/songs/abc123/audio.mp3',
    audioExt: '.mp3',
    audioFormat: 'wav',
    copyAudioVerbatim: false,
    canTranscode: true,
    leadingSilenceMs: 0,
    durationMs: 200_000,
    warnings: [],
    files: ['notes.chart', 'song.wav', 'song.ini'],
    ...overrides,
  };
}

describe('exportAudioName', () => {
  it('is song.wav for the default format', () => {
    expect(exportAudioName(true, 'wav', '.mp3')).toBe('song.wav');
  });

  it('is song.ogg when OGG was asked for', () => {
    expect(exportAudioName(true, 'ogg', '.mp3')).toBe('song.ogg');
  });

  it('falls back to the source extension when ffmpeg cannot convert', () => {
    expect(exportAudioName(false, 'wav', '.mp3')).toBe('song.mp3');
    expect(exportAudioName(false, 'wav', '.opus')).toBe('song.opus');
  });
});

describe('exportProjectFor', () => {
  it('does NOT fold the lead-in into the offset', () => {
    // The audio is padded with real silence instead, so the padded timeline is chart
    // time. Adding it to Offset too would cancel the pad out and undo the whole point
    // of dragging the waveform right.
    const plan = planWith({ leadingSilenceMs: 2000 });
    plan.project.meta.offset = 0.5;
    expect(exportProjectFor(plan).meta.offset).toBeCloseTo(0.5, 6);
  });

  it('leaves the offset alone with no lead-in', () => {
    const plan = planWith({ leadingSilenceMs: 0 });
    plan.project.meta.offset = 0.25;
    expect(exportProjectFor(plan).meta.offset).toBeCloseTo(0.25, 6);
  });

  it('does not move any ticks', () => {
    const plan = planWith({ leadingSilenceMs: 5000 });
    plan.project.tracks.ExpertSingle.notes = [
      { id: 'a', tick: 768, lane: 0, length: 192, forced: false, tap: false },
    ];
    plan.project.sync.bpms = [{ tick: 0, bpm: 120 }];
    const exported = exportProjectFor(plan);
    expect(exported.tracks.ExpertSingle.notes[0].tick).toBe(768);
    expect(exported.sync.bpms[0].tick).toBe(0);
  });
});

describe('resolveExportFile', () => {
  it('generates notes.chart as text, naming the audio it ships', () => {
    const resolved = resolveExportFile(planWith(), 'abc123', 'notes.chart');
    expect(resolved?.kind).toBe('text');
    if (resolved?.kind === 'text') {
      expect(resolved.body).toContain('[Song]');
      // MusicStream used to be hardcoded to song.ogg even when a WAV was shipped.
      expect(resolved.body).toContain('MusicStream = "song.wav"');
    }
  });

  it('generates notes.mid as MIDI bytes when that format was chosen', () => {
    const plan = planWith({
      chartFormat: 'mid',
      files: ['notes.mid', 'song.wav', 'song.ini'],
    });
    const resolved = resolveExportFile(plan, 'abc123', 'notes.mid');
    expect(resolved?.kind).toBe('binary');
    if (resolved?.kind === 'binary') {
      expect(String.fromCharCode(...resolved.body.slice(0, 4))).toBe('MThd');
    }
  });

  it('generates song.ini as text', () => {
    const resolved = resolveExportFile(planWith(), 'abc123', 'song.ini');
    expect(resolved?.kind).toBe('text');
    if (resolved?.kind === 'text') expect(resolved.body).toContain('[song]');
  });

  it('resolves the audio name to the audio stream', () => {
    expect(resolveExportFile(planWith(), 'abc123', 'song.wav')?.kind).toBe('audio');
  });

  it('rejects a name that is not part of this export', () => {
    // song.mp3 is a real audio name, but not for a plan that is producing WAV.
    expect(resolveExportFile(planWith(), 'abc123', 'song.mp3')).toBeNull();
    expect(resolveExportFile(planWith(), 'abc123', 'notes.mid')).toBeNull();
    expect(resolveExportFile(planWith(), 'abc123', 'secrets.txt')).toBeNull();
  });

  it('rejects traversal, because the name must be one the plan listed', () => {
    for (const name of ['../project.json', '../../songs.json', '/etc/passwd', 'notes.chart/..']) {
      expect(resolveExportFile(planWith(), 'abc123', name)).toBeNull();
    }
  });

  it('rejects album art when the project has none, even if asked for', () => {
    const plan = planWith({ files: ['notes.chart', 'song.wav', 'song.ini', 'album.png'] });
    plan.project.album = null;
    expect(resolveExportFile(plan, 'abc123', 'album.png')).toBeNull();
  });
});

describe('exportAudioContentType', () => {
  it('follows the target format', () => {
    expect(exportAudioContentType(planWith())).toBe('audio/wav');
    expect(exportAudioContentType(planWith({ audioFormat: 'ogg' }))).toBe('audio/ogg');
  });

  it('follows the source extension when ffmpeg cannot convert', () => {
    expect(exportAudioContentType(planWith({ canTranscode: false, audioExt: '.mp3' }))).toBe(
      'audio/mpeg',
    );
  });
});
