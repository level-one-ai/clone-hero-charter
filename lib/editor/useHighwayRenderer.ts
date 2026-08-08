'use client';

import { useEffect, useRef } from 'react';
import { LANE_COLORS, type Note, type Project, type TrackName } from '../chart/types';
import { TimingMap } from '../chart/timing';
import type { SnapDivision } from '../chart/snap';

/**
 * Note-highway canvas renderer.
 *
 * Deliberately isolated from React's render cycle. Playback position lives in refs,
 * and the requestAnimationFrame loop reads them directly, so scrubbing through a song
 * never triggers a React re-render — at 60fps with a few thousand notes on screen,
 * re-rendering the tree per frame would drop frames on any machine.
 *
 * Geometry: ticks increase DOWNWARD off the top of the screen, the strike line sits
 * near the bottom, and the chart scrolls up past it — the Moonscraper convention.
 */

export const HIGHWAY = {
  /** Fraction of canvas height at which the strike line sits. */
  strikeLineY: 0.82,
  laneWidth: 56,
  noteHeight: 16,
  /** Total width of the 5 lanes plus padding. */
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
}

const COLORS = {
  background: '#0a0a0a',
  highway: '#101010',
  laneLine: '#242424',
  measureLine: '#4a4a4a',
  beatLine: '#2e2e2e',
  subLine: '#1c1c1c',
  strikeLine: '#e5e5e5',
  text: '#8a8a8a',
  selection: '#ffffff',
  marker: '#e5e5e5',
  starPower: 'rgba(120, 190, 255, 0.10)',
  marquee: 'rgba(229, 229, 229, 0.12)',
  marqueeEdge: '#e5e5e5',
} as const;

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
 * performance.now() stamp, and advance by real elapsed time between readings. The
 * result is smooth motion that re-anchors to the true audio clock on every update, so
 * it cannot drift.
 */
export function currentTime(clock: PlaybackClock): number {
  if (!clock.playing) return clock.audioTime;
  return clock.audioTime + (performance.now() - clock.wallClock) / 1000;
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
  const tickToY = (tick: number) => strikeY - (tick - playTick) * pixelsPerTick;
  const topTick = playTick + strikeY / pixelsPerTick;
  const bottomTick = playTick - (cssHeight - strikeY) / pixelsPerTick;

  ctx.fillStyle = COLORS.highway;
  ctx.fillRect(originX, 0, highwayWidth, cssHeight);

  drawStarPower(ctx, track.starPower, originX, highwayWidth, tickToY, bottomTick, topTick);
  drawGrid(ctx, timing, view, originX, highwayWidth, tickToY, bottomTick, topTick, cssWidth);
  drawLaneLines(ctx, originX, cssHeight);
  drawSyncMarkers(ctx, project, originX, highwayWidth, tickToY, bottomTick, topTick);

  // Notes are drawn in two passes so every sustain tail sits behind every head,
  // rather than a later note's tail covering an earlier note's head.
  const visible = visibleNotes(track.notes, bottomTick, topTick, pixelsPerTick, cssHeight);
  drawSustains(ctx, visible, originX, selection, interaction, tickToY, pixelsPerTick);

  if (interaction.placementGhost) {
    drawGhost(ctx, interaction.placementGhost, originX, tickToY);
  }

  drawNoteHeads(ctx, visible, originX, selection, interaction, tickToY, timing, timeSeconds);
  drawStrikeLine(ctx, originX, highwayWidth, strikeY, cssWidth);

  if (interaction.marquee) {
    const { x0, y0, x1, y1 } = interaction.marquee;
    ctx.fillStyle = COLORS.marquee;
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeStyle = COLORS.marqueeEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.min(x0, x1) + 0.5,
      Math.min(y0, y1) + 0.5,
      Math.abs(x1 - x0),
      Math.abs(y1 - y0),
    );
  }
}

/**
 * Binary-search the tick-sorted note array for the visible window.
 * A full scan per frame would be O(notes) at 60fps — fine for 200 notes, not for the
 * 3000+ in a real Expert chart, especially with several difficulties loaded.
 */
