'use client';

import { ENTRY_LEGEND } from '@/lib/editor/liveEntry';
import { LANE_COLORS } from '@/lib/chart/types';

/**
 * The live-entry keys, on screen.
 *
 * Note entry from the keyboard is the fastest way to chart and the least discoverable
 * thing in the editor — you would never guess it from looking. A thin strip under the
 * highway makes the mapping learnable in one glance and then fades into the furniture,
 * which is what a legend should do.
 *
 * The key caps carry their lane colour, so the row reads as the fretboard it mirrors
 * rather than as a list of letters.
 */
export default function KeyLegend() {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge bg-panel px-4 py-1.5">
      <span className="text-2xs uppercase tracking-widest text-faint">Play it in</span>

      <div className="flex items-center gap-1.5">
        {ENTRY_LEGEND.map(({ key, label, lane }) => (
          <span
            key={key}
            title={`${key} places a ${label.toLowerCase()} note at the playhead`}
            className="flex items-center gap-1 border border-edge2 px-1.5 py-0.5"
          >
            <span
              aria-hidden
              className="h-2 w-2 shrink-0"
              style={{ backgroundColor: LANE_COLORS[lane] }}
            />
            <span className="font-mono text-2xs text-fg">{key}</span>
          </span>
        ))}
      </div>

      <span className="text-2xs text-faint">
        Hold for a sustain · <span className="text-muted">Shift</span> for a hammer-on ·{' '}
        <span className="text-muted">Enter</span> plays
      </span>
    </div>
  );
}
