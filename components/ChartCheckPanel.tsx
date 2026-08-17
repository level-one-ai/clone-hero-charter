'use client';

import { useMemo } from 'react';
import { countBySeverity, type ChartIssue } from '@/lib/chart/validateChart';

/**
 * The chart check.
 *
 * Everything listed here produces a chart that LOADS but plays wrong, which is the worst
 * kind of mistake to ship: Clone Hero says nothing, and you find out halfway through the
 * song. Clicking an issue jumps the playhead to it, so the list doubles as a work queue.
 *
 * Advisory only — nothing here blocks an export.
 */

interface Props {
  /**
   * The issues, already computed.
   *
   * Passed in rather than derived here so the panel and the tab badge can never disagree,
   * and — more importantly — so there is exactly one place that decides what "the end of
   * the audio" means. This panel used to run the check itself against the source file's
   * length, which with a lead-in or a charted region is the wrong yardstick in both
   * directions: it flagged perfectly good notes and missed genuinely unreachable ones.
   */
  issues: ChartIssue[];
  onSeekToTick: (tick: number) => void;
}

export default function ChartCheckPanel({ issues, onSeekToTick }: Props) {
  const { errors, warnings } = useMemo(() => countBySeverity(issues), [issues]);

  return (
    <div className="flex h-full flex-col">
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Chart check</h3>
        {issues.length === 0 ? (
          <p className="text-2xs text-lane-green">
            No problems found. Nothing here can catch a chart that is simply no fun, but the
            mistakes that break a song in game are all clear.
          </p>
        ) : (
          <p className="text-2xs text-faint">
            {errors > 0 && <span className="text-lane-red">{errors} to fix</span>}
            {errors > 0 && warnings > 0 && ' · '}
            {warnings > 0 && <span className="text-lane-orange">{warnings} to look at</span>}
            . Click one to jump to it. None of these stop you exporting.
          </p>
        )}
      </section>

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {issues.map((issue, index) => (
          <IssueRow
            key={`${issue.message}-${issue.tick ?? index}`}
            issue={issue}
            onSeek={() => issue.tick !== undefined && onSeekToTick(issue.tick)}
          />
        ))}
      </ul>
    </div>
  );
}

function IssueRow({ issue, onSeek }: { issue: ChartIssue; onSeek: () => void }) {
  const isError = issue.severity === 'error';
  return (
    <li>
      <button
        type="button"
        onClick={onSeek}
        disabled={issue.tick === undefined}
        className="flex w-full gap-2 border border-edge2 bg-bg p-2 text-left text-2xs hover:border-edge disabled:cursor-default"
      >
        <span
          aria-hidden
          className="mt-px shrink-0 font-mono"
          style={{ color: isError ? '#C6413B' : '#E88A2E' }}
        >
          {isError ? '!' : '?'}
        </span>
        <span className="text-muted">{issue.message}</span>
      </button>
    </li>
  );
}
