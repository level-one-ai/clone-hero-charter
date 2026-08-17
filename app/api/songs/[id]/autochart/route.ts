import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { detectOnsets, onsetsToNotes } from '@/lib/chart/autoChart';
import { TimingMap } from '@/lib/chart/timing';
import { buildAudioTimeline } from '@/lib/chart/audioTimeline';
import { trackNameFor, type Difficulty, type TrackName } from '@/lib/chart/types';
import { decodeToMono } from '@/lib/server/audio';
import { isValidSongId, songDir } from '@/lib/server/paths';
import { readProject, saveProject } from '@/lib/server/storage';
import { mergeIntoGaps } from '@/lib/server/mergeNotes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/songs/[id]/autochart — chart a marked stretch from the audio.
 *
 * Deliberately scoped to a range the user marked as missing. Two reasons: it can then
 * never disturb work already done, and it keeps the promise honest — this finds the
 * RHYTHM of a passage reliably and guesses at the frets, so it is a scaffold for a
 * section you have not started, not a replacement for charting.
 *
 * The heavy lifting is on the server because decoding a three-minute WAV and running an
 * FFT over it would lock the editor's UI thread for seconds.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const project = await readProject(id);
  if (!project) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  let body: { fromTick?: number; toTick?: number; difficulty?: string; sensitivity?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Request body was not valid JSON' }, { status: 400 });
  }

  const fromTick = Math.max(0, Math.round(body.fromTick ?? 0));
  const toTick = Math.round(body.toTick ?? 0);
  if (!(toTick > fromTick)) {
    return NextResponse.json(
      { error: 'Mark the stretch to fill first — select a range on the highway.' },
      { status: 400 },
    );
  }

  const difficulty = (['Expert', 'Hard', 'Medium', 'Easy'] as Difficulty[]).includes(
    body.difficulty as Difficulty,
  )
    ? (body.difficulty as Difficulty)
    : 'Expert';
  const trackName: TrackName = trackNameFor(difficulty);

  const audioPath = path.join(songDir(id), project.audio.file);
  try {
    await fs.access(audioPath);
  } catch {
    return NextResponse.json({ error: 'This project has no audio to listen to' }, { status: 400 });
  }

  const timing = new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures);

  /**
   * Only decode the stretch being charted.
   *
   * The lead-in and the region both shift chart time relative to the audio file, so the
   * window has to be converted back through the same timeline the editor plays against.
   * Getting this wrong would put every generated note out by exactly that shift.
   */
  const timeline = buildAudioTimeline(project, timing);
  const fromSec = Math.max(0, timeline.chartToAudio(timing.tickToSec(fromTick)));
  const toSec = Math.max(fromSec, timeline.chartToAudio(timing.tickToSec(toTick)));

  let audio;
  try {
    audio = await decodeToMono(audioPath, fromSec, toSec - fromSec);
  } catch (error) {
    return NextResponse.json(
      { error: `Could not read the audio: ${(error as Error).message}` },
      { status: 500 },
    );
  }
  if (audio.samples.length === 0) {
    return NextResponse.json({ error: 'That range contains no audio' }, { status: 400 });
  }

  const onsets = detectOnsets(audio.samples, {
    sampleRate: audio.sampleRate,
    sensitivity: typeof body.sensitivity === 'number' ? body.sensitivity : undefined,
  });

  // Onset times are relative to the decoded window, so shift them back into chart time
  // through the same timeline the window was cut with.
  const candidates = onsetsToNotes(
    onsets.map((onset) => ({
      ...onset,
      timeSec: timeline.audioToChart(onset.timeSec + fromSec),
    })),
    (seconds) => timing.secToTick(seconds),
    {
      resolution: project.resolution,
      // A sixteenth: fine enough for most playing, coarse enough that a detection a few
      // milliseconds early still lands on the beat a human would have chosen.
      snapTicks: Math.max(1, Math.round(project.resolution / 4)),
      fromTick,
      toTick,
    },
  );

  // Belt and braces: the range was meant to be empty, but gap-filling guarantees that
  // anything already charted survives even if it was not.
  const existing = project.tracks[trackName].notes;
  const merged = mergeIntoGaps(existing, candidates, {
    windowTicks: Math.max(1, Math.round(project.resolution / 2)),
  });

  const updated = {
    ...project,
    tracks: {
      ...project.tracks,
      [trackName]: { notes: merged.notes, starPower: project.tracks[trackName].starPower },
    },
  };

  try {
    const stored = await saveProject(updated);
    return NextResponse.json({
      ok: true,
      project: stored,
      onsets: onsets.length,
      added: merged.added,
      skipped: merged.skipped,
    });
  } catch (error) {
    console.error(`Failed to auto-chart ${id}:`, error);
    return NextResponse.json({ error: 'Could not save the generated notes' }, { status: 500 });
  }
}
