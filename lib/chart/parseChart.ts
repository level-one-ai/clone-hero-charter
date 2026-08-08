import {
  DEFAULT_RESOLUTION,
  FLAG_FORCED,
  FLAG_TAP,
  LANE_OPEN,
  TRACK_NAMES,
  createEmptyProject,
  emptyTracks,
  newNoteId,
  type Lane,
  type Note,
  type Project,
  type TrackName,
} from './types';

/**
 * .chart parser (Moonscraper / Clone Hero text format).
 *
 * Structure is a sequence of `[SectionName]` headers each followed by a `{ ... }`
 * block of `<tick> = <TYPE> <args...>` lines. We are deliberately lenient: real
 * charts in the wild have inconsistent whitespace, stray blank lines, CRLF or LF,
 * unknown sections from other editors, and unquoted metadata values. Anything we do
 * not understand is skipped rather than fatal — refusing to open a slightly odd
 * chart would be worse than ignoring one line of it.
 */

export interface ParseChartResult {
  project: Project;
  warnings: string[];
}

const SECTION_RE = /^\[(.+?)\]\s*$/;
const ENTRY_RE = /^\s*(-?\d+)\s*=\s*(\S+)\s*(.*)$/;

/** Strip surrounding double quotes from a .chart metadata value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface RawSection {
  name: string;
  lines: string[];
}

function splitSections(text: string): RawSection[] {
  const sections: RawSection[] = [];
  const lines = text.split(/\r?\n/);
  let current: RawSection | null = null;
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const header = SECTION_RE.exec(line);
    if (header && !inBlock) {
      current = { name: header[1].trim(), lines: [] };
      continue;
    }
    if (line === '{') {
      inBlock = true;
      continue;
    }
    if (line === '}') {
      inBlock = false;
      if (current) sections.push(current);
      current = null;
      continue;
    }
    if (inBlock && current) current.lines.push(line);
  }

  // Tolerate a final unterminated block (truncated file).
  if (current && current.lines.length > 0) sections.push(current);
  return sections;
}

export function parseChart(text: string, id: string): ParseChartResult {
  const warnings: string[] = [];
  const project = createEmptyProject(id);
  project.tracks = emptyTracks();

  const sections = splitSections(text);
  const bpms: Project['sync']['bpms'] = [];
  const timeSignatures: Project['sync']['timeSignatures'] = [];

  for (const section of sections) {
    const name = section.name;

    if (name === 'Song') {
      for (const line of section.lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = unquote(line.slice(eq + 1));
        switch (key.toLowerCase()) {
          case 'name':
            project.meta.name = value;
            break;
          case 'artist':
            project.meta.artist = value;
            break;
          case 'album':
            project.meta.album = value;
            break;
          case 'year': {
            // .chart conventionally writes Year = ", 2024" — strip the leading comma.
            const digits = value.replace(/[^0-9]/g, '');
            project.meta.year = digits.length >= 4 ? Number.parseInt(digits.slice(0, 4), 10) : null;
            break;
          }
          case 'genre':
            project.meta.genre = value;
            break;
          case 'charter':
            project.meta.charter = value;
            break;
          case 'mediatype':
            project.meta.mediaType = value;
            break;
          case 'offset': {
            const num = Number.parseFloat(value);
            project.meta.offset = Number.isFinite(num) ? num : 0;
            break;
          }
          case 'resolution': {
            const num = Number.parseInt(value, 10);
            project.resolution = Number.isFinite(num) && num > 0 ? num : DEFAULT_RESOLUTION;
            break;
          }
          default:
            break;
        }
      }
      continue;
    }

    if (name === 'SyncTrack') {
      for (const line of section.lines) {
        const m = ENTRY_RE.exec(line);
        if (!m) continue;
        const tick = Math.max(0, Number.parseInt(m[1], 10));
        const type = m[2].toUpperCase();
        const args = m[3].trim().split(/\s+/).filter(Boolean);

        if (type === 'B') {
          // BPM is stored multiplied by 1000: 120000 -> 120.000 BPM.
          const raw = Number.parseInt(args[0], 10);
          if (Number.isFinite(raw) && raw > 0) bpms.push({ tick, bpm: raw / 1000 });
        } else if (type === 'TS') {
          const numerator = Number.parseInt(args[0], 10);
          // Second arg is the denominator EXPONENT: denominator = 2^exp, default 2 (/4).
          const exponent = args.length > 1 ? Number.parseInt(args[1], 10) : 2;
          if (Number.isFinite(numerator) && numerator > 0) {
            timeSignatures.push({
              tick,
              numerator,
              denominator: Number.isFinite(exponent) ? 2 ** exponent : 4,
            });
          }
        }
        // `A` (anchor) entries are Moonscraper-internal and intentionally dropped.
      }
      continue;
    }

    if (name === 'Events') {
      for (const line of section.lines) {
        const m = ENTRY_RE.exec(line);
        if (!m) continue;
        if (m[2].toUpperCase() !== 'E') continue;
        project.events.push({
          tick: Math.max(0, Number.parseInt(m[1], 10)),
          text: unquote(m[3]),
        });
      }
      continue;
    }

    if ((TRACK_NAMES as readonly string[]).includes(name)) {
      parseTrackSection(section, project, name as TrackName, warnings);
      continue;
    }

    // Sections for instruments we do not chart (drums, bass, keys) are dropped with
    // a warning rather than silently, so the user knows data was not carried over.
    if (/^(Expert|Hard|Medium|Easy)/.test(name)) {
      warnings.push(`Skipped unsupported instrument track [${name}] (only lead guitar is charted).`);
    }
  }

  if (bpms.length === 0) {
    warnings.push('Chart had no BPM markers; defaulted to 120 BPM at tick 0.');
    bpms.push({ tick: 0, bpm: 120 });
  }
  if (timeSignatures.length === 0) {
    timeSignatures.push({ tick: 0, numerator: 4, denominator: 4 });
  }
  if (!bpms.some((b) => b.tick === 0)) {
    bpms.unshift({ tick: 0, bpm: bpms[0].bpm });
    warnings.push('Chart had no tick-0 BPM marker; inserted one.');
  }
  if (!timeSignatures.some((t) => t.tick === 0)) {
    timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }

  project.sync.bpms = bpms.sort((a, b) => a.tick - b.tick);
  project.sync.timeSignatures = timeSignatures.sort((a, b) => a.tick - b.tick);
  project.events.sort((a, b) => a.tick - b.tick);

  return { project, warnings };
}

/**
 * Parse one [DifficultyInstrument] section.
 *
 * The awkward part: `N 5 0` (forced) and `N 6 0` (tap) are not notes, they are flags
 * that apply to whatever real notes share their tick. They can appear before or after
 * the notes they modify, so we collect notes into a per-tick bucket first, then apply
 * the flags in a second pass.
 */
