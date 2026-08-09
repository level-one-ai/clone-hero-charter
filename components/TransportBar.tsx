'use client';

import { SNAP_DIVISIONS, snapLabel, type SnapDivision } from '@/lib/chart/snap';
import { formatTime } from '@/lib/chart/timing';

/** Playback transport, zoom, snap and save/export controls. */

interface Props {
  playing: boolean;
  currentSeconds: number;
  durationSeconds: number;
  snap: SnapDivision;
  onSnapChange: (snap: SnapDivision) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onSave: () => void;
  onExport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  saving: boolean;
  exporting: boolean;
  onShowHelp: () => void;
}

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1];

export default function TransportBar({
  playing,
  currentSeconds,
  durationSeconds,
  snap,
  onSnapChange,
  zoom,
  onZoomChange,
  playbackRate,
  onPlaybackRateChange,
  onTogglePlay,
  onSeek,
  onSave,
  onExport,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  dirty,
  saving,
  exporting,
  onShowHelp,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-edge bg-panel px-4 py-2">
      <div className="flex items-center gap-1.5">
        <button type="button" className="ch-button w-16" onClick={onTogglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="ch-button" onClick={() => onSeek(0)} title="Back to start">
          ⏮
        </button>
      </div>

      <div className="flex items-baseline gap-2 font-mono text-xs">
        <span className="text-fg">{formatTime(currentSeconds)}</span>
        <span className="text-faint">/ {formatTime(durationSeconds)}</span>
      </div>

      <Control label="Snap">
        <select
          className="ch-input w-24 py-1"
          value={snap}
          onChange={(event) => onSnapChange(Number(event.target.value) as SnapDivision)}
        >
          {SNAP_DIVISIONS.map((division) => (
            <option key={division} value={division}>
              {snapLabel(division)}
            </option>
          ))}
        </select>
      </Control>

      <Control label="Zoom">
        <button
          type="button"
          className="ch-button px-2"
          onClick={() => onZoomChange(Math.max(0.05, zoom / 1.3))}
          title="Zoom out"
        >
          −
        </button>
        <input
          type="range"
          min={0.05}
          max={1.2}
          step={0.01}
          value={zoom}
          onChange={(event) => onZoomChange(Number(event.target.value))}
          className="w-24 accent-white"
        />
        <button
          type="button"
          className="ch-button px-2"
          onClick={() => onZoomChange(Math.min(1.2, zoom * 1.3))}
          title="Zoom in"
        >
          +
        </button>
      </Control>

      <Control label="Speed">
        <div className="flex">
          {PLAYBACK_RATES.map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => onPlaybackRateChange(rate)}
              className={`border px-2 py-1 text-2xs ${
                playbackRate === rate
                  ? 'border-fg bg-fg text-bg'
                  : 'border-edge2 bg-panel text-muted hover:text-fg'
              }`}
            >
              {rate}×
            </button>
          ))}
        </div>
      </Control>

      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" className="ch-button px-2.5" onClick={onShowHelp} title="Keyboard shortcuts">
          ?
        </button>
        <button type="button" className="ch-button" onClick={onUndo} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" className="ch-button" onClick={onRedo} disabled={!canRedo}>
          Redo
        </button>
        <button
          type="button"
          className="ch-button min-w-[86px]"
          onClick={onSave}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <button
          type="button"
          className="ch-button ch-button-primary min-w-[92px]"
          onClick={onExport}
          disabled={exporting}
        >
          {exporting ? 'Packing…' : 'Export'}
        </button>
      </div>
    </div>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-2xs uppercase tracking-widest text-faint">{label}</span>
      {children}
    </label>
  );
}
