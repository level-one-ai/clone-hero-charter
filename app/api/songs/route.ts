import { NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createEmptyProject, type Project } from '@/lib/chart/types';
import {
  convertParsedMidi,
  midiToChart,
  formatImportReport,
  type MidiImportReport,
} from '@/lib/chart/midiToChart';
import { isGuitarProExtension, parseGuitarPro } from '@/lib/server/guitarPro';
import { parseChart } from '@/lib/chart/parseChart';
import { alignImportToLeadIn } from '@/lib/chart/alignImport';
import { probeAudio } from '@/lib/server/audio';
import { songDir } from '@/lib/server/paths';
import { newSongId, readIndex, saveProject, sweepTmp } from '@/lib/server/storage';
import {
  AUDIO_EXTENSIONS,
  CHART_EXTENSIONS,
  IMAGE_EXTENSIONS,
  UploadError,
  cleanupUpload,
  commitUploadedFile,
  extensionOf,
  parseMultipart,
} from '@/lib/server/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/songs — the project list. */
export async function GET() {
  const index = await readIndex();
  return NextResponse.json(index);
}

/**
 * POST /api/songs — create a project.
 *
 * multipart/form-data:
 *   title, artist, album, year, charter   text fields
 *   audio                                 required, .wav/.ogg/.mp3/.opus/.flac
 *   reference                             optional, .mid or .chart
 *   albumArt                              optional, .png/.jpg
 *
 * Ordering matters here: everything that can fail (validation, MIDI parsing) runs
 * BEFORE the project folder is created, so a rejected upload never leaves a half-built
 * folder behind for the user to clean up.
 */
