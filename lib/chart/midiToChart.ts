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
import {
  assignLanesByContour,
  assignLanesByPitch,
  groupByTick,
  type BandSplit,
} from './pitchToLanes';

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

/**
 * Track names that contain "guitar" but are NOT the standard 5-fret lead part.
 * Matched before the fuzzy name pass so a file containing both PART REAL_GUITAR and
 * an oddly-named lead track does not pick the Pro Guitar part.
 */
const NON_LEAD_HINTS = ['ghl', 'real', 'bass', 'coop', '22', 'pro'];

/** Whole-octave shifts worth testing. Charting conventions shift by 12, never by 1. */
const CANDIDATE_OFFSETS = [0, -12, 12, -24, 24];

/** Is this note number meaningful in a Guitar Hero chart track? */
function isChartNote(note: number): boolean {
  if (note === STAR_POWER_NOTE || note === TAP_NOTE) return true;
  // Other markers that legitimately appear in chart tracks. Counted as valid so a
  // genuine chart is not penalised for carrying them.
  if (note >= 120 && note <= 127) return true; // BRE / fill / tremolo / trill markers
  for (const base of Object.values(DIFFICULTY_BASE)) {
    const relative = note - base;
    // base+0..4 frets, +5/+6 force flags, +7 open note.
    if (relative >= 0 && relative <= 7) return true;
  }
  return false;
}

/**
 * How much does this track look like a chart rather than music?
 *
 * Returns the fraction of notes landing on meaningful chart note numbers, at the
 * best-fitting octave offset.
 *
 * This is the load-bearing heuristic. Matching on track NAMES alone is brittle —
 * plenty of real charts have tracks named something other than PART GUITAR, or not
 * named at all — whereas the note numbers cannot lie: a genuine chart track puts
 * almost every note inside the four difficulty blocks, while an ordinary music track
 * scatters across the chromatic scale and scores near zero. So we let the data decide
 * when the name is unhelpful.
 */
function bestChartFit(notes: { midi: number }[]): { score: number; offset: number } {
  if (notes.length === 0) return { score: 0, offset: 0 };
  let best = { score: 0, offset: 0 };
  for (const offset of CANDIDATE_OFFSETS) {
    let valid = 0;
    for (const note of notes) {
      if (isChartNote(note.midi - offset)) valid += 1;
    }
    const score = valid / notes.length;
    if (score > best.score) best = { score, offset };
  }
  return best;
}

/**
 * How many of the four difficulty blocks does this track actually use?
 *
 * Used to break ties between tracks that score equally on chart fit — which happens
 * routinely, because PART DRUMS uses the SAME note numbers as PART GUITAR (96-100 for
 * Expert, and so on). Note numbers alone genuinely cannot tell those two apart.
 *
 * What does separate them in practice is coverage: a finished guitar part is charted
 * across several difficulties, whereas a partial or stray track tends to occupy a
 * single block. Preferring wider coverage beats preferring raw note count, which just
 * picks whichever part happens to be busiest — often the drums.
 *
 * This is a tie-break, not a guarantee. When a file holds both a full guitar and a full
 * drum chart and neither is named, no heuristic can choose correctly — which is exactly
 * why the re-import track picker exists.
 */
function difficultyCoverage(notes: { midi: number }[], offset: number): number {
  const blocks = new Set<string>();
  for (const note of notes) {
    const shifted = note.midi - offset;
    for (const [difficulty, base] of Object.entries(DIFFICULTY_BASE)) {
      const relative = shifted - base;
      if (relative >= 0 && relative <= 7) {
        blocks.add(difficulty);
        break;
      }
    }
  }
  return blocks.size;
}

/**
 * Below this, a track is not plausibly a chart part.
 *
 * Set high deliberately. The difficulty blocks span 8 of every 12 semitones, so an
 * ordinary chromatic music track scores around 0.6 purely by chance — a "majority of
 * notes are valid" test would wave almost anything through. A genuine chart track
 * scores 1.0, because every note in it is meaningful by construction, so the gap
 * between the two is wide and the threshold belongs near the top of it.
 */
const CHART_FIT_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface MidiTrackSummary {
  index: number;
  name: string;
  noteCount: number;
  /** Lowest and highest note numbers present, or null for an empty track. */
  range: [number, number] | null;
  /**
   * 0-1: fraction of notes landing on valid chart note numbers. Near 1 means a real
   * chart part; near 0 means ordinary music. Shown in the UI so the right track is
   * obvious when picking one by hand.
   */
  chartFit: number;
  /** Octave offset at which chartFit was achieved. */
  offset: number;
  /** How many of the four difficulty blocks carry notes (0-4). */
  difficultyCoverage: number;
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
  /** True when frets were derived from a melody rather than read as chart data. */
  musicalMode: boolean;
  warnings: string[];
}

