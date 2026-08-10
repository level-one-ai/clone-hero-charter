import {
  newNoteId,
  type BpmMarker,
  type Lane,
  type Note,
  type Project,
  type TimeSignature,
  type TrackName,
} from '../chart/types';

/**
 * Editor state and mutations.
 *
 * Every edit is a discrete action, which buys three things at once: undo/redo is a
 * stack of past/future snapshots rather than bespoke inverse operations, the autosave
 * layer has a single place to observe "something changed", and the canvas can stay a
 * pure function of state.
 *
 * Snapshots rather than inverse-operation undo: a chart is at most a few thousand
 * small objects, so structural sharing (only the touched track is cloned) keeps the
 * memory cost trivial while removing an entire class of "undo did not fully reverse
 * the edit" bugs.
 */

export interface EditorState {
  project: Project;
  /** Selected note ids in the active difficulty. */
  selection: Set<string>;
  past: Project[];
  future: Project[];
  /** True when the project differs from what is on the server. */
  dirty: boolean;
}

export type EditorAction =
  | { type: 'addNote'; track: TrackName; tick: number; lane: Lane; length?: number }
  | { type: 'moveNotes'; track: TrackName; ids: string[]; deltaTick: number; deltaLane: number }
  | { type: 'setNoteLength'; track: TrackName; id: string; length: number }
  | { type: 'deleteNotes'; track: TrackName; ids: string[] }
  | { type: 'toggleFlag'; track: TrackName; ids: string[]; flag: 'forced' | 'tap' }
  | { type: 'setNotesLane'; track: TrackName; ids: string[]; lane: Lane }
  | { type: 'select'; ids: string[]; additive?: boolean }
  | { type: 'selectAll'; track: TrackName }
  /**
   * Select every note in a tick range, across all lanes — what shift-clicking a second
   * note produces. A range is a slice of the SONG, not of one lane, because that is what
   * "select this section" means when you are looking at the highway.
   */
  | { type: 'selectRange'; track: TrackName; fromTick: number; toTick: number; additive?: boolean }
  | { type: 'clearSelection' }
  /** Insert a copied block; the pasted notes end up selected. */
  | { type: 'pasteNotes'; track: TrackName; notes: Note[] }
  /** Replace a difficulty wholesale — used by difficulty generation. */
  | { type: 'replaceTrack'; track: TrackName; notes: Note[]; starPower: Project['tracks'][TrackName]['starPower'] }
  | { type: 'addStarPowerPhrase'; track: TrackName; tick: number; length: number }
  | { type: 'deleteStarPowerPhrase'; track: TrackName; tick: number }
  | { type: 'upsertEvent'; tick: number; text: string }
  | { type: 'deleteEvent'; tick: number }
  | { type: 'upsertBpm'; marker: BpmMarker }
  | { type: 'deleteBpm'; tick: number }
  | { type: 'upsertTimeSignature'; marker: TimeSignature }
  | { type: 'deleteTimeSignature'; tick: number }
  | { type: 'setMeta'; meta: Partial<Project['meta']> }
  | { type: 'setStarPower'; track: TrackName; phrases: Project['tracks'][TrackName]['starPower'] }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Replace state after a server load; clears history and the dirty flag. */
  | { type: 'reset'; project: Project }
  /** Mark the current state as saved without otherwise changing it. */
  | { type: 'markSaved' };

const MAX_HISTORY = 200;

export function createEditorState(project: Project): EditorState {
  return { project, selection: new Set(), past: [], future: [], dirty: false };
}