function visibleNotes(
  notes: Note[],
  bottomTick: number,
  topTick: number,
  pixelsPerTick: number,
  cssHeight: number,
): Note[] {
  // A long sustain can start far above the window and still be visible, so extend the
  // lower bound by the tallest plausible tail rather than clipping at bottomTick.
  const lookBehind = cssHeight / pixelsPerTick;
  const from = lowerBound(notes, bottomTick - lookBehind);
  const result: Note[] = [];
  for (let i = from; i < notes.length; i += 1) {
    const note = notes[i];
    if (note.tick > topTick) break;
    if (note.tick + note.length >= bottomTick) result.push(note);
  }
  return result;
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

function drawGrid(
  ctx: CanvasRenderingContext2D,
  timing: TimingMap,
  view: HighwayView,
  originX: number,
  highwayWidth: number,
  tickToY: (tick: number) => number,
  bottomTick: number,
  topTick: number,
  cssWidth: number,
): void {
  // Sub-gridlines follow the snap setting, so the visible grid always matches where
  // a click will actually place a note.
  const subdivisions = view.snap === 0 ? 1 : Math.max(1, view.snap / 4);
  const lines = timing.gridLines(Math.max(0, bottomTick), topTick, subdivisions);

  ctx.lineWidth = 1;
  for (const line of lines) {
    const y = Math.round(tickToY(line.tick)) + 0.5;
    ctx.strokeStyle =
      line.kind === 'measure'
        ? COLORS.measureLine
        : line.kind === 'beat'
          ? COLORS.beatLine
          : COLORS.subLine;
    ctx.beginPath();
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + highwayWidth, y);
    ctx.stroke();

    if (line.kind === 'measure') {
      ctx.fillStyle = COLORS.text;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(line.measureNumber + 1), originX - 8, y + 3);
      ctx.textAlign = 'left';
    }
  }
  void cssWidth;
}

function drawLaneLines(ctx: CanvasRenderingContext2D, originX: number, cssHeight: number): void {
  ctx.strokeStyle = COLORS.laneLine;
  ctx.lineWidth = 1;
  for (let lane = 0; lane <= 5; lane += 1) {
    const x = Math.round(originX + lane * HIGHWAY.laneWidth) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();
  }
}

function drawStarPower(
  ctx: CanvasRenderingContext2D,
  phrases: { tick: number; length: number }[],
  originX: number,
  highwayWidth: number,
  tickToY: (tick: number) => number,
  bottomTick: number,
  topTick: number,
): void {
  ctx.fillStyle = COLORS.starPower;
  for (const phrase of phrases) {
    if (phrase.tick > topTick || phrase.tick + phrase.length < bottomTick) continue;
    const yTop = tickToY(phrase.tick + phrase.length);
    const yBottom = tickToY(phrase.tick);
    ctx.fillRect(originX, yTop, highwayWidth, yBottom - yTop);
  }
}

