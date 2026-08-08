import { describe, expect, it } from 'vitest';
import { createEditorState, editorReducer, type EditorState } from './projectReducer';
import { createEmptyProject, type Lane } from '../chart/types';

const TRACK = 'ExpertSingle' as const;

function stateWithNotes(notes: Array<{ tick: number; lane: Lane; length?: number }>): EditorState {
  const project = createEmptyProject('test-id');
  project.tracks[TRACK].notes = notes.map((n, i) => ({
    id: `n${i}`,
    tick: n.tick,
    lane: n.lane,
    length: n.length ?? 0,
    forced: false,
    tap: false,
  }));
  return createEditorState(project);
}

const notesOf = (state: EditorState) => state.project.tracks[TRACK].notes;

describe('note editing', () => {
  it('adds a note and keeps the track sorted by tick', () => {
    let state = stateWithNotes([{ tick: 960, lane: 0 }]);
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 2 });
    expect(notesOf(state).map((n) => n.tick)).toEqual([192, 960]);
    expect(state.dirty).toBe(true);
  });

  it('ignores a duplicate note at the same tick and lane', () => {
    const state = stateWithNotes([{ tick: 192, lane: 0 }]);
    const next = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 0 });
    // Same object reference back, so React can skip the re-render entirely.
    expect(next).toBe(state);
  });

  it('allows a chord — several lanes at one tick', () => {
    let state = stateWithNotes([{ tick: 192, lane: 0 }]);
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 1 });
    expect(notesOf(state)).toHaveLength(2);
  });

  it('replaces frets with an open note at the same tick', () => {
    let state = stateWithNotes([
      { tick: 192, lane: 0 },
      { tick: 192, lane: 1 },
    ]);
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 7 });
    // Clone Hero cannot play an open note and frets simultaneously.
    expect(notesOf(state)).toHaveLength(1);
    expect(notesOf(state)[0].lane).toBe(7);
  });

  it('replaces an open note when a fret is added at its tick', () => {
    let state = stateWithNotes([{ tick: 192, lane: 7 }]);
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 3 });
    expect(notesOf(state)).toHaveLength(1);
    expect(notesOf(state)[0].lane).toBe(3);
  });

  it('deletes notes', () => {
    let state = stateWithNotes([
      { tick: 192, lane: 0 },
      { tick: 384, lane: 1 },
    ]);
    state = editorReducer(state, { type: 'deleteNotes', track: TRACK, ids: ['n0'] });
    expect(notesOf(state).map((n) => n.id)).toEqual(['n1']);
  });

  it('sets a sustain length, never negative', () => {
    let state = stateWithNotes([{ tick: 192, lane: 0 }]);
    state = editorReducer(state, { type: 'setNoteLength', track: TRACK, id: 'n0', length: 96 });
    expect(notesOf(state)[0].length).toBe(96);
    state = editorReducer(state, { type: 'setNoteLength', track: TRACK, id: 'n0', length: -50 });
    expect(notesOf(state)[0].length).toBe(0);
  });
});

