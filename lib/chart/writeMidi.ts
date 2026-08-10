import { DIFFICULTY_BASE } from './midiToChart';
import { DIFFICULTIES, trackNameFor, type Difficulty, type Project } from './types';

/**
 * Write a Clone Hero `notes.mid`.
 *
 * Clone Hero loads both `.chart` and `.mid`, but `.mid` is what almost every song folder
 * in the wild actually contains, and it is what other tools (Moonscraper, EOF, the Rock
 * Band lineage) expect. This writes the standard Guitar Hero MIDI layout, which is the
 * mirror image of what lib/chart/midiToChart.ts reads:
 *
 *     Expert 96   Hard 84   Medium 72   Easy 60      (+0..4 = green..orange)
 *     base + 5    forced HOPO
 *     base + 7    open note
 *     note 116    star power phrase   (track-wide)
 *     note 104    tap phrase          (track-wide)
 *
 * A minimal SMF writer rather than a library: the format is a few hundred bytes of
 * structure, and the parts we need that general-purpose MIDI libraries tend not to
 * expose — text meta-events for section markers, exact tick placement with no rescaling
 * — are precisely the parts that matter here.
 *
 * TICKS: the file's PPQ is the project's own resolution, so no tick is ever rescaled and
 * the round trip through midiToChart is exact.
 */

/**
 * Length written for a note with no sustain.
 *
 * It cannot be zero — a zero-length MIDI note is ambiguous and some parsers drop it —
 * and it must stay below the importer's sustain cutoff of `resolution / 3`, or every
 * note would come back as a short sustain. A 64th note is comfortably under it and
 * displays sensibly in other editors.
 */
const BLIP_DIVISOR = 16;

const STAR_POWER_NOTE = 116;
const TAP_NOTE = 104;
const FORCED_OFFSET = 5;
const OPEN_OFFSET = 7;

export interface WriteMidiResult {
  data: Uint8Array;
  /** Fidelity notes — things the MIDI layout cannot express as precisely as our model. */
  warnings: string[];
}

export function writeMidi(project: Project): WriteMidiResult {
  const ppq = project.resolution;
  const blip = Math.max(1, Math.round(ppq / BLIP_DIVISOR));
  const warnings: string[] = [];

  // ---- track 0: tempo map ------------------------------------------------------------
  const tempoEvents: MidiEvent[] = [];
  tempoEvents.push(meta(0, 0x03, textBytes(project.meta.name || 'Song')));

  const bpms = [...project.sync.bpms].sort((a, b) => a.tick - b.tick);
  if (bpms.length === 0 || bpms[0].tick !== 0) {
    tempoEvents.push(meta(0, 0x51, microsecondsPerQuarter(bpms[0]?.bpm ?? 120)));
  }
  for (const marker of bpms) {
    tempoEvents.push(meta(marker.tick, 0x51, microsecondsPerQuarter(marker.bpm)));
  }

  const timeSignatures = [...project.sync.timeSignatures].sort((a, b) => a.tick - b.tick);
  if (timeSignatures.length === 0 || timeSignatures[0].tick !== 0) {
    tempoEvents.push(meta(0, 0x58, timeSignatureBytes(4, 4)));
  }
  for (const marker of timeSignatures) {
    tempoEvents.push(meta(marker.tick, 0x58, timeSignatureBytes(marker.numerator, marker.denominator)));
  }

  // ---- EVENTS track: section markers --------------------------------------------------
  const eventEvents: MidiEvent[] = [meta(0, 0x03, textBytes('EVENTS'))];
  for (const event of [...project.events].sort((a, b) => a.tick - b.tick)) {
    // Clone Hero reads practice-mode sections from "[section Name]" text events, which is
    // the Rock Band convention our own .chart writer mirrors with "section Name".
    const text = event.text.startsWith('[') ? event.text : `[section ${event.text}]`;
    eventEvents.push(meta(event.tick, 0x01, textBytes(text)));
  }

  // ---- PART GUITAR --------------------------------------------------------------------
  const guitarEvents: MidiEvent[] = [meta(0, 0x03, textBytes('PART GUITAR'))];

  const hasOpenNotes = DIFFICULTIES.some((d) =>
    project.tracks[trackNameFor(d)].notes.some((n) => n.lane === 7),
  );
  if (hasOpenNotes) {
    // Some parsers only honour base+7 as an open note when the track opts in. Harmless
    // to the ones that always honour it.
    guitarEvents.push(meta(0, 0x01, textBytes('[ENHANCED_OPENS]')));
  }

  for (const difficulty of DIFFICULTIES) {
    const base = DIFFICULTY_BASE[difficulty];
    const notes = project.tracks[trackNameFor(difficulty)].notes;
    const forcedTicks = new Set<number>();

    for (const note of notes) {
      const duration = note.length > 0 ? note.length : blip;
      const number = note.lane === 7 ? base + OPEN_OFFSET : base + note.lane;
      pushNote(guitarEvents, note.tick, number, duration);
      if (note.forced) forcedTicks.add(note.tick);
    }

    // The forced flag is per-tick in both the .chart format and the MIDI layout, so one
    // marker covers a whole chord rather than one per note.
    for (const tick of forcedTicks) {
      pushNote(guitarEvents, tick, base + FORCED_OFFSET, blip);
    }
  }

  /**
   * Star power and taps are TRACK-WIDE in the MIDI layout — one set of phrases covers
   * every difficulty — while our model stores them per difficulty. Expert is the source
   * of truth, since that is the difficulty everything else is derived from; if a lower
   * difficulty disagrees, that difference cannot survive the file and is reported rather
   * than silently dropped.
   */
  const expertTrack = project.tracks[trackNameFor('Expert')];

  for (const phrase of expertTrack.starPower) {
    pushNote(guitarEvents, phrase.tick, STAR_POWER_NOTE, Math.max(1, phrase.length));
  }
  if (differsFromExpert(project, (track) => JSON.stringify(track.starPower))) {
    warnings.push(
      'Star power is one set of phrases per song in a .mid file, so Expert’s phrases were used. Another difficulty had different ones, and that difference is not in the export.',
    );
  }

  for (const [start, end] of tapPhrases(expertTrack.notes, blip)) {
    pushNote(guitarEvents, start, TAP_NOTE, Math.max(1, end - start));
  }
  if (
    differsFromExpert(project, (track) =>
      JSON.stringify(track.notes.filter((n) => n.tap).map((n) => n.tick)),
    )
  ) {
    warnings.push(
      'Tap notes are marked once per song in a .mid file, so Expert’s taps were used. Another difficulty tapped different notes, and that difference is not in the export.',
    );
  }

  const chunks = [
    header(1, 3, ppq),
    trackChunk(tempoEvents),
    trackChunk(eventEvents),
    trackChunk(guitarEvents),
  ];

  return { data: concat(chunks), warnings };
}