function drawSyncMarkers(
  ctx: CanvasRenderingContext2D,
  project: Project,
  originX: number,
  highwayWidth: number,
  tickToY: (tick: number) => number,
  bottomTick: number,
  topTick: number,
): void {
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';

  for (const bpm of project.sync.bpms) {
    if (bpm.tick < bottomTick || bpm.tick > topTick) continue;
    const y = Math.round(tickToY(bpm.tick)) + 0.5;
    ctx.strokeStyle = COLORS.marker;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + highwayWidth, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.marker;
    ctx.fillText(`${formatBpm(bpm.bpm)}`, originX + highwayWidth + 8, y + 3);
  }

  for (const ts of project.sync.timeSignatures) {
    if (ts.tick < bottomTick || ts.tick > topTick) continue;
    const y = Math.round(tickToY(ts.tick)) + 0.5;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${ts.numerator}/${ts.denominator}`, originX + highwayWidth + 54, y + 3);
  }
}

function drawSustains(
  ctx: CanvasRenderingContext2D,
  notes: Note[],
  originX: number,
  selection: Set<string>,
  interaction: HighwayInteraction,
  tickToY: (tick: number) => number,
  pixelsPerTick: number,
): void {
  for (const note of notes) {
    const preview = interaction.dragPreview?.get(note.id);
    const tick = preview ? preview.tick : note.tick;
    const lane = preview ? preview.lane : note.lane;
    const length =
      interaction.sustainPreview?.id === note.id ? interaction.sustainPreview.length : note.length;
    if (length <= 0) continue;

    const yBottom = tickToY(tick);
    const yTop = tickToY(tick + length);
    const color = LANE_COLORS[lane] ?? '#888888';

    if (lane === 7) {
      ctx.fillStyle = withAlpha(color, selection.has(note.id) ? 0.85 : 0.55);
      ctx.fillRect(originX + 2, yTop, HIGHWAY.width - 4, yBottom - yTop);
    } else {
      const centerX = originX + lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
      const tailWidth = 10;
      ctx.fillStyle = withAlpha(color, selection.has(note.id) ? 0.9 : 0.6);
      ctx.fillRect(centerX - tailWidth / 2, yTop, tailWidth, yBottom - yTop);
    }
  }
  void pixelsPerTick;
}

function drawNoteHeads(
  ctx: CanvasRenderingContext2D,
  notes: Note[],
  originX: number,
  selection: Set<string>,
  interaction: HighwayInteraction,
  tickToY: (tick: number) => number,
  timing: TimingMap,
  timeSeconds: number,
): void {
  for (const note of notes) {
    const preview = interaction.dragPreview?.get(note.id);
    const tick = preview ? preview.tick : note.tick;
    const lane = preview ? preview.lane : note.lane;
    const y = tickToY(tick);
    const color = LANE_COLORS[lane] ?? '#888888';
    const isSelected = selection.has(note.id);
    const isHovered = interaction.hoveredId === note.id;

    // Highlight notes crossing the strike line. A ±40ms window is roughly Clone
    // Hero's hit window, so the flash reads as "this is the note you just heard".
    const noteSeconds = timing.tickToSec(tick);
    const isHit = Math.abs(noteSeconds - timeSeconds) < 0.04;

    if (lane === 7) {
      // Open notes span the full highway.
      const height = HIGHWAY.noteHeight * 0.7;
      ctx.fillStyle = isHit ? '#ffffff' : color;
      ctx.fillRect(originX + 2, y - height / 2, HIGHWAY.width - 4, height);
      if (isSelected || isHovered) {
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(originX + 2, y - height / 2, HIGHWAY.width - 4, height);
      }
      continue;
    }

    const centerX = originX + lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
    const w = HIGHWAY.laneWidth - 16;
    const h = HIGHWAY.noteHeight;
    const x = centerX - w / 2;
    const top = y - h / 2;

    ctx.fillStyle = isHit ? '#ffffff' : color;
    ctx.fillRect(x, top, w, h);

    // Tap notes read as hollow, forced notes carry a centre bar — both are visual
    // conventions charters already know from Moonscraper.
    if (note.tap) {
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(x + 3, top + 3, w - 6, h - 6);
      ctx.fillStyle = isHit ? '#ffffff' : color;
      ctx.fillRect(x + 3, top + h / 2 - 1, w - 6, 2);
    }
    if (note.forced) {
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(centerX - 2, top + 2, 4, h - 4);
    }

    if (isSelected || isHovered) {
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(x - 1.5, top - 1.5, w + 3, h + 3);
    }
  }
}

function drawGhost(
  ctx: CanvasRenderingContext2D,
  ghost: { tick: number; lane: number },
  originX: number,
  tickToY: (tick: number) => number,
): void {
  const y = tickToY(ghost.tick);
  const color = LANE_COLORS[ghost.lane] ?? '#888888';
  ctx.globalAlpha = 0.3;
  if (ghost.lane === 7) {
    ctx.fillStyle = color;
    ctx.fillRect(originX + 2, y - HIGHWAY.noteHeight * 0.35, HIGHWAY.width - 4, HIGHWAY.noteHeight * 0.7);
  } else {
    const centerX = originX + ghost.lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
    const w = HIGHWAY.laneWidth - 16;
    ctx.fillStyle = color;
    ctx.fillRect(centerX - w / 2, y - HIGHWAY.noteHeight / 2, w, HIGHWAY.noteHeight);
  }
  ctx.globalAlpha = 1;
}

function drawStrikeLine(
  ctx: CanvasRenderingContext2D,
  originX: number,
  highwayWidth: number,
  strikeY: number,
  cssWidth: number,
): void {
  ctx.strokeStyle = COLORS.strikeLine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(originX - 12, strikeY);
  ctx.lineTo(originX + highwayWidth + 12, strikeY);
  ctx.stroke();
  void cssWidth;
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

    if (note.lane === 7) {
      const originX = (ctx.cssWidth - HIGHWAY.width) / 2;
      const withinX = x >= originX && x <= originX + HIGHWAY.width;
      if (withinX && Math.abs(y - noteY) <= halfHeight) {
        return { note, onSustainHandle: false };
      }
    } else {
      const centerX = laneToX(note.lane, ctx);
      const withinX = Math.abs(x - centerX) <= (HIGHWAY.laneWidth - 16) / 2 + 3;
      if (withinX && Math.abs(y - noteY) <= halfHeight) {
        return { note, onSustainHandle: false };
      }
    }

    // Sustain tail: grabbing near its far end resizes instead of moving.
    if (note.length > 0) {
      const tailY = tickToY(note.tick + note.length, ctx);
      const centerX = note.lane === 7 ? ctx.cssWidth / 2 : laneToX(note.lane, ctx);
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
