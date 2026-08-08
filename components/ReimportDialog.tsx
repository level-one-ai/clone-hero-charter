'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@/lib/chart/types';
import {
  analyzeReimport,
  applyReimport,
  type ReimportAnalysis,
  type ReimportMode,
  type ReimportTrackOption,
} from '@/lib/client/api';

/**
 * Re-import from the project's stored MIDI, choosing the track by hand.
 *
 * Track detection is a guess — chart MIDIs do not reliably name their guitar track —
 * so this is the correction path when the importer picks the wrong part or the wrong
 * octave. Each track shows the note counts it WOULD produce, so the choice is made
 * from real numbers rather than from a track name that was unhelpful in the first
 * place.
 */

interface Props {
  project: Project;
  open: boolean;
  onClose: () => void;
  onApplied: (project: Project) => void;
}

const OCTAVE_OPTIONS = [
  { value: -24, label: '−2 octaves' },
  { value: -12, label: '−1 octave' },
  { value: 0, label: 'None (standard)' },
  { value: 12, label: '+1 octave' },
  { value: 24, label: '+2 octaves' },
];

export default function ReimportDialog({ project, open, onClose, onApplied }: Props) {
  const [analysis, setAnalysis] = useState<ReimportAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackIndex, setTrackIndex] = useState<number | null>(null);
  const [octaveOffset, setOctaveOffset] = useState(0);
  const [mode, setMode] = useState<ReimportMode>('auto');
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await analyzeReimport(project.id);
      setAnalysis(result);
      setOctaveOffset(result.octaveOffset);
      // Preselect whichever track fits the chart layout best, which is usually the
      // one the user wants — they are here because the automatic pick was wrong, so
      // the best-fit track is the most useful starting point to compare against.
      const best = [...result.tracks].sort((a, b) => b.chartFit - a.chartFit)[0];
      setTrackIndex(best ? best.index : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    if (open) void load();
    else {
      setAnalysis(null);
      setConfirming(false);
      setError(null);
    }
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !applying) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, applying, onClose]);

  if (!open) return null;

  const selected = analysis?.tracks.find((t) => t.index === trackIndex) ?? null;
  const totalNotes = selected
    ? Object.values(selected.notesPerDifficulty).reduce((a, b) => a + b, 0)
    : 0;

  const handleApply = async () => {
    setApplying(true);
    setError(null);
    try {
      const updated = await applyReimport(project.id, {
        trackIndex: trackIndex ?? undefined,
        octaveOffset,
        mode,
      });
      onApplied(updated);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setConfirming(false);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => !applying && onClose()}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col border border-edge2 bg-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Re-import from MIDI"
      >
        <header className="shrink-0 border-b border-edge px-4 py-3">
          <h2 className="text-2xs uppercase tracking-widest text-muted">Re-import from MIDI</h2>
          <p className="mt-1 text-2xs text-faint">
            Pick which track in the MIDI holds the guitar part.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 border border-danger bg-bg px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {loading && (
            <p className="text-xs uppercase tracking-widest text-faint">Reading the MIDI…</p>
          )}

          {analysis && (
            <>
              <p className="mb-3 text-2xs text-faint">
                Currently charted from <span className="text-fg">{analysis.currentTrack}</span>.
                &ldquo;Fit&rdquo; is how much of a track looks like chart data rather than music —
                a real guitar part is at or near 100%.
              </p>

              {analysis.musicalMode && (
                <div className="mb-3 border border-lane-orange bg-bg p-3 text-2xs">
                  <p className="text-lane-orange">This file is a transcription, not a chart.</p>
                  <p className="mt-1 text-faint">
                    Its note numbers are pitches rather than fret colours, so the frets were
                    derived from the melody&apos;s shape. The timing and tempo are exact —
                    treat the lanes as a starting point and adjust them for playability.
                  </p>
                </div>
              )}

              <div className="mb-4">
                <span className="ch-label">Read the file as</span>
                <div className="flex">
                  {(
                    [
                      ['auto', 'Auto'],
                      ['chart', 'Chart'],
                      ['musical', 'Melody'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setMode(value);
                        setConfirming(false);
                      }}
                      className={`border px-3 py-1.5 text-2xs uppercase tracking-wide ${
                        mode === value
                          ? 'border-fg bg-fg text-bg'
                          : 'border-edge2 bg-panel text-muted hover:text-fg'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-2xs text-faint">
                  {mode === 'auto'
                    ? 'Reads note numbers as frets when the track looks like a chart, and as pitches otherwise.'
                    : mode === 'chart'
                      ? 'Forces note numbers to be read as fret assignments. Use for a real chart the detector misread.'
                      : 'Forces note numbers to be read as pitches, deriving frets from the melody. Use for a transcription of the song.'}
                </p>
              </div>

              <ul className="space-y-1">
                {analysis.tracks.map((track) => (
                  <TrackRow
                    key={track.index}
                    track={track}
                    selected={track.index === trackIndex}
                    onSelect={() => {
                      setTrackIndex(track.index);
                      // Adopt the offset that makes this particular track fit.
                      setOctaveOffset(track.offset);
                      setConfirming(false);
                    }}
                  />
                ))}
              </ul>

              <label className="mt-4 block">
                <span className="ch-label">Octave offset</span>
                <select
                  className="ch-input"
                  value={octaveOffset}
                  onChange={(event) => {
                    setOctaveOffset(Number(event.target.value));
                    setConfirming(false);
                  }}
                >
                  {OCTAVE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-2xs text-faint">
                  Only change this if the note counts below stay at zero. Some charts are
                  authored an octave away from the standard layout.
                </span>
              </label>

              {selected && (
                <div className="mt-4 border border-edge2 bg-bg p-3">
                  <p className="mb-2 text-2xs uppercase tracking-widest text-faint">
                    This track would give you
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {(['Expert', 'Hard', 'Medium', 'Easy'] as const).map((difficulty) => (
                      <div key={difficulty} className="border border-edge px-2 py-1.5">
                        <p className="text-2xs uppercase tracking-widest text-faint">
                          {difficulty}
                        </p>
                        <p className="font-mono text-sm text-fg">
                          {selected.notesPerDifficulty[difficulty]}
                        </p>
                      </div>
                    ))}
                  </div>
                  {totalNotes === 0 && (
                    <p className="mt-2 text-2xs text-lane-orange">
                      This track produces no notes. Try another track, or a different octave
                      offset.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="shrink-0 border-t border-edge px-4 py-3">
          {confirming ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-2xs text-lane-orange">
                This replaces every note in all four difficulties with the MIDI&apos;s. Any
                charting you have done by hand will be lost.
              </p>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="ch-button"
                  onClick={() => setConfirming(false)}
                  disabled={applying}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ch-button ch-button-danger min-w-[104px]"
                  onClick={() => void handleApply()}
                  disabled={applying}
                >
                  {applying ? 'Importing…' : 'Replace chart'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <button type="button" className="ch-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="ch-button ch-button-primary min-w-[104px]"
                onClick={() => setConfirming(true)}
                disabled={loading || !analysis || trackIndex === null}
              >
                Re-import
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}

function TrackRow({
  track,
  selected,
  onSelect,
}: {
  track: ReimportTrackOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const fitPercent = Math.round(track.chartFit * 100);
  // Three bands rather than a gradient: a track is a chart part, is not, or is
  // ambiguous. A precise percentage is less useful than that judgement.
  const fitColor =
    track.chartFit >= 0.85
      ? 'text-lane-green'
      : track.chartFit >= 0.5
        ? 'text-lane-orange'
        : 'text-faint';

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-3 border px-3 py-2 text-left transition-colors ${
          selected ? 'border-fg bg-panel2' : 'border-edge hover:border-faint'
        }`}
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 border ${
            selected ? 'border-fg bg-fg' : 'border-edge2'
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-fg">{track.name}</span>
          <span className="block font-mono text-2xs text-faint">
            {track.noteCount} notes
            {track.range ? ` · range ${track.range[0]}–${track.range[1]}` : ''}
          </span>
        </span>
        <span className={`shrink-0 font-mono text-2xs ${fitColor}`}>{fitPercent}% fit</span>
      </button>
    </li>
  );
}
