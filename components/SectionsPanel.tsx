'use client';

import { useMemo, useState } from 'react';
import { LANE_COLORS, LANE_LABELS, type Lane, type Project, type TrackName } from '@/lib/chart/types';
import type { EditorAction } from '@/lib/editor/projectReducer';
import { TimingMap, formatTime } from '@/lib/chart/timing';
import {
  nextSectionName,
  readSections,
  sectionBaseName,
  SECTION_PREFIX,
  type Section,
} from '@/lib/chart/sections';
import Disclosure from './Disclosure';

/**
 * Named sections — and, because sections are what give a chart structure, the two
 * operations that structure makes possible: copying one section onto another, and
 * selecting notes within a chosen set of them.
 *
 * The panel is built around SELECTION as the shared verb. Clicking a section arms it;
 * armed sections then scope the colour buttons and provide the source and target for a
 * copy. That is one concept doing three jobs, rather than three separate pickers that each
 * ask the same question in a different way.
 *
 * Star power lives here too because in practice you place it by section: "the chorus gets
 * a phrase". Phrases are per-difficulty, so the panel edits whichever difficulty is open.
 */

interface Props {
  project: Project;
  trackName: TrackName;
  timing: TimingMap;
  playheadTick: number;
  dispatch: React.Dispatch<EditorAction>;
  onSeekToTick: (tick: number) => void;
  /** Select every note between two ticks — used to grab a whole named section. */
  onSelectSection: (fromTick: number, toTick: number, label: string) => void;
  /** Select notes by lane, scoped to the armed sections (or the whole chart if none). */
  onSelectLanes: (lanes: Lane[], sections: Section[]) => void;
  /** Copy one section's notes onto another. */
  onCopySection: (from: Section, to: Section) => void;
}

/** The presets, in the order a song tends to use them. */
const PRESETS = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Solo', 'Breakdown', 'Outro'];

/** Colour buttons, open note included — it is a lane like any other for selection. */
const SELECTABLE_LANES: Lane[] = [0, 1, 2, 3, 4, 7];

