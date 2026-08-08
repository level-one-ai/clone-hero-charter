import { describe, expect, it } from 'vitest';
import { exportFolderName, isValidSongId, sanitizeFilename } from './paths';
import { generateSongIni } from '../chart/songIni';
import { createEmptyProject } from '../chart/types';

describe('exportFolderName', () => {
  it('builds the Clone Hero library convention', () => {
    expect(
      exportFolderName({ artist: 'ERRA', name: 'Gore of Being', charter: 'enerbewow' }),
    ).toBe('ERRA - Gore of Being (enerbewow)');
  });

  it('matches the other naming shapes in a real library', () => {
    expect(
      exportFolderName({ artist: 'I See Stars', name: 'Ten Thousand Feet', charter: 'TheAssman' }),
    ).toBe('I See Stars - Ten Thousand Feet (TheAssman)');
    expect(
      exportFolderName({
        artist: 'Chunk! No, Captain Chunk!',
        name: 'Haters Gonna Hate',
        charter: '[FOC] NHBageL',
      }),
    ).toBe('Chunk! No, Captain Chunk! - Haters Gonna Hate ([FOC] NHBageL)');
  });

  it('omits the parentheses entirely when there is no charter', () => {
    // "Artist - Title ()" reads as a bug and sorts oddly in the song browser.
    expect(exportFolderName({ artist: 'ERRA', name: 'Gore of Being', charter: '' })).toBe(
      'ERRA - Gore of Being',
    );
    expect(exportFolderName({ artist: 'ERRA', name: 'Gore of Being', charter: '   ' })).toBe(
      'ERRA - Gore of Being',
    );
  });

  it('keeps parentheses and hyphens but strips characters Windows rejects', () => {
    expect(
      exportFolderName({ artist: 'AC/DC', name: 'T.N.T: Live?', charter: 'me<>|' }),
    ).toBe('ACDC - T.N.T Live (me)');
  });

  it('falls back on missing artist or title', () => {
    expect(exportFolderName({ artist: '', name: '', charter: 'dean' })).toBe(
      'Unknown Artist - Untitled (dean)',
    );
  });

  it('trims surrounding whitespace on every part', () => {
    expect(
      exportFolderName({ artist: '  ERRA  ', name: '  Gore of Being ', charter: ' enerbewow ' }),
    ).toBe('ERRA - Gore of Being (enerbewow)');
  });

  it('never produces a name ending in a dot or space', () => {
    // Windows silently mangles those, which breaks extraction.
    const name = exportFolderName({ artist: 'Band', name: 'Song.', charter: '' });
    expect(name.endsWith('.')).toBe(false);
    expect(name.endsWith(' ')).toBe(false);
  });
});

describe('sanitizeFilename', () => {
  it('preserves parentheses, which the folder convention depends on', () => {
    expect(sanitizeFilename('Band - Song (Charter)')).toBe('Band - Song (Charter)');
  });

  it('falls back when everything is stripped', () => {
    expect(sanitizeFilename('///', 'Untitled')).toBe('Untitled');
  });
});

describe('isValidSongId', () => {
  it('accepts generated ids and rejects traversal attempts', () => {
    expect(isValidSongId('V1StGXR8_Z5j')).toBe(true);
    expect(isValidSongId('../../etc/passwd')).toBe(false);
    expect(isValidSongId('ab')).toBe(false);
    expect(isValidSongId('a/b/c')).toBe(false);
  });
});

describe('generateSongIni', () => {
  function project(overrides: Partial<ReturnType<typeof createEmptyProject>['meta']> = {}) {
    const p = createEmptyProject('id');
    p.meta = { ...p.meta, name: 'Gore of Being', artist: 'ERRA', charter: 'enerbewow', ...overrides };
    p.audio.durationMs = 213480;
    return p;
  }

  it('writes the fields Clone Hero reads', () => {
    const ini = generateSongIni(project({ album: 'Bleak', year: 2016, genre: 'Metalcore' }), {
      durationMs: 213480,
    });
    expect(ini).toContain('[song]');
    expect(ini).toContain('name = Gore of Being');
    expect(ini).toContain('artist = ERRA');
    expect(ini).toContain('album = Bleak');
    expect(ini).toContain('year = 2016');
    expect(ini).toContain('genre = Metalcore');
    expect(ini).toContain('charter = enerbewow');
    expect(ini).toContain('song_length = 213480');
  });

  it('omits optional fields that are empty rather than writing blanks', () => {
    const ini = generateSongIni(project({ album: '', year: null, genre: '' }), {
      durationMs: 213480,
    });
    expect(ini).not.toContain('album =');
    expect(ini).not.toContain('year =');
    expect(ini).not.toContain('genre =');
    expect(ini).not.toContain('icon =');
    expect(ini).not.toContain('loading_phrase =');
  });

  it('always emits song_length, the one field that affects playback', () => {
    const ini = generateSongIni(project(), { durationMs: 0 });
    expect(ini).toContain('song_length = 0');
  });

  it('rounds song_length to whole milliseconds', () => {
    expect(generateSongIni(project(), { durationMs: 213480.7 })).toContain('song_length = 213481');
  });

  it('marks uncharted instruments as -1 so Clone Hero does not offer them', () => {
    const ini = generateSongIni(project(), { durationMs: 1000 });
    for (const key of ['diff_bass', 'diff_drums', 'diff_keys']) {
      expect(ini).toContain(`${key} = -1`);
    }
  });
});
