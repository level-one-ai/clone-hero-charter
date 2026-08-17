import { describe, expect, it } from 'vitest';
import {
  copySection,
  nextSectionName,
  readSections,
  sectionBaseName,
  selectByLane,
  SECTION_PREFIX,
  type Section,
} from './sections';
import type { Lane, Note } from './types';

let idCounter = 0;
const newId = () => `copy${(idCounter += 1)}`;

function notes(spec: Array<{ tick: number; lane: Lane; length?: number }>): Note[] {
  return spec.map((n, i) => ({
    id: `n${i}`,
    tick: n.tick,
    lane: n.lane,
    length: n.length ?? 0,
    forced: false,
    tap: false,
  }));
}

function events(spec: Array<[number, string]>) {
  return spec.map(([tick, name]) => ({ tick, text: `${SECTION_PREFIX}${name}` }));
}

describe('readSections', () => {
  it('pairs each section with where it ends', () => {
    const sections = readSections(events([[0, 'Intro'], [768, 'Verse'], [1536, 'Chorus']]));
    expect(sections.map((s) => [s.name, s.tick, s.endTick])).toEqual([
      ['Intro', 0, 768],
      ['Verse', 768, 1536],
      ['Chorus', 1536, Number.MAX_SAFE_INTEGER],
    ]);
  });

  it('sorts by tick regardless of the order events were added', () => {
    const sections = readSections(events([[1536, 'Chorus'], [0, 'Intro']]));
    expect(sections.map((s) => s.name)).toEqual(['Intro', 'Chorus']);
  });

  it('ignores events that are not sections', () => {
    const mixed = [...events([[0, 'Intro']]), { tick: 96, text: 'lighting (flare)' }];
    expect(readSections(mixed)).toHaveLength(1);
  });

  it('ends a section EXCLUSIVELY, at the next marker’s own tick', () => {
    /**
     * The boundary convention, pinned because both conventions are defensible and mixing
     * them is an off-by-one that hides. `endTick` is the next section's first tick, NOT
     * the last tick of this one — so a half-open range [tick, endTick) is this section,
     * and any consumer wanting an inclusive range must subtract one. `copySection` and
     * `selectByLane` below both use the half-open form.
     */
    const [intro] = readSections(events([[0, 'Intro'], [768, 'Verse']]));
    expect(intro.endTick).toBe(768);
  });
});

describe('nextSectionName', () => {
  it('leaves the first of a name unnumbered', () => {
    expect(nextSectionName([], 'Chorus')).toBe('Chorus');
  });

  it('numbers from two, the way people talk about songs', () => {
    const one = readSections(events([[0, 'Chorus']]));
    expect(nextSectionName(one, 'Chorus')).toBe('Chorus 2');

    const two = readSections(events([[0, 'Chorus'], [768, 'Chorus 2']]));
    expect(nextSectionName(two, 'Chorus')).toBe('Chorus 3');
  });

  it('fills a gap rather than continuing past it', () => {
    // Deleting a mislabelled "Chorus 2" and pressing the button again should give it back.
    const withGap = readSections(events([[0, 'Chorus'], [768, 'Chorus 3']]));
    expect(nextSectionName(withGap, 'Chorus')).toBe('Chorus 2');
  });

  it('counts only sections sharing the name', () => {
    const mixed = readSections(events([[0, 'Chorus'], [768, 'Verse'], [1536, 'Bridge']]));
    expect(nextSectionName(mixed, 'Verse')).toBe('Verse 2');
    expect(nextSectionName(mixed, 'Solo')).toBe('Solo');
  });

  it('treats a different name as different, not as a variant', () => {
    const chorus = readSections(events([[0, 'Chorus']]));
    expect(nextSectionName(chorus, 'Pre-Chorus')).toBe('Pre-Chorus');
  });
});

describe('sectionBaseName', () => {
  it('strips a trailing number', () => {
    expect(sectionBaseName('Chorus 3')).toBe('Chorus');
    expect(sectionBaseName('Chorus')).toBe('Chorus');
  });

  it('leaves a number that is part of the name', () => {
    expect(sectionBaseName('Solo 2 Reprise')).toBe('Solo 2 Reprise');
  });
});

