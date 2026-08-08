'use client';

import { useEffect, useState } from 'react';
import type { Project } from '@/lib/chart/types';
import { exportFolderName } from '@/lib/chart/naming';

/**
 * Export dialog.
 *
 * Shows exactly what folder will be produced before anything is downloaded, and
 * exposes the one real choice: OGG (small, the default) or the original audio
 * untouched. Clone Hero loads both, so this is purely a size-versus-fidelity call and
 * belongs with the user rather than buried in a config file.
 */

interface Props {
  project: Project;
  open: boolean;
  exporting: boolean;
  onClose: () => void;
  onExport: (keepOriginalAudio: boolean) => void;
}

export default function ExportDialog({ project, open, exporting, onClose, onExport }: Props) {
  const [keepOriginal, setKeepOriginal] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !exporting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, exporting, onClose]);

  if (!open) return null;

  const folderName = exportFolderName(project.meta);
  const sourceExt = project.audio.file.slice(project.audio.file.lastIndexOf('.')).toLowerCase();
  const alreadyOgg = sourceExt === '.ogg';
  const audioName = keepOriginal || alreadyOgg ? `song${sourceExt}` : 'song.ogg';
  const albumName = project.album
    ? project.album.toLowerCase().endsWith('.png')
      ? 'album.png'
      : 'album.jpg'
    : null;

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
            <p className="ch-label">You will get</p>
            <div className="border border-edge2 bg-bg p-3 font-mono text-2xs">
              <p className="text-fg">{folderName}/</p>
              <ul className="mt-1 space-y-0.5 pl-4 text-muted">
                <li>notes.chart</li>
                <li>{audioName}</li>
                <li>song.ini</li>
                {albumName && <li>{albumName}</li>}
              </ul>
            </div>
            <p className="mt-1 text-2xs text-faint">
              Downloads as {folderName}.zip. Extract it into your Clone Hero Songs folder.
            </p>
          </div>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={keepOriginal || alreadyOgg}
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
            onClick={() => onExport(keepOriginal || alreadyOgg)}
            disabled={exporting}
          >
            {exporting ? 'Packing…' : 'Export'}
          </button>
        </footer>
      </div>
    </div>
  );
}
