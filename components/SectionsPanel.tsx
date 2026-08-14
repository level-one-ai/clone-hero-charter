'use client';

import { useState } from 'react';
import type { Project, TrackName } from '@/lib/chart/types';
import type { EditorAction } from '@/lib/editor/projectReducer';
import { TimingMap, formatTime } from '@/lib/chart/timing';

/**
 * Named sections, and star power phrases.
 *
 * Sections are stored in the chart's global [Events] block as `section <name>`, which
 * is the convention Clone Hero and Moonscraper both read — Clone Hero shows them on
 * the practice-mode section list, so they are what makes a long chart navigable
 * rather than merely decorative.
 *
 * Star power lives here too because in practice you place it by section: "the chorus
 * gets a phrase". Phrases are per-difficulty, so the panel edits whichever difficulty
 * is open.
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
}

/** `section Intro` in the chart; the panel shows and edits just the name. */
const SECTION_PREFIX = 'section ';

export default function SectionsPanel({
  project,
  trackName,
  timing,
  playheadTick,
  dispatch,
  onSeekToTick,
  onSelectSection,
}: Props) {
  const [name, setName] = useState('');

  /**
   * Sections, each paired with where it ends.
   *
   * A section marker only records where it STARTS; its extent is "until the next one",
   * which is what makes selecting one possible at all. The last section runs to the end
   * of the chart, so `endTick` is Infinity there and the range selection simply takes
   * everything after it.
   */
  const sections = project.events
    .filter((event) => event.text.startsWith(SECTION_PREFIX))
    .map((event) => ({ tick: event.tick, name: event.text.slice(SECTION_PREFIX.length) }))
    .sort((a, b) => a.tick - b.tick)
    .map((section, index, all) => ({
      ...section,
      endTick: index + 1 < all.length ? all[index + 1].tick - 1 : Number.MAX_SAFE_INTEGER,
    }));

  const otherEvents = project.events.filter((event) => !event.text.startsWith(SECTION_PREFIX));
  const starPower = project.tracks[trackName].starPower;

  const addSection = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    dispatch({ type: 'upsertEvent', tick: playheadTick, text: `${SECTION_PREFIX}${trimmed}` });
    setName('');
  };

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
                  addSection();
                }
              }}
            />
          </label>
          <button type="button" className="ch-button" onClick={addSection} disabled={!name.trim()}>
            Add
          </button>
        </div>
        <p className="mt-1 text-2xs text-faint">
          Added at the playhead. Sections show up in Clone Hero&apos;s practice mode, so
          they are how you jump around a long chart.
        </p>

        <div className="mt-2 flex flex-wrap gap-1">
          {['Intro', 'Verse', 'Chorus', 'Bridge', 'Solo', 'Outro'].map((preset) => (
            <button
              key={preset}
              type="button"
              className="border border-edge2 bg-panel px-2 py-1 text-2xs text-muted hover:text-fg"
              onClick={() =>
                dispatch({
                  type: 'upsertEvent',
                  tick: playheadTick,
                  text: `${SECTION_PREFIX}${preset}`,
                })
              }
            >
              {preset}
            </button>
          ))}
        </div>

        <ul className="mt-3 max-h-48 space-y-0.5 overflow-y-auto">
          {sections.length === 0 && (
            <li className="text-2xs text-faint">No sections yet.</li>
          )}
          {sections.map((section) => (
            <li key={section.tick} className="flex items-center gap-2 text-2xs">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-muted hover:text-fg"
                onClick={() => onSeekToTick(section.tick)}
                title="Jump to this section"
              >
                <span className="font-mono">{formatTime(timing.tickToSec(section.tick))}</span>{' '}
                {section.name}
              </button>
              {/*
                Selecting the section is the point of naming it: once its notes are
                selected they can be copied to another chorus, retyped, or moved as one.
              */}
              <button
                type="button"
                className="shrink-0 border border-edge2 px-1 text-faint hover:text-fg"
                onClick={() => onSelectSection(section.tick, section.endTick, section.name)}
                title={`Select every note in "${section.name}"`}
              >
                Select
              </button>
              <button
                type="button"
                className="text-faint hover:text-danger"
                onClick={() => dispatch({ type: 'deleteEvent', tick: section.tick })}
                aria-label={`Delete section ${section.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
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
        <section className="p-3">
          <h3 className="mb-2 text-2xs uppercase tracking-widest text-muted">Other events</h3>
          <ul className="space-y-0.5">
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
        </section>
      )}
    </div>
  );
}
