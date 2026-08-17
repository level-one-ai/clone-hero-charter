'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';

/**
 * Waveform view. Owns the audio element and is therefore the single source of truth
 * for playback position — the highway follows it, never the other way round.
 *
 * The parent drives playback through the imperative handle rather than through props,
 * because play/pause/seek are commands, not state, and modelling them as state
 * produces feedback loops between the audio element and React.
 *
 * It also owns REGION SELECTION: dragging across the waveform marks the slice of a long
 * upload this chart covers. That is a direct manipulation of the audio, so it belongs on
 * the audio, not in a panel of number fields somewhere else on screen.
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

export interface RegionSelection {
  startSec: number;
  endSec: number;
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
  /** Lead-in length in seconds, drawn to scale as a gutter before the waveform. */
  leadInSec: number;
  /** How the lead-in reads in musical terms, e.g. "2 bars". */
  leadInLabel: string;
  /** The charted slice of the file, or null when the whole file is charted. */
  region: RegionSelection | null;
  /** Fired while a region edge is dragged, and once more on release. */
  onRegionChange: (region: RegionSelection | null, committed: boolean) => void;
  /** True while the charter is picking a region; drag-select is only armed then. */
  selecting: boolean;
}

/**
 * Widest the lead-in gutter is allowed to grow on screen. Past this the waveform would
 * be pushed off the right-hand side; the gutter stops growing and reports the value
 * numerically instead.
 */
const MAX_GUTTER_PX = 320;

/** Region fill. Translucent so the waveform underneath stays readable. */
const REGION_COLOR = 'rgba(70, 198, 70, 0.14)';

export default function WaveformPanel({
  audioUrl,
  handleRef,
  onTimeUpdate,
  onReady,
  onError,
  zoom,
  leadInSec,
  leadInLabel,
  region,
  onRegionChange,
  selecting,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const [loading, setLoading] = useState(true);

  // Callbacks are mirrored into refs so changing them never tears down the
  // wavesurfer instance — re-decoding a 50 MB WAV on every parent render would be
  // both slow and audible.
  const callbacks = useRef({ onTimeUpdate, onReady, onError, onRegionChange });
  callbacks.current = { onTimeUpdate, onReady, onError, onRegionChange };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const regions = RegionsPlugin.create();
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
      plugins: [regions],
    });

    waveRef.current = wavesurfer;
    regionsRef.current = regions;

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

    /**
     * Only ever ONE region exists. Dragging out a second would leave two slices with no
     * way to say which one the chart covers, so a new drag replaces the old selection.
     *
     * `region-created` fires for OUR OWN `addRegion` too, not just for a user's drag. Left
     * unguarded, simply loading a saved project reported its stored region back as a fresh
     * edit — which announced a selection nobody made, marked the detector's alignment as
     * overridden, and dirtied the project into an autosave on open. `applyingProp` marks
     * the writes we perform ourselves so only real drags are reported.
     */
    regions.on('region-created', (created: Region) => {
      for (const existing of regions.getRegions()) {
        if (existing.id !== created.id) existing.remove();
      }
      if (applyingProp.current) return;
      callbacks.current.onRegionChange({ startSec: created.start, endSec: created.end }, true);
    });
    regions.on('region-update', (updated: Region) => {
      callbacks.current.onRegionChange({ startSec: updated.start, endSec: updated.end }, false);
    });
    regions.on('region-updated', (updated: Region) => {
      callbacks.current.onRegionChange({ startSec: updated.start, endSec: updated.end }, true);
    });

    return () => {
      wavesurfer.destroy();
      waveRef.current = null;
      regionsRef.current = null;
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

  /** Arm drag-select only while the charter is choosing a region. */
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || loading) return;
    if (!selecting) return;
    const disable = regions.enableDragSelection({ color: REGION_COLOR });
    return () => disable();
  }, [selecting, loading]);

  /**
   * Mirror the region prop onto the waveform.
   *
   * Skipped while the user is dragging one of the handles: writing the prop back mid-drag
   * would fight the plugin for control of the same rectangle and make the edge stutter.
   */
  const draggingRef = useRef(false);
  /** True while this component is writing the prop onto the waveform, not the user. */
  const applyingProp = useRef(false);
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || loading || draggingRef.current) return;

    const existing = regions.getRegions();
    if (!region) {
      for (const item of existing) item.remove();
      return;
    }

    const current = existing[0];
    if (current && Math.abs(current.start - region.startSec) < 0.001 && Math.abs(current.end - region.endSec) < 0.001) {
      return;
    }

    applyingProp.current = true;
    try {
      for (const item of existing) item.remove();
      regions.addRegion({
        start: region.startSec,
        end: region.endSec,
        color: REGION_COLOR,
        drag: true,
        resize: true,
      });
    } finally {
      // The plugin emits `region-created` synchronously from addRegion, so clearing the
      // flag here is enough — no timeout, and no window in which a real drag is missed.
      applyingProp.current = false;
    }
  }, [region, loading]);

  const markDragging = useCallback((value: boolean) => {
    draggingRef.current = value;
  }, []);

  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;
    const onUpdate = () => markDragging(true);
    const onUpdated = () => markDragging(false);
    regions.on('region-update', onUpdate);
    regions.on('region-updated', onUpdated);
    return () => {
      regions.un('region-update', onUpdate);
      regions.un('region-updated', onUpdated);
    };
  }, [markDragging, loading]);

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
   * Read-only here, unlike the draggable grip this replaced. The lead-in is now counted
   * in bars and beats, and a value you can only reach by dragging pixels cannot land on a
   * whole bar — so it is set by its bar count in the Sync panel, and shown here so you can
   * see how much silence that buys at the current tempo.
   */
  const gutterPx = Math.min(MAX_GUTTER_PX, leadInSec * zoom);
  const clampedGutter = gutterPx >= MAX_GUTTER_PX && leadInSec > 0;

  return (
    <div className="relative flex items-stretch overflow-hidden border-b border-edge bg-panel">
      {/* Lead-in: the silence before the music, to scale. */}
      <div
        className="relative shrink-0 border-r border-edge2"
        style={{
          width: gutterPx,
          background: 'repeating-linear-gradient(135deg, #1a1a1a 0 6px, #141414 6px 12px)',
        }}
        title={`${leadInLabel} of silence before the music — set it in Sync`}
      >
        {gutterPx > 58 && (
          <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center font-mono text-2xs leading-tight text-faint">
            <span>{leadInLabel}</span>
            <span>
              {leadInSec.toFixed(2)}s{clampedGutter ? '+' : ''}
            </span>
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div ref={containerRef} className="px-2 py-1" />
      </div>

      {selecting && (
        <div className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 rounded border border-lane-green px-2 py-0.5 text-2xs text-lane-green">
          Drag across the waveform to choose the section to chart
        </div>
      )}

      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-2xs uppercase tracking-widest text-faint">Decoding audio…</span>
        </div>
      )}
    </div>
  );
}