/** Actions that only affect the UI, not the chart, and so must not enter history. */
function isHistoryAction(action: EditorAction): boolean {
  switch (action.type) {
    case 'select':
    case 'selectAll':
    case 'clearSelection':
    case 'undo':
    case 'redo':
    case 'reset':
    case 'markSaved':
      return false;
    default:
      return true;
  }
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'reset':
      return createEditorState(action.project);

    case 'markSaved':
      return { ...state, dirty: false };

    case 'select': {
      const selection = action.additive ? new Set(state.selection) : new Set<string>();
      for (const id of action.ids) {
        // Additive click on an already-selected note toggles it off, which is what
        // ctrl-click does everywhere else.
        if (action.additive && selection.has(id)) selection.delete(id);
        else selection.add(id);
      }
      return { ...state, selection };
    }

    case 'selectAll': {
      const ids = state.project.tracks[action.track].notes.map((n) => n.id);
      return { ...state, selection: new Set(ids) };
    }

    case 'selectRange': {
      // Normalised, so shift-clicking backwards up the highway works exactly as well as
      // forwards — which is how you select a section you have just scrolled past.
      const from = Math.min(action.fromTick, action.toTick);
      const to = Math.max(action.fromTick, action.toTick);
      const selection = action.additive ? new Set(state.selection) : new Set<string>();
      for (const note of state.project.tracks[action.track].notes) {
        if (note.tick >= from && note.tick <= to) selection.add(note.id);
      }
      return { ...state, selection };
    }

    case 'clearSelection':
      return state.selection.size === 0 ? state : { ...state, selection: new Set() };

    case 'undo': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...state,
        project: previous,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, MAX_HISTORY),
        selection: pruneSelection(state.selection, previous),
        dirty: true,
      };
    }

    case 'redo': {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        ...state,
        project: next,
        past: [...state.past, state.project].slice(-MAX_HISTORY),
        future: state.future.slice(1),
        selection: pruneSelection(state.selection, next),
        dirty: true,
      };
    }

    default:
      break;
  }

  const project = applyEdit(state.project, action);
  if (project === state.project) return state;

  return {
    ...state,
    project,
    past: isHistoryAction(action) ? [...state.past, state.project].slice(-MAX_HISTORY) : state.past,
    // Any new edit invalidates the redo branch.
    future: [],
    // A paste selects what it just pasted, so the block can be nudged or flagged
    // immediately without hunting for it again.
    selection:
      action.type === 'pasteNotes'
        ? pruneSelection(new Set(action.notes.map((n) => n.id)), project)
        : pruneSelection(state.selection, project),
    dirty: true,
  };
}

