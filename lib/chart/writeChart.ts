import {
  FLAG_FORCED,
  FLAG_TAP,
  TRACK_NAMES,
  type Note,
  type Project,
} from './types';

/**
 * .chart serializer.
 *
 * Output matches Moonscraper's conventions closely enough that Moonscraper reopens
 * our files without complaint: CRLF line endings, tab-indented block bodies, quoted
 * metadata strings, and `Year = ", 2024"` with its odd leading comma-space (that is
 * genuinely what the format does — Clone Hero strips the punctuation on read).
 */

const EOL = '\r\n';

function quote(value: string): string {
  // The format has no escape mechanism, so an embedded quote would break the parser.
  // Stripping is the only safe option.
  return `"${value.replace(/"/g, '')}"`;
}

function section(name: string, body: string[]): string {
  const lines = [`[${name}]`, '{'];
  for (const entry of body) lines.push(`\t${entry}`);
  lines.push('}');
  return lines.join(EOL);
}

export interface WriteChartOptions {
  /**
   * Filename to put in `MusicStream`. Clone Hero finds `song.*` regardless of what this
   * says — real charts in the wild have stale values here — but naming the file we
   * actually ship costs nothing and is one less thing to look wrong.
   */
  musicStream?: string;
}

export function writeChart(project: Project, options: WriteChartOptions = {}): string {
  const blocks: string[] = [];

  // ---- [Song] ------------------------------------------------------------------
  const songBody: string[] = [
    `Name = ${quote(project.meta.name)}`,
    `Artist = ${quote(project.meta.artist)}`,
    `Album = ${quote(project.meta.album)}`,
    `Year = ${quote(project.meta.year ? `, ${project.meta.year}` : '')}`,
    `Charter = ${quote(project.meta.charter)}`,
    `Offset = ${formatNumber(project.meta.offset)}`,
    `Resolution = ${project.resolution}`,
    `Player2 = bass`,
    `Difficulty = 0`,
    `PreviewStart = 0`,
    `PreviewEnd = 0`,
    `Genre = ${quote(project.meta.genre)}`,
    `MediaType = ${quote(project.meta.mediaType || 'cd')}`,
    `MusicStream = ${quote(options.musicStream ?? 'song.ogg')}`,
  ];
  blocks.push(section('Song', songBody));

  // ---- [SyncTrack] -------------------------------------------------------------
  // BPM and TS entries are interleaved in tick order. BPM is written as an integer
  // of BPM * 1000; TS writes the denominator as log2(denominator), omitted when /4.
  interface SyncEntry {
    tick: number;
    // TS is emitted before B at the same tick, matching Moonscraper's ordering.
    order: number;
    text: string;
  }
  const syncEntries: SyncEntry[] = [];
  for (const ts of project.sync.timeSignatures) {
    const exponent = Math.round(Math.log2(ts.denominator > 0 ? ts.denominator : 4));
    const suffix = exponent === 2 ? '' : ` ${exponent}`;
    syncEntries.push({ tick: ts.tick, order: 0, text: `${ts.tick} = TS ${ts.numerator}${suffix}` });
  }
  for (const bpm of project.sync.bpms) {
    syncEntries.push({
      tick: bpm.tick,
      order: 1,
      text: `${bpm.tick} = B ${Math.round(bpm.bpm * 1000)}`,
    });
  }
  syncEntries.sort((a, b) => a.tick - b.tick || a.order - b.order);
  blocks.push(section('SyncTrack', syncEntries.map((e) => e.text)));

  // ---- [Events] ----------------------------------------------------------------
  const eventBody = [...project.events]
    .sort((a, b) => a.tick - b.tick)
    .map((e) => `${e.tick} = E ${quote(e.text)}`);
  blocks.push(section('Events', eventBody));

  // ---- [<Difficulty>Single] ----------------------------------------------------
  for (const trackName of TRACK_NAMES) {
    const track = project.tracks[trackName];
    // Clone Hero treats an empty difficulty section as "not charted"; omitting it
    // entirely is cleaner than writing an empty block that shows up as a playable
    // but noteless difficulty in the song select screen.
    if (!track || (track.notes.length === 0 && track.starPower.length === 0)) continue;
    blocks.push(section(trackName, serializeTrackEntries(track.notes, track.starPower)));
  }

  return `${blocks.join(EOL)}${EOL}`;
}

/**
 * Expand notes back into .chart lines.
 *
 * The flag expansion is the inverse of the parser's fold: `forced` and `tap` are
 * per-TICK in the file, not per-note, so a chord with forced=true emits exactly one
 * `N 5 0` line for the whole tick, not one per note. Emitting duplicates would be
 * read back as-is by some parsers and is worth avoiding.
 */
function serializeTrackEntries(
  notes: Note[],
  starPower: { tick: number; length: number }[],
): string[] {
  interface Entry {
    tick: number;
    order: number;
    text: string;
  }
  const entries: Entry[] = [];

  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.lane - b.lane);
  const flagsEmitted = new Map<number, { forced: boolean; tap: boolean }>();

  for (const note of sorted) {
    entries.push({ tick: note.tick, order: note.lane, text: `${note.tick} = N ${note.lane} ${note.length}` });

    const seen = flagsEmitted.get(note.tick) ?? { forced: false, tap: false };
    if (note.forced && !seen.forced) {
      entries.push({ tick: note.tick, order: FLAG_FORCED, text: `${note.tick} = N ${FLAG_FORCED} 0` });
      seen.forced = true;
    }
    if (note.tap && !seen.tap) {
      entries.push({ tick: note.tick, order: FLAG_TAP, text: `${note.tick} = N ${FLAG_TAP} 0` });
      seen.tap = true;
    }
    flagsEmitted.set(note.tick, seen);
  }

  for (const phrase of starPower) {
    // Star power sorts after notes at the same tick (order 8 is past every lane/flag).
    entries.push({ tick: phrase.tick, order: 8, text: `${phrase.tick} = S 2 ${phrase.length}` });
  }

  entries.sort((a, b) => a.tick - b.tick || a.order - b.order);
  return entries.map((e) => e.text);
}

/** Offset is a float in the format; write it without a trailing ".0" when integral. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}
