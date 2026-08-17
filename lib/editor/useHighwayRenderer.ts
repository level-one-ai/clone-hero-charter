'use client';

import { useEffect, useRef } from 'react';
import { LANE_COLORS, type Note, type Project, type TrackName } from '../chart/types';
import { TimingMap } from '../chart/timing';
import type { SnapDivision } from '../chart/snap';
import { isNaturalHopo } from '../chart/noteTypes';

/**
 * Note-highway canvas renderer, styled after Moonscraper.
 *
 * Deliberately isolated from React's render cycle. Playback position lives in refs,
 * and the requestAnimationFrame loop reads them directly, so scrubbing through a song
 * never triggers a React re-render — at 60fps with a few thousand notes on screen,
 * re-rendering the tree per frame would drop frames on any machine.
 *
 * Geometry: ticks increase DOWNWARD off the top of the screen, the strike line sits
 * near the bottom, and the chart scrolls up past it — the Moonscraper convention.
 *
 * The visual language is deliberately borrowed from Guitar Hero: each note type has a
 * distinct SILHOUETTE, not just a distinct colour, so a chart stays readable in
 * peripheral vision while it scrolls. Colour is reserved entirely for lane identity;
 * every other piece of UI chrome in the app stays square and monochrome.
 */

export const HIGHWAY = {
  /** Fraction of canvas height at which the strike line sits. */
  strikeLineY: 0.82,
  // Widened once the waveform and toolbar gave vertical space back: the notes were
  // small in the middle of a lot of empty screen, and lane width is what makes a chord
  // readable at a glance while it scrolls.
  laneWidth: 76,
  noteHeight: 22,
  /** Total width of the 5 lanes. */
  get width() {
    return this.laneWidth * 5;
  },
} as const;

export interface HighwayView {
  /** Vertical zoom, in pixels per tick. */
  pixelsPerTick: number;
  snap: SnapDivision;
}

export interface HighwayInteraction {
  /** Notes being dragged, drawn at their preview position rather than committed. */
  dragPreview: Map<string, { tick: number; lane: number }> | null;
  /** Note whose sustain is being resized, with its preview length. */
  sustainPreview: { id: string; length: number } | null;
  /** Marquee selection rectangle in canvas pixels. */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Note under the cursor, for hover highlighting. */
  hoveredId: string | null;
  /** Ghost note shown where a click would place one. */
  placementGhost: { tick: number; lane: number } | null;
  /**
   * Star power phrase being drawn with the two-click tool. `endTick` follows the cursor
   * until the second click lands, so the band you are dragging out looks exactly like
   * the phrase it becomes.
   */
  starPowerPreview: { startTick: number; endTick: number } | null;
}

export interface RendererInput {
  project: Project;
  trackName: TrackName;
  timing: TimingMap;
  selection: Set<string>;
  view: HighwayView;
  interaction: HighwayInteraction;
}

/** Live playback clock, updated outside React. */
export interface PlaybackClock {
  /** Chart-time seconds at the last authoritative reading. */
  audioTime: number;
  /** performance.now() when that reading was taken. */
  wallClock: number;
  playing: boolean;
  /**
   * Playback speed. Interpolation MUST scale by this or the highway and the music come
   * apart — see currentTime.
   */
  rate: number;
  /**
   * True while the playhead is inside the lead-in silence, before the audio has started.
   * The audio element has no negative time, so this stretch is driven by the wall clock
   * alone; `audioTime` still counts in chart seconds throughout.
   */
  preRoll: boolean;
}

const COLORS = {
  background: '#0a0a0a',
  highwayNear: '#161616',
  highwayFar: '#0c0c0c',
  rail: '#3a3a3a',
  laneLine: '#232323',
  measureLine: '#5c5c5c',
  beatLine: '#333333',
  subLine: '#1e1e1e',
  strikeLine: '#f0f0f0',
  text: '#8a8a8a',
  textDim: '#5a5a5a',
  selection: '#ffffff',
  marker: '#e5e5e5',
  /** Star power is cyan everywhere in the GH/CH lineage. */
  starPower: '#7fd8ff',
  marquee: 'rgba(229, 229, 229, 0.12)',
  /** Section markers get their own colour so they read as structure, not timing. */
  section: '#c9a227',
} as const;

/** HOPO threshold: a 1/12 step, which is `resolution / 3` ticks (64 at 192). */
const HOPO_THRESHOLD_DIVISOR = 3;

export function useHighwayRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  inputRef: React.RefObject<RendererInput>,
  clockRef: React.RefObject<PlaybackClock>,
) {
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;

    let cancelled = false;

    // Resize to the element's real size times devicePixelRatio, so lines stay crisp
    // on HiDPI displays instead of being blurred by the browser's upscale.
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      return dpr;
    };

    const observer = new ResizeObserver(() => resize());
    observer.observe(canvas);

    const loop = () => {
      if (cancelled) return;
      const dpr = resize();
      const input = inputRef.current;
      const clock = clockRef.current;
      if (input && clock) {
        drawHighway(context, canvas.width, canvas.height, dpr, input, currentTime(clock));
      }
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [canvasRef, inputRef, clockRef]);
}

