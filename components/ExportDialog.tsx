'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@/lib/chart/types';
import { exportFolderName } from '@/lib/chart/naming';
import {
  exportFileUrl,
  exportPreflight,
  type ChartFormat,
  type ExportAudioFormat,
  type ExportOptions,
  type ExportPreflight,
} from '@/lib/client/api';
import { countBySeverity, summariseIssues, validateChart } from '@/lib/chart/validateChart';
import { formatTime } from '@/lib/chart/timing';

/**
 * Export dialog.
 *
 * Shows exactly what folder will be produced before anything is downloaded, and exposes
 * the one real choice: WAV (the default, and what a Clone Hero song folder normally
 * contains) or OGG (about ten times smaller, identical in game). Both load, so this is a
 * size-versus-convention call and belongs with the user rather than buried in a config
 * file.
 *
 * The preview is not guessed from the project — it comes from the server's dry run, so
 * what you see listed is what the archive will actually contain, including the cases
 * the client cannot know about (ffmpeg missing, album art unreadable).
 */

interface Props {
  songId: string;
  project: Project;
  open: boolean;
  exporting: boolean;
  onClose: () => void;
  onExport: (options: ExportOptions) => void;
}

export default function ExportDialog({
  songId,
  project,
  open,
  exporting,
  onClose,
  onExport,
}: Props) {
  /**
   * WAV by default, because that is what a Clone Hero song folder normally contains and
   * what the game loads with no decoding cost at all. OGG stays available for anyone who
   * cares more about the download size than about matching the convention.
   */
  const [audioFormat, setAudioFormat] = useState<ExportAudioFormat>('wav');
  /**
   * `.chart` by default. It is what Clone Hero song folders overwhelmingly contain and
   * what the game's parser is most reliable with — if a chart will not load in game,
   * this is the format to be on. `.mid` is here for tools that prefer it.
   */
  const [chartFormat, setChartFormat] = useState<ChartFormat>('chart');
  const options: ExportOptions = { audioFormat, chartFormat };
  const [plan, setPlan] = useState<ExportPreflight | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  /**
   * False when the page is served over plain HTTP (anything but localhost), which is
   * exactly when Chrome refuses to download the zip. Read in an effect because
   * `window` does not exist during server rendering.
   */
  const [secureContext, setSecureContext] = useState(true);

  useEffect(() => {
    setSecureContext(window.isSecureContext);
  }, []);

  const chartIssues = useMemo(
    () => validateChart(project, { durationMs: project.audio.durationMs }),
    [project],
  );
  const issueCounts = countBySeverity(chartIssues);

  const sourceExt = project.audio.file.slice(project.audio.file.lastIndexOf('.')).toLowerCase();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !exporting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, exporting, onClose]);

  // Re-run the dry run whenever the dialog opens or the audio choice changes; the file
  // list and the warnings both depend on it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingPlan(true);
    setPlanError(null);
    exportPreflight(songId, { audioFormat, chartFormat })
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPlan(null);
          setPlanError(error instanceof Error ? error.message : 'Could not check the export.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPlan(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, songId, audioFormat, chartFormat]);

  if (!open) return null;

  const folderName = plan?.folderName ?? exportFolderName(project.meta);
  const files = plan?.files ?? [
    `notes.${chartFormat}`,
    `song.${audioFormat}`,
    'song.ini',
    ...(project.album ? [project.album.toLowerCase().endsWith('.png') ? 'album.png' : 'album.jpg'] : []),
  ];
  const warnings = plan?.warnings ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => !exporting && onClose()}
    >
      <div
        className="w-full max-w-lg border border-edge2 bg-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Export song"
      >
        <header className="border-b border-edge px-4 py-3">
          <h2 className="text-2xs uppercase tracking-widest text-muted">Export song</h2>
        </header>

        <div className="space-y-4 p-4">
          {/* Preview of the exact folder structure that will be produced. */}
          <div>
            <p className="ch-label">
              You will get{loadingPlan ? ' — checking…' : ''}
            </p>
            <div className="border border-edge2 bg-bg p-3 font-mono text-2xs">
              <p className="text-fg">{folderName}/</p>
              <ul className="mt-1 space-y-0.5 pl-4">
                {files.map((file) => (
                  <li key={file} className="flex items-baseline justify-between gap-3">
                    <span className="text-muted">{file}</span>
                    {/*
                      A direct link, not a button: the response carries
                      Content-Disposition: attachment, so the browser downloads it and
                      leaves the dialog exactly where it is.
                    */}
                    <a
                      href={exportFileUrl(songId, file, options)}
                      className="shrink-0 font-sans text-faint underline-offset-2 hover:text-fg hover:underline"
                    >
                      download
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-1 text-2xs text-faint">
              Downloads as {folderName}.zip. Extract it into your Clone Hero Songs folder.
            </p>
          </div>

          {!secureContext && (
            <div className="border border-edge2 bg-bg p-2 text-2xs text-muted">
              <p className="text-lane-orange">This page is not served over HTTPS.</p>
              <p className="mt-1">
                Chrome refuses to download <span className="font-mono">.zip</span> files over a
                plain HTTP connection, so the Export button below may be blocked. The individual
                files above are ordinary text and audio and should still come through &mdash;
                make a folder named{' '}
                <span className="font-mono text-fg">{folderName}</span> and put them in it.
              </p>
              <p className="mt-1">
                The real fix is a certificate. Failing that, Firefox does not block these
                downloads.
              </p>
            </div>
          )}

          {/*
            What the packaged audio will actually be. These numbers come from the server's
            dry run, which is the same plan the download uses, so this is a report rather
            than a prediction — the point of showing it is that a trimmed section is a
            destructive-looking operation and should be confirmed before it happens.
          */}
          {plan && (
            <div className="border border-edge2 bg-bg p-2 text-2xs text-muted">
              <p className="text-fg">Packaged audio</p>
              <ul className="mt-1 space-y-0.5">
                {plan.leadingSilenceMs > 0 && (
                  <li>— {(plan.leadingSilenceMs / 1000).toFixed(2)}s lead-in silence</li>
                )}
                <li>
                  {plan.trimmed ? (
                    <>
                      — {formatTime(plan.region.startMs / 1000)} –{' '}
                      {formatTime(plan.region.endMs / 1000)} of the upload
                    </>
                  ) : (
                    <>— the whole uploaded file</>
                  )}
                </li>
                {plan.trailingSilenceMs > 0 && (
                  <li>— {(plan.trailingSilenceMs / 1000).toFixed(2)}s tail silence</li>
                )}
                <li className="text-faint">
                  {formatTime(plan.durationMs / 1000)} total, which is what song.ini reports.
                </li>
              </ul>
            </div>
          )}

          {/*
            The chart check, summarised. Advisory: it never blocks the export, but a
            problem is far cheaper to find here than halfway through the song in game.
          */}
          {chartIssues.length > 0 && (
            <div className="border border-edge2 bg-bg p-2 text-2xs">
              <p className={issueCounts.errors > 0 ? 'text-lane-red' : 'text-lane-orange'}>
                Chart check: {summariseIssues(chartIssues)}
              </p>
              <ul className="mt-1 space-y-0.5 text-muted">
                {chartIssues.slice(0, 3).map((issue, index) => (
                  <li key={`${issue.message}-${index}`}>— {issue.message}</li>
                ))}
              </ul>
              {chartIssues.length > 3 && (
                <p className="mt-1 text-faint">
                  {chartIssues.length - 3} more in the Check tab.
                </p>
              )}
            </div>
          )}

          {planError && (
            <p className="border border-edge2 bg-bg p-2 text-2xs text-lane-red">{planError}</p>
          )}

          {warnings.length > 0 && (
            <ul className="space-y-1 border border-edge2 bg-bg p-2 text-2xs text-lane-orange">
              {warnings.map((warning) => (
                <li key={warning}>— {warning}</li>
              ))}
            </ul>
          )}

          <div className="flex gap-6">
            <div>
              <p className="ch-label">Chart format</p>
              <FormatChoice
                options={['chart', 'mid']}
                value={chartFormat}
                onChange={setChartFormat}
              />
            </div>
            <div>
              <p className="ch-label">Audio format</p>
              <FormatChoice
                options={['wav', 'ogg']}
                value={audioFormat}
                onChange={setAudioFormat}
              />
            </div>
          </div>

          <p className="text-2xs text-faint">
            {chartFormat === 'chart'
              ? 'notes.chart is what Clone Hero song folders normally contain, and what the game reads most reliably. If a song does not show up in game, be on this.'
              : 'notes.mid suits tools that prefer MIDI, but Clone Hero is fussier about it. If the song fails to appear in your library, switch back to .chart.'}{' '}
            {audioFormat === 'wav'
              ? `WAV matches the same convention${
                  sourceExt === '.wav' ? ', and your audio is already WAV, so it is copied untouched.' : '.'
                }`
              : 'OGG is roughly ten times smaller and identical in game.'}
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-edge px-4 py-3">
          <button type="button" className="ch-button" onClick={onClose} disabled={exporting}>
            Cancel
          </button>
          <button
            type="button"
            className="ch-button ch-button-primary min-w-[104px]"
            onClick={() => onExport(options)}
            disabled={exporting || Boolean(planError)}
          >
            {exporting ? 'Packing…' : 'Export'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Small segmented control, shared by the chart and audio format pickers. */
function FormatChoice<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`border px-3 py-1.5 text-2xs uppercase tracking-widest ${
            value === option
              ? 'border-fg bg-fg text-bg'
              : 'border-edge2 bg-panel text-muted hover:text-fg'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
