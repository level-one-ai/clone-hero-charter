'use client';

import { LANE_COLORS, type Lane, type Note } from '@/lib/chart/types';

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
  onToggleFlag: (flag: 'forced' | 'tap') => void;
  onClearSustain: () => void;
  onDelete: () => void;
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
  onToggleFlag,
  onClearSustain,
  onDelete,
  starPowerArmed,
  starPowerHint,
  onToggleStarPowerTool,
  totalNotes,
}: Props) {
  const count = selectedNotes.length;
  const none = count === 0;

  // A flag reads as "on" only when every selected note has it, matching how the
  // toggle behaves: pressing it turns the whole selection on unless it already is.
  const allForced = !none && selectedNotes.every((n) => n.forced);
  const allTap = !none && selectedNotes.every((n) => n.tap);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge bg-panel px-4 py-2">
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
          title="Make the selection open notes (0)"
          className="h-6 border border-edge2 px-2 text-2xs disabled:opacity-30"
          style={{ backgroundColor: none ? 'transparent' : LANE_COLORS[7], color: '#0a0a0a' }}
        >
          Open
        </button>
      </Group>

      <Group label="Type">
        <button
          type="button"
          className={`ch-button ${allForced ? 'ch-button-primary' : ''}`}
          onClick={() => onToggleFlag('forced')}
          disabled={none}
          title="Force hammer-on / pull-off, or force a strum (F)"
        >
          HOPO
        </button>
        <button
          type="button"
          className={`ch-button ${allTap ? 'ch-button-primary' : ''}`}
          onClick={() => onToggleFlag('tap')}
          disabled={none}
          title="Tap note — no strum needed (T)"
        >
          Tap
        </button>
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
          title="Draw a star power phrase: click its start on the highway, then its end (P)"
        >
          Star power
        </button>
        <button type="button" className="ch-button" onClick={onClearSustain} disabled={none}>
          Clear sustain
        </button>
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