export async function POST(request: Request) {
  // Opportunistic cleanup of temp files orphaned by an earlier crash.
  void sweepTmp().catch(() => {});

  let upload;
  try {
    upload = await parseMultipart(request);
  } catch (error) {
    const status = error instanceof UploadError ? error.status : 400;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }

  try {
    const { fields, files } = upload;

    const title = (fields.title ?? '').trim();
    const artist = (fields.artist ?? '').trim();
    // Title and artist are required, but a Guitar Pro file carries its own — so the
    // check is deferred until after the import for those, and only fails if the file
    // turns out not to name the song either. Demanding a title the user is about to
    // upload anyway would be busywork.
    const referenceIsGuitarPro = files.some(
      (f) => f.field === 'reference' && isGuitarProExtension(extensionOf(f.filename)),
    );
    if (!title && !referenceIsGuitarPro) return bad('Song title is required');
    if (!artist && !referenceIsGuitarPro) return bad('Artist is required');

    const yearRaw = (fields.year ?? '').trim();
    let year: number | null = null;
    if (yearRaw) {
      if (!/^\d{4}$/.test(yearRaw)) return bad('Year must be exactly 4 digits');
      year = Number.parseInt(yearRaw, 10);
    }

    const audioFile = files.find((f) => f.field === 'audio');
    if (!audioFile) return bad('An audio file is required');
    const audioExt = extensionOf(audioFile.filename);
    if (!AUDIO_EXTENSIONS.includes(audioExt)) {
      return bad(`Unsupported audio format "${audioExt || audioFile.filename}". Use ${AUDIO_EXTENSIONS.join(', ')}.`);
    }

    const referenceFile = files.find((f) => f.field === 'reference');
    const referenceExt = referenceFile ? extensionOf(referenceFile.filename) : '';
    if (referenceFile && !CHART_EXTENSIONS.includes(referenceExt)) {
      return bad(
        `Reference file must be ${CHART_EXTENSIONS.join(', ')}, got "${referenceExt || referenceFile.filename}"`,
      );
    }

    const albumArtFile = files.find((f) => f.field === 'albumArt');
    const albumArtExt = albumArtFile ? extensionOf(albumArtFile.filename) : '';
    if (albumArtFile && !IMAGE_EXTENSIONS.includes(albumArtExt)) {
      return bad(`Album art must be .png or .jpg, got "${albumArtExt || albumArtFile.filename}"`);
    }

    const id = newSongId();

    // ---- build the project model from the reference file, if any ----------------
    let project: Project;
    let midiReport: MidiImportReport | null = null;
    let gpMeta: { title: string; artist: string; album: string } | null = null;
    const warnings: string[] = [];

    if (referenceFile && isGuitarProExtension(referenceExt)) {
      // Guitar Pro files go through alphaTab's score model and then down exactly the
      // same path as a MIDI file, so track picking, musical mode and the import report
      // all behave identically — see lib/server/guitarPro.ts.
      const buffer = await fs.readFile(referenceFile.tempPath);
      try {
        const gp = parseGuitarPro(new Uint8Array(buffer));
        /**
         * Always musical mode. The chart-fit heuristic exists to spot MIDI files written
         * in the Guitar Hero note layout (Expert at 96, Hard at 84 and so on) — a
         * charting convention. A Guitar Pro file is sheet music: its pitches are the
         * notes the guitarist plays. Letting the heuristic guess means a transcription
         * that happens to sit in the 60-100 range gets shredded across difficulties,
         * which is exactly what "Astronomy" did before this line.
         */
        const result = convertParsedMidi(gp.parsed, id, { mode: 'musical' });
        project = result.project;
        midiReport = result.report;
        warnings.push(...gp.warnings, ...result.report.warnings);
        // The file knows its own title and artist; remember them so the empty form
        // fields below can fall back to them rather than to nothing.
        gpMeta = gp.meta;
        console.log(`[gp-import ${id}] ${referenceExt}\n${formatImportReport(result.report)}`);
      } catch (error) {
        return bad(`Could not read that Guitar Pro file: ${(error as Error).message}`);
      }
    } else if (referenceFile && (referenceExt === '.mid' || referenceExt === '.midi')) {
      const buffer = await fs.readFile(referenceFile.tempPath);
      try {
        const result = midiToChart(new Uint8Array(buffer), id);
        project = result.project;
        midiReport = result.report;
        warnings.push(...result.report.warnings);
        // Logged in full so a mis-mapped file can be diagnosed from the server output.
        console.log(`[midi-import ${id}]\n${formatImportReport(result.report)}`);
      } catch (error) {
        return bad(`Could not read that MIDI file: ${(error as Error).message}`);
      }
    } else if (referenceFile && referenceExt === '.chart') {
      const text = await fs.readFile(referenceFile.tempPath, 'utf8');
      try {
        const result = parseChart(text, id);
        project = result.project;
        warnings.push(...result.warnings);
      } catch (error) {
        return bad(`Could not read that .chart file: ${(error as Error).message}`);
      }
    } else {
      project = createEmptyProject(id);
    }

    // The form wins over the file, but a Guitar Pro file carries its own title, artist
    // and album — so an empty form field falls back to what the file says rather than
    // leaving the user to retype what they already have.
    project.id = id;
    project.meta.name = title || gpMeta?.title || project.meta.name;
    project.meta.artist = artist || gpMeta?.artist || project.meta.artist;
    project.meta.album = (fields.album ?? '').trim() || gpMeta?.album || '';
    // Plenty of Guitar Pro files leave the artist or even the title blank. Rejecting an
    // otherwise perfect import over a missing text field would be absurd, so fall back
    // and say so — both are editable in Song Properties.
    if (!project.meta.name.trim()) {
      project.meta.name = referenceFile
        ? referenceFile.filename.replace(/\.[^.]+$/, '')
        : 'Untitled';
      warnings.push(`The file did not name the song, so the title was set to "${project.meta.name}".`);
    }
    if (!project.meta.artist.trim()) {
      project.meta.artist = 'Unknown Artist';
      warnings.push('The file did not name the artist. Set it in Song Properties before exporting.');
    }
    project.meta.year = year;
    project.meta.charter = (fields.charter ?? '').trim();

    /**
     * Slide the import in behind the lead-in.
     *
     * Applied to every source, including .chart. For a score — Guitar Pro or a
     * transcription MIDI — this is what puts bar 1 of the music on bar 1 of the chart
     * instead of inside the count-in. For a .chart it PRESERVES sync rather than
     * establishing it: the notes move later by the lead-in and the audio gains exactly
     * that much silence in front, so what lined up before still lines up.
     */
    project = alignImportToLeadIn(project, project.meta.leadIn);

    // ---- commit files to the project folder -------------------------------------
    const dir = songDir(id);
    await fs.mkdir(dir, { recursive: true });

    const audioName = `audio${audioExt}`;
    await commitUploadedFile(audioFile.tempPath, path.join(dir, audioName));

    const probe = await probeAudio(path.join(dir, audioName));
    project.audio = {
      file: audioName,
      durationMs: probe.durationMs,
      sampleRate: probe.sampleRate,
      // The whole file, until the charter picks a section; and no tempo reading yet —
      // detection runs in the browser on first open, where the decoded audio already is.
      region: null,
      detected: null,
    };
    if (probe.durationMs <= 0) {
      warnings.push(
        'Could not determine the audio duration. song_length in the export will be wrong until this is fixed — check that the file is valid.',
      );
    }

    if (albumArtFile) {
      const albumName = `album${albumArtExt === '.jpeg' ? '.jpg' : albumArtExt}`;
      await commitUploadedFile(albumArtFile.tempPath, path.join(dir, albumName));
      project.album = albumName;
    }

    // Keep the original reference file so the import can be repeated later with
    // different settings (e.g. a corrected octave offset) without a re-upload.
    if (referenceFile) {
      const sourceName =
        referenceExt === '.chart'
          ? 'source.chart'
          : isGuitarProExtension(referenceExt)
            ? `source${referenceExt}`
            : 'source.mid';
      await commitUploadedFile(referenceFile.tempPath, path.join(dir, sourceName));
    }

    // Writes project.json AND notes.chart, then updates the index.
    await saveProject(project);

    return NextResponse.json({ id, project, warnings, midiReport }, { status: 201 });
  } catch (error) {
    console.error('Failed to create song project:', error);
    return NextResponse.json(
      { error: `Could not create the project: ${(error as Error).message}` },
      { status: 500 },
    );
  } finally {
    // Removes anything not already renamed into place.
    await cleanupUpload(upload);
  }
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}