/** Returns the same project reference when nothing changed, so React can bail out. */
function applyEdit(project: Project, action: EditorAction): Project {
  switch (action.type) {
    case 'addNote': {
      const track = project.tracks[action.track];
      // An open note is exclusive: it cannot coexist with frets at the same tick, and
      // vice versa, because Clone Hero has no way to play both.
      const conflicting =
        action.lane === 7
          ? track.notes.filter((n) => n.tick === action.tick)
          : track.notes.filter((n) => n.tick === action.tick && n.lane === 7);
      const duplicate = track.notes.find((n) => n.tick === action.tick && n.lane === action.lane);
      if (duplicate) return project;

      const note: Note = {
        id: newNoteId(),
        tick: action.tick,
        lane: action.lane,
        length: action.length ?? 0,
        forced: false,
        tap: false,
      };
      const removed = new Set(conflicting.map((n) => n.id));
      const notes = track.notes.filter((n) => !removed.has(n.id)).concat(note);
      return withTrack(project, action.track, sortNotes(notes), track.starPower);
    }

    case 'pasteNotes': {
      if (action.notes.length === 0) return project;
      const track = project.tracks[action.track];
      // The pasted notes are the "moved" set, so dedupeNotes resolves every collision in
      // their favour — including the open-note rule, where an open note displaces frets
      // at its tick and vice versa. Pasting over existing notes replaces them, which is
      // what dragging one note onto another already does.
      const pastedIds = new Set(action.notes.map((n) => n.id));
      const notes = dedupeNotes(sortNotes([...track.notes, ...action.notes]), pastedIds);
      return withTrack(project, action.track, notes, track.starPower);
    }

    case 'replaceTrack': {
      const track = project.tracks[action.track];
      if (track.notes.length === 0 && action.notes.length === 0) return project;
      return withTrack(project, action.track, sortNotes(action.notes), action.starPower);
    }

    case 'moveNotes': {
      if (action.ids.length === 0) return project;
      const track = project.tracks[action.track];
      const moving = new Set(action.ids);
      const selected = track.notes.filter((n) => moving.has(n.id));
      if (selected.length === 0) return project;

      // Clamp as a group so a multi-note drag keeps its internal shape when it hits
      // an edge, instead of collapsing notes onto each other.
      const minTick = Math.min(...selected.map((n) => n.tick));
      const deltaTick = Math.max(action.deltaTick, -minTick);

      let deltaLane = action.deltaLane;
      const fretNotes = selected.filter((n) => n.lane !== 7);
      if (deltaLane !== 0 && fretNotes.length > 0) {
        const minLane = Math.min(...fretNotes.map((n) => n.lane));
        const maxLane = Math.max(...fretNotes.map((n) => n.lane));
        deltaLane = Math.max(-minLane, Math.min(deltaLane, 4 - maxLane));
      }
      if (deltaTick === 0 && deltaLane === 0) return project;

      const moved = track.notes.map((n) =>
        moving.has(n.id)
          ? {
              ...n,
              tick: n.tick + deltaTick,
              // Open notes have no lane axis to move along.
              lane: n.lane === 7 ? n.lane : ((n.lane + deltaLane) as Lane),
            }
          : n,
      );
      return withTrack(project, action.track, sortNotes(dedupeNotes(moved, moving)), track.starPower);
    }

    case 'setNoteLength': {
      const track = project.tracks[action.track];
      const length = Math.max(0, Math.round(action.length));
      const existing = track.notes.find((n) => n.id === action.id);
      if (!existing || existing.length === length) return project;
      const notes = track.notes.map((n) => (n.id === action.id ? { ...n, length } : n));
      return withTrack(project, action.track, notes, track.starPower);
    }

    case 'deleteNotes': {
      if (action.ids.length === 0) return project;
      const track = project.tracks[action.track];
      const removing = new Set(action.ids);
      const notes = track.notes.filter((n) => !removing.has(n.id));
      if (notes.length === track.notes.length) return project;
      return withTrack(project, action.track, notes, track.starPower);
    }

    case 'toggleFlag': {
      if (action.ids.length === 0) return project;
      const track = project.tracks[action.track];
      const target = new Set(action.ids);
      const affected = track.notes.filter((n) => target.has(n.id));
      if (affected.length === 0) return project;

      // Flags are per-tick in the .chart format, so a chord must flip as a unit —
      // flipping one note of a chord would silently change its neighbours on export.
      const ticks = new Set(affected.map((n) => n.tick));
      const nextValue = !affected.every((n) => n[action.flag]);
      const notes = track.notes.map((n) =>
        ticks.has(n.tick) ? { ...n, [action.flag]: nextValue } : n,
      );
      return withTrack(project, action.track, notes, track.starPower);
    }

    case 'setNotesLane': {
      const track = project.tracks[action.track];
      const target = new Set(action.ids);
      if (target.size === 0) return project;
      const notes = track.notes.map((n) => (target.has(n.id) ? { ...n, lane: action.lane } : n));
      return withTrack(project, action.track, sortNotes(dedupeNotes(notes, target)), track.starPower);
    }

    case 'addStarPowerPhrase': {
      const track = project.tracks[action.track];
      const tick = Math.max(0, Math.round(action.tick));
      const length = Math.max(1, Math.round(action.length));
      // Merge with any phrase this one touches. Overlapping star power phrases are
      // invalid in Clone Hero, and silently producing them would only show up in game.
      const overlapping = track.starPower.filter(
        (p) => tick <= p.tick + p.length && p.tick <= tick + length,
      );
      const start = Math.min(tick, ...overlapping.map((p) => p.tick));
      const end = Math.max(tick + length, ...overlapping.map((p) => p.tick + p.length));
      const merged = { tick: start, length: end - start };
      const kept = track.starPower.filter((p) => !overlapping.includes(p));
      return withTrack(
        project,
        action.track,
        track.notes,
        [...kept, merged].sort((a, b) => a.tick - b.tick),
      );
    }

    case 'deleteStarPowerPhrase': {
      const track = project.tracks[action.track];
      const starPower = track.starPower.filter((p) => p.tick !== action.tick);
      if (starPower.length === track.starPower.length) return project;
      return withTrack(project, action.track, track.notes, starPower);
    }

    case 'upsertEvent': {
      const tick = Math.max(0, Math.round(action.tick));
      const text = action.text.trim();
      if (text.length === 0) return project;
      const events = project.events.filter((e) => e.tick !== tick).concat({ tick, text });
      events.sort((a, b) => a.tick - b.tick);
      return { ...project, events };
    }

    case 'deleteEvent': {
      const events = project.events.filter((e) => e.tick !== action.tick);
      if (events.length === project.events.length) return project;
      return { ...project, events };
    }

    case 'setStarPower': {
      const track = project.tracks[action.track];
      return withTrack(project, action.track, track.notes, [...action.phrases].sort((a, b) => a.tick - b.tick));
    }

    case 'upsertBpm': {
      const tick = Math.max(0, Math.round(action.marker.tick));
      const bpm = clamp(action.marker.bpm, 1, 1000);
      const existing = project.sync.bpms.find((b) => b.tick === tick);
      if (existing && existing.bpm === bpm) return project;
      const bpms = project.sync.bpms.filter((b) => b.tick !== tick).concat({ tick, bpm });
      bpms.sort((a, b) => a.tick - b.tick);
      return { ...project, sync: { ...project.sync, bpms } };
    }

    case 'deleteBpm': {
      // The tick-0 marker is the anchor for all timing math and cannot be removed.
      if (action.tick === 0) return project;
      const bpms = project.sync.bpms.filter((b) => b.tick !== action.tick);
      if (bpms.length === project.sync.bpms.length) return project;
      return { ...project, sync: { ...project.sync, bpms } };
    }

    case 'upsertTimeSignature': {
      const tick = Math.max(0, Math.round(action.marker.tick));
      const numerator = clamp(Math.round(action.marker.numerator), 1, 64);
      const denominator = nearestPowerOfTwo(action.marker.denominator);
      const existing = project.sync.timeSignatures.find((t) => t.tick === tick);
      if (existing && existing.numerator === numerator && existing.denominator === denominator) {
        return project;
      }
      const timeSignatures = project.sync.timeSignatures
        .filter((t) => t.tick !== tick)
        .concat({ tick, numerator, denominator });
      timeSignatures.sort((a, b) => a.tick - b.tick);
      return { ...project, sync: { ...project.sync, timeSignatures } };
    }

    case 'deleteTimeSignature': {
      if (action.tick === 0) return project;
      const timeSignatures = project.sync.timeSignatures.filter((t) => t.tick !== action.tick);
      if (timeSignatures.length === project.sync.timeSignatures.length) return project;
      return { ...project, sync: { ...project.sync, timeSignatures } };
    }

    case 'setMeta':
      return { ...project, meta: { ...project.meta, ...action.meta } };

    default:
      return project;
  }
}