describe('moving notes', () => {
  it('moves a note in tick and lane', () => {
    let state = stateWithNotes([{ tick: 192, lane: 1 }]);
    state = editorReducer(state, {
      type: 'moveNotes',
      track: TRACK,
      ids: ['n0'],
      deltaTick: 192,
      deltaLane: 2,
    });
    expect(notesOf(state)[0]).toMatchObject({ tick: 384, lane: 3 });
  });

  it('clamps a group at tick 0 without collapsing its shape', () => {
    let state = stateWithNotes([
      { tick: 0, lane: 0 },
      { tick: 192, lane: 1 },
    ]);
    state = editorReducer(state, {
      type: 'moveNotes',
      track: TRACK,
      ids: ['n0', 'n1'],
      deltaTick: -500,
      deltaLane: 0,
    });
    // The group is clamped as a unit, so the 192-tick gap survives.
    expect(notesOf(state).map((n) => n.tick)).toEqual([0, 192]);
  });

  it('clamps a group at the lane edges without collapsing it', () => {
    let state = stateWithNotes([
      { tick: 192, lane: 0 },
      { tick: 192, lane: 2 },
    ]);
    state = editorReducer(state, {
      type: 'moveNotes',
      track: TRACK,
      ids: ['n0', 'n1'],
      deltaTick: 0,
      deltaLane: 10,
    });
    expect(notesOf(state).map((n) => n.lane)).toEqual([2, 4]);
  });

  it('lets a moved note displace the one it lands on', () => {
    let state = stateWithNotes([
      { tick: 192, lane: 0 },
      { tick: 384, lane: 0 },
    ]);
    state = editorReducer(state, {
      type: 'moveNotes',
      track: TRACK,
      ids: ['n1'],
      deltaTick: -192,
      deltaLane: 0,
    });
    expect(notesOf(state)).toHaveLength(1);
    expect(notesOf(state)[0].id).toBe('n1');
  });

  it('does not move an open note between lanes', () => {
    let state = stateWithNotes([{ tick: 192, lane: 7 }]);
    state = editorReducer(state, {
      type: 'moveNotes',
      track: TRACK,
      ids: ['n0'],
      deltaTick: 0,
      deltaLane: 3,
    });
    expect(notesOf(state)[0].lane).toBe(7);
  });
});

describe('flags', () => {
  it('flips a whole chord together, since flags are per-tick in .chart', () => {
    let state = stateWithNotes([
      { tick: 192, lane: 0 },
      { tick: 192, lane: 1 },
      { tick: 384, lane: 2 },
    ]);
    state = editorReducer(state, { type: 'toggleFlag', track: TRACK, ids: ['n0'], flag: 'forced' });
    const atTick = notesOf(state).filter((n) => n.tick === 192);
    expect(atTick.every((n) => n.forced)).toBe(true);
    // A note at a different tick is untouched.
    expect(notesOf(state).find((n) => n.tick === 384)!.forced).toBe(false);
  });

  it('toggles back off', () => {
    let state = stateWithNotes([{ tick: 192, lane: 0 }]);
    state = editorReducer(state, { type: 'toggleFlag', track: TRACK, ids: ['n0'], flag: 'tap' });
    expect(notesOf(state)[0].tap).toBe(true);
    state = editorReducer(state, { type: 'toggleFlag', track: TRACK, ids: ['n0'], flag: 'tap' });
    expect(notesOf(state)[0].tap).toBe(false);
  });
});

describe('sync markers', () => {
  it('adds and replaces a BPM marker at a tick', () => {
    let state = stateWithNotes([]);
    state = editorReducer(state, { type: 'upsertBpm', marker: { tick: 1920, bpm: 90 } });
    expect(state.project.sync.bpms).toHaveLength(2);
    state = editorReducer(state, { type: 'upsertBpm', marker: { tick: 1920, bpm: 95 } });
    expect(state.project.sync.bpms).toHaveLength(2);
    expect(state.project.sync.bpms[1].bpm).toBe(95);
  });

  it('refuses to delete the tick-0 anchor', () => {
    let state = stateWithNotes([]);
    state = editorReducer(state, { type: 'deleteBpm', tick: 0 });
    // All timing math anchors at tick 0; removing it would break every conversion.
    expect(state.project.sync.bpms).toHaveLength(1);
  });

  it('snaps a time-signature denominator to a power of two', () => {
    let state = stateWithNotes([]);
    state = editorReducer(state, {
      type: 'upsertTimeSignature',
      marker: { tick: 1920, numerator: 7, denominator: 7 },
    });
    expect(state.project.sync.timeSignatures[1].denominator).toBe(8);
  });
});

