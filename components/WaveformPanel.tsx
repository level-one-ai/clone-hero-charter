'use client';

import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';

/**
 * Waveform view. Owns the audio element and is therefore the single source of truth
 * for playback position — the highway follows it, never the other way round.
 *
 * The parent drives playback through the imperative handle rather than through props,
 * because play/pause/seek are commands, not state, and modelling them as state
 * produces feedback loops between the audio element and React.
 */

export interface WaveformHandle {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  isPlaying: () => boolean;
  setPlaybackRate: (rate: number) => void;
  /** The decoded buffer, for BPM detection. Null until the audio has loaded. */
  getDecodedBuffer: () => AudioBuffer | null;
}

interface Props {
  audioUrl: string;
  handleRef: React.RefObject<WaveformHandle | null>;
  /** Fired on every authoritative position update, including seeks. */
  onTimeUpdate: (seconds: number, playing: boolean) => void;
  onReady: (durationSeconds: number) => void;
  onError: (message: string) => void;
  /** Horizontal zoom in pixels per second. */
  zoom: number;
}

export default function WaveformPanel({
  audioUrl,
  handleRef,
  onTimeUpdate,
  onReady,
  onError,
  zoom,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<WaveSurfer | null>(null);
  const [loading, setLoading] = useState(true);

  // Callbacks are mirrored into refs so changing them never tears down the
  // wavesurfer instance — re-decoding a 50 MB WAV on every parent render would be
  // both slow and audible.
  const callbacks = useRef({ onTimeUpdate, onReady, onError });
  callbacks.current = { onTimeUpdate, onReady, onError };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const wavesurfer = WaveSurfer.create({
      container,
      height: 96,
      // Monochrome to match the chrome; the lane colours belong to the highway alone.
      // Kept bright enough to read against #121212 — the waveform is a primary
      // navigation surface, so low contrast here makes the tool hard to use.
      waveColor: '#6e6e6e',
      progressColor: '#c8c8c8',
      cursorColor: '#e5e5e5',
      cursorWidth: 1,
      barWidth: 1,
      barGap: 1,
      barRadius: 0,
      normalize: true,
      autoScroll: true,
      autoCenter: true,
      // Uses a real <audio> element (rather than WebAudio-only playback) so the
      // browser can stream via HTTP Range instead of buffering the whole file first.
      backend: 'MediaElement',
      url: audioUrl,
    });

    waveRef.current = wavesurfer;

    wavesurfer.on('ready', () => {
      setLoading(false);
      callbacks.current.onReady(wavesurfer.getDuration());
      callbacks.current.onTimeUpdate(wavesurfer.getCurrentTime(), false);
    });
    wavesurfer.on('error', (error) => {
      setLoading(false);
      callbacks.current.onError(
        typeof error === 'string' ? error : ((error as Error)?.message ?? 'Could not load the audio'),
      );
    });

    // Every one of these is an authoritative reading; the highway re-anchors its
    // interpolation clock on each.
    wavesurfer.on('timeupdate', (time) => callbacks.current.onTimeUpdate(time, wavesurfer.isPlaying()));
    wavesurfer.on('seeking', (time) => callbacks.current.onTimeUpdate(time, wavesurfer.isPlaying()));
    wavesurfer.on('play', () => callbacks.current.onTimeUpdate(wavesurfer.getCurrentTime(), true));
    wavesurfer.on('pause', () => callbacks.current.onTimeUpdate(wavesurfer.getCurrentTime(), false));
    wavesurfer.on('finish', () => callbacks.current.onTimeUpdate(wavesurfer.getCurrentTime(), false));

    return () => {
      wavesurfer.destroy();
      waveRef.current = null;
    };
  }, [audioUrl]);

  useEffect(() => {
    const wavesurfer = waveRef.current;
    if (!wavesurfer || loading) return;
    try {
      wavesurfer.zoom(zoom);
    } catch {
      // zoom() throws if called before decoding finishes; the ready handler re-applies.
    }
  }, [zoom, loading]);

  useImperativeHandle(
    handleRef,
    (): WaveformHandle => ({
      play: () => void waveRef.current?.play(),
      pause: () => waveRef.current?.pause(),
      toggle: () => void waveRef.current?.playPause(),
      seek: (seconds) => {
        const wavesurfer = waveRef.current;
        if (!wavesurfer) return;
        const duration = wavesurfer.getDuration();
        if (!duration) return;
        // setTime is absolute; seekTo takes a 0-1 fraction. Absolute avoids a
        // rounding error at the very end of long songs.
        wavesurfer.setTime(Math.max(0, Math.min(seconds, duration)));
      },
      getCurrentTime: () => waveRef.current?.getCurrentTime() ?? 0,
      getDuration: () => waveRef.current?.getDuration() ?? 0,
      isPlaying: () => waveRef.current?.isPlaying() ?? false,
      setPlaybackRate: (rate) => waveRef.current?.setPlaybackRate(rate, true),
      getDecodedBuffer: () => waveRef.current?.getDecodedData() ?? null,
    }),
    [],
  );

  return (
    <div className="relative border-b border-edge bg-panel">
      <div ref={containerRef} className="px-2 py-2" />
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-2xs uppercase tracking-widest text-faint">Decoding audio…</span>
        </div>
      )}
    </div>
  );
}
