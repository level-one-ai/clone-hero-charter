'use client';

import { useEffect } from 'react';

/**
 * Keyboard reference.
 *
 * The editor has more shortcuts than fit sensibly on screen, and a single line of
 * cramped hint text along the footer taught nobody anything. One deliberate,
 * dismissible panel behind a visible "?" is easier to use than hints competing with
 * the chart for attention.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

const GROUPS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: 'Playing notes in',
    rows: [
      ['A S D F G', 'Green, red, yellow, blue, orange at the playhead'],
      ['Space', 'Open note'],
      ['Hold a key', 'The note becomes a sustain, ending where you let go'],
      ['Shift + key', 'The note is a forced hammer-on'],
      ['Several at once', 'A chord'],
    ],
  },
  {
    title: 'Playback',
    rows: [
      ['Enter', 'Play / pause'],
      ['Home', 'Jump to the start'],
      ['Mouse wheel', 'Scrub the timeline'],
      ['Shift + wheel', 'Scrub faster'],
      ['Click', 'Metronome on the transport bar, following the tempo map'],
    ],
  },
  {
    title: 'Placing notes',
    rows: [
      ['Click a lane', 'Place a note at the nearest snap point'],
      ['1 – 5 / 0', 'Place on that fret / an open note at the playhead'],
      ['Drag a note', 'Move it'],
      ['Drag its top or tail', 'Pull out a sustain'],
      ['Double-click a note', 'Delete it'],
    ],
  },
  {
    title: 'Selecting',
    rows: [
      ['Click a note', 'Select it, and anchor a range here'],
      ['Shift + click', 'Select everything between the anchor and this note'],
      ['Ctrl / Cmd + click', 'Add or remove just this note'],
      ['Drag across notes', 'Select everything the pointer passes over'],
      ['Shift + drag', 'Marquee select'],
      ['Ctrl / Cmd + A', 'Select everything in this difficulty'],
      ['⌖ on the note bar', 'Select every solid, hammer-on or tap note at once'],
      ['Select on a section', 'Select every note in a named section'],
      ['Esc', 'Clear the selection'],
    ],
  },
  {
    title: 'Editing the selection',
    rows: [
      ['Alt + ← / →', 'Move down or up a fret'],
      ['Alt + N', 'Convert to solid strums'],
      ['Alt + H', 'Convert to hammer-ons'],
      ['Alt + T', 'Convert to taps'],
      ['Alt + O', 'Make open notes'],
      ['Alt + E', 'Sustain to the next note'],
      ['Alt + S', 'Clear sustains'],
      ['Delete', 'Remove'],
      ['Right-click', 'Context menu'],
    ],
  },
  {
    title: 'Copy and paste',
    rows: [
      ['Ctrl / Cmd + C', 'Copy the selection'],
      ['Ctrl / Cmd + X', 'Cut the selection'],
      ['Ctrl / Cmd + V', 'Paste at the playhead, in this difficulty'],
    ],
  },
  {
    title: 'Star power',
    rows: [
      ['Alt + P', 'Arm the star power tool'],
      ['Click, click', 'Set the start of the phrase, then its end'],
      ['Esc', 'Cancel while placing'],
    ],
  },
  {
    title: 'File',
    rows: [
      ['Ctrl / Cmd + S', 'Save now (it also autosaves)'],
      ['Ctrl / Cmd + Z', 'Undo'],
      ['Ctrl / Cmd + Shift + Z', 'Redo'],
    ],
  },
];

export default function HelpOverlay({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-y-auto border border-edge2 bg-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-2xs uppercase tracking-widest text-muted">Shortcuts</h2>
          <button type="button" className="ch-button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">{group.title}</h3>
              <dl className="space-y-1">
                {group.rows.map(([key, description]) => (
                  <div key={key} className="flex gap-3 text-2xs">
                    <dt className="w-40 shrink-0 border border-edge2 bg-bg px-1.5 py-0.5 text-center font-mono text-fg">
                      {key}
                    </dt>
                    <dd className="text-muted">{description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