export interface MidiImportResult {
  project: Project;
  report: MidiImportReport;
}

/**
 * How to interpret the MIDI.
 *
 *  chart   — note numbers are fret assignments (a real Guitar Hero chart)
 *  musical — note numbers are pitches (a transcription); frets are derived from the
 *            melody's contour
 *  auto    — use chart mode when a track looks like a chart, otherwise musical
 */
export type MidiImportMode = 'auto' | 'chart' | 'musical';

/** How a transcription's pitches become frets. See lib/chart/pitchToLanes. */
export interface MelodyMappingOptions {
  /** 'pitch' (default): low pitch to green, high to orange. 'contour': follow the tune. */
  strategy?: 'pitch' | 'contour';
  /** Where the band boundaries fall. Only used by the pitch strategy. */
  split?: BandSplit;
  /** Reserve the lowest pitch band for open notes. */
  useOpenNotes?: boolean;
  /** Flip so the highest pitches take green instead of orange. */
  invert?: boolean;
  /** Cap on simultaneous notes. */
  maxChordSize?: number;
}

export interface MidiImportOptions {
  mode?: MidiImportMode;
  melody?: MelodyMappingOptions;
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
  // MIDI stores tempo as microseconds per quarter note, so an authored 140 BPM comes
  // back as 140.00014. The .chart format only carries three decimals, so rounding
  // here loses nothing real and keeps the editor from showing phantom precision.
  const bpms = midi.header.tempos
    .filter((t) => Number.isFinite(t.bpm) && t.bpm > 0)
    .map((t) => ({ tick: toChartTick(t.ticks), bpm: Math.round(t.bpm * 1000) / 1000 }))
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
    const fit = bestChartFit(track.notes);
    return {
      index,
      name: track.name || `(unnamed track ${index})`,
      noteCount: track.notes.length,
      range: numbers.length > 0 ? [Math.min(...numbers), Math.max(...numbers)] : null,
      chartFit: fit.score,
      offset: fit.offset,
      difficultyCoverage: difficultyCoverage(track.notes, fit.offset),
    };
  });

  // ---- pick the guitar track ---------------------------------------------------
  let selectedIndex = -1;
  let selectionReason = '';
  const mode: MidiImportMode = options.mode ?? 'auto';
  let musicalMode = mode === 'musical';

  if (options.trackIndex !== undefined && midi.tracks[options.trackIndex]) {
    selectedIndex = options.trackIndex;
    selectionReason = 'explicitly selected by the caller';
    // An explicit track in auto mode still has to be interpreted correctly: a chosen
    // track that does not use the fret layout is a transcription.
    if (mode === 'auto') {
      musicalMode = bestChartFit(midi.tracks[options.trackIndex].notes).score < CHART_FIT_THRESHOLD;
    }
  } else if (mode === 'musical') {
    // Track chosen below, by note count rather than chart fit.
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

  // Second pass: a name merely CONTAINING "guitar", once the parts that are not the
  // 5-fret lead (Pro Guitar, GHL, co-op, bass) have been ruled out. Catches real
  // charts named things like "Guitar Expert" or "PART GUITAR X".
  if (selectedIndex < 0) {
    const found = midi.tracks.findIndex((t) => {
      const name = (t.name || '').trim().toLowerCase();
      if (!name.includes('guitar') || t.notes.length === 0) return false;
      return !NON_LEAD_HINTS.some((hint) => name.includes(hint));
    });
    if (found >= 0) {
      selectedIndex = found;
      selectionReason = `track name contains "guitar" ("${midi.tracks[found].name}")`;
    }
  }

  /**
   * Third pass: ignore names entirely and pick the track whose NOTES look most like a
   * chart. This is what handles unnamed tracks, which is the common case in charts
   * exported by tools that drop track names — previously these fell through to a crude
   * "most notes in range" guess that would happily pick a bass or drum part.
   */
  if (selectedIndex < 0) {
    const ranked = trackSummaries
      .filter((t) => t.noteCount > 0 && t.chartFit >= CHART_FIT_THRESHOLD)
      // Best fit first, then widest difficulty coverage, then note count. Coverage
      // matters more than density: a full guitar part spans several difficulties,
      // while the busiest track in a file is often the drums.
      .sort(
        (a, b) =>
          b.chartFit - a.chartFit ||
          b.difficultyCoverage - a.difficultyCoverage ||
          b.noteCount - a.noteCount,
      );

    if (ranked.length > 0) {
      selectedIndex = ranked[0].index;
      selectionReason = `no standard track name found; picked the track whose notes best match the chart layout (${Math.round(ranked[0].chartFit * 100)}% of notes are valid chart notes)`;
      warnings.push(
        `No track named PART GUITAR was found, so "${ranked[0].name}" was chosen because its notes match the Guitar Hero layout. Check the note counts below — if it picked the wrong part, use "Re-import from MIDI" in the editor's Song panel to choose a different track.`,
      );
    }
  }

  /**
   * Nothing scored as a chart — so this is a transcription of the song, where the note
   * numbers are pitches rather than fret assignments. Switch to musical mode and derive
   * the frets from the melody's contour.
   *
   * Previously this fell back to "the densest track between notes 58 and 108", which
   * reported "contains no note data at all" for any transcription written outside that
   * window — a guitar part written at sounding pitch sits well below it — even when the
   * file held hundreds of notes.
   */
  if (selectedIndex < 0 || mode === 'musical') {
    let best = -1;
    let bestCount = 0;
    midi.tracks.forEach((track, index) => {
      if (track.notes.length > bestCount) {
        bestCount = track.notes.length;
        best = index;
      }
    });
    if (best >= 0) {
      selectedIndex = best;
      musicalMode = true;
      selectionReason =
        mode === 'musical'
          ? `musical mode: frets derived from the melody in "${midi.tracks[best].name || `track ${best}`}"`
          : `no track uses the chart note layout, so this was read as a transcription; frets derived from the melody in "${midi.tracks[best].name || `track ${best}`}"`;
      if (mode !== 'musical') {
        warnings.push(
          'This is a transcription of the song, not a Guitar Hero chart — its note numbers are pitches, not fret colours. The timing and tempo have been imported exactly, and the frets were derived from those pitches (low pitches on green, high on orange). Adjust the lanes for playability, or change the mapping under Song → Re-import from MIDI.',
        );
      }
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
        musicalMode: false,
        warnings,
      },
    };
  }

  const track = midi.tracks[selectedIndex];
  for (const note of track.notes) {
    noteHistogram[note.midi] = (noteHistogram[note.midi] ?? 0) + 1;
  }

  // ---- musical mode: derive frets from the melody ------------------------------
  if (musicalMode) {
    // A quarter note, not the 1/12 step used when reading a real chart — see the note
    // on sustainCutoff in pitchToLanes.
    const sustainCutoff = resolution;
    const melody = options.melody ?? {};
    const groups = groupByTick(
      track.notes.map((n) => ({
        tick: toChartTick(n.ticks),
        pitch: n.midi,
        durationTicks: toChartTick(n.durationTicks),
      })),
    );

    const assignments =
      melody.strategy === 'contour'
        ? assignLanesByContour(groups, {
            sustainCutoff,
            maxChordSize: melody.maxChordSize ?? 2,
          })
        : assignLanesByPitch(groups, {
            sustainCutoff,
            split: melody.split ?? 'balanced',
            useOpenNotes: melody.useOpenNotes ?? true,
            invert: melody.invert ?? false,
            maxChordSize: melody.maxChordSize ?? 3,
          });

    const notes: Note[] = [];
    for (const assignment of assignments) {
      for (const lane of assignment.lanes) {
        notes.push({
          id: newNoteId(),
          tick: assignment.tick,
          lane,
          length: assignment.length,
          forced: false,
          tap: false,
        });
      }
    }
    notes.sort((a, b) => a.tick - b.tick || a.lane - b.lane);

    // Expert only. Auto-thinned lower difficulties come out unmusical and need
    // redoing anyway, so leaving them empty is more honest than filling them badly.
    project.tracks.ExpertSingle = { notes, starPower: [] };
    notesPerDifficulty.Expert = notes.length;

    return {
      project,
      report: {
        ppq,
        resolution,
        trackSummaries,
        selectedTrack: track.name || `track ${selectedIndex}`,
        selectionReason,
        noteHistogram,
        octaveOffset: 0,
        notesPerDifficulty,
        tempoCount: project.sync.bpms.length,
        timeSignatureCount: project.sync.timeSignatures.length,
        musicalMode: true,
        warnings,
      },
    };
  }

  // ---- octave offset detection -------------------------------------------------
  // Same scoring used to pick the track, now applied to choose its offset, so the two
  // decisions can never disagree.
  const selectedFit = bestChartFit(track.notes);
  octaveOffset = options.octaveOffset ?? selectedFit.offset;

  if (selectedFit.score < CHART_FIT_THRESHOLD) {
    warnings.push(
      `Only ${Math.round(selectedFit.score * 100)}% of the notes in "${track.name || `track ${selectedIndex}`}" are valid chart notes, so this is probably not a guitar chart track. Use "Re-import from MIDI" in the editor's Song panel to try another track.`,
    );
  }
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
      musicalMode: false,
      warnings,
    },
  };
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