describe('undo and redo', () => {
  it('reverses an edit and reapplies it', () => {
    let state = stateWithNotes([]);
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 0 });
    expect(notesOf(state)).toHaveLength(1);

    state = editorReducer(state, { type: 'undo' });
    expect(notesOf(state)).toHaveLength(0);

    state = editorReducer(state, { type: 'redo' });
    expect(notesOf(state)).toHaveLength(1);
  });

  it('walks back through several edits in order', () => {
    let state = stateWithNotes([]);
    for (const tick of [192, 384, 576]) {
      state = editorReducer(state, { type: 'addNote', track: TRACK, tick, lane: 0 });
    }
    state = editorReducer(state, { type: 'undo' });
    state = editorReducer(state, { type: 'undo' });
    expect(notesOf(state).map((n) => n.tick)).toEqual([192]);
  });

  it('drops the redo branch once a new edit is made', () => {
    let state = stateWithNotes([]);
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 0 });
    state = editorReducer(state, { type: 'undo' });
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 960, lane: 3 });
    expect(state.future).toHaveLength(0);
    state = editorReducer(state, { type: 'redo' });
    expect(notesOf(state).map((n) => n.tick)).toEqual([960]);
  });

  it('does not put selection changes into history', () => {
    let state = stateWithNotes([{ tick: 192, lane: 0 }]);
    state = editorReducer(state, { type: 'select', ids: ['n0'] });
    expect(state.past).toHaveLength(0);
    // Undo must reverse the last real edit, not a click.
    expect(editorReducer(state, { type: 'undo' }).project).toBe(state.project);
  });

  it('drops selected ids that no longer exist after an undo', () => {
    let state = stateWithNotes([]);
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 0 });
    const id = notesOf(state)[0].id;
    state = editorReducer(state, { type: 'select', ids: [id] });
    expect(state.selection.size).toBe(1);
    state = editorReducer(state, { type: 'undo' });
    expect(state.selection.size).toBe(0);
  });
});

describe('selection', () => {
  it('replaces the selection by default and extends it additively', () => {
    let state = stateWithNotes([
      { tick: 192, lane: 0 },
      { tick: 384, lane: 1 },
    ]);
    state = editorReducer(state, { type: 'select', ids: ['n0'] });
    state = editorReducer(state, { type: 'select', ids: ['n1'] });
    expect([...state.selection]).toEqual(['n1']);

    state = editorReducer(state, { type: 'select', ids: ['n0'], additive: true });
    expect(state.selection.size).toBe(2);
  });

  it('deselects an already-selected note on additive click', () => {
    let state = stateWithNotes([{ tick: 192, lane: 0 }]);
    state = editorReducer(state, { type: 'select', ids: ['n0'] });
    state = editorReducer(state, { type: 'select', ids: ['n0'], additive: true });
    expect(state.selection.size).toBe(0);
  });
});

describe('dirty tracking', () => {
  it('marks dirty on edit and clean on markSaved', () => {
    let state = stateWithNotes([]);
    expect(state.dirty).toBe(false);
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 0 });
    expect(state.dirty).toBe(true);
    state = editorReducer(state, { type: 'markSaved' });
    expect(state.dirty).toBe(false);
  });

  it('does not mark dirty for a no-op edit', () => {
    let state = stateWithNotes([{ tick: 192, lane: 0 }]);
    state = editorReducer(state, { type: 'markSaved' });
    state = editorReducer(state, { type: 'addNote', track: TRACK, tick: 192, lane: 0 });
    expect(state.dirty).toBe(false);
  });
});

describe('difficulty independence', () => {
  it('edits only the named track', () => {
    let state = stateWithNotes([{ tick: 192, lane: 0 }]);
    state = editorReducer(state, { type: 'addNote', track: 'HardSingle', tick: 384, lane: 2 });
    expect(state.project.tracks.ExpertSingle.notes).toHaveLength(1);
    expect(state.project.tracks.HardSingle.notes).toHaveLength(1);
    expect(state.project.tracks.MediumSingle.notes).toHaveLength(0);
  });
});
