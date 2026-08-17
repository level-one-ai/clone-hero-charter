import { describe, expect, it } from 'vitest';
import { transcodeArgs, NO_SHAPING, type AudioShape } from './audio';

/**
 * The ffmpeg arguments ARE the export's timing.
 *
 * Everything else in the pipeline can be right and the shipped audio still start a
 * fraction of a second in the wrong place, because a single misplaced flag changes where
 * ffmpeg begins reading. These tests pin the two decisions that determine whether the
 * chart lines up with the music, both of which look like harmless style choices.
 */

function shape(overrides: Partial<AudioShape> = {}): AudioShape {
  return { ...NO_SHAPING, ...overrides };
}

describe('transcodeArgs', () => {
  it('never cuts with -ss or -to, which would trim the silence back off', () => {
    /**
     * The one that matters most, and it was got wrong first time round.
     *
     * `-ss`/`-to` after `-i` are OUTPUT options: ffmpeg appends them to the END of the
     * filter chain, so they cut the already-delayed and padded stream rather than the
     * source. Measured with ffmpeg 7: a 30s region with 4s of lead-in and 1s of tail came
     * out as a 30s file with no silence at either end, and the music four seconds early.
     *
     * `-ss` before `-i` gives the right length but seeks to a frame boundary — an MP3 cut
     * at 60s started 10.6ms late, a fixed chart-to-music offset for the whole song.
     */
    const args = transcodeArgs('in.mp3', shape({ startMs: 60_000, endMs: 90_000 }), 'wav', 'out.wav');
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-to');
    expect(args).not.toContain('-t');
  });

  it('cuts with atrim inside the chain, at absolute positions in the source', () => {
    const args = transcodeArgs('in.mp3', shape({ startMs: 60_000, endMs: 90_000 }), 'wav', 'out.wav');
    expect(args[args.indexOf('-af') + 1]).toContain('atrim=start=60.000:end=90.000');
  });

  it('rebases timestamps after trimming', () => {
    // Without asetpts the trimmed audio keeps its original presentation times, and adelay
    // adds the lead-in on top of them — leaving the region's start offset in the output.
    const args = transcodeArgs('in.mp3', shape({ startMs: 60_000, endMs: 90_000 }), 'wav', 'out.wav');
    const filters = args[args.indexOf('-af') + 1];
    expect(filters.indexOf('asetpts')).toBeGreaterThan(filters.indexOf('atrim'));
  });

  it('keeps millisecond precision in the cut', () => {
    const args = transcodeArgs('in.mp3', shape({ startMs: 60_123 }), 'wav', 'out.wav');
    expect(args[args.indexOf('-af') + 1]).toContain('start=60.123');
  });

  it('trims, then delays, then pads', () => {
    // The whole order in one assertion: cut the region out, put silence in front of it,
    // put silence behind it. Any other order produces a different file.
    const args = transcodeArgs(
      'in.mp3',
      shape({ startMs: 60_000, endMs: 90_000, leadingSilenceMs: 4000, trailingSilenceMs: 2000 }),
      'wav',
      'out.wav',
    );
    expect(args[args.indexOf('-af') + 1]).toBe(
      'atrim=start=60.000:end=90.000,asetpts=N/SR/TB,adelay=4000:all=1,apad=pad_dur=2.000',
    );
  });

  it('delays every channel, not just the first', () => {
    // Without all=1 only the first channel moves and the result is audibly out of phase.
    const args = transcodeArgs('in.mp3', shape({ leadingSilenceMs: 4000 }), 'wav', 'out.wav');
    expect(args[args.indexOf('-af') + 1]).toContain(':all=1');
  });

  it('omits the filter chain entirely when there is nothing to shape', () => {
    expect(transcodeArgs('in.wav', NO_SHAPING, 'wav', 'out.wav')).not.toContain('-af');
  });

  it('omits the cut when the whole file is wanted', () => {
    const args = transcodeArgs('in.wav', shape({ leadingSilenceMs: 1000 }), 'wav', 'out.wav');
    expect(args[args.indexOf('-af') + 1]).toBe('adelay=1000:all=1');
  });

  it('ignores an end that is not after the start', () => {
    // An inverted region would otherwise ask ffmpeg for a negative-length trim.
    const args = transcodeArgs('in.wav', shape({ startMs: 5000, endMs: 1000 }), 'wav', 'out.wav');
    expect(args[args.indexOf('-af') + 1]).toBe('atrim=start=5.000,asetpts=N/SR/TB');
  });

  it('drops video, which would otherwise break the packaged file', () => {
    expect(transcodeArgs('in.mp3', NO_SHAPING, 'wav', 'out.wav')).toContain('-vn');
  });

  it('writes 16-bit 44.1kHz PCM for WAV, which is what song folders ship', () => {
    const args = transcodeArgs('in.mp3', NO_SHAPING, 'wav', 'out.wav');
    expect(args).toContain('pcm_s16le');
    expect(args[args.indexOf('-ar') + 1]).toBe('44100');
  });

  it('overwrites a file destination but not a pipe', () => {
    expect(transcodeArgs('in.mp3', NO_SHAPING, 'wav', 'out.wav')).toContain('-y');
    expect(transcodeArgs('in.mp3', NO_SHAPING, 'ogg', 'pipe:1')).not.toContain('-y');
  });

  it('puts the destination last', () => {
    const args = transcodeArgs('in.mp3', shape({ startMs: 1000 }), 'ogg', 'out.ogg');
    expect(args[args.length - 1]).toBe('out.ogg');
  });
});
