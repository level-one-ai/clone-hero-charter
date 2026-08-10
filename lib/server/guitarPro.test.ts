import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isGuitarProExtension, parseGuitarPro } from './guitarPro';
import { convertParsedMidi } from '../chart/midiToChart';

/**
 * Fixtures are the test files from rageagainsthepc/GuitarPro-to-Midi (MIT), covering
 * every Guitar Pro format from 3 to 7 — the same files that project uses to prove its
 * own parser, which makes them a fair check on ours.
 */
const FIXTURES = path.join(__dirname, '__fixtures__');
const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

const CASES = [
  { file: 'test_gp3.gp3', title: 'Enter Sandman', tracks: 5, tempo: 123 },
  { file: 'test_gp4.gp4', title: 'Bad Religion', tracks: 3, tempo: 154 },
  { file: 'test_gp5.gp5', title: 'Astronomy', tracks: 5, tempo: 90 },
  { file: 'test_gp6.gpx', title: '', tracks: 1, tempo: 155 },
  { file: 'test_gp7.gp', title: 'SHALLOW', tracks: 1, tempo: 96 },
] as const;

describe('isGuitarProExtension', () => {
  it('accepts every Guitar Pro extension, case-insensitively', () => {
    for (const ext of ['.gp3', '.gp4', '.gp5', '.gpx', '.gp', '.GP5']) {
      expect(isGuitarProExtension(ext)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const ext of ['.mid', '.midi', '.chart', '.gpif', '.zip', '']) {
      expect(isGuitarProExtension(ext)).toBe(false);
    }
  });
});

describe('parseGuitarPro', () => {
  for (const testCase of CASES) {
    describe(testCase.file, () => {
      const result = parseGuitarPro(read(testCase.file));

      it('reports the right track count and real track names', () => {
        expect(result.parsed.tracks).toHaveLength(testCase.tracks);
        // The point of going through the score model: names, not "track 4".
        for (const track of result.parsed.tracks) {
          expect(track.name.trim()).not.toBe('');
        }
      });

      it('reads the title from the file', () => {
        expect(result.meta.title).toBe(testCase.title);
      });

      it('has a tempo at tick 0 matching the score', () => {
        const first = result.parsed.header.tempos[0];
        expect(first.ticks).toBe(0);
        expect(Math.round(first.bpm)).toBe(testCase.tempo);
      });

      it('produces notes with non-negative ticks and durations', () => {
        const all = result.parsed.tracks.flatMap((t) => t.notes);
        expect(all.length).toBeGreaterThan(0);
        for (const note of all) {
          expect(note.ticks).toBeGreaterThanOrEqual(0);
          expect(note.durationTicks).toBeGreaterThanOrEqual(0);
          expect(note.midi).toBeGreaterThanOrEqual(0);
          expect(note.midi).toBeLessThanOrEqual(127);
        }
      });

      it('converts to a chart with notes on the highway', () => {
        const { project } = convertParsedMidi(result.parsed, 'test-id');
        const total = Object.values(project.tracks).reduce((n, t) => n + t.notes.length, 0);
        expect(total).toBeGreaterThan(0);
        expect(project.sync.bpms[0].tick).toBe(0);
        for (const track of Object.values(project.tracks)) {
          for (const note of track.notes) {
            expect(note.tick).toBeGreaterThanOrEqual(0);
            expect(note.lane === 7 || (note.lane >= 0 && note.lane <= 4)).toBe(true);
          }
        }
      });
    });
  }

  it('closes a re-struck note rather than losing it', () => {
    // Enter Sandman is dense enough that repeated pitches on one channel are certain;
    // every note-on must have produced exactly one note.
    const result = parseGuitarPro(read('test_gp3.gp3'));
    const total = result.parsed.tracks.reduce((n, t) => n + t.notes.length, 0);
    expect(total).toBe(5481);
  });

  it('gives a helpful error for a file that is not Guitar Pro at all', () => {
    expect(() => parseGuitarPro(new Uint8Array([1, 2, 3, 4]))).toThrow(/could not be read/i);
  });
});