/**
 * Interpolate the playback position between authoritative readings.
 *
 * THE JITTER FIX: an <audio> element updates currentTime far less often than 60Hz —
 * roughly every 250ms in Chrome. Reading it directly each frame makes the highway
 * visibly stutter: it freezes, then jumps. Instead we take a reading plus a
 * performance.now() stamp, and advance by elapsed time between readings. The result is
 * smooth motion that re-anchors to the true audio clock on every update, so it cannot
 * drift.
 *
 * SCALING BY `rate` IS NOT OPTIONAL. Elapsed wall time is not elapsed song time at any
 * speed but 1×. Without it, half-speed playback ran the highway at twice the music's
 * pace for up to 250ms and then snapped back on the next reading — which read as the
 * whole editor lagging and losing sync, and was worst at exactly the slow speeds you
 * would use to chart a hard passage.
 */
export function currentTime(clock: PlaybackClock, now = performance.now()): number {
  if (!clock.playing) return clock.audioTime;
  return clock.audioTime + ((now - clock.wallClock) / 1000) * clock.rate;
}

/** A note plus everything needed to draw it, resolved once per frame. */
interface RenderNote {
  note: Note;
  /** Position to draw at — the drag preview when one is active. */
  tick: number;
  lane: number;
  length: number;
  /** True when this note plays as a HOPO (natural status, inverted by `forced`). */
  hopo: boolean;
  inStarPower: boolean;
  selected: boolean;
  hovered: boolean;
}

