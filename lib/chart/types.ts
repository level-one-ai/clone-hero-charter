/**
 * Core chart data model.
 *
 * `Project` (persisted as project.json) is the SOURCE OF TRUTH for a song. The
 * .chart file is a generated artifact, regenerated from this on every save and
 * export. We do not edit .chart in place because it is a lossy round-trip: note
 * flags are encoded as separate lines at the same tick, and notes carry no stable
 * identity, which an interactive editor needs for selection and drag state.
 */

/** Ticks per quarter note. 192 is the Moonscraper/Clone Hero standard. */
export const DEFAULT_RESOLUTION = 192;

export const DIFFICULTIES = ['Expert', 'Hard', 'Medium', 'Easy'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * .chart track section names, of the form [Difficulty][Instrument].
 * We only chart the lead guitar ("Single") instrument; the type is written so
 * adding e.g. DoubleBass later is a matter of widening this union.
 */
export const TRACK_NAMES = ['ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle'] as const;
export type TrackName = (typeof TRACK_NAMES)[number];

export function trackNameFor(difficulty: Difficulty): TrackName {
  return `${difficulty}Single` as TrackName;
}

/**
 * Lane numbers as written in `N <lane> <length>`.
 * 0-4 are the coloured frets. 5 and 6 are FLAGS, not lanes — they appear as extra
 * lines at the same tick and are folded into Note.forced / Note.tap. 7 is the open
 * note, which we do model as a lane because it occupies a tick exclusively.
 */
export const LANE_GREEN = 0;
export const LANE_RED = 1;
export const LANE_YELLOW = 2;
export const LANE_BLUE = 3;
export const LANE_ORANGE = 4;
export const FLAG_FORCED = 5;
export const FLAG_TAP = 6;
export const LANE_OPEN = 7;

/** Lanes that can hold a note (excludes the two flag values). */
export type Lane = 0 | 1 | 2 | 3 | 4 | 7;
export const FRET_LANES: Lane[] = [0, 1, 2, 3, 4];

export const LANE_COLORS: Record<number, string> = {
  0: '#46C646',
  1: '#C6413B',
  2: '#C6C13B',
  3: '#3B6EC6',
  4: '#E88A2E',
  7: '#9b59d0', // open notes are drawn as a full-width bar; purple is Moonscraper's convention
};

export const LANE_LABELS: Record<number, string> = {
  0: 'Green',
  1: 'Red',
  2: 'Yellow',
  3: 'Blue',
  4: 'Orange',
  7: 'Open',
};

export interface Note {
  /**
   * Client-side identity only. Exists so the canvas editor can track selection and
   * drag targets across re-renders and array re-sorts. Dropped on .chart export.
   */
  id: string;
  /** Absolute tick position from the start of the song. */
  tick: number;
  lane: Lane;
  /** Sustain length in ticks. 0 = a normal single note. */
  length: number;
  /** Inverts the natural HOPO/strum decision (written as `N 5 0` at the same tick). */
  forced: boolean;
  /** Tap note (written as `N 6 0` at the same tick). */
  tap: boolean;
}

/** A star power phrase, written as `S 2 <length>`. */
export interface StarPowerPhrase {
  tick: number;
  length: number;
}

export interface Track {
  /** Kept sorted by tick, then lane. */
  notes: Note[];
  starPower: StarPowerPhrase[];
}

export interface BpmMarker {
  tick: number;
  /** Real BPM (e.g. 128.5). Serialized as round(bpm * 1000). */
  bpm: number;
}

export interface TimeSignature {
  tick: number;
  numerator: number;
  /** Power of two. Serialized as log2(denominator), omitted when it is 4. */
  denominator: number;
}

export interface ChartEvent {
  tick: number;
  /** Raw event text, e.g. `section Intro`. */
  text: string;
}

export interface SongMeta {
  name: string;
  artist: string;
  album: string;
  year: number | null;
  genre: string;
  charter: string;
  mediaType: string;
  /**
   * Chart offset in SECONDS (the .chart convention). Positive values delay the
   * chart relative to the audio. Applied only when converting tick space to audio
   * playback time — never inside the tick/beat math itself.
   */
  offset: number;
  /**
   * Silence before the music, measured in BARS AND BEATS rather than milliseconds.
   *
   * Charting against a song that starts immediately is awkward: there is no room to get
   * your bearings, and the first notes are hard to line up. So every chart gets a lead-in,
   * and it is expressed in musical units for one reason — a lead-in of "2 bars" ends
   * exactly on a downbeat at any tempo, where "1.8 seconds" lands wherever it lands and
   * puts the first beat of the song off the grid forever after.
   *
   * THE MUSIC MOVES, THE NOTES STAY PUT. Tick 0 is the start of the silence, so the
   * highway gains empty bars before the first beat. `offset` is deliberately NOT
   * adjusted: the export prepends real silence with ffmpeg, so the padded file's timeline
   * already IS chart time, and adding the lead-in to offset as well would cancel the pad
   * out.
   *
   * Non-destructive: the uploaded audio on disk is never modified. The editor previews
   * it by running a silent pre-roll before handing over to the audio element, so what
   * you hear against the highway is what the game plays.
   */
  leadIn: LeadIn;
  /**
   * Silence appended after the audio region, in milliseconds.
   *
   * Exists for charting a section out of a longer recording: a live set or an album rip
   * runs straight into the next track, so a region that ends on the last chord ends
   * abruptly. Padding the tail gives the chart somewhere to finish.
   */
  trailingSilenceMs: number;
}

/**
 * Lead-in length in musical units, counted from tick 0.
 *
 * `bars` is the whole-bar count and `beats` the remainder, both measured against the time
 * signature in force at tick 0. Total, not "extra": a lead-in of 2 bars 0 beats IS the
 * enforced minimum, and 3 bars 2 beats is that minimum plus a bar and two beats.
 */
export interface LeadIn {
  bars: number;
  beats: number;
}

/**
 * Every chart gets at least this many bars of silence before the music.
 *
 * Two bars is a full count-in: enough to read the approach of the first note and get a
 * hand to the frets, which songs that open on beat one otherwise never give you.
 */
export const MIN_LEAD_IN_BARS = 2;

/**
 * Trailing silence added by default, in milliseconds.
 *
 * Two seconds is enough that a chart cut out of a continuous recording does not end on
 * the first note of whatever came next.
 */
export const DEFAULT_TRAILING_SILENCE_MS = 2000;

/**
 * The slice of the uploaded audio that this chart covers.
 *
 * Null means the whole file. A region is how you chart one song out of a long upload — a
 * full album side, a live set, a practice recording — without cutting the source up
 * first. It is purely a view onto the file: the upload on disk is never modified, and
 * changing the region re-aims the chart rather than destroying anything.
 *
 * `startMs` doubles as the SYNC ANCHOR. Chart time runs: lead-in silence, then the region
 * from `startMs`, then the trailing silence. So placing `startMs` on the first downbeat of
 * the music is what makes bar 1 of the chart land on bar 1 of the recording.
 */
export interface AudioRegion {
  /** Offset into the source file where the charted audio begins, in ms. */
  startMs: number;
  /** Offset into the source file where it ends, in ms. Exclusive. */
  endMs: number;
}

export interface AudioInfo {
  /** Filename within the song folder, e.g. "audio.wav". */
  file: string;
  /** Length of the SOURCE file, not of the charted region. */
  durationMs: number;
  sampleRate: number | null;
  /** Charted slice of the source file, or null for all of it. */
  region?: AudioRegion | null;
  /**
   * Tempo detection result for this file, kept so the UI can show what it found and
   * whether the anchor BPM came from analysis or from a person. Null until analysed.
   */
  detected?: DetectedTempo | null;
}

/** What beat detection made of the audio. Advisory: the charter always gets the last word. */
export interface DetectedTempo {
  bpm: number;
  /** Seconds into the SOURCE file where the first detected beat falls. */
  firstBeatSec: number;
  /** 0-1. Below ~0.5 the UI says so rather than quietly trusting it. */
  confidence: number;
  /** True once the charter has moved the anchor or the region themselves. */
  overridden?: boolean;
}

export interface Project {
  version: 1;
  id: string;
  /**
   * Bumped by the server on every write, and never by the client.
   *
   * This is what stops two people — or two tabs — silently overwriting each other. A
   * save carries the revision it was based on; if the stored one has moved past it, the
   * server refuses rather than accepting a write built on a stale copy. Optional so
   * projects saved before it existed still load.
   */
  revision?: number;
  meta: SongMeta;
  resolution: number;
  audio: AudioInfo;
  /** Album art filename within the song folder, or null if none uploaded. */
  album: string | null;
  sync: {
    /** Sorted by tick. A tick-0 entry is always present. */
    bpms: BpmMarker[];
    /** Sorted by tick. A tick-0 entry is always present. */
    timeSignatures: TimeSignature[];
  };
  events: ChartEvent[];
  tracks: Record<TrackName, Track>;
}

/** Row shape in /data/songs.json. */
export interface SongIndexEntry {
  id: string;
  title: string;
  artist: string;
  album: string;
  year: number | null;
  charter: string;
  createdAt: string;
  updatedAt: string;
  audioFile: string;
  albumFile: string | null;
  durationMs: number;
}

export interface SongIndex {
  version: 1;
  songs: SongIndexEntry[];
}

export function emptyTracks(): Record<TrackName, Track> {
  return {
    ExpertSingle: { notes: [], starPower: [] },
    HardSingle: { notes: [], starPower: [] },
    MediumSingle: { notes: [], starPower: [] },
    EasySingle: { notes: [], starPower: [] },
  };
}

let noteIdCounter = 0;
/** Short, collision-free-within-a-session note id. Not persisted meaningfully. */
export function newNoteId(): string {
  noteIdCounter += 1;
  return `n${noteIdCounter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createEmptyProject(id: string, meta: Partial<SongMeta> = {}): Project {
  return {
    version: 1,
    id,
    revision: 0,
    meta: {
      name: '',
      artist: '',
      album: '',
      year: null,
      genre: '',
      charter: '',
      mediaType: 'cd',
      offset: 0,
      leadIn: { bars: MIN_LEAD_IN_BARS, beats: 0 },
      trailingSilenceMs: DEFAULT_TRAILING_SILENCE_MS,
      ...meta,
    },
    resolution: DEFAULT_RESOLUTION,
    audio: { file: '', durationMs: 0, sampleRate: null, region: null, detected: null },
    album: null,
    sync: {
      bpms: [{ tick: 0, bpm: 120 }],
      timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    },
    events: [],
    tracks: emptyTracks(),
  };
}
