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
  /** Silence before the music starts, in milliseconds. */
  leadingSilenceMs: number;
  /** Called as the lead-in grip is dragged, and once more when it is released. */
  onLeadingSilenceChange: (ms: number, committed: boolean) => void;
}

/**
 * Widest the lead-in gutter is allowed to grow on screen. Past this the waveform would
 * be pushed off the right-hand side; the gutter stops growing and reports the value
 * numerically instead.
 */
const MAX_GUTTER_PX = 320;

export default function WaveformPanel({
  audioUrl,
  handleRef,
  onTimeUpdate,
  onReady,
  onError,
  zoom,
  leadingSilenceMs,
  onLeadingSilenceChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<WaveSurfer | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);

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
      // Deliberately short: the waveform is for navigation, and every pixel it gives
      // back goes to the highway, which is what you actually chart on.
      height: 56,
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

  /**
   * The lead-in, drawn to scale.
   *
   * Dragging the grip pushes the audio to the right, which is exactly what the lead-in
   * does to the song: the music starts later and the highway gains empty space before
   * the first beat. Width comes from the same pixels-per-second as the zoom, so what you
   * drag out is the silence you get.
   */
  const gutterPx = Math.min(MAX_GUTTER_PX, (leadingSilenceMs / 1000) * zoom);
  const clamped = gutterPx >= MAX_GUTTER_PX && leadingSilenceMs > 0;

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startMs = leadingSilenceMs;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDragging(true);

    const move = (moveEvent: PointerEvent) => {
      const deltaMs = ((moveEvent.clientX - startX) / zoom) * 1000;
      onLeadingSilenceChange(clampMs(startMs + deltaMs), false);
    };
    const end = (endEvent: PointerEvent) => {
      const deltaMs = ((endEvent.clientX - startX) / zoom) * 1000;
      onLeadingSilenceChange(clampMs(startMs + deltaMs), true);
      setDragging(false);
      target.releasePointerCapture(endEvent.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  return (
    <div className="relative flex items-stretch overflow-hidden border-b border-edge bg-panel">
      {/* Lead-in: the silence before the music, to scale. */}
      <div
        className="relative shrink-0 border-r border-edge2"
        style={{ width: gutterPx, background: 'repeating-linear-gradient(135deg, #1a1a1a 0 6px, #141414 6px 12px)' }}
      >
        {gutterPx > 46 && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-2xs text-faint">
            {(leadingSilenceMs / 1000).toFixed(2)}s{clamped ? '+' : ''}
          </span>
        )}
      </div>

      {/*
        The grip. Always present, even at zero lead-in, so the feature is discoverable —
        an affordance that only appears once you already know about it is no affordance.
      */}
      <div
        onPointerDown={startDrag}
        title="Drag right to add silence before the song starts"
        className={`z-10 flex w-2 shrink-0 cursor-ew-resize items-center justify-center ${
          dragging ? 'bg-fg' : 'bg-edge2 hover:bg-muted'
        }`}
      >
        <span className="pointer-events-none text-2xs leading-none text-bg">⋮</span>
      </div>

      <div className="min-w-0 flex-1">
        <div ref={containerRef} className="px-2 py-1" />
      </div>

      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-2xs uppercase tracking-widest text-faint">Decoding audio…</span>
        </div>
      )}
    </div>
  );
}

/** Lead-in bounds: never negative, and 60s is far past any musical use. */
function clampMs(ms: number): number {
  return Math.max(0, Math.min(60_000, Math.round(ms)));
}