export default function SectionsPanel({
  project,
  trackName,
  timing,
  playheadTick,
  dispatch,
  onSeekToTick,
  onSelectSection,
  onSelectLanes,
  onCopySection,
}: Props) {
  const [name, setName] = useState('');
  /** Ticks of the armed sections. Ticks rather than names, since names can repeat. */
  const [armed, setArmed] = useState<number[]>([]);
  const [copySource, setCopySource] = useState<number | null>(null);

  const sections = useMemo(() => readSections(project.events), [project.events]);
  const otherEvents = project.events.filter((event) => !event.text.startsWith(SECTION_PREFIX));
  const starPower = project.tracks[trackName].starPower;

  const armedSections = sections.filter((section) => armed.includes(section.tick));

  const addSection = (base: string) => {
    const trimmed = base.trim();
    if (!trimmed) return;
    // Numbering happens here rather than in the reducer so the button and the text field
    // behave identically: typing "Chorus" a second time also gets you "Chorus 2".
    const numbered = nextSectionName(sections, trimmed);
    dispatch({ type: 'upsertEvent', tick: playheadTick, text: `${SECTION_PREFIX}${numbered}` });
    setName('');
  };

  const toggleArmed = (tick: number) => {
    setArmed((current) =>
      current.includes(tick) ? current.filter((t) => t !== tick) : [...current, tick],
    );
  };

  /**
   * The likely copy target: the next section sharing this one's base name.
   *
   * "Copy the chorus into chorus 2" is overwhelmingly the operation, so the button offers
   * it directly instead of making the charter pick from a list of every marker in the song.
   * The full list is still there for anything else.
   */
  const source = sections.find((section) => section.tick === copySource) ?? null;
  const copyTargets = source
    ? sections.filter(
        (section) =>
          section.tick !== source.tick && sectionBaseName(section.name) === sectionBaseName(source.name),
      )
    : [];
  const otherTargets = source
    ? sections.filter(
        (section) =>
          section.tick !== source.tick && sectionBaseName(section.name) !== sectionBaseName(source.name),
      )
    : [];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* ---- Sections -------------------------------------------------------- */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Sections</h3>

        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="ch-label">Name</span>
            <input
              className="ch-input"
              value={name}
              maxLength={100}
              placeholder="Chorus"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addSection(name);
                }
              }}
            />
          </label>
          <button
            type="button"
            className="ch-button"
            onClick={() => addSection(name)}
            disabled={!name.trim()}
          >
            Add
          </button>
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {PRESETS.map((preset) => {
            // Show what pressing it will actually produce, so the numbering is visible
            // before the click rather than being a surprise after it.
            const willBe = nextSectionName(sections, preset);
            return (
              <button
                key={preset}
                type="button"
                className="border border-edge2 bg-panel px-2 py-1 text-2xs text-muted hover:text-fg"
                onClick={() => addSection(preset)}
                title={`Add "${willBe}" at the playhead`}
              >
                {willBe}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-2xs text-faint">
          Added at the playhead. The first of a name is unnumbered and the next gets a
          number, so pressing Chorus repeatedly gives Chorus, Chorus 2, Chorus 3.
        </p>

        <ul className="mt-3 max-h-48 space-y-0.5 overflow-y-auto">
          {sections.length === 0 && <li className="text-2xs text-faint">No sections yet.</li>}
          {sections.map((section) => {
            const isArmed = armed.includes(section.tick);
            return (
              <li key={section.tick} className="flex items-center gap-1 text-2xs">
                {/*
                  Arming is a checkbox rather than a click on the row, because the row
                  already does something (jump to the section) and a charter navigating a
                  long chart should not be silently changing the scope of the next
                  selection while they do it.
                */}
                <input
                  type="checkbox"
                  checked={isArmed}
                  onChange={() => toggleArmed(section.tick)}
                  className="shrink-0 accent-white"
                  aria-label={`Include ${section.name} in colour selections`}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-muted hover:text-fg"
                  onClick={() => onSeekToTick(section.tick)}
                  title="Jump to this section"
                >
                  <span className="font-mono">{formatTime(timing.tickToSec(section.tick))}</span>{' '}
                  {section.name}
                </button>
                <button
                  type="button"
                  className={`shrink-0 border px-1 ${
                    copySource === section.tick
                      ? 'border-lane-green text-lane-green'
                      : 'border-edge2 text-faint hover:text-fg'
                  }`}
                  onClick={() => setCopySource(copySource === section.tick ? null : section.tick)}
                  title={`Copy the notes in "${section.name}" somewhere else`}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="shrink-0 border border-edge2 px-1 text-faint hover:text-fg"
                  // `endTick` is EXCLUSIVE — it is the next marker's tick — while the
                  // range selection is inclusive at both ends. Without the -1, selecting a
                  // section also grabs the first note of the one after it.
                  onClick={() => onSelectSection(section.tick, section.endTick - 1, section.name)}
                  title={`Select every note in "${section.name}"`}
                >
                  Select
                </button>
                <button
                  type="button"
                  className="text-faint hover:text-danger"
                  onClick={() => {
                    dispatch({ type: 'deleteEvent', tick: section.tick });
                    setArmed((current) => current.filter((t) => t !== section.tick));
                    if (copySource === section.tick) setCopySource(null);
                  }}
                  aria-label={`Delete section ${section.name}`}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>

        {/*
          The paste half of the copy, shown only once a source is chosen. Same-name
          sections are offered first and prominently, since "chorus into chorus 2" is the
          operation this exists for.
        */}
        {source && (
          <div className="mt-3 border border-edge2 p-2">
            <p className="text-2xs text-muted">
              Copy <span className="text-fg">{source.name}</span> into:
            </p>
            {copyTargets.length === 0 && otherTargets.length === 0 && (
              <p className="mt-1 text-2xs text-faint">
                There is nowhere to put it — add another section first.
              </p>
            )}
            <div className="mt-1 flex flex-wrap gap-1">
              {copyTargets.map((target) => (
                <button
                  key={target.tick}
                  type="button"
                  className="ch-button"
                  onClick={() => {
                    onCopySection(source, target);
                    setCopySource(null);
                  }}
                >
                  {target.name}
                </button>
              ))}
            </div>
            {otherTargets.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {otherTargets.map((target) => (
                  <button
                    key={target.tick}
                    type="button"
                    className="border border-edge2 bg-panel px-2 py-1 text-2xs text-faint hover:text-fg"
                    onClick={() => {
                      onCopySection(source, target);
                      setCopySource(null);
                    }}
                  >
                    {target.name}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1 text-2xs text-faint">
              Notes keep their position within the section. Anything already in the target
              is replaced.
            </p>
          </div>
        )}
      </section>

      {/* ---- Select by colour ------------------------------------------------ */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Select by colour</h3>

        <div className="flex flex-wrap gap-1">
          {SELECTABLE_LANES.map((lane) => (
            <button
              key={lane}
              type="button"
              className="flex items-center gap-1.5 border border-edge2 bg-panel px-2 py-1 text-2xs text-muted hover:text-fg"
              onClick={() => onSelectLanes([lane], armedSections)}
              title={`Select every ${LANE_LABELS[lane].toLowerCase()} note${
                armedSections.length > 0 ? ' in the ticked sections' : ' in the chart'
              }`}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: LANE_COLORS[lane] }}
              />
              {LANE_LABELS[lane]}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="ch-button mt-2 w-full"
          onClick={() => onSelectLanes(SELECTABLE_LANES, armedSections)}
        >
          Every colour
        </button>

        <p className="mt-1 text-2xs text-faint">
          {armedSections.length > 0
            ? `Scoped to ${armedSections.map((s) => s.name).join(', ')}. Untick them to search the whole chart.`
            : 'Searching the whole chart. Tick sections above to narrow it.'}
        </p>
        {armedSections.length > 0 && (
          <button
            type="button"
            className="mt-1 text-2xs text-faint underline-offset-2 hover:text-fg hover:underline"
            onClick={() => setArmed([])}
          >
            Clear the section scope
          </button>
        )}
      </section>

      {/* ---- Star power ------------------------------------------------------ */}
      <section className="border-b border-edge p-3">
        <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">
          Star power &mdash; {trackName.replace('Single', '')}
        </h3>
        <p className="text-2xs text-faint">
          Press <span className="text-fg">Star power</span> on the note bar (or{' '}
          <span className="text-fg">P</span>), then click where the phrase starts on the
          highway and again where it ends. Drawing across an existing phrase joins the two.
          Phrases are per difficulty.
        </p>

        <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto">
          {starPower.length === 0 && <li className="text-2xs text-faint">No phrases yet.</li>}
          {starPower.map((phrase) => (
            <li key={phrase.tick} className="flex items-center gap-2 text-2xs">
              <button
                type="button"
                className="flex-1 text-left font-mono text-muted hover:text-fg"
                onClick={() => onSeekToTick(phrase.tick)}
              >
                {formatTime(timing.tickToSec(phrase.tick))} &rarr;{' '}
                {formatTime(timing.tickToSec(phrase.tick + phrase.length))}
              </button>
              <button
                type="button"
                className="text-faint hover:text-danger"
                onClick={() =>
                  dispatch({ type: 'deleteStarPowerPhrase', track: trackName, tick: phrase.tick })
                }
                aria-label="Delete star power phrase"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Anything in [Events] that is not a section — imported from a .chart. */}
      {otherEvents.length > 0 && (
        <Disclosure label={`Other events (${otherEvents.length})`}>
          <ul className="space-y-0.5 p-3">
            {otherEvents.map((event) => (
              <li key={`${event.tick}-${event.text}`} className="flex items-center gap-2 text-2xs">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left font-mono text-muted hover:text-fg"
                  onClick={() => onSeekToTick(event.tick)}
                >
                  {formatTime(timing.tickToSec(event.tick))} {event.text}
                </button>
                <button
                  type="button"
                  className="text-faint hover:text-danger"
                  onClick={() => dispatch({ type: 'deleteEvent', tick: event.tick })}
                  aria-label="Delete event"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
