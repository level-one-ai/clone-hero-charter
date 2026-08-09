'use client';

import { useEffect, useState } from 'react';
import type { Project } from '@/lib/chart/types';
import { exportFolderName } from '@/lib/chart/naming';
import { exportPreflight, type ExportPreflight } from '@/lib/client/api';

/**
 * Export dialog.
 *
 * Shows exactly what folder will be produced before anything is downloaded, and
 * exposes the one real choice: OGG (small, the default) or the original audio
 * untouched. Clone Hero loads both, so this is purely a size-versus-fidelity call and
 * belongs with the user rather than buried in a config file.
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
  onExport: (keepOriginalAudio: boolean) => void;
}

export default function ExportDialog({
  songId,
  project,
  open,
  exporting,
  onClose,
  onExport,
}: Props) {
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [plan, setPlan] = useState<ExportPreflight | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const sourceExt = project.audio.file.slice(project.audio.file.lastIndexOf('.')).toLowerCase();
  const alreadyOgg = sourceExt === '.ogg';
  const effectiveKeepOriginal = keepOriginal || alreadyOgg;

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
    exportPreflight(songId, effectiveKeepOriginal)
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
  }, [open, songId, effectiveKeepOriginal]);

  if (!open) return null;

  const folderName = plan?.folderName ?? exportFolderName(project.meta);
  const fallbackAudioName = effectiveKeepOriginal ? `song${sourceExt}` : 'song.ogg';
  const files = plan?.files ?? [
    'notes.chart',
    fallbackAudioName,
    'song.ini',
    ...(project.album ? [project.album.toLowerCase().endsWith('.png') ? 'album.png' : 'album.jpg'] : []),
  ];
  const warnings = plan?.warnings ?? [];
  const leadIn = plan?.leadingSilenceMs ?? project.meta.leadingSilenceMs;

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
              <ul className="mt-1 space-y-0.5 pl-4 text-muted">
                {files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
            <p className="mt-1 text-2xs text-faint">
              Downloads as {folderName}.zip. Extract it into your Clone Hero Songs folder.
            </p>
          </div>

          {leadIn > 0 && (
            <p className="text-2xs text-faint">
              {(leadIn / 1000).toFixed(2)}s of silence is added to the start of the audio so the
              chart lines up in game.
            </p>
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

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={effectiveKeepOriginal}
              disabled={alreadyOgg}
              onChange={(event) => setKeepOriginal(event.target.checked)}
              className="mt-0.5 accent-white"
            />
            <span className="text-xs">
              <span className="text-fg">Keep the original audio</span>
              <span className="mt-0.5 block text-2xs text-faint">
                {alreadyOgg
                  ? 'Your audio is already OGG, so nothing is converted either way.'
                  : `Packages your ${sourceExt.replace('.', '').toUpperCase()} untouched instead of converting to OGG. Identical in game, but roughly ten times larger to download.`}
              </span>
            </span>
          </label>
        </div>

        <footer className="flex justify-end gap-2 border-t border-edge px-4 py-3">
          <button type="button" className="ch-button" onClick={onClose} disabled={exporting}>
            Cancel
          </button>
          <button
            type="button"
            className="ch-button ch-button-primary min-w-[104px]"
            onClick={() => onExport(effectiveKeepOriginal)}
            disabled={exporting || Boolean(planError)}
          >
            {exporting ? 'Packing…' : 'Export'}
          </button>
        </footer>
      </div>
    </div>
  );
}
