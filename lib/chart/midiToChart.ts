import { Midi } from '@tonejs/midi';
import {
  DEFAULT_RESOLUTION,
  createEmptyProject,
  emptyTracks,
  newNoteId,
  trackNameFor,
  type Difficulty,
  type Lane,
  type Note,
  type Project,
  type StarPowerPhrase,
} from './types';

/**
 * MIDI -> chart conversion for Guitar Hero style .mid files.
 *
 * Per the brief, this INSPECTS THE ACTUAL FILE BEFORE MAPPING. It reports the track
 * names it found and a full histogram of note numbers in the chosen track, so a file
 * using a non-standard octave offset shows up as a diagnostic instead of silently
 * producing an empty chart. The baseline mapping below is applied only after that,
 * and the caller can override the octave offset if the histogram says to.
 */

// ---------------------------------------------------------------------------
// Mapping baseline
// ---------------------------------------------------------------------------

/**
 * Standard GH/RB note layout. Each difficulty owns a 12-semitone block:
 *
 *   base+0..base+4  green, red, yellow, blue, orange
 *   base+5          forced HOPO  (flip the natural strum/HOPO decision on)
 *   base+6          forced strum (flip it off)
 *   base+7          open note (Clone Hero's extension; RB uses a sysex event)
 */
export const DIFFICULTY_BASE: Record<Difficulty, number> = {
  Easy: 60,
  Medium: 72,
  Hard: 84,
  Expert: 96,
};

/** Star power phrase marker, shared across all difficulties. */
const STAR_POWER_NOTE = 116;
/**
 * Note 103 was the solo/overdrive marker in some pre-RB3 charts, but it collides
 * exactly with Expert's open note (96 + 7). We resolve the ambiguity in favour of the
 * open note, because that is what Clone Hero and the .chart format actually support —
 * treating 103 as star power would silently delete every Expert open note in the file.
 */
/**
 * Tap marker. Unlike the fret notes this is GLOBAL, not per-difficulty: one note 104
 * phrase makes every note under it a tap note in all four difficulties.
 */
const TAP_NOTE = 104;

/** Track names to look for, most preferred first. */
const GUITAR_TRACK_NAMES = ['part guitar', 't1 gems', 'part guitar coop', 'part rhythm', 'guitar'];

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface MidiTrackSummary {
  index: number;
  name: string;
  noteCount: number;
  /** Lowest and highest note numbers present, or null for an empty track. */
  range: [number, number] | null;
}

export interface MidiImportReport {
  ppq: number;
  resolution: number;
  trackSummaries: MidiTrackSummary[];
  /** Name of the track we charted from, and why it was chosen. */
  selectedTrack: string;
  selectionReason: string;
  /** note number -> count, for the selected track. The key diagnostic. */
  noteHistogram: Record<number, number>;
  /** Semitone shift applied on top of the standard bases (0 when the file is standard). */
  octaveOffset: number;
  notesPerDifficulty: Record<Difficulty, number>;
  tempoCount: number;
  timeSignatureCount: number;
  warnings: string[];
}

export interface MidiImportResult {
  project: Project;
  report: MidiImportReport;
}

