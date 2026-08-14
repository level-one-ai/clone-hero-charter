'use client';

import { useState } from 'react';
import { LANE_COLORS, type Lane, type Note } from '@/lib/chart/types';
import { NOTE_TYPE_LABELS, type NoteType } from '@/lib/chart/noteTypes';

/**
 * Actions on the current selection.
 *
 * These all existed as keyboard shortcuts, which meant they were effectively hidden:
 * nobody discovers "press F to force a HOPO" from looking at the screen. Putting them
 * on a bar above the highway makes the editor's capabilities visible, and the shortcut
 * is shown on each button so the keyboard route is learned rather than replaced.
 *
 * Everything here operates on the SELECTION, so the bar is disabled with nothing
 * selected rather than hidden — a control that vanishes is harder to learn than one
 * that is visibly unavailable.
 */

interface Props {
  selectedNotes: Note[];
  onSelectAll: () => void;
  onClearSelection: () => void;
  onMoveFret: (delta: number) => void;
  onSetLane: (lane: Lane) => void;
  /** Convert the selection to a solid strum, a hammer-on or a tap. */
  onConvertType: (target: NoteType) => void;
  /** Select every note of a given type in this difficulty. */
  onSelectByType: (target: NoteType) => void;
  onClearSustain: () => void;
  onDelete: () => void;
  /** Extend the selection's sustains to just before the next note on each lane. */
  onSustain: () => void;
  /** Chart the stretch between the selection's first and last note from the audio. */
  onAutoChart: () => void;
  /** True while the server is listening to the audio. */
  autoCharting: boolean;
  onCopy: (cut: boolean) => void;
  onPaste: () => void;
  /** What is on the clipboard, or null when nothing has been copied yet. */
  clipboardLabel: string | null;
  /** True while the two-click star power tool is waiting for clicks on the highway. */
  starPowerArmed: boolean;
  /** What to do next while the tool is armed, or null when it is off. */
  starPowerHint: string | null;
  onToggleStarPowerTool: () => void;
  totalNotes: number;
}