function drawHighway(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  input: RendererInput,
  timeSeconds: number,
): void {
  const { project, trackName, timing, selection, view, interaction } = input;
  const track = project.tracks[trackName];

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cssWidth = width / dpr;
  const cssHeight = height / dpr;

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const highwayWidth = HIGHWAY.width;
  const originX = Math.round((cssWidth - highwayWidth) / 2);
  const strikeY = Math.round(cssHeight * HIGHWAY.strikeLineY);
  const pixelsPerTick = view.pixelsPerTick;

  const playTick = timing.secToTick(timeSeconds);
  // y = strikeY - (tick - playTick) * pxPerTick, so future notes sit above the line.
  const tickToYLocal = (tick: number) => strikeY - (tick - playTick) * pixelsPerTick;
  const topTick = playTick + strikeY / pixelsPerTick;
  const bottomTick = playTick - (cssHeight - strikeY) / pixelsPerTick;

  drawHighwaySurface(ctx, originX, highwayWidth, cssHeight, strikeY);
  drawStarPowerPhrases(ctx, track.starPower, originX, highwayWidth, tickToYLocal, bottomTick, topTick);
  drawGrid(ctx, timing, view, originX, highwayWidth, tickToYLocal, bottomTick, topTick);
  drawLaneLines(ctx, originX, cssHeight);
  drawSyncMarkers(ctx, project, originX, highwayWidth, tickToYLocal, bottomTick, topTick);

  const renderNotes = resolveVisibleNotes(
    track.notes,
    track.starPower,
    project.resolution,
    bottomTick,
    topTick,
    pixelsPerTick,
    cssHeight,
    selection,
    interaction,
  );

  // Two passes: every sustain tail sits behind every head, so a later note's tail can
  // never cover an earlier note's gem.
  drawSustains(ctx, renderNotes, originX, tickToYLocal);

  if (interaction.placementGhost) {
    drawGhost(ctx, interaction.placementGhost, originX, tickToYLocal);
  }

  if (interaction.starPowerPreview) {
    drawStarPowerPreview(
      ctx,
      interaction.starPowerPreview,
      originX,
      highwayWidth,
      tickToYLocal,
    );
  }

  // Fret buttons sit under the gems so a note crossing the line reads as landing ON
  // the button, exactly as it does in game — and they light as each note arrives.
  drawFretButtons(ctx, originX, strikeY, laneGlow(renderNotes, timing, timeSeconds));
  drawStrikeLine(ctx, originX, highwayWidth, strikeY);
  drawNoteHeads(ctx, renderNotes, originX, tickToYLocal, timing, timeSeconds);

  if (interaction.marquee) {
    const { x0, y0, x1, y1 } = interaction.marquee;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    ctx.fillStyle = COLORS.marquee;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
}

// ---------------------------------------------------------------------------
// Note resolution
// ---------------------------------------------------------------------------

/**
 * Find the visible notes and resolve their draw-time properties.
 *
 * The visible window is found by binary search into the tick-sorted array. A full scan
 * per frame is fine for 200 notes and not fine for the 3000+ in a real Expert chart.
 */
function resolveVisibleNotes(
  notes: Note[],
  starPower: { tick: number; length: number }[],
  resolution: number,
  bottomTick: number,
  topTick: number,
  pixelsPerTick: number,
  cssHeight: number,
  selection: Set<string>,
  interaction: HighwayInteraction,
): RenderNote[] {
  // A long sustain can start far above the window and still be visible, so extend the
  // lower bound by a full screen height rather than clipping at bottomTick.
  const lookBehind = cssHeight / pixelsPerTick;
  const from = lowerBound(notes, bottomTick - lookBehind);
  const hopoThreshold = resolution / HOPO_THRESHOLD_DIVISOR;

  const result: RenderNote[] = [];
  for (let i = from; i < notes.length; i += 1) {
    const note = notes[i];
    if (note.tick > topTick) break;
    if (note.tick + note.length < bottomTick) continue;

    const preview = interaction.dragPreview?.get(note.id);
    const length =
      interaction.sustainPreview?.id === note.id ? interaction.sustainPreview.length : note.length;

    result.push({
      note,
      tick: preview ? preview.tick : note.tick,
      lane: preview ? preview.lane : note.lane,
      length,
      hopo: isHopo(notes, i, hopoThreshold),
      inStarPower: isInStarPower(starPower, note.tick),
      selected: selection.has(note.id),
      hovered: interaction.hoveredId === note.id,
    });
  }
  return result;
}

/**
 * Does this note play as a HOPO?
 *
 * The .chart format does not store HOPO status — it is DERIVED, and the `forced` flag
 * inverts whatever the derivation says. The rules Clone Hero applies:
 *
 *   - a chord (more than one note on the same tick) is never a natural HOPO
 *   - a single note within the HOPO threshold of the previous note, on a different
 *     fret, is a natural HOPO
 *   - `forced` flips that result either way
 *
 * Drawing the derived status rather than just the `forced` flag is what makes the gem
 * shapes actually informative: the charter sees what the note will DO in game, not
 * which flag happens to be set on it.
 */
export function isHopo(notes: Note[], index: number, threshold: number): boolean {
  const note = notes[index];
  if (note.lane === 7) return note.forced; // open notes have no natural HOPO status

  /**
   * The derivation itself lives in lib/chart/noteTypes.ts and is shared with the
   * conversion tools. It used to be duplicated here, and the two copies disagreed about a
   * note following a chord — so "make this a hammer-on" set `forced` against one rule
   * while the highway drew the note against the other, and the note rendered as a strum.
   *
   * The threshold is passed in as ticks and converted back to the resolution the shared
   * function expects, so the two cannot drift apart again.
   */
  const natural = isNaturalHopo(notes, index, threshold * HOPO_THRESHOLD_DIVISOR);
  return note.forced ? !natural : natural;
}

function isInStarPower(phrases: { tick: number; length: number }[], tick: number): boolean {
  // Phrases are tick-sorted and few, so a linear scan with an early break beats the
  // overhead of a binary search here.
  for (const phrase of phrases) {
    if (phrase.tick > tick) return false;
    if (tick < phrase.tick + phrase.length) return true;
  }
  return false;
}

function lowerBound(notes: Note[], tick: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Highway surface
// ---------------------------------------------------------------------------

/**
 * The highway itself: a vertical gradient darkening toward the top, plus side rails.
 *
 * This fakes depth without true perspective projection. Real perspective would mean
 * notes changing size as they approach, which makes precise tick placement harder to
 * judge — the wrong trade for an editor, however good it looks in a game.
 */
function drawHighwaySurface(
  ctx: CanvasRenderingContext2D,
  originX: number,
  highwayWidth: number,
  cssHeight: number,
  strikeY: number,
): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, cssHeight);
  gradient.addColorStop(0, COLORS.highwayFar);
  gradient.addColorStop(Math.min(0.999, strikeY / cssHeight), COLORS.highwayNear);
  gradient.addColorStop(1, COLORS.highwayFar);
  ctx.fillStyle = gradient;
  ctx.fillRect(originX, 0, highwayWidth, cssHeight);

  // Side rails, brightest at the strike line and fading into the distance.
  for (const x of [originX, originX + highwayWidth]) {
    const rail = ctx.createLinearGradient(0, 0, 0, cssHeight);
    rail.addColorStop(0, 'rgba(58, 58, 58, 0)');
    rail.addColorStop(Math.min(0.999, strikeY / cssHeight), COLORS.rail);
    rail.addColorStop(1, 'rgba(58, 58, 58, 0.25)');
    ctx.fillStyle = rail;
    ctx.fillRect(Math.round(x) - 1, 0, 2, cssHeight);
  }
}