describe('copySection', () => {
  const from: Section = { tick: 1000, name: 'Chorus', endTick: 2000 };
  const to: Section = { tick: 5000, name: 'Chorus 2', endTick: 6000 };

  it('keeps timing relative to the section start', () => {
    const chart = notes([
      { tick: 1000, lane: 0 },
      { tick: 1250, lane: 1 },
      { tick: 1999, lane: 2 },
    ]);
    const result = copySection(chart, from, to, newId);
    expect(result.notes.map((n) => n.tick)).toEqual([5000, 5250, 5999]);
  });

  it('carries lanes, sustains and flags across', () => {
    const chart = notes([{ tick: 1100, lane: 3, length: 192 }]);
    chart[0].forced = true;
    chart[0].tap = true;
    const [copied] = copySection(chart, from, to, newId).notes;
    expect(copied).toMatchObject({ lane: 3, length: 192, forced: true, tap: true });
  });

  it('gives every copy a fresh id', () => {
    const chart = notes([{ tick: 1000, lane: 0 }]);
    const copied = copySection(chart, from, to, newId).notes[0];
    expect(copied.id).not.toBe(chart[0].id);
  });

  it('replaces what was already in the target', () => {
    const chart = notes([
      { tick: 1000, lane: 0 },
      { tick: 5100, lane: 4 },
      { tick: 5200, lane: 4 },
    ]);
    const result = copySection(chart, from, to, newId);
    expect(result.replacedIds).toEqual(['n1', 'n2']);
  });

  it('leaves notes outside both sections alone', () => {
    const chart = notes([
      { tick: 500, lane: 0 },
      { tick: 1000, lane: 1 },
      { tick: 9000, lane: 2 },
    ]);
    const result = copySection(chart, from, to, newId);
    expect(result.replacedIds).toEqual([]);
    expect(result.notes.map((n) => n.tick)).toEqual([5000]);
  });

  it('excludes the next section: the range is start-inclusive, end-exclusive', () => {
    const chart = notes([
      { tick: 1000, lane: 0 },
      { tick: 2000, lane: 1 }, // the first note of whatever follows
    ]);
    expect(copySection(chart, from, to, newId).notes).toHaveLength(1);
  });

  it('reports notes that overhang a shorter target rather than dropping them', () => {
    // Silently truncating is worse: a missing tail is much harder to notice than an
    // overhanging one, and the charter can always delete what they can see.
    const chart = notes([
      { tick: 1000, lane: 0 },
      { tick: 1900, lane: 1 },
    ]);
    const shortTarget: Section = { tick: 5000, name: 'Chorus 2', endTick: 5500 };
    const result = copySection(chart, from, shortTarget, newId);
    expect(result.notes).toHaveLength(2);
    expect(result.overflowCount).toBe(1);
  });

  it('copies an empty section to nothing, and still clears the target', () => {
    const chart = notes([{ tick: 5100, lane: 0 }]);
    const result = copySection(chart, from, to, newId);
    expect(result.notes).toEqual([]);
    expect(result.replacedIds).toEqual(['n0']);
  });
});

describe('selectByLane', () => {
  const chart = notes([
    { tick: 0, lane: 0 },
    { tick: 100, lane: 1 },
    { tick: 900, lane: 0 },
    { tick: 2000, lane: 0 },
    { tick: 2100, lane: 7 },
  ]);

  it('selects a colour across the whole chart when no section is chosen', () => {
    expect(selectByLane(chart, [0])).toEqual(['n0', 'n2', 'n3']);
  });

  it('takes more than one colour at a time', () => {
    expect(selectByLane(chart, [0, 1])).toEqual(['n0', 'n1', 'n2', 'n3']);
  });

  it('restricts to the chosen sections', () => {
    const intro: Section = { tick: 0, name: 'Intro', endTick: 1000 };
    expect(selectByLane(chart, [0], [intro])).toEqual(['n0', 'n2']);
  });

  it('takes more than one section at a time', () => {
    const intro: Section = { tick: 0, name: 'Intro', endTick: 1000 };
    const chorus: Section = { tick: 2000, name: 'Chorus', endTick: 3000 };
    expect(selectByLane(chart, [0], [intro, chorus])).toEqual(['n0', 'n2', 'n3']);
  });

  it('handles open notes like any other lane', () => {
    expect(selectByLane(chart, [7])).toEqual(['n4']);
  });

  it('returns nothing when the colour is absent', () => {
    expect(selectByLane(chart, [4])).toEqual([]);
  });
});