function withTrack(
  project: Project,
  trackName: TrackName,
  notes: Note[],
  starPower: Project['tracks'][TrackName]['starPower'],
): Project {
  return {
    ...project,
    tracks: { ...project.tracks, [trackName]: { notes, starPower } },
  };
}

function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.tick - b.tick || a.lane - b.lane);
}

/**
 * After a move, two notes can land on the same tick+lane. The moved note wins and the
 * one it landed on is removed — the same behaviour as dragging a note onto another in
 * Moonscraper, and better than silently keeping a duplicate that the export would
 * have to resolve.
 */
function dedupeNotes(notes: Note[], movedIds: Set<string>): Note[] {
  const byKey = new Map<string, Note>();
  for (const note of notes) {
    const key = `${note.tick}:${note.lane}`;
    const existing = byKey.get(key);
    if (!existing || movedIds.has(note.id)) byKey.set(key, note);
  }
  // An open note at a tick displaces any frets there, and vice versa.
  const openTicks = new Set(
    [...byKey.values()].filter((n) => n.lane === 7 && movedIds.has(n.id)).map((n) => n.tick),
  );
  const fretTicks = new Set(
    [...byKey.values()].filter((n) => n.lane !== 7 && movedIds.has(n.id)).map((n) => n.tick),
  );
  return [...byKey.values()].filter((n) => {
    if (n.lane === 7) return !fretTicks.has(n.tick) || movedIds.has(n.id);
    return !openTicks.has(n.tick) || movedIds.has(n.id);
  });
}

function pruneSelection(selection: Set<string>, project: Project): Set<string> {
  if (selection.size === 0) return selection;
  const live = new Set<string>();
  for (const track of Object.values(project.tracks)) {
    for (const note of track.notes) {
      if (selection.has(note.id)) live.add(note.id);
    }
  }
  return live.size === selection.size ? selection : live;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Time-signature denominators must be powers of two; snap to the nearest valid one. */
function nearestPowerOfTwo(value: number): number {
  const candidates = [1, 2, 4, 8, 16, 32, 64];
  return candidates.reduce((best, c) => (Math.abs(c - value) < Math.abs(best - value) ? c : best), 4);
}
