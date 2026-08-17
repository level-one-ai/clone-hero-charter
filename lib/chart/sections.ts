import type { ChartEvent, Lane, Note } from './types';

/**
 * Named sections: how they are numbered, what they span, and how one is copied onto
 * another.
 *
 * A section marker records only where it STARTS. Its extent is "until the next marker",
 * which is what makes selecting or copying one possible at all — and what makes the last
 * section run to the end of the chart. Everything here follows from that single fact.
 *
 * Sections live in the chart's global [Events] block as `section <name>`, the convention
 * Clone Hero and Moonscraper both read. Clone Hero lists them in practice mode, so they
 * are what makes a long chart navigable rather than merely decorative.
 */

/** `section Intro` in the chart; the editor shows and edits just the name. */
export const SECTION_PREFIX = 'section ';

export interface Section {
  tick: number;
  name: string;
  /** Where this section ends: the next marker's tick, or the end of the chart. */
  endTick: number;
}

/** Sections in tick order, each paired with where it ends. */
export function readSections(events: ChartEvent[]): Section[] {
  const markers = events
    .filter((event) => event.text.startsWith(SECTION_PREFIX))
    .map((event) => ({ tick: event.tick, name: event.text.slice(SECTION_PREFIX.length) }))
    .sort((a, b) => a.tick - b.tick);

  return markers.map((section, index) => ({
    ...section,
    endTick: index + 1 < markers.length ? markers[index + 1].tick : Number.MAX_SAFE_INTEGER,
  }));
}

/**
 * The name a preset button should produce, given what is already in the chart.
 *
 * First Chorus is "Chorus", the next is "Chorus 2", then "Chorus 3". Numbering from the
 * second rather than the first matches how people talk about songs — nobody calls the
 * only chorus "Chorus 1" — and it matches what Clone Hero's practice list reads best.
 *
 * The count is of sections sharing this BASE name, so "Chorus" and "Chorus 2" both count
 * towards the next "Chorus 3", while "Pre-Chorus" is a different name entirely and
 * numbers on its own. Numbers fill the first free slot rather than continuing past a gap:
 * deleting "Chorus 2" and pressing the button again gives you "Chorus 2" back, which is
 * what someone repairing a mislabelled section expects.
 */
export function nextSectionName(existing: Section[], base: string): string {
  const trimmed = base.trim();
  if (!trimmed) return trimmed;

  const taken = new Set(existing.map((section) => section.name));
  if (!taken.has(trimmed)) return trimmed;

  // Start at 2: the unnumbered name is the first one.
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${trimmed} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return trimmed;
}

/**
 * The base name behind a numbered one: "Chorus 3" -> "Chorus".
 *
 * Used to group a song's choruses together in the copy picker, so copying "Chorus" onto
 * "Chorus 2" is offered as the obvious thing rather than buried among every other marker.
 */
export function sectionBaseName(name: string): string {
  return name.replace(/\s+\d+$/, '').trim();
}

export interface CopySectionResult {
  /** Notes to add, already positioned in the target section. */
  notes: Note[];
  /** Ids of notes inside the target range that the copy replaces. */
  replacedIds: string[];
  /** Notes that landed past the target section's end, if any. */
  overflowCount: number;
}

/**
 * Copy every note in `from` into `to`, keeping their timing relative to the section start.
 *
 * RELATIVE, not absolute: a note a beat and a half into the first chorus lands a beat and a
 * half into the second, whatever ticks the two sections happen to sit at. That is the only
 * definition under which "copy the chorus" means what a musician means by it.
 *
 * Notes already inside the target are REPLACED, because the operation people reach for
 * this to perform is "make chorus 2 the same as chorus 1", and layering a copy on top of
 * whatever was there would produce doubled notes that are tedious to unpick.
 *
 * Notes that fall past the target's end are still placed, and counted so the caller can
 * say so. The alternative — dropping them — silently truncates a copy when the second
 * chorus is marked a bar short, and a missing tail is far harder to notice than an
 * overhanging one.
 */
export function copySection(notes: Note[], from: Section, to: Section, newId: () => string): CopySectionResult {
  const source = notes.filter((note) => note.tick >= from.tick && note.tick < from.endTick);
  const shift = to.tick - from.tick;

  const copied = source.map((note) => ({
    ...note,
    id: newId(),
    tick: note.tick + shift,
  }));

  const replacedIds = notes
    .filter((note) => note.tick >= to.tick && note.tick < to.endTick)
    .map((note) => note.id);

  const overflowCount = copied.filter((note) => note.tick >= to.endTick).length;

  return { notes: copied, replacedIds, overflowCount };
}

/**
 * Ids of every note on the given lanes, optionally restricted to given sections.
 *
 * With no sections named, the whole chart is the scope. That is not a special case bolted
 * on: "select every green note" is the question when a chart has no structure marked, and
 * "select every green note in these two choruses" is the same question once it has.
 */
export function selectByLane(
  notes: Note[],
  lanes: Lane[],
  sections: Section[] = [],
): string[] {
  const wanted = new Set<number>(lanes);
  const inScope =
    sections.length === 0
      ? () => true
      : (tick: number) =>
          sections.some((section) => tick >= section.tick && tick < section.endTick);

  return notes.filter((note) => wanted.has(note.lane) && inScope(note.tick)).map((note) => note.id);
}
