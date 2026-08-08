'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimingMap } from '@/lib/chart/timing';
import { snapTick, snapTickFloor, type SnapDivision } from '@/lib/chart/snap';
import { LANE_LABELS, type Lane, type Project, type TrackName } from '@/lib/chart/types';
import type { EditorAction } from '@/lib/editor/projectReducer';
import {
  HIGHWAY,
  currentTime,
  hitTestNote,
  useHighwayRenderer,
  xToLane,
  yToTick,
  type HighwayInteraction,
  type HitTestContext,
  type PlaybackClock,
  type RendererInput,
} from '@/lib/editor/useHighwayRenderer';

/**
 * The note highway: a canvas plus pointer handling. All drawing lives in
 * useHighwayRenderer; this component owns only interaction state.
 *
 * Everything here works in TICK space and converts to pixels at the last moment, so
 * behaviour is identical at every zoom level and across tempo changes.
 */

interface Props {
  project: Project;
  trackName: TrackName;
  timing: TimingMap;
  selection: Set<string>;
  snap: SnapDivision;
  pixelsPerTick: number;
  clockRef: React.RefObject<PlaybackClock>;
  dispatch: React.Dispatch<EditorAction>;
  /** Seek the audio to a chart-time position, used when scrubbing on the highway. */
  onSeek: (seconds: number) => void;
}

type DragState =
  | { kind: 'none' }
  | {
      kind: 'moveNotes';
      ids: string[];
      startTick: number;
      startLane: number;
      anchorTick: number;
      anchorLane: number;
      moved: boolean;
    }
  | { kind: 'sustain'; id: string; noteTick: number; length: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number };

