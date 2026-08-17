'use client';

import { useState } from 'react';
import type { Project } from '@/lib/chart/types';
import type { EditorAction } from '@/lib/editor/projectReducer';
import type { AudioTimeline } from '@/lib/chart/audioTimeline';
import type { TempoGuess } from '@/lib/editor/tempoDetect';
import { TimingMap, formatTime } from '@/lib/chart/timing';
import Disclosure from './Disclosure';

/**
 * Everything that decides WHERE IN TIME the chart sits: tempo, alignment to the
 * recording, the lead-in, the time signature and the offset.
 *
 * These are one panel rather than four because they are one job. A charter opens this to
 * answer a single question — "does the grid line up with the music?" — and the answer
 * involves the tempo, the point the music starts from and the count-in together. Splitting
 * them across tabs makes the user hold the relationship in their head instead of seeing it.
 *
 * Markers are placed at the CURRENT PLAYHEAD tick rather than at an arbitrary typed
 * position: the charter is listening for the tempo change as it happens, so "put one
 * here" is the operation they actually want. The tick is still shown for fine adjustment.
 */

interface Props {
  project: Project;
  timing: TimingMap;
  timeline: AudioTimeline;
  /** Playhead position in ticks, already snapped by the caller. */
  playheadTick: number;
  dispatch: React.Dispatch<EditorAction>;
  onSeekToTick: (tick: number) => void;
  /** Runs beat detection over the charted region. */
  onDetectTempo: () => Promise<TempoGuess | null>;
  /** Applies a detection result; `alignRegion` also moves the start point onto its beat. */
  onApplyTempo: (result: TempoGuess, alignRegion: boolean) => void;
  onLeadInChange: (bars: number, beats: number) => void;
  /** Shift the point the music starts from, in whole beats. */
  onNudgeStart: (beats: number) => void;
  onStartRegionSelect: () => void;
  onClearRegion: () => void;
  regionSelecting: boolean;
}

