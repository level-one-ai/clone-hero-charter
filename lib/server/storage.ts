import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import {
  DATA_DIR,
  INDEX_FILE,
  SONGS_DIR,
  ensureDataDirs,
  pathExists,
  projectFile,
  songDir,
} from './paths';
import type { Project, SongIndex, SongIndexEntry } from '../chart/types';
import { migrateProject } from '../chart/migrate';
import { writeChart } from '../chart/writeChart';

/**
 * Filesystem-backed persistence. No database — a songs.json index plus one folder
 * per project, exactly as specified.
 *
 * Two correctness concerns this module exists to handle:
 *
 * 1. TORN WRITES. A crash partway through rewriting songs.json leaves invalid JSON
 *    and loses every project. Every write goes to a temp file in the same directory
 *    and is then rename()d over the target — rename is atomic within a filesystem,
 *    so a reader sees either the old file or the new one, never a half-written one.
 *
 * 2. LOST UPDATES. Two concurrent requests doing read-modify-write on songs.json
 *    would clobber each other. Next.js serves requests concurrently on one Node
 *    process, so this is reachable in practice (create a song in two tabs). A simple
 *    promise-chain mutex serialises index mutations. It is per-process, which is
 *    correct here because the app is a single container by design.
 */

// ---------------------------------------------------------------------------
// Mutex
// ---------------------------------------------------------------------------

let indexLock: Promise<unknown> = Promise.resolve();

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn, fn);
  // Keep the chain alive even when a caller's promise rejects.
  indexLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

export async function writeFileAtomic(target: string, contents: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Temp file must live on the same filesystem as the target for rename to be atomic,
  // so it goes in the same directory rather than in tmp/.
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, contents);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const EMPTY_INDEX: SongIndex = { version: 1, songs: [] };

export async function readIndex(): Promise<SongIndex> {
  await ensureDataDirs();
  if (!(await pathExists(INDEX_FILE))) return { ...EMPTY_INDEX, songs: [] };
  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw) as SongIndex;
    if (!parsed || !Array.isArray(parsed.songs)) return { ...EMPTY_INDEX, songs: [] };
    return { version: 1, songs: parsed.songs };
  } catch {
    // A corrupt index must not brick the app. Rebuild it from the folders on disk,
    // which are the real data — the index is only a cache of their metadata.
    return rebuildIndexFromDisk();
  }
}

async function rebuildIndexFromDisk(): Promise<SongIndex> {
  const songs: SongIndexEntry[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(SONGS_DIR);
  } catch {
    return { ...EMPTY_INDEX, songs: [] };
  }

  for (const id of entries) {
    try {
      const raw = await fs.readFile(projectFile(id), 'utf8');
      const project = JSON.parse(raw) as Project;
      const stat = await fs.stat(projectFile(id));
      songs.push(indexEntryFromProject(project, stat.birthtime.toISOString(), stat.mtime.toISOString()));
    } catch {
      // Not a valid project folder; skip it.
    }
  }
  return { version: 1, songs };
}

export function indexEntryFromProject(
  project: Project,
  createdAt: string,
  updatedAt: string,
): SongIndexEntry {
  return {
    id: project.id,
    title: project.meta.name,
    artist: project.meta.artist,
    album: project.meta.album,
    year: project.meta.year,
    charter: project.meta.charter,
    createdAt,
    updatedAt,
    audioFile: project.audio.file,
    albumFile: project.album,
    durationMs: project.audio.durationMs,
  };
}

async function writeIndex(index: SongIndex): Promise<void> {
  await ensureDataDirs();
  await writeFileAtomic(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
}

/** Read-modify-write songs.json under the mutex. */
export function mutateIndex(mutator: (index: SongIndex) => SongIndex | Promise<SongIndex>): Promise<SongIndex> {
  return withIndexLock(async () => {
    const current = await readIndex();
    const next = await mutator(current);
    next.songs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    await writeIndex(next);
    return next;
  });
}

export async function upsertIndexEntry(entry: SongIndexEntry): Promise<void> {
  await mutateIndex((index) => {
    const existing = index.songs.findIndex((s) => s.id === entry.id);
    if (existing >= 0) {
      // Preserve the original creation time on update.
      index.songs[existing] = { ...entry, createdAt: index.songs[existing].createdAt };
    } else {
      index.songs.push(entry);
    }
    return index;
  });
}

export async function removeIndexEntry(id: string): Promise<void> {
  await mutateIndex((index) => {
    index.songs = index.songs.filter((s) => s.id !== id);
    return index;
  });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function newSongId(): string {
  // 12 URL-safe chars — matches the ID_RE in paths.ts.
  return nanoid(12).replace(/[^A-Za-z0-9_-]/g, '_');
}

export async function readProject(id: string): Promise<Project | null> {
  try {
    const raw = await fs.readFile(projectFile(id), 'utf8');
    // Migrate on read: a project.json can predate any field added since it was written,
    // whether it came from an old install, a backup or a copied folder.
    return migrateProject(JSON.parse(raw) as Project);
  } catch {
    return null;
  }
}

/**
 * Persist a project: writes project.json AND regenerates notes.chart, then refreshes
 * the index entry. Keeping chart generation here means the .chart on disk can never
 * drift from project.json — there is no code path that writes one without the other.
 */
export async function saveProject(project: Project): Promise<Project> {
  const dir = songDir(project.id);
  await fs.mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  // The server owns the revision. Bumping it here — the one place a project is written —
  // is what lets the chart route detect a save built on a stale copy.
  const stored: Project = { ...project, revision: (project.revision ?? 0) + 1 };
  await writeFileAtomic(projectFile(project.id), `${JSON.stringify(stored, null, 2)}\n`);
  // MusicStream names the file the EXPORT will ship, not the upload on disk, so the
  // working copy reads the same as the exported one.
  const audioExt = path.extname(project.audio.file || '').toLowerCase() || '.ogg';
  await writeFileAtomic(
    path.join(dir, 'notes.chart'),
    writeChart(stored, { musicStream: `song${audioExt}` }),
  );

  let createdAt = now;
  try {
    const stat = await fs.stat(projectFile(project.id));
    createdAt = stat.birthtime.toISOString();
  } catch {
    // Fall back to now.
  }
  await upsertIndexEntry(indexEntryFromProject(stored, createdAt, now));
  return stored;
}

export async function deleteProject(id: string): Promise<void> {
  await fs.rm(songDir(id), { recursive: true, force: true });
  await removeIndexEntry(id);
}

/** Remove stale upload staging and export scratch files left by a previous run. */
export async function sweepTmp(maxAgeMs = 6 * 60 * 60 * 1000): Promise<void> {
  await ensureDataDirs();
  const tmp = path.join(DATA_DIR, 'tmp');
  let entries: string[] = [];
  try {
    entries = await fs.readdir(tmp);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries.map(async (name) => {
      const target = path.join(tmp, name);
      try {
        const stat = await fs.stat(target);
        if (stat.mtimeMs < cutoff) await fs.rm(target, { recursive: true, force: true });
      } catch {
        // Raced with another sweep; nothing to do.
      }
    }),
  );
}