export default function NoteHighway({
  project,
  trackName,
  timing,
  selection,
  snap,
  pixelsPerTick,
  clockRef,
  dispatch,
  onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<DragState>({ kind: 'none' });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ tick: number; lane: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; noteId: string } | null>(
    null,
  );

  const track = project.tracks[trackName];

  /**
   * Interaction state is mirrored into a ref because the render loop runs outside
   * React and must see the latest values without waiting for a re-render.
   */
  const interaction = useMemo<HighwayInteraction>(() => {
    let dragPreview: Map<string, { tick: number; lane: number }> | null = null;
    let sustainPreview: { id: string; length: number } | null = null;
    let marquee: HighwayInteraction['marquee'] = null;

    if (drag.kind === 'moveNotes' && drag.moved) {
      dragPreview = new Map();
      const deltaTick = drag.anchorTick - drag.startTick;
      const deltaLane = drag.anchorLane - drag.startLane;
      const moving = new Set(drag.ids);
      for (const note of track.notes) {
        if (!moving.has(note.id)) continue;
        dragPreview.set(note.id, {
          tick: Math.max(0, note.tick + deltaTick),
          lane: note.lane === 7 ? 7 : clampLane(note.lane + deltaLane),
        });
      }
    } else if (drag.kind === 'sustain') {
      sustainPreview = { id: drag.id, length: drag.length };
    } else if (drag.kind === 'marquee') {
      marquee = { x0: drag.x0, y0: drag.y0, x1: drag.x1, y1: drag.y1 };
    }

    return { dragPreview, sustainPreview, marquee, hoveredId, placementGhost: ghost };
  }, [drag, track.notes, hoveredId, ghost]);

  const inputRef = useRef<RendererInput>({
    project,
    trackName,
    timing,
    selection,
    view: { pixelsPerTick, snap },
    interaction,
  });
  inputRef.current = {
    project,
    trackName,
    timing,
    selection,
    view: { pixelsPerTick, snap },
    interaction,
  };

  useHighwayRenderer(canvasRef, inputRef, clockRef);

  /** Build the pixel<->tick context for the current frame. */
  const hitContext = useCallback((): HitTestContext | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      pixelsPerTick,
      playTick: timing.secToTick(currentTime(clockRef.current)),
    };
  }, [pixelsPerTick, timing, clockRef]);

  const pointerPosition = (event: React.PointerEvent | React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2) return; // right-click is handled by onContextMenu
    setContextMenu(null);

    const position = pointerPosition(event);
    const ctx = hitContext();
    if (!position || !ctx) return;

    canvasRef.current?.setPointerCapture(event.pointerId);

    const hit = hitTestNote(track.notes, position.x, position.y, ctx);

    // Middle-click, or a click outside the lanes, scrubs playback instead of editing.
    const lane = xToLane(position.x, ctx);
    if (!hit && lane === null) {
      const tick = Math.max(0, yToTick(position.y, ctx));
      onSeek(timing.tickToSec(tick));
      return;
    }

    if (hit) {
      if (hit.onSustainHandle) {
        setDrag({
          kind: 'sustain',
          id: hit.note.id,
          noteTick: hit.note.tick,
          length: hit.note.length,
        });
        return;
      }

      // Clicking an unselected note selects it; clicking a selected one keeps the
      // whole selection so a multi-note drag works without a modifier.
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      const alreadySelected = selection.has(hit.note.id);
      if (!alreadySelected || additive) {
        dispatch({ type: 'select', ids: [hit.note.id], additive });
      }

      const ids = additive
        ? [...new Set([...selection, hit.note.id])]
        : alreadySelected
          ? [...selection]
          : [hit.note.id];

      const tick = yToTick(position.y, ctx);
      setDrag({
        kind: 'moveNotes',
        ids,
        startTick: snapTick(tick, project.resolution, snap, timing),
        startLane: hit.note.lane === 7 ? 7 : (lane ?? hit.note.lane),
        anchorTick: snapTick(tick, project.resolution, snap, timing),
        anchorLane: hit.note.lane === 7 ? 7 : (lane ?? hit.note.lane),
        moved: false,
      });
      return;
    }

    // Empty space inside the lanes: shift-drag marquee-selects, plain click adds.
    if (event.shiftKey) {
      setDrag({ kind: 'marquee', x0: position.x, y0: position.y, x1: position.x, y1: position.y });
      return;
    }

    if (lane !== null) {
      const tick = snapTick(Math.max(0, yToTick(position.y, ctx)), project.resolution, snap, timing);
      dispatch({ type: 'addNote', track: trackName, tick, lane: lane as Lane });
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const position = pointerPosition(event);
    const ctx = hitContext();
    if (!position || !ctx) return;

    if (drag.kind === 'none') {
      const hit = hitTestNote(track.notes, position.x, position.y, ctx);
      setHoveredId(hit?.note.id ?? null);
      const lane = xToLane(position.x, ctx);
      setGhost(
        !hit && lane !== null
          ? {
              tick: snapTick(Math.max(0, yToTick(position.y, ctx)), project.resolution, snap, timing),
              lane,
            }
          : null,
      );
      // A resize cursor over the tail end is the only affordance telling the user a
      // sustain can be dragged out at all.
      if (canvasRef.current) {
        canvasRef.current.style.cursor = hit?.onSustainHandle
          ? 'ns-resize'
          : hit
            ? 'grab'
            : 'crosshair';
      }
      return;
    }

    if (drag.kind === 'moveNotes') {
      const tick = snapTick(Math.max(0, yToTick(position.y, ctx)), project.resolution, snap, timing);
      const lane = xToLane(position.x, ctx) ?? drag.anchorLane;
      if (tick !== drag.anchorTick || lane !== drag.anchorLane) {
        setDrag({ ...drag, anchorTick: tick, anchorLane: lane, moved: true });
      }
      return;
    }

    if (drag.kind === 'sustain') {
      // Snap the sustain END, then take the distance back to the note head. Floor
      // rather than round so dragging never overshoots past the pointer.
      const endTick = snapTickFloor(
        Math.max(0, yToTick(position.y, ctx)),
        project.resolution,
        snap,
        timing,
      );
      const length = Math.max(0, endTick - drag.noteTick);
      if (length !== drag.length) setDrag({ ...drag, length });
      return;
    }

    if (drag.kind === 'marquee') {
      setDrag({ ...drag, x1: position.x, y1: position.y });
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.releasePointerCapture(event.pointerId);
    const ctx = hitContext();

    if (drag.kind === 'moveNotes' && drag.moved) {
      dispatch({
        type: 'moveNotes',
        track: trackName,
        ids: drag.ids,
        deltaTick: drag.anchorTick - drag.startTick,
        deltaLane: drag.anchorLane - drag.startLane,
      });
    } else if (drag.kind === 'sustain') {
      dispatch({ type: 'setNoteLength', track: trackName, id: drag.id, length: drag.length });
    } else if (drag.kind === 'marquee' && ctx) {
      const minX = Math.min(drag.x0, drag.x1);
      const maxX = Math.max(drag.x0, drag.x1);
      const minY = Math.min(drag.y0, drag.y1);
      const maxY = Math.max(drag.y0, drag.y1);
      const ids: string[] = [];
      for (const note of track.notes) {
        const noteY = tickToYLocal(note.tick, ctx);
        const noteX = note.lane === 7 ? (minX + maxX) / 2 : laneCenter(note.lane, ctx);
        if (noteX >= minX && noteX <= maxX && noteY >= minY && noteY <= maxY) ids.push(note.id);
      }
      dispatch({ type: 'select', ids, additive: event.shiftKey });
    }

    setDrag({ kind: 'none' });
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const position = pointerPosition(event);
    const ctx = hitContext();
    if (!position || !ctx) return;
    const hit = hitTestNote(track.notes, position.x, position.y, ctx);
    if (!hit) {
      setContextMenu(null);
      return;
    }
    if (!selection.has(hit.note.id)) dispatch({ type: 'select', ids: [hit.note.id] });
    setContextMenu({ x: position.x, y: position.y, noteId: hit.note.id });
  };

  // Wheel scrubs the timeline. Ctrl+wheel is left to the browser's zoom, and the
  // transport owns highway zoom, so there is no modifier conflict.
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      const seconds = currentTime(clockRef.current);
      const ctx = hitContext();
      if (!ctx) return;
      const tickDelta = (event.deltaY / pixelsPerTick) * (event.shiftKey ? 4 : 1);
      const nextTick = Math.max(0, timing.secToTick(seconds) - tickDelta);
      onSeek(timing.tickToSec(nextTick));
    },
    [clockRef, hitContext, onSeek, pixelsPerTick, timing],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Registered manually because React's onWheel is passive and cannot preventDefault.
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const selectedNotes = track.notes.filter((n) => selection.has(n.id));

  return (
    <div className="relative h-full w-full select-none">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => {
          setHoveredId(null);
          setGhost(null);
        }}
        onContextMenu={handleContextMenu}
      />

      {contextMenu && (
        <NoteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedCount={selectedNotes.length}
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            dispatch({ type: 'deleteNotes', track: trackName, ids: selectedNotes.map((n) => n.id) });
            setContextMenu(null);
          }}
          onToggleForced={() => {
            dispatch({
              type: 'toggleFlag',
              track: trackName,
              ids: selectedNotes.map((n) => n.id),
              flag: 'forced',
            });
            setContextMenu(null);
          }}
          onToggleTap={() => {
            dispatch({
              type: 'toggleFlag',
              track: trackName,
              ids: selectedNotes.map((n) => n.id),
              flag: 'tap',
            });
            setContextMenu(null);
          }}
          onMakeOpen={() => {
            dispatch({
              type: 'setNotesLane',
              track: trackName,
              ids: selectedNotes.map((n) => n.id),
              lane: 7,
            });
            setContextMenu(null);
          }}
          onClearSustain={() => {
            for (const note of selectedNotes) {
              dispatch({ type: 'setNoteLength', track: trackName, id: note.id, length: 0 });
            }
            setContextMenu(null);
          }}
        />
      )}

      {/* Lane labels under the strike line, coloured to match their lanes. */}
      <div
        className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 gap-0"
        style={{ bottom: '9%', width: HIGHWAY.width }}
      >
        {[0, 1, 2, 3, 4].map((lane) => (
          <span
            key={lane}
            className="text-center text-2xs uppercase tracking-widest text-faint"
            style={{ width: HIGHWAY.laneWidth }}
          >
            {LANE_LABELS[lane]?.[0]}
          </span>
        ))}
      </div>
    </div>
  );
}