export default function SyncPanel({
  project,
  timing,
  timeline,
  playheadTick,
  dispatch,
  onSeekToTick,
  onDetectTempo,
  onApplyTempo,
  onLeadInChange,
  onNudgeStart,
  onStartRegionSelect,
  onClearRegion,
  regionSelecting,
}: Props) {
  const [bpmInput, setBpmInput] = useState(() => formatBpm(timing.bpmAt(0)));
  const [numeratorInput, setNumeratorInput] = useState('4');
  const [denominatorInput, setDenominatorInput] = useState('4');
  const [detecting, setDetecting] = useState(false);
  const [guess, setGuess] = useState<TempoGuess | null>(project.audio.detected ?? null);
  const [detectError, setDetectError] = useState<string | null>(null);

  const leadIn = project.meta.leadIn;
  const beatsPerBar = timing.timeSignatureAt(0).numerator;

  const handleDetect = async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      const result = await onDetectTempo();
      if (result === null) {
        setDetectError('No steady tempo found. Enter the BPM manually.');
      } else {
        setGuess(result);
        setBpmInput(formatBpm(result.bpm));
      }
    } catch (error) {
      setDetectError((error as Error).message);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* ---- Tempo -------------------------------------------------------- */}
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
        <p className="mt-1 text-2xs text-faint">Placed at the playhead — tick {playheadTick}.</p>

        <button
          type="button"
          className="ch-button mt-3 w-full"
          onClick={() => void handleDetect()}
          disabled={detecting}
        >
          {detecting ? 'Analysing…' : 'Detect tempo'}
        </button>

        {/*
          The detection result is shown WITH its confidence and an explicit apply step.
          Detection runs automatically when a song is first opened, so by the time anyone
          presses this button they are usually checking a number they already doubt —
          which is exactly when quietly overwriting the anchor would be wrong.
        */}
        {guess && (
          <div className="mt-2 border border-edge2 p-2">
            <p className="font-mono text-2xs text-fg">
              {formatBpm(guess.bpm)} BPM · first beat at {formatTime(guess.firstBeatSec)}
            </p>
            <p className="mt-0.5 text-2xs text-faint">{describeConfidence(guess.confidence)}</p>
            <div className="mt-2 flex gap-1">
              <button
                type="button"
                className="ch-button flex-1"
                onClick={() => onApplyTempo(guess, true)}
              >
                Use &amp; align
              </button>
              <button
                type="button"
                className="ch-button flex-1"
                onClick={() => onApplyTempo(guess, false)}
                title="Set the anchor BPM but leave the start point where it is"
              >
                Tempo only
              </button>
            </div>
          </div>
        )}
        {detectError && <p className="mt-1 text-2xs text-lane-orange">{detectError}</p>}

        <ul className="mt-3 max-h-32 space-y-0.5 overflow-y-auto">
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

      {/* ---- Alignment and region ----------------------------------------- */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Audio section</h3>

        <p className="font-mono text-2xs text-muted">
          {timeline.trimmed
            ? `${formatTime(timeline.regionStartSec)} – ${formatTime(timeline.regionEndSec)}`
            : 'Whole file'}
          <span className="text-faint"> · {formatTime(timeline.regionSec)} long</span>
        </p>

        <div className="mt-2 flex gap-1">
          <button
            type="button"
            className={`ch-button flex-1 ${regionSelecting ? 'border-lane-green text-lane-green' : ''}`}
            onClick={onStartRegionSelect}
          >
            {regionSelecting ? 'Drag on the waveform…' : 'Choose section'}
          </button>
          {timeline.trimmed && (
            <button type="button" className="ch-button" onClick={onClearRegion}>
              Use all
            </button>
          )}
        </div>
        <p className="mt-1 text-2xs text-faint">
          Charting one song out of a longer upload. Only this section is exported, with the
          lead-in before it and the tail silence after.
        </p>

        {/*
          Beat-wise nudging rather than a millisecond field. Detection finds the pulse but
          not which beat begins a bar, so lining up by ear means stepping the start point a
          whole beat at a time — and a beat is the unit that keeps the grid phase-locked to
          the music, where milliseconds do not.
        */}
        <div className="mt-3">
          <span className="ch-label">Start point</span>
          <div className="mt-1 flex items-center gap-1">
            {[-4, -1].map((beats) => (
              <button
                key={beats}
                type="button"
                className="ch-button flex-1"
                onClick={() => onNudgeStart(beats)}
              >
                {beats} beat{beats === -1 ? '' : 's'}
              </button>
            ))}
            {[1, 4].map((beats) => (
              <button
                key={beats}
                type="button"
                className="ch-button flex-1"
                onClick={() => onNudgeStart(beats)}
              >
                +{beats} beat{beats === 1 ? '' : 's'}
              </button>
            ))}
          </div>
          <p className="mt-1 text-2xs text-faint">
            Moves where the music starts against bar 1 of the chart. Use the metronome and
            step until the click sits on the beat.
          </p>
        </div>
      </section>

      {/* ---- Lead-in -------------------------------------------------------- */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Lead-in</h3>
        <div className="flex items-end gap-2">
          <label className="w-20">
            <span className="ch-label">Bars</span>
            <input
              className="ch-input"
              value={leadIn.bars}
              inputMode="numeric"
              onChange={(event) =>
                onLeadInChange(Number.parseInt(event.target.value, 10) || 0, leadIn.beats)
              }
            />
          </label>
          <label className="w-20">
            <span className="ch-label">Beats</span>
            <input
              className="ch-input"
              value={leadIn.beats}
              inputMode="numeric"
              onChange={(event) =>
                onLeadInChange(leadIn.bars, Number.parseInt(event.target.value, 10) || 0)
              }
            />
          </label>
          <div className="flex flex-1 gap-1">
            <button
              type="button"
              className="ch-button flex-1"
              onClick={() => onLeadInChange(leadIn.bars + 1, leadIn.beats)}
            >
              +1 bar
            </button>
            <button
              type="button"
              className="ch-button flex-1"
              onClick={() => onLeadInChange(leadIn.bars - 1, leadIn.beats)}
            >
              −1 bar
            </button>
          </div>
        </div>
        <p className="mt-1 text-2xs text-faint">
          {formatTime(timeline.leadInSec)} of silence at {formatBpm(timing.bpmAt(0))} BPM in{' '}
          {beatsPerBar}/{timing.timeSignatureAt(0).denominator}. Every chart gets at least
          two bars so the first notes are playable; add more to line the song up on a
          particular beat. The music moves, the notes stay put.
        </p>
      </section>

      {/* ---- Advanced ------------------------------------------------------- */}
      <Disclosure label="Time signature, offset, tail">
        <div className="p-3">
          <h4 className="mb-2 text-2xs uppercase tracking-widest text-muted">Time signature</h4>
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
                  {formatTime(timing.tickToSec(marker.tick))} · {marker.numerator}/
                  {marker.denominator}
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

          <h4 className="mb-2 mt-4 text-2xs uppercase tracking-widest text-muted">Chart offset</h4>
          <label>
            <span className="ch-label">Seconds</span>
            <input
              className="ch-input"
              value={project.meta.offset}
              inputMode="decimal"
              onChange={(event) => {
                const offset = Number.parseFloat(event.target.value);
                dispatch({
                  type: 'setMeta',
                  meta: { offset: Number.isFinite(offset) ? offset : 0 },
                });
              }}
            />
          </label>
          <p className="mt-1 text-2xs text-faint">
            Fine sync adjustment for when every note is early or late by the same amount.
            Prefer the start-point nudge above — this shifts the chart against the audio
            without moving the grid, so it cannot fix a mis-aligned bar 1.
          </p>

          <h4 className="mb-2 mt-4 text-2xs uppercase tracking-widest text-muted">Tail silence</h4>
          <label>
            <span className="ch-label">Seconds after the section ends</span>
            <input
              className="ch-input"
              value={(project.meta.trailingSilenceMs ?? 0) / 1000}
              inputMode="decimal"
              onChange={(event) => {
                const seconds = Number.parseFloat(event.target.value);
                dispatch({
                  type: 'setMeta',
                  meta: {
                    trailingSilenceMs: Number.isFinite(seconds)
                      ? Math.max(0, Math.min(30, seconds)) * 1000
                      : 0,
                  },
                });
              }}
            />
          </label>
          <p className="mt-1 text-2xs text-faint">
            Added to the end of the exported audio, so a section cut out of a continuous
            recording does not run into whatever came next.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}

function formatBpm(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Confidence in words rather than a percentage.
 *
 * A number invites the reader to weigh it; a sentence tells them what to do. The low-
 * confidence case is the one that matters, and it should read as an instruction to check.
 */
function describeConfidence(confidence: number): string {
  if (confidence >= 0.85) return 'Steady tempo throughout — this reading is reliable.';
  if (confidence >= 0.6) return 'Mostly steady. Worth a listen against the metronome.';
  if (confidence >= 0.35) return 'The tempo drifted between halves of the section — check it by ear.';
  return 'Unsteady reading. Detection often lands on half or double the real tempo; verify before charting.';
}
