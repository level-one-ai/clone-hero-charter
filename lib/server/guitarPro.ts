import * as alphaTab from '@coderline/alphatab';
import type { ParsedMidi } from '@/lib/chart/midiToChart';

/**
 * Guitar Pro import.
 *
 * WHY ALPHATAB RATHER THAN A CONVERTER BINARY
 * -------------------------------------------
 * The obvious route is GuitarPro-to-Midi, the .NET CLI everyone uses. It is a C# port of
 * alphaTab's Guitar Pro importers — the same parsing lineage, the same five formats. What
 * differs is packaging: alphaTab is a plain npm dependency with no native code and no
 * runtime dependencies, so it works in `npm run dev` and needs no change to the
 * Dockerfile. The .NET tool would mean either a large SDK build stage or downloading a
 * prebuilt binary at image build time, and its releases cover linux-x64 but NOT
 * linux-arm64 — so on an ARM host it would simply not run.
 *
 * WHY WE NEVER ASK FOR A MIDI FILE
 * --------------------------------
 * alphaTab's SMF *writer* has known output bugs (CoderLine/alphaTab#943). So we run its
 * generator into an in-memory MidiFile and read the note events off it directly. The
 * serializer is the broken part; event generation is what alphaTab's own playback engine
 * consumes, and it carries the full effect simulation — bends, harmonics, muted notes,
 * strum patterns — that makes these files worth importing in the first place.
 *
 * The result is shaped as a `ParsedMidi`, so everything downstream in midiToChart —
 * track scoring, musical mode, pitch-to-fret mapping, the import report — applies to a
 * .gp file exactly as it does to a .mid.
 */

/** Extensions Guitar Pro has used across versions 3 to 7. */
export const GUITAR_PRO_EXTENSIONS = ['.gp3', '.gp4', '.gp5', '.gpx', '.gp'] as const;

export function isGuitarProExtension(ext: string): boolean {
  return (GUITAR_PRO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export interface GuitarProImport {
  parsed: ParsedMidi;
  /** Metadata from the file itself, used to prefill the song fields. */
  meta: { title: string; artist: string; album: string };
  warnings: string[];
}

export function parseGuitarPro(data: Uint8Array): GuitarProImport {
  // alphaTab logs a stack trace to the console for any unreadable file. We turn every
  // failure into a thrown Error with a useful message, so its logging would only fill the
  // server output with noise whenever someone uploads the wrong file.
  alphaTab.Logger.logLevel = alphaTab.LogLevel.None;

  const settings = new alphaTab.Settings();

  let score: alphaTab.model.Score;
  try {
    score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(data, settings);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `This Guitar Pro file could not be read (${detail}). If it was written by a very old ` +
        'or unusual version, re-saving it from Guitar Pro as .gp5 usually fixes it.',
    );
  }

  const warnings: string[] = [];

  // Generate the playback events in memory. `true` selects SMF-1.0-style output, which is
  // what puts each score track on its own event track — the grouping we need below.
  const midiFile = new alphaTab.midi.MidiFile();
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midiFile, true);
  new alphaTab.midi.MidiFileGenerator(score, settings, handler).generate();

  const ppq = midiFile.division > 0 ? midiFile.division : 960;

  // ---- notes, grouped by score track ------------------------------------------------
  // Every event carries the index of the score track it came from, so tracks survive the
  // trip intact — which is what gives the picker real names like "Rhythm Guitar" instead
  // of "track 4".
  const notes: { ticks: number; durationTicks: number; midi: number }[][] = score.tracks.map(
    () => [],
  );
  // A note is open until its note-off arrives. Keyed by track+channel+pitch, because the
  // same pitch can legitimately sound on two channels of one track (alphaTab splits some
  // effects onto a secondary channel).
  const pending = new Map<string, { ticks: number; midi: number }>();

  for (const event of midiFile.events) {
    if (event instanceof alphaTab.midi.NoteOnEvent) {
      const key = `${event.track}:${event.channel}:${event.noteKey}`;
      // A repeated note-on without a note-off means a re-strike; close the old one at
      // this tick rather than losing it.
      const open = pending.get(key);
      if (open && notes[event.track]) {
        notes[event.track].push({
          ticks: open.ticks,
          durationTicks: Math.max(0, event.tick - open.ticks),
          midi: open.midi,
        });
      }
      pending.set(key, { ticks: event.tick, midi: event.noteKey });
    } else if (event instanceof alphaTab.midi.NoteOffEvent) {
      const key = `${event.track}:${event.channel}:${event.noteKey}`;
      const open = pending.get(key);
      if (!open) continue;
      pending.delete(key);
      if (!notes[event.track]) continue;
      notes[event.track].push({
        ticks: open.ticks,
        durationTicks: Math.max(0, event.tick - open.ticks),
        midi: open.midi,
      });
    }
  }

  // Anything still sounding at the end of the file gets a zero length rather than being
  // dropped — a missing note is worse than a missing sustain.
  for (const [key, open] of pending) {
    const trackIndex = Number(key.split(':')[0]);
    if (notes[trackIndex]) {
      notes[trackIndex].push({ ticks: open.ticks, durationTicks: 0, midi: open.midi });
    }
  }
  for (const list of notes) list.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);

  // ---- tempo and time signature -----------------------------------------------------
  const tempos = midiFile.events
    .filter((e): e is alphaTab.midi.TempoChangeEvent => e instanceof alphaTab.midi.TempoChangeEvent)
    .map((e) => ({ ticks: e.tick, bpm: e.beatsPerMinute }))
    .filter((t) => Number.isFinite(t.bpm) && t.bpm > 0);
  if (tempos.length === 0) {
    tempos.push({ ticks: 0, bpm: score.tempo > 0 ? score.tempo : 120 });
    warnings.push('The Guitar Pro file had no tempo events; used the score tempo instead.');
  }

  const timeSignatures = midiFile.events
    .filter(
      (e): e is alphaTab.midi.TimeSignatureEvent => e instanceof alphaTab.midi.TimeSignatureEvent,
    )
    .map((e) => ({
      ticks: e.tick,
      // MIDI stores the denominator as a power of two, so 2 means a quarter-note beat.
      timeSignature: [e.numerator, 2 ** e.denominatorIndex],
    }));

  const totalNotes = notes.reduce((sum, list) => sum + list.length, 0);
  if (totalNotes === 0) {
    warnings.push('No notes were found in this Guitar Pro file.');
  }

  return {
    parsed: {
      name: score.title || undefined,
      header: { ppq, tempos, timeSignatures },
      tracks: score.tracks.map((track, index) => ({
        name: track.name || `Track ${index + 1}`,
        notes: notes[index] ?? [],
      })),
    },
    meta: {
      title: (score.title || '').trim(),
      artist: (score.artist || '').trim(),
      album: (score.album || '').trim(),
    },
    warnings,
  };
}