function drawLaneLines(ctx: CanvasRenderingContext2D, originX: number, cssHeight: number): void {
  ctx.strokeStyle = COLORS.laneLine;
  ctx.lineWidth = 1;
  // Interior dividers only — the outer edges are drawn as rails.
  for (let lane = 1; lane < 5; lane += 1) {
    const x = Math.round(originX + lane * HIGHWAY.laneWidth) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  timing: TimingMap,
  view: HighwayView,
  originX: number,
  highwayWidth: number,
  tickToYLocal: (tick: number) => number,
  bottomTick: number,
  topTick: number,
): void {
  // Sub-gridlines follow the snap setting, so the visible grid always matches where a
  // click will actually place a note.
  const subdivisions = view.snap === 0 ? 1 : Math.max(1, view.snap / 4);
  const lines = timing.gridLines(Math.max(0, bottomTick), topTick, subdivisions);

  for (const line of lines) {
    const y = Math.round(tickToYLocal(line.tick)) + 0.5;
    // Three clearly separated tiers: measures dominate beats, beats dominate
    // subdivisions. Without that hierarchy the grid reads as noise at high zoom.
    if (line.kind === 'measure') {
      ctx.strokeStyle = COLORS.measureLine;
      ctx.lineWidth = 2;
    } else if (line.kind === 'beat') {
      ctx.strokeStyle = COLORS.beatLine;
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = COLORS.subLine;
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + highwayWidth, y);
    ctx.stroke();

    if (line.kind === 'measure') {
      ctx.fillStyle = COLORS.text;
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(line.measureNumber + 1), originX - 10, y + 4);
      ctx.textAlign = 'left';
    }
  }
  ctx.lineWidth = 1;
}

function drawStarPowerPhrases(
  ctx: CanvasRenderingContext2D,
  phrases: { tick: number; length: number }[],
  originX: number,
  highwayWidth: number,
  tickToYLocal: (tick: number) => number,
  bottomTick: number,
  topTick: number,
): void {
  for (const phrase of phrases) {
    if (phrase.tick > topTick || phrase.tick + phrase.length < bottomTick) continue;
    const yTop = tickToYLocal(phrase.tick + phrase.length);
    const yBottom = tickToYLocal(phrase.tick);

    ctx.fillStyle = 'rgba(127, 216, 255, 0.07)';
    ctx.fillRect(originX, yTop, highwayWidth, yBottom - yTop);

    // Defined start and end edges, so the phrase boundary is unambiguous when several
    // phrases sit close together.
    ctx.strokeStyle = 'rgba(127, 216, 255, 0.5)';
    ctx.lineWidth = 1;
    for (const y of [yTop, yBottom]) {
      ctx.beginPath();
      ctx.moveTo(originX, Math.round(y) + 0.5);
      ctx.lineTo(originX + highwayWidth, Math.round(y) + 0.5);
      ctx.stroke();
    }
  }
}

/**
 * The phrase being defined by the two-click star power tool.
 *
 * Deliberately brighter than a committed phrase and dashed at the edges: while the tool
 * is armed you need to tell at a glance which band is live and which are already part of
 * the chart.
 */
