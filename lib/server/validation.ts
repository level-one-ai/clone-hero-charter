import { z } from 'zod';
import { TRACK_NAMES, type Project } from '../chart/types';

/**
 * Request validation for the chart-save endpoint.
 *
 * The editor posts the entire project on every autosave, so this is the boundary
 * where a buggy client (or a stale tab) could otherwise write nonsense to disk and
 * corrupt a chart the user has spent hours on. Everything is bounded and normalised
 * rather than merely type-checked.
 */

const laneSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(7),
]);

// A generous but finite ceiling: 2^24 ticks is ~24 hours at 192 res / 120 BPM.
const MAX_TICK = 16_777_216;

const noteSchema = z.object({
  id: z.string().min(1).max(64),
  tick: z.number().int().min(0).max(MAX_TICK),
  lane: laneSchema,
  length: z.number().int().min(0).max(MAX_TICK),
  forced: z.boolean(),
  tap: z.boolean(),
});

const starPowerSchema = z.object({
  tick: z.number().int().min(0).max(MAX_TICK),
  length: z.number().int().min(0).max(MAX_TICK),
});

const trackSchema = z.object({
  // 50k notes is far past any real chart but stops a runaway client filling the disk.
  notes: z.array(noteSchema).max(50_000),
  starPower: z.array(starPowerSchema).max(5_000),
});

const bpmSchema = z.object({
  tick: z.number().int().min(0).max(MAX_TICK),
  // Clone Hero itself misbehaves outside this range; reject rather than store it.
  bpm: z.number().min(1).max(1000),
});

const timeSignatureSchema = z.object({
  tick: z.number().int().min(0).max(MAX_TICK),
  numerator: z.number().int().min(1).max(64),
  // Must be a power of two — the format stores log2(denominator).
  denominator: z
    .number()
    .int()
    .min(1)
    .max(64)
    .refine((d) => (d & (d - 1)) === 0, { message: 'denominator must be a power of two' }),
});

export const projectSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(64),
  // Client-supplied revisions are advisory only: the route compares them and the server
  // owns the value it stores, so a forged one cannot do anything but fail the check.
  revision: z.number().int().min(0).optional(),
  meta: z.object({
    name: z.string().max(300),
    artist: z.string().max(300),
    album: z.string().max(300),
    year: z.number().int().min(1000).max(9999).nullable(),
    genre: z.string().max(120),
    charter: z.string().max(120),
    mediaType: z.string().max(60),
    offset: z.number().min(-600).max(600),
    // Up to a minute of lead-in; beyond that it is a mistake, not an intention.
    leadingSilenceMs: z.number().min(0).max(60_000).default(0),
  }),
  resolution: z.number().int().min(1).max(19200),
  audio: z.object({
    file: z.string().max(260),
    durationMs: z.number().min(0).max(24 * 60 * 60 * 1000),
    sampleRate: z.number().int().min(0).max(768_000).nullable(),
  }),
  album: z.string().max(260).nullable(),
  sync: z.object({
    bpms: z.array(bpmSchema).min(1).max(10_000),
    timeSignatures: z.array(timeSignatureSchema).min(1).max(10_000),
  }),
  events: z
    .array(z.object({ tick: z.number().int().min(0).max(MAX_TICK), text: z.string().max(500) }))
    .max(5_000),
  tracks: z.object({
    ExpertSingle: trackSchema,
    HardSingle: trackSchema,
    MediumSingle: trackSchema,
    EasySingle: trackSchema,
  }),
});

/**
 * Normalise a validated project into the canonical form we persist.
 *
 * Invariants enforced here rather than trusted from the client:
 *  - notes and markers sorted by tick
 *  - no two notes share a tick+lane (the later one wins, keeping the longer sustain)
 *  - a tick-0 BPM and time signature always exist, since all timing math anchors there
 */
export function normalizeProject(input: z.infer<typeof projectSchema>): Project {
  const project = input as Project;

  const bpms = [...project.sync.bpms].sort((a, b) => a.tick - b.tick);
  const dedupedBpms = dedupeByTick(bpms);
  if (dedupedBpms.length === 0 || dedupedBpms[0].tick !== 0) {
    dedupedBpms.unshift({ tick: 0, bpm: dedupedBpms[0]?.bpm ?? 120 });
  }
  project.sync.bpms = dedupedBpms;

  const timeSignatures = dedupeByTick([...project.sync.timeSignatures].sort((a, b) => a.tick - b.tick));
  if (timeSignatures.length === 0 || timeSignatures[0].tick !== 0) {
    timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }
  project.sync.timeSignatures = timeSignatures;

  project.events = [...project.events].sort((a, b) => a.tick - b.tick);

  for (const trackName of TRACK_NAMES) {
    const track = project.tracks[trackName];
    const byKey = new Map<string, (typeof track.notes)[number]>();
    for (const note of track.notes) {
      const key = `${note.tick}:${note.lane}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.length = Math.max(existing.length, note.length);
        existing.forced = existing.forced || note.forced;
        existing.tap = existing.tap || note.tap;
      } else {
        byKey.set(key, note);
      }
    }
    track.notes = [...byKey.values()].sort((a, b) => a.tick - b.tick || a.lane - b.lane);
    track.starPower = [...track.starPower]
      .filter((p) => p.length > 0)
      .sort((a, b) => a.tick - b.tick);
  }

  return project;
}

function dedupeByTick<T extends { tick: number }>(items: T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    if (result.length > 0 && result[result.length - 1].tick === item.tick) {
      result[result.length - 1] = item;
    } else {
      result.push(item);
    }
  }
  return result;
}
