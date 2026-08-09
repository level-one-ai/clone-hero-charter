import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import {
  midiToChart,
  formatImportReport,
  type MelodyMappingOptions,
} from '@/lib/chart/midiToChart';
import { isValidSongId, songDir } from '@/lib/server/paths';
import { readProject, saveProject } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Re-run the MIDI import against the reference file kept in the project folder.
 *
 * This exists because track detection is a guess. Chart MIDIs do not reliably name
 * their guitar track, so when the importer picks the wrong one — or the right one at
 * the wrong octave — the user needs a way to correct it without re-uploading the audio
 * and losing the project. `source.mid` is stored on creation precisely for this.
 *
 * GET  analyses the file and returns what each track would produce, changing nothing.
 * POST applies a chosen track/offset and rewrites the chart.
 */

/** GET — analyse source.mid and report the options, without touching the project. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const project = await readProject(id);
  if (!project) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  const sourcePath = path.join(songDir(id), 'source.mid');
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(sourcePath);
  } catch {
    return NextResponse.json(
      { error: 'This project was not created from a MIDI file, so there is nothing to re-import.' },
      { status: 404 },
    );
  }

  try {
    // The default (auto-detected) import, for the track list and fit scores.
    const auto = midiToChart(new Uint8Array(buffer), id);

    /**
     * What each track WOULD yield if chosen. Running the full conversion per track is
     * cheap next to the round trip, and it means the picker shows real note counts
     * rather than asking the user to guess from a fit percentage alone.
     */
    const previews = auto.report.trackSummaries.map((summary) => {
      try {
        const attempt = midiToChart(new Uint8Array(buffer), id, { trackIndex: summary.index });
        return {
          index: summary.index,
          name: summary.name,
          noteCount: summary.noteCount,
          range: summary.range,
          chartFit: summary.chartFit,
          offset: summary.offset,
          notesPerDifficulty: attempt.report.notesPerDifficulty,
        };
      } catch {
        return {
          index: summary.index,
          name: summary.name,
          noteCount: summary.noteCount,
          range: summary.range,
          chartFit: summary.chartFit,
          offset: summary.offset,
          notesPerDifficulty: { Expert: 0, Hard: 0, Medium: 0, Easy: 0 },
        };
      }
    });

    return NextResponse.json({
      currentTrack: auto.report.selectedTrack,
      selectionReason: auto.report.selectionReason,
      octaveOffset: auto.report.octaveOffset,
      musicalMode: auto.report.musicalMode,
      noteHistogram: auto.report.noteHistogram,
      warnings: auto.report.warnings,
      tracks: previews,
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not read the stored MIDI: ${(error as Error).message}` },
      { status: 500 },
    );
  }
}

/**
 * POST — re-import with an explicit track and/or octave offset.
 *
 * Replaces the note data and the tempo map, but deliberately KEEPS the song metadata,
 * audio and album art: those are the user's, not the MIDI's, and re-deriving them would
 * undo any edits made in the Song panel.
 *
 * This is destructive to charted notes by design — it is the "start over from the
 * MIDI" action — so the UI confirms before calling it.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const existing = await readProject(id);
  if (!existing) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  let body: {
    trackIndex?: number;
    octaveOffset?: number;
    mode?: string;
    melody?: {
      strategy?: string;
      split?: string;
      useOpenNotes?: boolean;
      invert?: boolean;
      maxChordSize?: number;
    };
  } = {};
  try {
    body = ((await request.json()) ?? {}) as typeof body;
  } catch {
    // No body — re-import with auto-detection.
  }

  const trackIndex =
    typeof body.trackIndex === 'number' && Number.isInteger(body.trackIndex) && body.trackIndex >= 0
      ? body.trackIndex
      : undefined;
  const octaveOffset =
    typeof body.octaveOffset === 'number' && Number.isInteger(body.octaveOffset)
      ? Math.max(-48, Math.min(48, body.octaveOffset))
      : undefined;

  const mode =
    body.mode === 'chart' || body.mode === 'musical' || body.mode === 'auto'
      ? body.mode
      : undefined;

  // Whitelist rather than pass through: these come from a request body.
  const raw = body.melody ?? {};
  const melody: MelodyMappingOptions = {
    strategy: raw.strategy === 'contour' ? 'contour' : 'pitch',
    split:
      raw.split === 'even' || raw.split === 'distinct' || raw.split === 'balanced'
        ? raw.split
        : 'balanced',
    useOpenNotes: raw.useOpenNotes !== false,
    invert: raw.invert === true,
    maxChordSize:
      typeof raw.maxChordSize === 'number' ? Math.max(1, Math.min(5, raw.maxChordSize)) : 3,
  };

  const sourcePath = path.join(songDir(id), 'source.mid');
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(sourcePath);
  } catch {
    return NextResponse.json(
      { error: 'This project was not created from a MIDI file, so there is nothing to re-import.' },
      { status: 404 },
    );
  }

  try {
    const result = midiToChart(new Uint8Array(buffer), id, {
      trackIndex,
      octaveOffset,
      mode,
      melody,
      resolution: existing.resolution,
    });
    console.log(`[midi-reimport ${id}]\n${formatImportReport(result.report)}`);

    // Keep everything that is not derived from the MIDI.
    const project = {
      ...result.project,
      id,
      meta: existing.meta,
      audio: existing.audio,
      album: existing.album,
    };

    await saveProject(project);
    return NextResponse.json({ ok: true, project, report: result.report });
  } catch (error) {
    console.error(`Failed to re-import MIDI for ${id}:`, error);
    return NextResponse.json(
      { error: `Could not re-import that MIDI: ${(error as Error).message}` },
      { status: 500 },
    );
  }
}
