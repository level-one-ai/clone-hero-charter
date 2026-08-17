import fs from 'node:fs/promises';
import path from 'node:path';
import { Midi } from '@tonejs/midi';
import { NextResponse } from 'next/server';
import { convertParsedMidi, type ParsedMidi } from '@/lib/chart/midiToChart';
import { TRACK_NAMES, type Track } from '@/lib/chart/types';
import { isValidSongId, songDir } from '@/lib/server/paths';
import { readProject, saveProject } from '@/lib/server/storage';
import { shiftImport } from '@/lib/chart/alignImport';
import { leadInTicks } from '@/lib/chart/audioTimeline';
import { TimingMap } from '@/lib/chart/timing';
import { isGuitarProExtension, parseGuitarPro } from '@/lib/server/guitarPro';
import { mergeTracksIntoGaps } from '@/lib/server/mergeNotes';
import { commitUploadedFile, extensionOf, parseMultipart, CHART_EXTENSIONS } from '@/lib/server/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/songs/[id]/reimport/merge — add notes from extra files into the gaps.
 *
 * A single MIDI export often covers only part of a song: one guitar part, or a file that
 * drops out through a section. This takes further files and fills in what is missing,
 * WITHOUT touching anything already charted — see lib/server/mergeNotes.ts for why the
 * "already covered" test is deliberately generous.
 *
 * Files are parsed by exactly the same code as the initial import, so track picking,
 * musical mode and Guitar Pro support all behave identically here.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const project = await readProject(id);
  if (!project) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  let upload;
  try {
    upload = await parseMultipart(request);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  const files = upload.files.filter((f) => f.field === 'files');
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files were uploaded' }, { status: 400 });
  }

  // An eighth note: close enough that a second transcription of the same riff counts as
  // already charted rather than being layered on top a fraction out of step.
  const windowTicks = Math.max(1, Math.round(project.resolution / 2));

  // The grid the incoming notes are joining.
  const timing = new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures);

  let tracks: Record<string, Track> = { ...project.tracks };
  let added = 0;
  let skipped = 0;
  const warnings: string[] = [];
  const perFile: Array<{ name: string; added: number; skipped: number; track: string }> = [];

  for (const [index, file] of files.entries()) {
    const ext = extensionOf(file.filename);
    if (!CHART_EXTENSIONS.includes(ext) || ext === '.chart') {
      warnings.push(`Skipped "${file.filename}" — merging supports MIDI and Guitar Pro files.`);
      continue;
    }

    try {
      const buffer = await fs.readFile(file.tempPath);
      const bytes = new Uint8Array(buffer);

      let parsed: ParsedMidi;
      let musical = false;
      if (isGuitarProExtension(ext)) {
        const gp = parseGuitarPro(bytes);
        parsed = gp.parsed;
        // A Guitar Pro score is sheet music, never the Guitar Hero note layout.
        musical = true;
        warnings.push(...gp.warnings);
      } else {
        parsed = new Midi(bytes);
      }

      const converted = convertParsedMidi(parsed, id, {
        resolution: project.resolution,
        ...(musical ? { mode: 'musical' as const } : {}),
      });

      /**
       * Move the incoming notes past the lead-in before merging.
       *
       * Measured against THIS project's tempo map rather than the incoming file's: the
       * notes are joining an existing grid, and a merged file whose own tempo differs
       * would otherwise land a whole count-in away from where it belongs.
       */
      const aligned = shiftImport(converted.project, leadInTicks(project.meta.leadIn, timing));

      const result = mergeTracksIntoGaps(tracks, aligned.tracks, { windowTicks });
      tracks = result.tracks;
      added += result.added;
      skipped += result.skipped;
      perFile.push({
        name: file.filename,
        added: result.added,
        skipped: result.skipped,
        track: converted.report.selectedTrack,
      });

      // Kept so a merge can be repeated or audited later, exactly as source.mid is.
      await commitUploadedFile(
        file.tempPath,
        path.join(songDir(id), `source-merge-${index + 1}${ext}`),
      );
    } catch (error) {
      warnings.push(`Could not read "${file.filename}": ${(error as Error).message}`);
    }
  }

  if (added === 0 && perFile.length === 0) {
    return NextResponse.json(
      { error: warnings[0] ?? 'None of those files could be read.' },
      { status: 400 },
    );
  }

  const merged = {
    ...project,
    tracks: Object.fromEntries(
      TRACK_NAMES.map((name) => [name, tracks[name] ?? project.tracks[name]]),
    ) as typeof project.tracks,
  };

  try {
    const stored = await saveProject(merged);
    return NextResponse.json({ ok: true, project: stored, added, skipped, perFile, warnings });
  } catch (error) {
    console.error(`Failed to merge into ${id}:`, error);
    return NextResponse.json({ error: 'Could not save the merged chart' }, { status: 500 });
  }
}