export interface MidiImportOptions {
  resolution?: number;
  /**
   * Force a specific semitone offset instead of auto-detecting it. Use when the
   * histogram shows an unusual layout the heuristic gets wrong.
   */
  octaveOffset?: number;
  /** Force a specific track by index, overriding name-based selection. */
  trackIndex?: number;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export function midiToChart(
  data: Uint8Array | ArrayBuffer,
  id: string,
  options: MidiImportOptions = {},
): MidiImportResult {
  const midi = new Midi(data instanceof Uint8Array ? data : new Uint8Array(data));
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const warnings: string[] = [];

  const project = createEmptyProject(id);
  project.resolution = resolution;
  project.tracks = emptyTracks();
  if (midi.name) project.meta.name = midi.name;

  /**
   * TICK RESCALING.
   *
   * A MIDI file's ticks are in its own PPQ (pulses per quarter note), which is
   * commonly 480 but can be anything. Our chart uses `resolution` (192). Both count
   * ticks per quarter note, so the conversion is a straight ratio — but it must be
   * applied to EVERY tick and duration in the file, and rounding each independently
   * is what keeps notes on the grid rather than drifting by a tick over a long song.
   */
  const ppq = midi.header.ppq > 0 ? midi.header.ppq : 480;
  const scale = resolution / ppq;
  const toChartTick = (midiTick: number) => Math.max(0, Math.round(midiTick * scale));

  // ---- tempo map ---------------------------------------------------------------
  const bpms = midi.header.tempos
    .filter((t) => Number.isFinite(t.bpm) && t.bpm > 0)
    .map((t) => ({ tick: toChartTick(t.ticks), bpm: t.bpm }))
    .sort((a, b) => a.tick - b.tick);
  if (bpms.length === 0 || bpms[0].tick !== 0) {
    bpms.unshift({ tick: 0, bpm: bpms[0]?.bpm ?? 120 });
    warnings.push('MIDI had no tempo at tick 0; inserted one.');
  }
  project.sync.bpms = dedupeByTick(bpms);

  // ---- time signature map ------------------------------------------------------
  const timeSignatures = midi.header.timeSignatures
    .map((ts) => ({
      tick: toChartTick(ts.ticks),
      numerator: ts.timeSignature[0],
      denominator: ts.timeSignature[1],
    }))
    .filter((ts) => ts.numerator > 0 && ts.denominator > 0)
    .sort((a, b) => a.tick - b.tick);
  if (timeSignatures.length === 0 || timeSignatures[0].tick !== 0) {
    timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }
  project.sync.timeSignatures = dedupeByTick(timeSignatures);

  // ---- track summaries (always computed, always reported) ----------------------
  const trackSummaries: MidiTrackSummary[] = midi.tracks.map((track, index) => {
    const numbers = track.notes.map((n) => n.midi);
    return {
      index,
      name: track.name || `(unnamed track ${index})`,
      noteCount: track.notes.length,
      range: numbers.length > 0 ? [Math.min(...numbers), Math.max(...numbers)] : null,
    };
  });

  // ---- pick the guitar track ---------------------------------------------------
  let selectedIndex = -1;
  let selectionReason = '';

  if (options.trackIndex !== undefined && midi.tracks[options.trackIndex]) {
    selectedIndex = options.trackIndex;
    selectionReason = 'explicitly selected by the caller';
  } else {
    for (const wanted of GUITAR_TRACK_NAMES) {
      const found = midi.tracks.findIndex((t) => (t.name || '').trim().toLowerCase() === wanted);
      if (found >= 0 && midi.tracks[found].notes.length > 0) {
        selectedIndex = found;
        selectionReason = `matched standard track name "${midi.tracks[found].name}"`;
        break;
      }
    }
  }

  if (selectedIndex < 0) {
    // Fall back to whichever track has the most notes in the playable range. This is
    // what rescues files from editors that name tracks something unexpected.
    let best = -1;
    let bestCount = 0;
    midi.tracks.forEach((track, index) => {
      const count = track.notes.filter((n) => n.midi >= 58 && n.midi <= 108).length;
      if (count > bestCount) {
        bestCount = count;
        best = index;
      }
    });
    if (best >= 0) {
      selectedIndex = best;
      selectionReason = `no standard track name found; fell back to the track with the most notes in the playable range (${bestCount} notes)`;
      warnings.push(
        `No track named PART GUITAR was found. Charted from "${midi.tracks[best].name || `track ${best}`}" instead — check the note histogram below.`,
      );
    }
  }

  const noteHistogram: Record<number, number> = {};
  const notesPerDifficulty: Record<Difficulty, number> = { Easy: 0, Medium: 0, Hard: 0, Expert: 0 };
  let octaveOffset = 0;

  if (selectedIndex < 0) {
    warnings.push('MIDI file contains no note data at all; produced an empty chart.');
    return {
      project,
      report: {
        ppq,
        resolution,
        trackSummaries,
        selectedTrack: '(none)',
        selectionReason: 'no track contained any notes',
        noteHistogram,
        octaveOffset,
        notesPerDifficulty,
        tempoCount: project.sync.bpms.length,
        timeSignatureCount: project.sync.timeSignatures.length,
        warnings,
      },
    };
  }

  const track = midi.tracks[selectedIndex];
  for (const note of track.notes) {
    noteHistogram[note.midi] = (noteHistogram[note.midi] ?? 0) + 1;
  }

  // ---- octave offset detection -------------------------------------------------
  octaveOffset = options.octaveOffset ?? detectOctaveOffset(noteHistogram);
  if (octaveOffset !== 0) {
    warnings.push(
      `Note numbers sit ${octaveOffset > 0 ? '+' : ''}${octaveOffset} semitones from the standard layout; applied that offset. Verify the imported notes before charting on top of them.`,
    );
  }

  // ---- star power --------------------------------------------------------------
  const starPower: StarPowerPhrase[] = [];
  for (const note of track.notes) {
    if (note.midi === STAR_POWER_NOTE + octaveOffset) {
      starPower.push({
        tick: toChartTick(note.ticks),
        length: Math.max(1, toChartTick(note.durationTicks)),
      });
    }
  }
  starPower.sort((a, b) => a.tick - b.tick);

  /**
   * SUSTAIN CUTOFF.
   *
   * MIDI gives every note a duration, but in a chart most notes are single hits with
   * length 0. Moonscraper's convention is that anything shorter than a 1/12 step —
   * resolution / 3 ticks — is not a sustain. Without this every imported note becomes
   * a short sustain and the chart looks and plays wrong.
   */
  const sustainCutoff = resolution / 3;

  // Tap phrases are global. Collect their tick spans once, then mark any note that
  // falls inside one, for every difficulty.
  const tapPhrases: Array<[number, number]> = track.notes
    .filter((n) => n.midi === TAP_NOTE + octaveOffset)
    .map((n) => {
      const start = toChartTick(n.ticks);
      return [start, start + Math.max(1, toChartTick(n.durationTicks))] as [number, number];
    });
  const inTapPhrase = (tick: number) =>
    tapPhrases.some(([start, end]) => tick >= start && tick < end);

  // ---- notes per difficulty ----------------------------------------------------
  for (const difficulty of ['Easy', 'Medium', 'Hard', 'Expert'] as Difficulty[]) {
    const base = DIFFICULTY_BASE[difficulty] + octaveOffset;
    const notes: Note[] = [];
    // Flags are per-tick in the chart format, so collect them separately and apply
    // them after all the real notes for this difficulty are known.
    const forcedTicks = new Set<number>();

    for (const midiNote of track.notes) {
      const relative = midiNote.midi - base;
      const tick = toChartTick(midiNote.ticks);

      if (relative >= 0 && relative <= 4) {
        const rawLength = toChartTick(midiNote.durationTicks);
        notes.push({
          id: newNoteId(),
          tick,
          lane: relative as Lane,
          length: rawLength < sustainCutoff ? 0 : rawLength,
          forced: false,
          tap: false,
        });
      } else if (relative === 5) {
        forcedTicks.add(tick);
      } else if (relative === 7) {
        const rawLength = toChartTick(midiNote.durationTicks);
        notes.push({
          id: newNoteId(),
          tick,
          lane: 7,
          length: rawLength < sustainCutoff ? 0 : rawLength,
          forced: false,
          tap: false,
        });
      }
      // relative === 6 is "forced strum". Our model only stores a single `forced`
      // toggle (matching the .chart format's single N 5 flag), so an explicit strum
      // marker is the absence of that flag and needs no handling.
    }

    for (const note of notes) {
      if (forcedTicks.has(note.tick)) note.forced = true;
      if (inTapPhrase(note.tick)) note.tap = true;
    }

    // Deduplicate identical tick+lane pairs, which overlapping MIDI notes produce.
    const seen = new Set<string>();
    const deduped = notes.filter((n) => {
      const key = `${n.tick}:${n.lane}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.sort((a, b) => a.tick - b.tick || a.lane - b.lane);
    notesPerDifficulty[difficulty] = deduped.length;
    project.tracks[trackNameFor(difficulty)] = {
      notes: deduped,
      // Star power phrases are shared, so every charted difficulty gets a copy.
      starPower: deduped.length > 0 ? starPower.map((p) => ({ ...p })) : [],
    };
  }

  const total = Object.values(notesPerDifficulty).reduce((a, b) => a + b, 0);
  if (total === 0) {
    warnings.push(
      'No notes matched the expected note numbers for any difficulty. Check the histogram — the file may use a different convention, in which case re-import with an explicit octave offset.',
    );
  }

  // ---- global events (section markers) -----------------------------------------
  const eventTrack = midi.tracks.find((t) => /^(events|part events)$/i.test((t.name || '').trim()));
  if (eventTrack) {
    // @tonejs/midi does not expose text meta-events per track, so section markers
    // cannot be recovered here. Recorded as a warning rather than failing silently.
    warnings.push('An EVENTS track was present; section markers are not imported.');
  }

  return {
    project,
    report: {
      ppq,
      resolution,
      trackSummaries,
      selectedTrack: track.name || `track ${selectedIndex}`,
      selectionReason,
      noteHistogram,
      octaveOffset,
      notesPerDifficulty,
      tempoCount: project.sync.bpms.length,
      timeSignatureCount: project.sync.timeSignatures.length,
      warnings,
    },
  };
}

/**
 * Detect a uniform semitone shift from the standard layout.
 *
 * Scores candidate offsets by how many notes land on a recognised value (a fret, a
 * flag, or the star power marker) and picks the best. Offset 0 wins ties so a
 * standard file is never "corrected".
 */
function detectOctaveOffset(histogram: Record<number, number>): number {
  const entries = Object.entries(histogram).map(([note, count]) => [Number(note), count] as const);
  if (entries.length === 0) return 0;

  const validForOffset = (offset: number): number => {
    let score = 0;
    for (const [note, count] of entries) {
      const shifted = note - offset;
      if (shifted === STAR_POWER_NOTE || shifted === TAP_NOTE) {
        score += count;
        continue;
      }
      for (const base of Object.values(DIFFICULTY_BASE)) {
        const relative = shifted - base;
        if (relative >= 0 && relative <= 7) {
          score += count;
          break;
        }
      }
    }
    return score;
  };

  let bestOffset = 0;
  let bestScore = validForOffset(0);
  // Only whole octaves are plausible — charting conventions shift by 12, not by 1.
  for (const offset of [-24, -12, 12, 24]) {
    const score = validForOffset(offset);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

function dedupeByTick<T extends { tick: number }>(items: T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    if (result.length > 0 && result[result.length - 1].tick === item.tick) {
      result[result.length - 1] = item; // last entry at a tick wins
    } else {
      result.push(item);
    }
  }
  return result;
}

/** Render the import report as readable log lines. Written to the server console. */
export function formatImportReport(report: MidiImportReport): string {
  const lines: string[] = [];
  lines.push(`MIDI import: ppq=${report.ppq} -> resolution=${report.resolution}`);
  lines.push('Tracks found:');
  for (const t of report.trackSummaries) {
    const range = t.range ? `notes ${t.range[0]}-${t.range[1]}` : 'no notes';
    lines.push(`  [${t.index}] "${t.name}" — ${t.noteCount} notes, ${range}`);
  }
  lines.push(`Charting from: "${report.selectedTrack}" (${report.selectionReason})`);
  lines.push(`Octave offset applied: ${report.octaveOffset}`);
  lines.push('Note histogram (number: count):');
  const sorted = Object.entries(report.noteHistogram).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [note, count] of sorted) {
    lines.push(`  ${note}: ${count}`);
  }
  lines.push(
    `Notes per difficulty: Expert=${report.notesPerDifficulty.Expert} Hard=${report.notesPerDifficulty.Hard} Medium=${report.notesPerDifficulty.Medium} Easy=${report.notesPerDifficulty.Easy}`,
  );
  lines.push(`Tempo markers: ${report.tempoCount}, time signatures: ${report.timeSignatureCount}`);
  for (const warning of report.warnings) lines.push(`WARNING: ${warning}`);
  return lines.join('\n');
}