function drawStarPowerPreview(
  ctx: CanvasRenderingContext2D,
  preview: { startTick: number; endTick: number },
  originX: number,
  highwayWidth: number,
  tickToYLocal: (tick: number) => number,
): void {
  const lowTick = Math.min(preview.startTick, preview.endTick);
  const highTick = Math.max(preview.startTick, preview.endTick);
  const yTop = tickToYLocal(highTick);
  const yBottom = tickToYLocal(lowTick);

  ctx.fillStyle = 'rgba(127, 216, 255, 0.16)';
  ctx.fillRect(originX, yTop, highwayWidth, yBottom - yTop);

  ctx.save();
  ctx.strokeStyle = COLORS.starPower;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  for (const y of [yTop, yBottom]) {
    ctx.beginPath();
    ctx.moveTo(originX, Math.round(y) + 0.5);
    ctx.lineTo(originX + highwayWidth, Math.round(y) + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSyncMarkers(
  ctx: CanvasRenderingContext2D,
  project: Project,
  originX: number,
  highwayWidth: number,
  tickToYLocal: (tick: number) => number,
  bottomTick: number,
  topTick: number,
): void {
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';

  for (const bpm of project.sync.bpms) {
    if (bpm.tick < bottomTick || bpm.tick > topTick) continue;
    const y = Math.round(tickToYLocal(bpm.tick)) + 0.5;
    ctx.strokeStyle = COLORS.marker;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + highwayWidth, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.marker;
    ctx.fillText(formatBpm(bpm.bpm), originX + highwayWidth + 10, y + 4);
  }

  for (const ts of project.sync.timeSignatures) {
    if (ts.tick < bottomTick || ts.tick > topTick) continue;
    const y = Math.round(tickToYLocal(ts.tick)) + 0.5;
    ctx.fillStyle = COLORS.textDim;
    ctx.fillText(`${ts.numerator}/${ts.denominator}`, originX + highwayWidth + 62, y + 4);
  }

  // Section names, in the left gutter beside the measure numbers. Drawn as a solid
  // line across the highway because a section boundary is a structural landmark — it
  // should read at a glance while scrolling, unlike the dashed tempo markers.
  for (const event of project.events) {
    if (event.tick < bottomTick || event.tick > topTick) continue;
    if (!event.text.startsWith('section ')) continue;
    const y = Math.round(tickToYLocal(event.tick)) + 0.5;

    ctx.strokeStyle = COLORS.section;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + highwayWidth, y);
    ctx.stroke();
    ctx.lineWidth = 1;

    ctx.fillStyle = COLORS.section;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(event.text.slice('section '.length), originX - 34, y - 5);
    ctx.textAlign = 'left';
    ctx.font = '11px ui-monospace, monospace';
  }
}

/**
 * Fret buttons on the strike line — five rimmed circles in the lane colours.
 *
 * This is the single detail that makes the view read as a game highway rather than a
 * spreadsheet grid, and it gives the eye a fixed colour reference for which lane is
 * which without needing to read the labels.
 */
/**
 * How long a fret button stays lit after a note lands on it, in seconds.
 *
 * Long enough to register at a glance, short enough that a fast run still reads as
 * separate hits rather than one continuous glow.
 */
const GLOW_DECAY_SEC = 0.18;
/** Lit slightly BEFORE the note lands, so the flash reads as anticipation, not lag. */
const GLOW_LEAD_SEC = 0.03;

/**
 * Per-lane glow, 0-1, for the fret buttons.
 *
 * Stateless: intensity is derived from how far the playhead is from each note rather than
 * from a decaying value carried between frames. That means it is correct when scrubbing
 * backwards, when paused, and at any playback rate — a stored decay would need resetting
 * on every seek and would be wrong at 0.25×.
 *
 * A sustain keeps its lane lit for its whole length, exactly as the game holds the button
 * down.
 */
export function laneGlow(
  notes: RenderNote[],
  timing: TimingMap,
  timeSeconds: number,
): LaneGlow {
  const glow = [0, 0, 0, 0, 0];
  let open = 0;

  for (const item of notes) {
    const start = timing.tickToSec(item.tick);
    const end = item.length > 0 ? timing.tickToSec(item.tick + item.length) : start;

    let intensity = 0;
    if (timeSeconds >= start - GLOW_LEAD_SEC && timeSeconds <= end) {
      intensity = 1; // on the note, or held through its sustain
    } else if (timeSeconds > end && timeSeconds - end < GLOW_DECAY_SEC) {
      intensity = 1 - (timeSeconds - end) / GLOW_DECAY_SEC;
    }
    if (intensity <= 0) continue;

    /**
     * An open note is tracked SEPARATELY rather than lighting all five lanes.
     *
     * It used to raise every lane's glow to 70%, which drew as five colours brightening
     * at once — indistinguishable at a glance from a five-note chord, and saying nothing
     * about which note actually crossed the line. Kept apart, the buttons can flood purple
     * instead, which is unambiguous: purple is the open note's colour everywhere else in
     * the editor, and no fret note can produce it.
     */
    if (item.lane === 7) {
      open = Math.max(open, intensity);
    } else if (item.lane >= 0 && item.lane <= 4) {
      glow[item.lane] = Math.max(glow[item.lane], intensity);
    }
  }

  return { lanes: glow, open };
}

/** Per-lane fret-button glow, plus the open-note glow that overrides all five. */
export interface LaneGlow {
  lanes: number[];
  open: number;
}

/**
 * The five fret buttons at the strike line.
 *
 * Drawn with the SAME silhouette as a note gem rather than as rings: a note landing on
 * its button should look like the note arriving home, which is what makes Clone Hero
 * readable at speed. They light in their lane colour as each note crosses.
 */
function drawFretButtons(
  ctx: CanvasRenderingContext2D,
  originX: number,
  strikeY: number,
  glow: LaneGlow,
): void {
  const w = HIGHWAY.laneWidth - 18;
  const h = HIGHWAY.noteHeight;

  for (let lane = 0; lane < 5; lane += 1) {
    const centerX = originX + lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
    /**
     * An open note crossing the line turns the whole row PURPLE.
     *
     * That is the registration signal: purple is the open note's colour throughout the
     * editor, and no combination of fret notes can produce it, so a purple row means
     * "the open note landed" and nothing else. It overrides the lane colour outright
     * rather than blending, because a blend of five lane colours with purple reads as
     * mud at the speed this is actually watched.
     */
    const openLit = glow.open;
    const color = openLit > 0 ? LANE_COLORS[7] : LANE_COLORS[lane];
    const lit = Math.max(glow.lanes[lane] ?? 0, openLit);

    const x = centerX - w / 2;
    const top = strikeY - h / 2;

    // Body: dark when idle so gems landing on it stay legible, flooding with the lane
    // colour as it lights.
    roundRect(ctx, x, top, w, h, 5);
    ctx.fillStyle = lit > 0 ? withAlpha(color, 0.18 + lit * 0.72) : 'rgba(10, 10, 10, 0.55)';
    ctx.fill();

    ctx.lineWidth = lit > 0 ? 2 + lit : 2;
    ctx.strokeStyle = withAlpha(color, 0.5 + lit * 0.5);
    ctx.stroke();

    // A struck button throws light onto the highway around it, the way the game does.
    if (lit > 0.05) {
      ctx.save();
      ctx.globalAlpha = lit * 0.5;
      ctx.shadowColor = color;
      ctx.shadowBlur = 16 * lit;
      roundRect(ctx, x, top, w, h, 5);
      ctx.strokeStyle = withAlpha(color, 0.9);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.lineWidth = 1;
}

/**
 * The strike line — now only the stubs OUTSIDE the fret buttons.
 *
 * A white rule used to run the full width of the highway, straight across all five
 * buttons. It sat on top of every gem at the moment of the hit, which is the one moment
 * the gem most needs to be readable, and it competed with the open note (a bar in the
 * same place, in the same orientation) badly enough that the two were hard to tell apart.
 *
 * The buttons themselves already mark where the line is; they are the row of five, and
 * their tops and bottoms define it more clearly than a stroke through them. So the line is
 * kept only as short stubs at either edge, which give the eye the horizontal it needs to
 * judge approach without putting anything over the notes.
 */
function drawStrikeLine(
  ctx: CanvasRenderingContext2D,
  originX: number,
  highwayWidth: number,
  strikeY: number,
): void {
  ctx.strokeStyle = COLORS.strikeLine;
  ctx.lineWidth = 2;
  const stub = 14;
  ctx.beginPath();
  ctx.moveTo(originX - stub, strikeY);
  ctx.lineTo(originX + 2, strikeY);
  ctx.moveTo(originX + highwayWidth - 2, strikeY);
  ctx.lineTo(originX + highwayWidth + stub, strikeY);
  ctx.stroke();
  ctx.lineWidth = 1;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function drawSustains(
  ctx: CanvasRenderingContext2D,
  notes: RenderNote[],
  originX: number,
  tickToYLocal: (tick: number) => number,
): void {
  for (const item of notes) {
    if (item.length <= 0) continue;

    const yBottom = tickToYLocal(item.tick);
    const yTop = tickToYLocal(item.tick + item.length);
    const height = yBottom - yTop;
    const color = item.inStarPower ? COLORS.starPower : (LANE_COLORS[item.lane] ?? '#888888');

    if (item.lane === 7) {
      // Open sustains span the highway, drawn dimmer so they do not overpower the
      // fret sustains that may sit on top of them.
      ctx.fillStyle = withAlpha(color, item.selected ? 0.5 : 0.3);
      ctx.fillRect(originX + 3, yTop, HIGHWAY.width - 6, height);
      continue;
    }

    const centerX = originX + item.lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
    const trailWidth = 12;

    // Body, then a brighter core line down the middle. The core is what keeps a long
    // sustain legible against the lane gridlines showing through it.
    ctx.fillStyle = withAlpha(color, item.selected ? 0.85 : 0.55);
    roundRect(ctx, centerX - trailWidth / 2, yTop, trailWidth, height, 3);
    ctx.fill();

    ctx.fillStyle = withAlpha('#ffffff', 0.22);
    ctx.fillRect(centerX - 1.5, yTop, 3, height);
  }
}

function drawNoteHeads(
  ctx: CanvasRenderingContext2D,
  notes: RenderNote[],
  originX: number,
  tickToYLocal: (tick: number) => number,
  timing: TimingMap,
  timeSeconds: number,
): void {
  for (const item of notes) {
    const y = tickToYLocal(item.tick);
    const baseColor = LANE_COLORS[item.lane] ?? '#888888';
    const color = item.inStarPower ? COLORS.starPower : baseColor;

    // Highlight notes crossing the strike line. A ±40ms window is roughly Clone
    // Hero's hit window, so the flash reads as "this is the note you just heard".
    const isHit = Math.abs(timing.tickToSec(item.tick) - timeSeconds) < 0.04;

    if (item.lane === 7) {
      drawOpenNote(ctx, originX, y, color, item, isHit);
      continue;
    }

    const centerX = originX + item.lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
    if (item.note.tap) drawTapGem(ctx, centerX, y, color, item, isHit);
    else if (item.hopo) drawHopoGem(ctx, centerX, y, color, item, isHit);
    else drawStrumGem(ctx, centerX, y, color, item, isHit);
  }
}

/**
 * Strum note: the full-size gem. Widest silhouette of the three, so it reads as the
 * "default" note and the others are recognisable as departures from it.
 */
function drawStrumGem(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  y: number,
  color: string,
  item: RenderNote,
  isHit: boolean,
): void {
  const w = HIGHWAY.laneWidth - 18;
  const h = HIGHWAY.noteHeight;
  const x = centerX - w / 2;
  const top = y - h / 2;

  gemBody(ctx, x, top, w, h, 5, color, isHit);
  gemOutline(ctx, x, top, w, h, 5, color, item);
}

/**
 * HOPO note: a slimmer, rounder pill with a bright core. Deliberately a different
 * silhouette rather than merely a different shade — at speed, shape is far easier to
 * read than colour, and mistaking a HOPO for a strum changes how the part is played.
 */
function drawHopoGem(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  y: number,
  color: string,
  item: RenderNote,
  isHit: boolean,
): void {
  const w = HIGHWAY.laneWidth - 30;
  const h = HIGHWAY.noteHeight - 2;
  const x = centerX - w / 2;
  const top = y - h / 2;
  const radius = h / 2;

  gemBody(ctx, x, top, w, h, radius, color, isHit);

  // Bright inner core, the visual cue that this note does not need a strum.
  ctx.fillStyle = withAlpha('#ffffff', isHit ? 0.95 : 0.7);
  roundRect(ctx, x + w / 2 - 2.5, top + 4, 5, h - 8, 2.5);
  ctx.fill();

  gemOutline(ctx, x, top, w, h, radius, color, item);
}

/**
 * Tap note: a wide, flat bar — the GH "no strum at all" shape.
 *
 * Three silhouettes have to be separable at scroll speed, and the tap is the one most
 * easily confused with the HOPO, since both are smaller than a strum gem. So they differ
 * along two axes at once: the HOPO is NARROW and TALL with a vertical core, the tap is
 * WIDE and FLAT with a horizontal one. Even at a glance, the direction of the white mark
 * inside the gem tells them apart.
 */
function drawTapGem(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  y: number,
  color: string,
  item: RenderNote,
  isHit: boolean,
): void {
  const w = HIGHWAY.laneWidth - 8;
  const h = 8;
  const x = centerX - w / 2;
  const top = y - h / 2;

  gemBody(ctx, x, top, w, h, 4, color, isHit);
  // Full-width bright bar: the horizontal counterpart to the HOPO's vertical core.
  ctx.fillStyle = withAlpha('#ffffff', isHit ? 0.95 : 0.75);
  ctx.fillRect(x + 3, y - 1.5, w - 6, 3);
  gemOutline(ctx, x, top, w, h, 4, color, item);
}

/**
 * Open note: a bar across the whole highway, lit around its edges.
 *
 * The glow is not decoration. An open note is a rectangle spanning the highway, and so is
 * a barline, a star-power boundary and — before this change — the strike line. Flat, it
 * was one horizontal among several. The outer bloom in its own purple gives it depth
 * nothing else on the highway has, so it reads as a note at a glance rather than as
 * another piece of grid.
 */
function drawOpenNote(
  ctx: CanvasRenderingContext2D,
  originX: number,
  y: number,
  color: string,
  item: RenderNote,
  isHit: boolean,
): void {
  const h = HIGHWAY.noteHeight - 4;
  const x = originX + 3;
  const w = HIGHWAY.width - 6;
  const top = y - h / 2;

  // Bloom first, underneath the body, so the body's own edges stay crisp on top of it.
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = isHit ? 22 : 12;
  ctx.globalAlpha = isHit ? 0.95 : 0.6;
  roundRect(ctx, x, top, w, h, 3);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  gemBody(ctx, x, top, w, h, 3, color, isHit);

  // A brighter inner rim, which is what makes the edge itself look lit rather than
  // merely surrounded by light.
  roundRect(ctx, x + 1.5, top + 1.5, w - 3, h - 3, 2);
  ctx.strokeStyle = withAlpha('#ffffff', isHit ? 0.85 : 0.45);
  ctx.lineWidth = 1;
  ctx.stroke();

  gemOutline(ctx, x, top, w, h, 3, color, item);
}

/** Shared gem fill: body, top shine, bottom shade. */
function gemBody(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: string,
  isHit: boolean,
): void {
  roundRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = isHit ? '#ffffff' : color;
  ctx.fill();

  // A light top edge and a dark bottom edge read as a bevel, which is what gives the
  // gem physical presence without an expensive per-note gradient.
  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.fillStyle = withAlpha('#ffffff', 0.28);
  ctx.fillRect(x, y, w, Math.max(2, h * 0.3));
  ctx.fillStyle = withAlpha('#000000', 0.25);
  ctx.fillRect(x, y + h - Math.max(2, h * 0.25), w, Math.max(2, h * 0.25));
  ctx.restore();
}

/** Shared gem rim, plus the selection and hover states. */
function gemOutline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: string,
  item: RenderNote,
): void {
  // Every gem gets a dark rim so adjacent notes in a chord stay separable.
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius);
  ctx.strokeStyle = item.inStarPower ? withAlpha('#ffffff', 0.7) : shade(color, -0.45);
  ctx.lineWidth = 1;
  ctx.stroke();

  if (item.selected || item.hovered) {
    roundRect(ctx, x - 2, y - 2, w + 4, h + 4, radius + 2);
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = item.selected ? 2 : 1;
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

function drawGhost(
  ctx: CanvasRenderingContext2D,
  ghost: { tick: number; lane: number },
  originX: number,
  tickToYLocal: (tick: number) => number,
): void {
  const y = tickToYLocal(ghost.tick);
  const color = LANE_COLORS[ghost.lane] ?? '#888888';
  ctx.globalAlpha = 0.35;
  if (ghost.lane === 7) {
    const h = HIGHWAY.noteHeight - 4;
    roundRect(ctx, originX + 3, y - h / 2, HIGHWAY.width - 6, h, 3);
  } else {
    const centerX = originX + ghost.lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
    const w = HIGHWAY.laneWidth - 18;
    roundRect(ctx, centerX - w / 2, y - HIGHWAY.noteHeight / 2, w, HIGHWAY.noteHeight, 5);
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/** Path a rounded rectangle. Falls back to a manual path where roundRect is missing. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Lighten (amount > 0) or darken (amount < 0) a hex colour. */
function shade(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  const mix = (channel: number) =>
    Math.round(amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function formatBpm(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Hit testing — shared by the canvas pointer handlers
// ---------------------------------------------------------------------------

export interface HitTestContext {
  cssHeight: number;
  cssWidth: number;
  pixelsPerTick: number;
  playTick: number;
}

/** Canvas y -> tick. The inverse of the renderer's tickToY. */
export function yToTick(y: number, ctx: HitTestContext): number {
  const strikeY = ctx.cssHeight * HIGHWAY.strikeLineY;
  return ctx.playTick + (strikeY - y) / ctx.pixelsPerTick;
}

/** Tick -> canvas y. */
export function tickToY(tick: number, ctx: HitTestContext): number {
  const strikeY = ctx.cssHeight * HIGHWAY.strikeLineY;
  return strikeY - (tick - ctx.playTick) * ctx.pixelsPerTick;
}

/** Canvas x -> lane index, or null when outside the highway. */
export function xToLane(x: number, ctx: HitTestContext): number | null {
  const originX = (ctx.cssWidth - HIGHWAY.width) / 2;
  const lane = Math.floor((x - originX) / HIGHWAY.laneWidth);
  return lane >= 0 && lane <= 4 ? lane : null;
}

export function laneToX(lane: number, ctx: HitTestContext): number {
  const originX = (ctx.cssWidth - HIGHWAY.width) / 2;
  return originX + lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
}

/** How close to a sustain's end counts as grabbing the resize handle, in pixels. */
export const SUSTAIN_HANDLE_PX = 10;

/**
 * Band at the top of a note head that starts a sustain drag, in pixels.
 *
 * Kept to a third of the head so the rest of it still selects and drags the note — the
 * common action must stay the easy one.
 */
export const SUSTAIN_GRAB_PX = 7;

export interface HitResult {
  note: Note;
  /** True when the pointer is on the tail end, i.e. a sustain drag rather than a move. */
  onSustainHandle: boolean;
}

/**
 * Find the note under a pointer position.
 *
 * Iterates newest-first so that when notes overlap, the one drawn on top is the one
 * you grab — matching what the user sees.
 */
export function hitTestNote(
  notes: Note[],
  x: number,
  y: number,
  ctx: HitTestContext,
): HitResult | null {
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i];
    const noteY = tickToY(note.tick, ctx);
    const halfHeight = HIGHWAY.noteHeight / 2 + 3;

    const originX = (ctx.cssWidth - HIGHWAY.width) / 2;
    const centerX = note.lane === 7 ? ctx.cssWidth / 2 : laneToX(note.lane, ctx);
    const withinHeadX =
      note.lane === 7
        ? x >= originX && x <= originX + HIGHWAY.width
        : Math.abs(x - centerX) <= (HIGHWAY.laneWidth - 18) / 2 + 4;

    if (withinHeadX && Math.abs(y - noteY) <= halfHeight) {
      /**
       * The TOP edge of the head starts a sustain, on any note.
       *
       * Ticks grow upward, so a sustain extends up from the head — which means the top
       * edge is where you would instinctively pull it from. Without this a note with no
       * sustain had nothing to grab at all: the only handle was the end of a tail that
       * did not exist yet, so sustains could only be lengthened, never started.
       */
      if (y <= noteY - halfHeight + SUSTAIN_GRAB_PX) {
        return { note, onSustainHandle: true };
      }
      return { note, onSustainHandle: false };
    }

    // Sustain tail: grabbing near its far end resizes instead of moving.
    if (note.length > 0) {
      const tailY = tickToY(note.tick + note.length, ctx);
      const withinX =
        note.lane === 7
          ? Math.abs(x - centerX) <= HIGHWAY.width / 2
          : Math.abs(x - centerX) <= 10;
      if (withinX && Math.abs(y - tailY) <= SUSTAIN_HANDLE_PX) {
        return { note, onSustainHandle: true };
      }
      if (withinX && y > tailY && y < noteY) {
        return { note, onSustainHandle: false };
      }
    }
  }
  return null;
}
