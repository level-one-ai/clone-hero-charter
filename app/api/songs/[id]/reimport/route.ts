import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { Midi } from '@tonejs/midi';
import {
  convertParsedMidi,
  formatImportReport,
  type MelodyMappingOptions,
  type ParsedMidi,
} from '@/lib/chart/midiToChart';
import { GUITAR_PRO_EXTENSIONS, parseGuitarPro } from '@/lib/server/guitarPro';
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

/**
 * Resolve whatever source file this project was created from into a ParsedMidi.
 *
 * A project may have been created from a .mid or from a Guitar Pro file; re-import has to
 * work identically either way, so the format is resolved once here and everything below
 * works on the parsed result.
 */
async function loadSource(
  id: string,
): Promise<{ parsed: ParsedMidi; warnings: string[]; guitarPro: boolean } | { error: string }> {
  const dir = songDir(id);
  const candidates = ['source.mid', ...GUITAR_PRO_EXTENSIONS.map((ext) => `source${ext}`)];

  for (const name of candidates) {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path.join(dir, name));
    } catch {
      continue;
    }
    if (name === 'source.mid') {
      return { parsed: new Midi(new Uint8Array(buffer)), warnings: [], guitarPro: false };
    }
    try {
      const gp = parseGuitarPro(new Uint8Array(buffer));
      return { parsed: gp.parsed, warnings: gp.warnings, guitarPro: true };
    } catch (error) {
      return { error: `Could not re-read the Guitar Pro file: ${(error as Error).message}` };
    }
  }

  return {
    error:
      'This project was not created from a MIDI or Guitar Pro file, so there is nothing to re-import.',
  };
}

/** GET — analyse the stored source file and report the options, without touching the project. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const project = await readProject(id);
  if (!project) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  const source = await loadSource(id);
  if ('error' in source) return NextResponse.json({ error: source.error }, { status: 404 });
  const { parsed } = source;

  try {
    // The default (auto-detected) import, for the track list and fit scores.
    const auto = convertParsedMidi(parsed, id, source.guitarPro ? { mode: 'musical' } : {});

    /**
     * What each track WOULD yield if chosen. Running the full conversion per track is
     * cheap next to the round trip, and it means the picker shows real note counts
     * rather than asking the user to guess from a fit percentage alone.
     */
    const previews = auto.report.trackSummaries.map((summary) => {
      try {
        const attempt = convertParsedMidi(parsed, id, {
          trackIndex: summary.index,
          ...(source.guitarPro ? { mode: 'musical' as const } : {}),
        });
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

  const source = await loadSource(id);
  if ('error' in source) return NextResponse.json({ error: source.error }, { status: 404 });

  try {
    const result = convertParsedMidi(source.parsed, id, {
      trackIndex,
      octaveOffset,
      // A Guitar Pro score is sheet music, never the Guitar Hero note layout, so it
      // defaults to musical mode. An explicit choice from the dialog still wins.
      mode: mode ?? (source.guitarPro ? 'musical' : undefined),
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
