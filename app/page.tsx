'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { SongIndexEntry } from '@/lib/chart/types';
import { deleteSong, fetchSongs } from '@/lib/client/api';
import { formatTime } from '@/lib/chart/timing';

/** Project list — the app's home screen. */
export default function HomePage() {
  const [songs, setSongs] = useState<SongIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const index = await fetchSongs();
      setSongs(index.songs);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (id: string) => {
    try {
      await deleteSong(id);
      setSongs((current) => current.filter((s) => s.id !== id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-edge px-6 py-4">
        <div>
          <h1 className="text-sm uppercase tracking-[0.3em] text-fg">Charter</h1>
          <p className="mt-1 text-2xs uppercase tracking-widest text-faint">
            Clone Hero chart editor
          </p>
        </div>
        <Link href="/new" className="ch-button ch-button-primary">
          New Song
        </Link>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {error && (
          <div className="mb-4 border border-danger bg-panel px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-xs uppercase tracking-widest text-faint">Loading…</p>
        ) : songs.length === 0 ? (
          <div className="ch-panel rounded-md p-8 text-center">
            <p className="text-sm text-muted">No songs yet.</p>
            <p className="mt-2 text-xs text-faint">
              Create one to import audio and a reference .mid or .chart.
            </p>
            <Link href="/new" className="ch-button mt-5">
              New Song
            </Link>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {songs.map((song) => (
              <li key={song.id} className="ch-panel rounded-md">
                <Link href={`/songs/${song.id}`} className="flex gap-3 p-3">
                  <AlbumThumb song={song} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg">{song.title || 'Untitled'}</p>
                    <p className="truncate text-xs text-muted">{song.artist || 'Unknown artist'}</p>
                    <p className="mt-2 truncate text-2xs uppercase tracking-widest text-faint">
                      {[song.album, song.year ?? null].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                </Link>
                <div className="flex items-center justify-between border-t border-edge px-3 py-2">
                  <span className="font-mono text-2xs text-faint">
                    {song.durationMs > 0 ? formatTime(song.durationMs / 1000) : '—'}
                  </span>
                  {pendingDelete === song.id ? (
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        className="text-2xs uppercase tracking-widest text-danger hover:underline"
                        onClick={() => void handleDelete(song.id)}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        className="text-2xs uppercase tracking-widest text-faint hover:text-fg"
                        onClick={() => setPendingDelete(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="text-2xs uppercase tracking-widest text-faint hover:text-danger"
                      onClick={() => setPendingDelete(song.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function AlbumThumb({ song }: { song: SongIndexEntry }) {
  const [failed, setFailed] = useState(false);
  if (!song.albumFile || failed) {
    return (
      <div className="h-14 w-14 shrink-0 border border-edge bg-panel2" aria-hidden />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/songs/${song.id}/album`}
      alt=""
      className="h-14 w-14 shrink-0 border border-edge object-cover"
      onError={() => setFailed(true)}
    />
  );
}
