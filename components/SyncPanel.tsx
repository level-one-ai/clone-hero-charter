'use client';

import { useState } from 'react';
import type { Project } from '@/lib/chart/types';
import type { EditorAction } from '@/lib/editor/projectReducer';
import { TimingMap, formatTime } from '@/lib/chart/timing';

/**
 * BPM and time-signature marker editing.
 *
 * Markers are placed at the CURRENT PLAYHEAD tick rather than at an arbitrary typed
 * position: the charter is listening for the tempo change as it happens, so "put one
 * here" is the operation they actually want. The tick is still shown and editable for
 * fine adjustment.
 */

interface Props {
  project: Project;
  timing: TimingMap;
  /** Playhead position in ticks, already snapped by the caller. */
  playheadTick: number;
  dispatch: React.Dispatch<EditorAction>;
  onSeekToTick: (tick: number) => void;
  /** Runs client-side beat detection; resolves to a suggested BPM. */
  onDetectBpm: () => Promise<number | null>;
}

export default function SyncPanel({
  project,
  timing,
  playheadTick,
  dispatch,
  onSeekToTick,
  onDetectBpm,
}: Props) {
  const [bpmInput, setBpmInput] = useState('120');
  const [numeratorInput, setNumeratorInput] = useState('4');
  const [denominatorInput, setDenominatorInput] = useState('4');
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<string | null>(null);

  const handleDetect = async () => {
    setDetecting(true);
    setDetectResult(null);
    try {
      const bpm = await onDetectBpm();
      if (bpm === null) {
        setDetectResult('Detection failed. Enter the BPM manually.');
      } else {
        setBpmInput(bpm.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
        setDetectResult(`Suggested ${bpm.toFixed(2)} BPM — verify before using.`);
      }
    } catch (error) {
      setDetectResult((error as Error).message);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ---- BPM ---------------------------------------------------------- */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Tempo</h3>

        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="ch-label">BPM</span>
            <input
              className="ch-input"
              value={bpmInput}
              inputMode="decimal"
              onChange={(event) => setBpmInput(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="ch-button"
            onClick={() => {
              const bpm = Number.parseFloat(bpmInput);
              if (!Number.isFinite(bpm) || bpm <= 0) return;
              dispatch({ type: 'upsertBpm', marker: { tick: playheadTick, bpm } });
            }}
          >
            Place
          </button>
        </div>
        <p className="mt-1 text-2xs text-faint">
          Placed at the playhead — tick {playheadTick}.
        </p>

        <button
          type="button"
          className="ch-button mt-3 w-full"
          onClick={() => void handleDetect()}
          disabled={detecting}
        >
          {detecting ? 'Analysing…' : 'Auto-detect BPM'}
        </button>
        {detectResult && <p className="mt-1 text-2xs text-lane-orange">{detectResult}</p>}
        <p className="mt-1 text-2xs text-faint">
          Detection is a starting point, not an answer. It is often wrong on songs with
          tempo changes or sparse percussion — always confirm against the waveform.
        </p>

        <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto">
          {project.sync.bpms.map((marker) => (
            <li key={marker.tick} className="flex items-center gap-2 text-2xs">
              <button
                type="button"
                className="flex-1 text-left font-mono text-muted hover:text-fg"
                onClick={() => onSeekToTick(marker.tick)}
              >
                {formatTime(timing.tickToSec(marker.tick))} · {formatBpm(marker.bpm)} BPM
              </button>
              {marker.tick === 0 ? (
                <span className="text-faint">anchor</span>
              ) : (
                <button
                  type="button"
                  className="text-faint hover:text-danger"
                  onClick={() => dispatch({ type: 'deleteBpm', tick: marker.tick })}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ---- Time signature ----------------------------------------------- */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Time signature</h3>
        <div className="flex items-end gap-2">
          <label className="w-16">
            <span className="ch-label">Beats</span>
            <input
              className="ch-input"
              value={numeratorInput}
              inputMode="numeric"
              onChange={(event) => setNumeratorInput(event.target.value)}
            />
          </label>
          <label className="w-16">
            <span className="ch-label">Note</span>
            <select
              className="ch-input py-1.5"
              value={denominatorInput}
              onChange={(event) => setDenominatorInput(event.target.value)}
            >
              {[1, 2, 4, 8, 16, 32].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ch-button flex-1"
            onClick={() => {
              const numerator = Number.parseInt(numeratorInput, 10);
              const denominator = Number.parseInt(denominatorInput, 10);
              if (!Number.isFinite(numerator) || numerator <= 0) return;
              dispatch({
                type: 'upsertTimeSignature',
                marker: { tick: playheadTick, numerator, denominator },
              });
            }}
          >
            Place
          </button>
        </div>

        <ul className="mt-3 max-h-32 space-y-0.5 overflow-y-auto">
          {project.sync.timeSignatures.map((marker) => (
            <li key={marker.tick} className="flex items-center gap-2 text-2xs">
              <button
                type="button"
                className="flex-1 text-left font-mono text-muted hover:text-fg"
                onClick={() => onSeekToTick(marker.tick)}
              >
                {formatTime(timing.tickToSec(marker.tick))} · {marker.numerator}/{marker.denominator}
              </button>
              {marker.tick === 0 ? (
                <span className="text-faint">anchor</span>
              ) : (
                <button
                  type="button"
                  className="text-faint hover:text-danger"
                  onClick={() => dispatch({ type: 'deleteTimeSignature', tick: marker.tick })}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ---- Lead-in -------------------------------------------------------- */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Lead-in silence</h3>
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="ch-label">Seconds before the song starts</span>
            <input
              className="ch-input"
              value={(project.meta.leadingSilenceMs ?? 0) / 1000}
              inputMode="decimal"
              onChange={(event) => {
                const seconds = Number.parseFloat(event.target.value);
                dispatch({
                  type: 'setMeta',
                  meta: {
                    leadingSilenceMs: Number.isFinite(seconds)
                      ? Math.max(0, Math.min(60, seconds)) * 1000
                      : 0,
                  },
                });
              }}
            />
          </label>
          <div className="flex">
            {[1, 2, 4].map((seconds) => (
              <button
                key={seconds}
                type="button"
                className="border border-edge2 bg-panel px-2 py-1.5 text-2xs text-muted hover:text-fg"
                onClick={() =>
                  dispatch({ type: 'setMeta', meta: { leadingSilenceMs: seconds * 1000 } })
                }
              >
                {seconds}s
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1 text-2xs text-faint">
          Adds real silence to the front of the exported audio, so the song starts a
          little later and there is room to get your bearings. Nothing moves on the
          highway &mdash; the chart&apos;s offset is adjusted to match, so it stays in
          sync automatically.
        </p>
      </section>

      {/* ---- Offset -------------------------------------------------------- */}
      <section className="p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Chart offset</h3>
        <label>
          <span className="ch-label">Seconds</span>
          <input
            className="ch-input"
            value={project.meta.offset}
            inputMode="decimal"
            onChange={(event) => {
              const offset = Number.parseFloat(event.target.value);
              dispatch({ type: 'setMeta', meta: { offset: Number.isFinite(offset) ? offset : 0 } });
            }}
          />
        </label>
        <p className="mt-1 text-2xs text-faint">
          Fine sync adjustment. Use this when every note is early or late by the same
          amount, rather than moving notes.
        </p>
      </section>
    </div>
  );
}

function formatBpm(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
