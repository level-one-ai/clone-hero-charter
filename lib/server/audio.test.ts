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
  it('cuts AFTER the input, so the seek is sample-accurate', () => {
    /**
     * The one that matters most. `-ss` before `-i` seeks by keyframe — fast, and it lands
     * on the nearest frame boundary, which for a charted region is an arbitrary error of
     * up to a frame that offsets the chart from the music forever. After `-i`, ffmpeg
     * decodes and cuts at the exact sample.
     */
    const args = transcodeArgs('in.mp3', shape({ startMs: 60_000 }), 'wav', 'out.wav');
    const inputIndex = args.indexOf('-i');
    const seekIndex = args.indexOf('-ss');
    expect(seekIndex).toBeGreaterThan(inputIndex);
  });

  it('expresses the region as absolute positions in the source file', () => {
    const args = transcodeArgs('in.mp3', shape({ startMs: 60_000, endMs: 90_000 }), 'wav', 'out.wav');
    expect(args[args.indexOf('-ss') + 1]).toBe('60.000');
    // -to shares an origin with -ss, so it is the region's end, not its length.
    expect(args[args.indexOf('-to') + 1]).toBe('90.000');
  });

  it('keeps millisecond precision in the timestamps', () => {
    const args = transcodeArgs('in.mp3', shape({ startMs: 60_123 }), 'wav', 'out.wav');
    expect(args[args.indexOf('-ss') + 1]).toBe('60.123');
  });

  it('delays before it pads, so silence lands on the right end', () => {
    // Filters run in the order given: the lead-in has to come before the music and the
    // tail after it. Reversed, the file would be padded and then the whole thing delayed.
    const args = transcodeArgs(
      'in.mp3',
      shape({ leadingSilenceMs: 4000, trailingSilenceMs: 2000 }),
      'wav',
      'out.wav',
    );
    const filters = args[args.indexOf('-af') + 1];
    expect(filters).toBe('adelay=4000:all=1,apad=pad_dur=2.000');
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
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-to');
  });

  it('ignores an end that is not after the start', () => {
    // An inverted region would otherwise ask ffmpeg for a negative duration.
    const args = transcodeArgs('in.wav', shape({ startMs: 5000, endMs: 1000 }), 'wav', 'out.wav');
    expect(args).not.toContain('-to');
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