/** True when any non-empty difficulty other than Expert differs on `pick`. */
function differsFromExpert(
  project: Project,
  pick: (track: Project['tracks'][keyof Project['tracks']]) => string,
): boolean {
  const expert = project.tracks[trackNameFor('Expert')];
  const reference = pick(expert);
  return DIFFICULTIES.filter((d) => d !== 'Expert').some((d) => {
    const track = project.tracks[trackNameFor(d)];
    return track.notes.length > 0 && pick(track) !== reference;
  });
}

/** Merge tapped notes into as few phrases as possible. */
function tapPhrases(notes: Project['tracks'][keyof Project['tracks']]['notes'], blip: number) {
  const spans = notes
    .filter((n) => n.tap)
    .map((n) => [n.tick, n.tick + Math.max(n.length, blip)] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// SMF encoding
// ---------------------------------------------------------------------------

interface MidiEvent {
  tick: number;
  /** Sorts note-offs before note-ons at the same tick, and meta events before both. */
  order: number;
  bytes: number[];
}

function meta(tick: number, type: number, data: number[]): MidiEvent {
  return { tick, order: 0, bytes: [0xff, type, ...variableLength(data.length), ...data] };
}

function pushNote(events: MidiEvent[], tick: number, note: number, duration: number): void {
  const start = Math.max(0, Math.round(tick));
  const end = start + Math.max(1, Math.round(duration));
  // Velocity 100 is the convention for charted notes; the value is not read back.
  events.push({ tick: start, order: 2, bytes: [0x90, note & 0x7f, 100] });
  events.push({ tick: end, order: 1, bytes: [0x80, note & 0x7f, 0] });
}

function header(format: number, trackCount: number, ppq: number): number[] {
  return [
    ...ascii('MThd'),
    0x00, 0x00, 0x00, 0x06,
    (format >> 8) & 0xff, format & 0xff,
    (trackCount >> 8) & 0xff, trackCount & 0xff,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ];
}

function trackChunk(events: MidiEvent[]): number[] {
  // Note-offs must land before note-ons at the same tick, or a note that ends exactly
  // where the next begins swallows it.
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);

  const body: number[] = [];
  let previousTick = 0;
  for (const event of sorted) {
    body.push(...variableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00); // end of track

  return [
    ...ascii('MTrk'),
    (body.length >>> 24) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff,
    body.length & 0xff,
    ...body,
  ];
}

/** MIDI's 7-bits-per-byte variable-length quantity, high bit set on all but the last. */
function variableLength(value: number): number[] {
  let remaining = Math.max(0, Math.round(value));
  const out = [remaining & 0x7f];
  remaining >>= 7;
  while (remaining > 0) {
    out.unshift((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }
  return out;
}

function microsecondsPerQuarter(bpm: number): number[] {
  const value = Math.max(1, Math.round(60_000_000 / (bpm > 0 ? bpm : 120)));
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function timeSignatureBytes(numerator: number, denominator: number): number[] {
  // MIDI stores the denominator as a power of two: 2 means a quarter-note beat.
  const power = Math.max(0, Math.round(Math.log2(denominator > 0 ? denominator : 4)));
  return [Math.max(1, numerator) & 0xff, power, 24, 8];
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0) & 0xff);
}

/** UTF-8, so section names with accents survive. */
function textBytes(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

function concat(chunks: number[][]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
