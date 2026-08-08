'use client';

import { useRef, useState } from 'react';
import type { Project } from '@/lib/chart/types';
import { exportFolderName } from '@/lib/chart/naming';
import type { EditorAction } from '@/lib/editor/projectReducer';
import { uploadAlbumArt } from '@/lib/client/api';

/**
 * Song properties — the equivalent of Moonscraper's Song Properties panel.
 *
 * Every field dispatches the reducer's existing `setMeta` action, so edits join the
 * normal undo history and the existing debounced autosave. There is no separate save
 * path for metadata.
 *
 * The export folder name is previewed live because it is derived from three of these
 * fields. Discovering the naming only at download time, after the zip has landed in
 * your downloads folder, is exactly the wrong moment to notice a typo.
 */

interface Props {
  project: Project;
  dispatch: React.Dispatch<EditorAction>;
  /** Called after album art is replaced, so the parent can refresh its preview. */
  onAlbumChanged: (filename: string) => void;
  /** Opens the MIDI re-import dialog, owned by the editor shell. */
  onRequestReimport: () => void;
}

export default function SongPropertiesPanel({
  project,
  dispatch,
  onAlbumChanged,
  onRequestReimport,
}: Props) {
  const { meta } = project;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [albumError, setAlbumError] = useState<string | null>(null);
  // Bumped after an upload to bust the browser's cache of the album endpoint, whose
  // URL does not otherwise change when the image behind it does.
  const [albumVersion, setAlbumVersion] = useState(0);

  const setMeta = (patch: Partial<Project['meta']>) => dispatch({ type: 'setMeta', meta: patch });

  const handleAlbumFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setAlbumError(null);
    try {
      const filename = await uploadAlbumArt(project.id, file);
      setAlbumVersion((v) => v + 1);
      onAlbumChanged(filename);
    } catch (error) {
      setAlbumError((error as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const folderName = exportFolderName(meta);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <section className="border-b border-edge p-3">
        <h3 className="mb-3 text-2xs uppercase tracking-widest text-muted">Song</h3>

        <div className="space-y-3">
          <Field label="Title">
            <input
              className="ch-input"
              value={meta.name}
              maxLength={300}
              onChange={(event) => setMeta({ name: event.target.value })}
            />
          </Field>
          <Field label="Artist">
            <input
              className="ch-input"
              value={meta.artist}
              maxLength={300}
              onChange={(event) => setMeta({ artist: event.target.value })}
            />
          </Field>
          <Field label="Album">
            <input
              className="ch-input"
              value={meta.album}
              maxLength={300}
              onChange={(event) => setMeta({ album: event.target.value })}
            />
          </Field>
          <div className="flex gap-3">
            <Field label="Year" className="w-24">
              <input
                className="ch-input"
                value={meta.year ?? ''}
                inputMode="numeric"
                maxLength={4}
                placeholder="2024"
                onChange={(event) => {
                  const digits = event.target.value.replace(/[^0-9]/g, '').slice(0, 4);
                  // Only a complete 4-digit year is a year; anything shorter is still
                  // being typed, so store null rather than a nonsense value like 20.
                  setMeta({ year: digits.length === 4 ? Number.parseInt(digits, 10) : null });
                }}
              />
            </Field>
            <Field label="Genre" className="flex-1">
              <input
                className="ch-input"
                value={meta.genre}
                maxLength={120}
                onChange={(event) => setMeta({ genre: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Charter">
            <input
              className="ch-input"
              value={meta.charter}
              maxLength={120}
              placeholder="Your name"
              onChange={(event) => setMeta({ charter: event.target.value })}
            />
          </Field>
        </div>
      </section>

      {/* ---- Export folder name preview ------------------------------------- */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Export folder</h3>
        <p className="break-words border border-edge2 bg-bg px-2 py-1.5 font-mono text-2xs text-fg">
          {folderName}
        </p>
        <p className="mt-1 text-2xs text-faint">
          Artist &minus; Title (Charter). This names both the zip and the folder inside it,
          so it drops straight into your Clone Hero Songs folder.
        </p>
      </section>

      {/* ---- Album art ------------------------------------------------------- */}
      <section className="p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Album art</h3>
        <div className="flex items-start gap-3">
          {project.album ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/songs/${project.id}/album?v=${albumVersion}`}
              alt=""
              className="h-16 w-16 shrink-0 border border-edge object-cover"
            />
          ) : (
            <div className="h-16 w-16 shrink-0 border border-edge bg-panel2" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="ch-button w-full"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? 'Uploading…' : project.album ? 'Replace' : 'Add image'}
            </button>
            <p className="mt-1 truncate text-2xs text-faint">
              {project.album ?? 'No album art'}
            </p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          className="hidden"
          onChange={(event) => void handleAlbumFile(event.target.files?.[0])}
        />
        {albumError && <p className="mt-2 text-2xs text-danger">{albumError}</p>}
        <p className="mt-2 text-2xs text-faint">
          PNG or JPG, square works best. Packaged as album.png or album.jpg — Clone Hero
          reads either.
        </p>
      </section>

      {/* ---- Re-import ------------------------------------------------------- */}
      <section className="border-t border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Source MIDI</h3>
        <button type="button" className="ch-button w-full" onClick={onRequestReimport}>
          Re-import from MIDI
        </button>
        <p className="mt-2 text-2xs text-faint">
          Chart MIDIs do not reliably name their guitar track, so the importer has to
          guess. Use this to pick the track by hand if it chose the wrong part, or if a
          difficulty came in empty.
        </p>
      </section>
    </div>
  );
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="ch-label">{label}</span>
      {children}
    </label>
  );
}