function NoteContextMenu({
  x,
  y,
  selectedCount,
  onClose,
  onDelete,
  onToggleForced,
  onToggleTap,
  onMakeOpen,
  onClearSustain,
}: {
  x: number;
  y: number;
  selectedCount: number;
  onClose: () => void;
  onDelete: () => void;
  onToggleForced: () => void;
  onToggleTap: () => void;
  onMakeOpen: () => void;
  onClearSustain: () => void;
}) {
  useEffect(() => {
    const dismiss = () => onClose();
    // Deferred so the click that opened the menu does not immediately close it.
    const timer = setTimeout(() => window.addEventListener('pointerdown', dismiss), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', dismiss);
    };
  }, [onClose]);

  const items: [string, () => void][] = [
    [`Delete${selectedCount > 1 ? ` (${selectedCount})` : ''}`, onDelete],
    ['Toggle forced', onToggleForced],
    ['Toggle tap', onToggleTap],
    ['Make open note', onMakeOpen],
    ['Clear sustain', onClearSustain],
  ];

  return (
    <div
      className="absolute z-20 min-w-[168px] border border-edge2 bg-panel py-1"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map(([label, action]) => (
        <button
          key={label}
          type="button"
          className="block w-full px-3 py-1.5 text-left text-xs text-fg hover:bg-panel2"
          onClick={action}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function clampLane(lane: number): Lane {
  return Math.max(0, Math.min(4, lane)) as Lane;
}

function tickToYLocal(tick: number, ctx: HitTestContext): number {
  const strikeY = ctx.cssHeight * HIGHWAY.strikeLineY;
  return strikeY - (tick - ctx.playTick) * ctx.pixelsPerTick;
}

function laneCenter(lane: number, ctx: HitTestContext): number {
  const originX = (ctx.cssWidth - HIGHWAY.width) / 2;
  return originX + lane * HIGHWAY.laneWidth + HIGHWAY.laneWidth / 2;
}
