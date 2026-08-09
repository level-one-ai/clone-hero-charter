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
   * Silence to prepend to the audio, in milliseconds.
   *
   * Charting against a song that starts immediately is awkward: there is no room to
   * get your bearings, and the first notes are hard to line up. Adding a lead-in
   * shifts the whole song later without touching a single note.
   *
   * Non-destructive. The uploaded audio is never modified — the editor simply delays
   * playback by this much so it previews the result, and the export prepends real
   * silence with ffmpeg. midi-ch has the same setting but leaves padding the audio to
   * you in a DAW; doing it here keeps chart and audio in step automatically.
   */
  leadingSilenceMs: number;
}

export interface AudioInfo {
  /** Filename within the song folder, e.g. "audio.wav". */
  file: string;
  durationMs: number;
  sampleRate: number | null;
}

export interface Project {
  version: 1;
  id: string;
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
    meta: {
      name: '',
      artist: '',
      album: '',
      year: null,
      genre: '',
      charter: '',
      mediaType: 'cd',
      offset: 0,
      leadingSilenceMs: 0,
      ...meta,
    },
    resolution: DEFAULT_RESOLUTION,
    audio: { file: '', durationMs: 0, sampleRate: null },
    album: null,
    sync: {
      bpms: [{ tick: 0, bpm: 120 }],
      timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    },
    events: [],
    tracks: emptyTracks(),
  };
}