export default function NoteToolbar({
  selectedNotes,
  onSelectAll,
  onClearSelection,
  onMoveFret,
  onSetLane,
  onConvertType,
  onSelectByType,
  onClearSustain,
  onDelete,
  onSustain,
  onAutoChart,
  autoCharting,
  onCopy,
  onPaste,
  clipboardLabel,
  starPowerArmed,
  starPowerHint,
  onToggleStarPowerTool,
  totalNotes,
}: Props) {
  const [more, setMore] = useState(false);
  const count = selectedNotes.length;
  const none = count === 0;

  return (
    <div className="flex items-center gap-x-3 overflow-x-auto border-b border-edge bg-panel px-4 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-2xs uppercase tracking-widest text-faint">
          {none ? 'Nothing selected' : `${count} selected`}
        </span>
        <button
          type="button"
          className="ch-button"
          onClick={onSelectAll}
          disabled={totalNotes === 0}
          title="Select every note in this difficulty (Ctrl+A)"
        >
          Select all
        </button>
        <button type="button" className="ch-button" onClick={onClearSelection} disabled={none}>
          Clear
        </button>
      </div>

      <Group label="Block">
        <button
          type="button"
          className="ch-button"
          onClick={() => onCopy(false)}
          disabled={none}
          title="Copy the selection (Ctrl+C). Shift-click two notes to select everything between them."
        >
          Copy
        </button>
        <button
          type="button"
          className="ch-button"
          onClick={() => onCopy(true)}
          disabled={none}
          title="Cut the selection (Ctrl+X)"
        >
          Cut
        </button>
        {/* Paste does not need a selection — only something on the clipboard. */}
        <button
          type="button"
          className="ch-button"
          onClick={onPaste}
          disabled={!clipboardLabel}
          title={
            clipboardLabel
              ? `Paste at the playhead, in this difficulty (Ctrl+V) — ${clipboardLabel}`
              : 'Nothing copied yet'
          }
        >
          Paste
        </button>
      </Group>

      <Group label="Move fret">
        <button
          type="button"
          className="ch-button"
          onClick={() => onMoveFret(-1)}
          disabled={none}
          title="Move the selection one fret towards green (Alt + ←)"
        >
          ← Down
        </button>
        <button
          type="button"
          className="ch-button"
          onClick={() => onMoveFret(1)}
          disabled={none}
          title="Move the selection one fret towards orange (Alt + →)"
        >
          Up →
        </button>
      </Group>

      {/*
        Set-fret swatches and the destructive actions live behind "More". They are worth
        having but are not what you reach for while charting, and on a laptop they were
        what pushed this bar onto a second row and the highway down the screen.
      */}
      {more && (
      <Group label="Set fret">
        {([0, 1, 2, 3, 4] as Lane[]).map((lane) => (
          <button
            key={lane}
            type="button"
            onClick={() => onSetLane(lane)}
            disabled={none}
            title={`Put the selection on this fret (${lane + 1})`}
            className="h-6 w-6 border border-edge2 disabled:opacity-30"
            style={{ backgroundColor: none ? 'transparent' : LANE_COLORS[lane] }}
          >
            <span className="sr-only">Fret {lane + 1}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => onSetLane(7)}
          disabled={none}
          title="Make the selection open notes (Alt+O)"
          className="h-6 border border-edge2 px-2 text-2xs disabled:opacity-30"
          style={{ backgroundColor: none ? 'transparent' : LANE_COLORS[7], color: '#0a0a0a' }}
        >
          Open
        </button>
      </Group>
      )}

      {/*
        Convert, not toggle. Whether a note is a HOPO is DERIVED from its neighbours and
        the stored flag inverts that, so "make these hammer-ons" needs a different flag
        per note — a toggle would turn half a mixed selection into the opposite of what
        was asked for. Clicking the label selects every note of that type, so a whole
        class can be converted in two clicks.
      */}
      <Group label="Type">
        {(['strum', 'hopo', 'tap'] as const).map((target) => (
          <span key={target} className="flex">
            <button
              type="button"
              className="ch-button"
              onClick={() => onConvertType(target)}
              disabled={none}
              title={`Convert the selection to ${NOTE_TYPE_LABELS[target].toLowerCase()} notes`}
            >
              {NOTE_TYPE_LABELS[target]}
            </button>
            <button
              type="button"
              className="border border-l-0 border-edge2 bg-panel px-1 text-2xs text-faint hover:text-fg"
              onClick={() => onSelectByType(target)}
              disabled={totalNotes === 0}
              title={`Select every ${NOTE_TYPE_LABELS[target].toLowerCase()} note in this difficulty`}
              aria-label={`Select every ${NOTE_TYPE_LABELS[target].toLowerCase()} note`}
            >
              ⌖
            </button>
          </span>
        ))}
      </Group>

      <Group label="Other">
        {/*
          Unlike everything else on this bar, star power does not act on the selection —
          it is a drawing tool, so it stays enabled with nothing selected and shows its
          armed state rather than firing once and forgetting.
        */}
        <button
          type="button"
          className={`ch-button ${starPowerArmed ? 'ch-button-primary' : ''}`}
          onClick={onToggleStarPowerTool}
          aria-pressed={starPowerArmed}
          title="Draw a star power phrase: click its start on the highway, then its end (Alt+P)"
        >
          Star power
        </button>
        <button
          type="button"
          className="ch-button"
          onClick={onSustain}
          disabled={none}
          title="Extend each selected note to just before the next one on its lane (Alt+E)"
        >
          Sustain
        </button>
        {/*
          Deliberately gated on TWO selected notes rather than one or none. The range it
          fills is "between the notes you picked", so selecting a note either side of a
          hole is both how you aim it and the guarantee that it cannot wander into work
          you have already done.
        */}
        <button
          type="button"
          className="ch-button"
          onClick={onAutoChart}
          disabled={count < 2 || autoCharting}
          title={
            count < 2
              ? 'Select a note either side of the gap you want filled, then press this'
              : 'Listen to the audio and chart the stretch between the selected notes'
          }
        >
          {autoCharting ? 'Listening…' : 'Auto-chart gap'}
        </button>
        {more && (
          <button
            type="button"
            className="ch-button"
            onClick={onClearSustain}
            disabled={none}
            title="Remove sustains (Alt+S)"
          >
            Clear sustain
          </button>
        )}
        <button
          type="button"
          className="ch-button ch-button-danger"
          onClick={onDelete}
          disabled={none}
          title="Delete the selection (Del)"
        >
          Delete
        </button>
      </Group>

      <button
        type="button"
        className="ch-button px-2"
        onClick={() => setMore((v) => !v)}
        aria-expanded={more}
        title={more ? 'Hide the extra actions' : 'Show set-fret and clear-sustain'}
      >
        {more ? 'Less ‹' : 'More ›'}
      </button>

      {starPowerHint && (
        <span
          className="ml-auto border border-lane-blue px-2 py-1 text-2xs uppercase tracking-widest"
          style={{ color: '#7fd8ff', borderColor: '#7fd8ff' }}
        >
          {starPowerHint}
        </span>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-2xs uppercase tracking-widest text-faint">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}
