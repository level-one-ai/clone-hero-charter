'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import NoteHighway from './NoteHighway';
import SyncPanel from './SyncPanel';
import TransportBar from './TransportBar';
import WaveformPanel, { type WaveformHandle } from './WaveformPanel';
import { TimingMap } from '@/lib/chart/timing';
import { snapTick, type SnapDivision } from '@/lib/chart/snap';
import {
  DIFFICULTIES,
  trackNameFor,
  type Difficulty,
  type Project,
} from '@/lib/chart/types';
import { createEditorState, editorReducer } from '@/lib/editor/projectReducer';
import type { PlaybackClock } from '@/lib/editor/useHighwayRenderer';
import { exportSong, saveChart } from '@/lib/client/api';

/**
 * Editor shell: owns chart state, playback wiring, autosave and keyboard shortcuts.
 *
 * The one structural rule worth stating: the audio element is the clock. Playback
 * position is never React state — it lives in a ref that the canvas render loop reads
 * directly. Putting it in state would re-render the whole tree 60 times a second.
 */

const AUTOSAVE_DELAY_MS = 1500;

export default function EditorShell({ initialProject }: { initialProject: Project }) {
  const [state, dispatch] = useReducer(editorReducer, initialProject, createEditorState);
  const { project, selection, dirty } = state;

  const [difficulty, setDifficulty] = useState<Difficulty>('Expert');
  const trackName = trackNameFor(difficulty);

  const [snap, setSnap] = useState<SnapDivision>(16);
  const [highwayZoom, setHighwayZoom] = useState(0.28);
  const [waveZoom, setWaveZoom] = useState(40);
  const [playbackRate, setPlaybackRate] = useState(1);

  const [playing, setPlaying] = useState(false);
  // Mirrors the clock for UI readouts only, updated at wavesurfer's own cadence
  // rather than per frame.
  const [displayTime, setDisplayTime] = useState(0);
  const [duration, setDuration] = useState(project.audio.durationMs / 1000);

  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const waveformRef = useRef<WaveformHandle | null>(null);

  /**
   * Playback clock. Written by wavesurfer events, read by the canvas render loop.
   * Deliberately a ref: this is the value that must not cause re-renders.
   */
  const clockRef = useRef<PlaybackClock>({ audioTime: 0, wallClock: performance.now(), playing: false });

  const timing = useMemo(
    () => new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures),
    [project.sync.bpms, project.resolution, project.sync.timeSignatures],
  );

  // ---- playback wiring ---------------------------------------------------------

  const handleTimeUpdate = useCallback((seconds: number, isPlaying: boolean) => {
    clockRef.current = { audioTime: seconds, wallClock: performance.now(), playing: isPlaying };
    setDisplayTime(seconds);
    setPlaying(isPlaying);
  }, []);

  const handleSeek = useCallback((seconds: number) => {
    const clamped = Math.max(0, seconds);
    waveformRef.current?.seek(clamped);
    // Update the clock immediately so the highway responds on the very next frame
    // rather than waiting for wavesurfer's seek event to land.
    clockRef.current = {
      audioTime: clamped,
      wallClock: performance.now(),
      playing: clockRef.current.playing,
    };
    setDisplayTime(clamped);
  }, []);

  const togglePlay = useCallback(() => waveformRef.current?.toggle(), []);

  useEffect(() => {
    waveformRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  // ---- saving ------------------------------------------------------------------

  const projectRef = useRef(project);
  projectRef.current = project;

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await saveChart(projectRef.current.id, projectRef.current);
      dispatch({ type: 'markSaved' });
      setMessage(null);
    } catch (error) {
      setMessage({ kind: 'error', text: `Save failed: ${(error as Error).message}` });
    } finally {
      setSaving(false);
    }
  }, []);

  // Debounced autosave. Restarts on every edit, so a burst of note placements results
  // in one write rather than dozens.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, project, save]);

  // Last line of defence against losing work to a closed tab mid-debounce.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ---- export ------------------------------------------------------------------

  const handleExport = useCallback(async () => {
    setExporting(true);
    setMessage(null);
    try {
      // Export reads what is on disk, so flush pending edits first or the zip ships
      // a chart one autosave behind what the user is looking at.
      if (projectRef.current && dirty) await save();
      const warnings = await exportSong(projectRef.current.id, false);
      setMessage({
        kind: warnings.length > 0 ? 'error' : 'info',
        text: warnings.length > 0 ? warnings.join(' ') : 'Export downloaded.',
      });
    } catch (error) {
      setMessage({ kind: 'error', text: `Export failed: ${(error as Error).message}` });
    } finally {
      setExporting(false);
    }
  }, [dirty, save]);

  // ---- BPM detection -----------------------------------------------------------

  /**
   * Client-side beat detection.
   *
   * LIBRARY CHOICE: web-audio-beat-detector over realtime-bpm-analyzer.
   *
   * realtime-bpm-analyzer is built for streaming input — it wants an AudioWorklet
   * wired into a live AudioContext graph, which is the wrong shape for "analyse this
   * whole file once". web-audio-beat-detector exposes a plain
   * `analyze(audioBuffer) => Promise<number>` for offline analysis.
   *
   * It runs in the BROWSER, not on the server, for a concrete reason: Node has no
   * native AudioContext, so a server-side version would need an AudioContext shim
   * plus its own MP3/OGG decoder. In the browser wavesurfer has already decoded the
   * audio, so the AudioBuffer we need is sitting right there for free.
   *
   * The result is a SUGGESTION. Detection is unreliable on tempo-varying material and
   * on tracks with sparse percussion, and it frequently reports half or double the
   * true tempo — so the UI presents it as a starting point the user confirms.
   */
  const detectBpm = useCallback(async (): Promise<number | null> => {
    const buffer = waveformRef.current?.getDecodedBuffer();
    if (!buffer) {
      throw new Error('Audio is still decoding — try again in a moment.');
    }
    const { analyze } = await import('web-audio-beat-detector');
    try {
      return await analyze(buffer);
    } catch {
      // The library throws rather than returning a low-confidence guess when it
      // cannot find a stable tempo. That is a real answer: report it as failure.
      return null;
    }
  }, []);

  // ---- keyboard ----------------------------------------------------------------

  const playheadTick = useMemo(
    () => snapTick(Math.max(0, timing.secToTick(displayTime)), project.resolution, snap, timing),
    [displayTime, timing, project.resolution, snap],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never hijack keys while the user is typing in a field.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const mod = event.ctrlKey || event.metaKey;

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
        return;
      }
      if (mod) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          togglePlay();
          break;
        case 'Delete':
        case 'Backspace':
          if (selection.size > 0) {
            event.preventDefault();
            dispatch({ type: 'deleteNotes', track: trackName, ids: [...selection] });
          }
          break;
        case 'Escape':
          dispatch({ type: 'clearSelection' });
          break;
        case 'Home':
          event.preventDefault();
          handleSeek(0);
          break;
        // 1-5 place a note in that lane at the playhead — the fastest way to chart
        // while listening, and how charters expect a keyboard workflow to behave.
        case '1':
        case '2':
        case '3':
        case '4':
        case '5': {
          event.preventDefault();
          const lane = (Number.parseInt(event.key, 10) - 1) as 0 | 1 | 2 | 3 | 4;
          dispatch({ type: 'addNote', track: trackName, tick: playheadTick, lane });
          break;
        }
        case '0':
          event.preventDefault();
          dispatch({ type: 'addNote', track: trackName, tick: playheadTick, lane: 7 });
          break;
        case 'f':
          if (selection.size > 0) {
            dispatch({ type: 'toggleFlag', track: trackName, ids: [...selection], flag: 'forced' });
          }
          break;
        case 't':
          if (selection.size > 0) {
            dispatch({ type: 'toggleFlag', track: trackName, ids: [...selection], flag: 'tap' });
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection, trackName, togglePlay, handleSeek, save, playheadTick]);

  const audioUrl = `/api/songs/${project.id}/audio`;
  const noteCount = project.tracks[trackName].notes.length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-4 border-b border-edge px-4 py-2">
        <Link href="/" className="text-2xs uppercase tracking-widest text-faint hover:text-fg">
          ← Songs
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-sm text-fg">{project.meta.name || 'Untitled'}</h1>
          <p className="truncate text-2xs uppercase tracking-widest text-faint">
            {project.meta.artist || 'Unknown artist'}
          </p>
        </div>
        {message && (
          <p
            className={`ml-auto truncate text-2xs ${
              message.kind === 'error' ? 'text-danger' : 'text-muted'
            }`}
          >
            {message.text}
          </p>
        )}
      </header>

      <TransportBar
        playing={playing}
        currentSeconds={displayTime}
        durationSeconds={duration}
        snap={snap}
        onSnapChange={setSnap}
        zoom={highwayZoom}
        onZoomChange={setHighwayZoom}
        playbackRate={playbackRate}
        onPlaybackRateChange={setPlaybackRate}
        onTogglePlay={togglePlay}
        onSeek={handleSeek}
        onSave={() => void save()}
        onExport={() => void handleExport()}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        dirty={dirty}
        saving={saving}
        exporting={exporting}
      />

      <WaveformPanel
        audioUrl={audioUrl}
        handleRef={waveformRef}
        onTimeUpdate={handleTimeUpdate}
        onReady={setDuration}
        onError={(text) => setMessage({ kind: 'error', text })}
        zoom={waveZoom}
      />

      <div className="flex items-center gap-4 border-b border-edge bg-panel px-4">
        <nav className="flex">
          {DIFFICULTIES.map((level) => {
            const count = project.tracks[trackNameFor(level)].notes.length;
            return (
              <button
                key={level}
                type="button"
                onClick={() => {
                  setDifficulty(level);
                  // Selection ids belong to the track they came from.
                  dispatch({ type: 'clearSelection' });
                }}
                className={`ch-tab ${difficulty === level ? 'ch-tab-active' : ''}`}
              >
                {level}
                <span className="ml-1.5 font-mono text-faint">{count}</span>
              </button>
            );
          })}
        </nav>

        <label className="ml-auto flex items-center gap-2 py-1.5">
          <span className="text-2xs uppercase tracking-widest text-faint">Wave zoom</span>
          <input
            type="range"
            min={10}
            max={400}
            step={5}
            value={waveZoom}
            onChange={(event) => setWaveZoom(Number(event.target.value))}
            className="w-24 accent-white"
          />
        </label>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <NoteHighway
            project={project}
            trackName={trackName}
            timing={timing}
            selection={selection}
            snap={snap}
            pixelsPerTick={highwayZoom}
            clockRef={clockRef}
            dispatch={dispatch}
            onSeek={handleSeek}
          />
        </div>

        <aside className="w-72 shrink-0 overflow-y-auto border-l border-edge bg-panel">
          <SyncPanel
            project={project}
            timing={timing}
            playheadTick={playheadTick}
            dispatch={dispatch}
            onSeekToTick={(tick) => handleSeek(timing.tickToSec(tick))}
            onDetectBpm={detectBpm}
          />
        </aside>
      </div>

      <footer className="flex items-center gap-4 border-t border-edge bg-panel px-4 py-1.5 text-2xs text-faint">
        <span>{noteCount} notes in {difficulty}</span>
        <span>{selection.size} selected</span>
        <span className="ml-auto">
          Click to place · drag to move · drag tail to sustain · 1-5 lanes · 0 open · F forced ·
          T tap · Del remove · Space play
        </span>
      </footer>
    </div>
  );
}