function parseTrackSection(
  section: RawSection,
  project: Project,
  trackName: TrackName,
  warnings: string[],
): void {
  const byTick = new Map<number, Note[]>();
  const forcedTicks = new Set<number>();
  const tapTicks = new Set<number>();
  const starPower: Project['tracks'][TrackName]['starPower'] = [];

  for (const line of section.lines) {
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const tick = Math.max(0, Number.parseInt(m[1], 10));
    const type = m[2].toUpperCase();
    const args = m[3].trim().split(/\s+/).filter(Boolean);

    if (type === 'N') {
      const lane = Number.parseInt(args[0], 10);
      const length = Math.max(0, Number.parseInt(args[1], 10) || 0);
      if (!Number.isFinite(lane)) continue;

      if (lane === FLAG_FORCED) {
        forcedTicks.add(tick);
        continue;
      }
      if (lane === FLAG_TAP) {
        tapTicks.add(tick);
        continue;
      }
      if (lane >= 0 && lane <= 4) {
        pushNote(byTick, tick, lane as Lane, length);
        continue;
      }
      if (lane === LANE_OPEN) {
        pushNote(byTick, tick, LANE_OPEN, length);
        continue;
      }
      // Lanes 8+ are extended-instrument data (GHL black frets etc.).
      warnings.push(`Ignored note lane ${lane} at tick ${tick} in [${trackName}].`);
    } else if (type === 'S') {
      // `S 2 <length>` is star power. Other S types (solo markers, lane 0/1) exist in
      // some editors but are not part of the Clone Hero spec we target.
      const kind = Number.parseInt(args[0], 10);
      const length = Math.max(0, Number.parseInt(args[1], 10) || 0);
      if (kind === 2) starPower.push({ tick, length });
    } else if (type === 'E') {
      // Track-local events (solo/soloend). Preserved as global events would change
      // their meaning, so they are dropped intentionally.
    }
  }

  const notes: Note[] = [];
  for (const [tick, bucket] of byTick) {
    const forced = forcedTicks.has(tick);
    const tap = tapTicks.has(tick);
    for (const note of bucket) {
      note.forced = forced;
      note.tap = tap;
      notes.push(note);
    }
  }

  notes.sort((a, b) => a.tick - b.tick || a.lane - b.lane);
  starPower.sort((a, b) => a.tick - b.tick);
  project.tracks[trackName] = { notes, starPower };
}

function pushNote(
  byTick: Map<number, Note[]>,
  tick: number,
  lane: Lane,
  length: number,
): void {
  const bucket = byTick.get(tick);
  const note: Note = { id: newNoteId(), tick, lane, length, forced: false, tap: false };
  if (bucket) {
    // A duplicate tick+lane is malformed; keep the longer sustain and drop the other.
    const existing = bucket.find((n) => n.lane === lane);
    if (existing) {
      existing.length = Math.max(existing.length, length);
      return;
    }
    bucket.push(note);
  } else {
    byTick.set(tick, [note]);
  }
}
