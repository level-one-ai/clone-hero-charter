'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import ExportDialog from './ExportDialog';
import HelpOverlay from './HelpOverlay';
import NoteHighway from './NoteHighway';
import NoteToolbar from './NoteToolbar';
import SectionsPanel from './SectionsPanel';
import ChartCheckPanel from './ChartCheckPanel';
import KeyLegend from './KeyLegend';
import ReimportDialog from './ReimportDialog';
import SongPropertiesPanel from './SongPropertiesPanel';
import SyncPanel from './SyncPanel';
import TransportBar from './TransportBar';
import WaveformPanel, { type RegionSelection, type WaveformHandle } from './WaveformPanel';
import { TimingMap, formatTime } from '@/lib/chart/timing';
import {
  buildAudioTimeline,
  leadInTicks,
  normalizeLeadIn,
} from '@/lib/chart/audioTimeline';
import {
  detectTempo,
  regionStartForFirstBeat,
  type GuessFn,
  type TempoGuess,
} from '@/lib/editor/tempoDetect';
import { snapTick, type SnapDivision } from '@/lib/chart/snap';
import {
  DIFFICULTIES,
  newNoteId,
  trackNameFor,
  type Difficulty,
  type Lane,
  type Project,
} from '@/lib/chart/types';
import { sustainSelectionToNext } from '@/lib/chart/sustain';
import { convertNotes, selectByType, type NoteType } from '@/lib/chart/noteTypes';
import { Metronome } from '@/lib/editor/metronome';
import {
  createLiveEntryState,
  isEntryKey,
  pressKey,
  registerHeld,
  releaseKey,
} from '@/lib/editor/liveEntry';
import { createEditorState, editorReducer } from '@/lib/editor/projectReducer';
import { describeReduction, reduceNotes } from '@/lib/chart/generateDifficulty';
import {
  copyNotes,
  describeBlock,
  pasteAt,
  type ClipboardBlock,
} from '@/lib/editor/clipboard';
import { currentTime, type PlaybackClock } from '@/lib/editor/useHighwayRenderer';
import {
  STAR_POWER_TOOL_ARMED,
  STAR_POWER_TOOL_OFF,
  starPowerClick,
  starPowerHint,
  type StarPowerToolState,
} from '@/lib/editor/starPowerTool';
import {
  SaveConflictError,
  autoChartRange,
  exportSong,
  fetchProject,
  saveChart,
  saveChartBeacon,
  type ExportOptions,
} from '@/lib/client/api';

/**
 * Editor shell: owns chart state, playback wiring, autosave and keyboard shortcuts.
 *
 * The one structural rule worth stating: the audio element is the clock. Playback
 * position is never React state — it lives in a ref that the canvas render loop reads
 * directly. Putting it in state would re-render the whole tree 60 times a second.
 */

const AUTOSAVE_DELAY_MS = 1500;

/** The lead-in in words: "2 bars", "3 bars 2 beats". */
function describeLeadIn(leadIn: Project['meta']['leadIn']): string {
  const bars = `${leadIn.bars} bar${leadIn.bars === 1 ? '' : 's'}`;
  if (!leadIn.beats) return bars;
  return `${bars} ${leadIn.beats} beat${leadIn.beats === 1 ? '' : 's'}`;
}

/**
 * Disagreement between the interpolated playhead and the audio element that is absorbed
 * silently rather than snapped. Below roughly one frame at 60Hz nobody can see it, and
 * snapping would be more visible than the error.
 */
const DRIFT_TOLERANCE_SEC = 0.02;

export default function EditorShell({ initialProject }: { initialProject: Project }) {
  const router = useRouter();
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
  const [audioDuration, setAudioDuration] = useState(project.audio.durationMs / 1000);

  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [reimportOpen, setReimportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'song' | 'sync' | 'sections' | 'check'>('sections');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [metronomeOn, setMetronomeOn] = useState(false);
  /** True while the charter is dragging out the section of a long upload to chart. */
  const [regionSelecting, setRegionSelecting] = useState(false);
  const metronomeRef = useRef<Metronome | null>(null);
  const [starPowerTool, setStarPowerTool] = useState<StarPowerToolState>(STAR_POWER_TOOL_OFF);
  const clipboardRef = useRef<ClipboardBlock | null>(null);
  /** Server revision this editor is based on — see save(). */
  const revisionRef = useRef(initialProject.revision ?? 0);
  const [conflict, setConflict] = useState(false);
  const [clipboardLabel, setClipboardLabel] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const waveformRef = useRef<WaveformHandle | null>(null);

  /**
   * Playback clock. Written by wavesurfer events, read by the canvas render loop.
   * Deliberately a ref: this is the value that must not cause re-renders.
   */
  const clockRef = useRef<PlaybackClock>({
    audioTime: 0,
    wallClock: performance.now(),
    playing: false,
    rate: 1,
    preRoll: false,
  });

  const timing = useMemo(
    () => new TimingMap(project.sync.bpms, project.resolution, project.sync.timeSignatures),
    [project.sync.bpms, project.resolution, project.sync.timeSignatures],
  );

  // ---- playback wiring ---------------------------------------------------------

  /**
   * CHART TIME vs AUDIO TIME.
   *
   * The editor works in chart seconds. Two things separate that from the audio file's own
   * timeline: the lead-in silence before the music, and the region — the slice of a longer
   * upload this chart actually covers. `buildAudioTimeline` owns both conversions, and
   * every call into wavesurfer goes through it.
   *
   * Everything the user sees — the playhead, the highway, the readout — is chart time.
   */
  const timeline = useMemo(() => buildAudioTimeline(project, timing), [project, timing]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const leadInSec = timeline.leadInSec;

  const rateRef = useRef(playbackRate);
  rateRef.current = playbackRate;

  /**
   * Timer that ends the lead-in.
   *
   * An <audio> element has no negative time, so the silence before the music cannot come
   * from the file — it is run on the wall clock, and the audio is started when it
   * elapses. `preRoll` on the clock marks that stretch so wavesurfer's own position
   * updates (which would report 0 + leadIn) are ignored until the handover.
   */
  const preRollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPreRoll = useCallback(() => {
    if (preRollTimer.current !== null) {
      clearTimeout(preRollTimer.current);
      preRollTimer.current = null;
    }
  }, []);

  const writeClock = useCallback((chartSeconds: number, playing: boolean, preRoll: boolean) => {
    clockRef.current = {
      audioTime: chartSeconds,
      wallClock: performance.now(),
      playing,
      rate: rateRef.current,
      preRoll,
    };
    setDisplayTime(chartSeconds);
    setPlaying(playing);
  }, []);

  /** Schedule the handover from silence to audio, `chartSeconds` into the lead-in. */
  const startPreRoll = useCallback(
    (chartSeconds: number) => {
      cancelPreRoll();
      writeClock(chartSeconds, true, true);
      // Wall-clock delay, so a slower playback rate stretches the silence to match.
      const delayMs = ((timelineRef.current.leadInSec - chartSeconds) / rateRef.current) * 1000;
      preRollTimer.current = setTimeout(() => {
        preRollTimer.current = null;
        if (!clockRef.current.playing) return;
        // Hand over at the START OF THE REGION, not at zero: with a trimmed upload the
        // music this chart covers begins partway into the file.
        waveformRef.current?.seek(timelineRef.current.regionStartSec);
        waveformRef.current?.play();
        writeClock(timelineRef.current.leadInSec, true, false);
      }, Math.max(0, delayMs));
    },
    [cancelPreRoll, writeClock],
  );

  /** Position updates from wavesurfer, in AUDIO seconds. */
  const handleTimeUpdate = useCallback(
    (audioSeconds: number, isPlaying: boolean) => {
      /**
       * Anywhere inside the lead-in, the audio element is parked at zero and its position
       * says nothing about where the playhead is — taking it would snap the playhead
       * forward to the end of the silence. That is true whether or not we are playing:
       * seeking to chart time 0 while paused makes wavesurfer emit a `seeking` at audio 0,
       * which would otherwise read as chart time `leadIn` and bounce the playhead to the
       * first beat every time you pressed Home.
       */
      if (clockRef.current.preRoll) {
        if (isPlaying !== clockRef.current.playing) {
          clockRef.current = { ...clockRef.current, playing: isPlaying };
          setPlaying(isPlaying);
        }
        return;
      }

      /**
       * DRIFT GUARD.
       *
       * The audio element is the authority, so every reading re-anchors the clock and
       * the highway can never wander from the music. But re-anchoring hard on a reading
       * that is only a millisecond or two out would make the playhead visibly twitch
       * four times a second, because the interpolation is smooth and the readings are
       * quantised. So: small disagreements are absorbed silently, and only a real
       * divergence — the kind a dropped frame or a stalled buffer causes — snaps.
       */
      const chartSeconds = timelineRef.current.audioToChart(audioSeconds);

      /**
       * Stop at the end of the region.
       *
       * Past it the file carries whatever came next on the record — the following track,
       * the next song of a live set — which is precisely what a region exists to exclude.
       * The export replaces that stretch with silence, so playing it here would be the
       * editor telling a different story from the file that ships.
       */
      if (isPlaying && timelineRef.current.trimmed && audioSeconds >= timelineRef.current.regionEndSec) {
        waveformRef.current?.pause();
        writeClock(timelineRef.current.leadInSec + timelineRef.current.regionSec, false, false);
        return;
      }

      const drift = Math.abs(chartSeconds - currentTime(clockRef.current));
      if (isPlaying && drift < DRIFT_TOLERANCE_SEC) {
        // Absorb: keep the reading as the new anchor so error cannot accumulate, but do
        // not disturb the UI with a state update.
        clockRef.current = {
          ...clockRef.current,
          audioTime: chartSeconds,
          wallClock: performance.now(),
          playing: isPlaying,
        };
        return;
      }

      writeClock(chartSeconds, isPlaying, false);
    },
    [writeClock],
  );

  /** Seek to a CHART-time position. */
  const handleSeek = useCallback(
    (chartSeconds: number) => {
      const clamped = Math.max(0, chartSeconds);
      const wasPlaying = clockRef.current.playing;
      cancelPreRoll();

      if (clamped < timelineRef.current.leadInSec) {
        // Inside the lead-in: the audio has nothing to play yet, so park it at the point
        // the music will start from.
        waveformRef.current?.pause();
        waveformRef.current?.seek(timelineRef.current.regionStartSec);
        if (wasPlaying) startPreRoll(clamped);
        else writeClock(clamped, false, true);
        return;
      }

      waveformRef.current?.seek(timelineRef.current.chartToAudio(clamped));
      if (wasPlaying) waveformRef.current?.play();
      // Written synchronously so the highway responds on the very next frame rather than
      // waiting for wavesurfer's seek event.
      writeClock(clamped, wasPlaying, false);
    },
    [cancelPreRoll, startPreRoll, writeClock],
  );

  const togglePlay = useCallback(() => {
    const chartNow = currentTime(clockRef.current);
    if (clockRef.current.playing) {
      cancelPreRoll();
      waveformRef.current?.pause();
      writeClock(chartNow, false, chartNow < timelineRef.current.leadInSec);
      return;
    }
    if (chartNow < timelineRef.current.leadInSec) {
      startPreRoll(chartNow);
      return;
    }
    waveformRef.current?.play();
    writeClock(chartNow, true, false);
  }, [cancelPreRoll, startPreRoll, writeClock]);

  useEffect(() => cancelPreRoll, [cancelPreRoll]);

  /**
   * Tick the displayed time from the CLOCK, not from audio events.
   *
   * The highway reads `clockRef` every frame, so it moves smoothly whatever the audio
   * element is doing. The readout used to be written only by `writeClock` — which the
   * drift guard above deliberately skips while playback is healthy — so the clock display
   * sat frozen at the last big correction while the highway scrolled past it. Driving it
   * from the same source the highway uses means the number and the notes can never
   * disagree, which is the whole point of the guard.
   *
   * 10Hz, and only while playing: fast enough that the milliseconds look live, slow enough
   * that it is not re-rendering the editor every frame.
   */
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setDisplayTime(currentTime(clockRef.current)), 100);
    return () => clearInterval(id);
  }, [playing]);

  /**
   * Metronome.
   *
   * Kept in step with playback by starting it from the CURRENT chart position whenever
   * playback starts, the rate changes or the user seeks — it schedules against the audio
   * hardware clock from that anchor, so it cannot drift, but it has no way to know about
   * a seek unless it is re-anchored.
   */
  useEffect(() => {
    metronomeRef.current ??= new Metronome();
    metronomeRef.current.setTiming(timing, project.resolution);
  }, [timing, project.resolution]);

  useEffect(() => () => metronomeRef.current?.dispose(), []);

  useEffect(() => {
    const metronome = metronomeRef.current;
    if (!metronome) return;
    if (metronomeOn && playing) {
      metronome.start({
        positionSec: currentTime(clockRef.current),
        rate: playbackRate,
        volume: 0.35,
      });
    } else {
      metronome.stop();
    }
  }, [metronomeOn, playing, playbackRate, displayTime]);

  /** Convert the selection to a solid strum, a hammer-on or a tap. */
  const handleConvertType = useCallback(
    (target: NoteType) => {
      if (selection.size === 0) {
        setMessage({ kind: 'error', text: 'Select some notes first.' });
        return;
      }
      const notes = project.tracks[trackName].notes;
      const changes = convertNotes(notes, selection, project.resolution, target);
      if (changes.length === 0) {
        setMessage({ kind: 'info', text: 'Those notes are already that type.' });
        return;
      }
      dispatch({ type: 'setNoteFlags', track: trackName, changes });
      setMessage({
        kind: 'info',
        text: `Converted ${changes.length} note${changes.length === 1 ? '' : 's'}.`,
      });
    },
    [selection, project.tracks, project.resolution, trackName],
  );

  /** Select every note of a given type, so a whole class can be converted at once. */
  const handleSelectByType = useCallback(
    (target: NoteType) => {
      const ids = selectByType(project.tracks[trackName].notes, project.resolution, target);
      if (ids.length === 0) {
        setMessage({ kind: 'error', text: `No ${target === 'strum' ? 'solid' : target} notes here.` });
        return;
      }
      dispatch({ type: 'select', ids });
      setMessage({ kind: 'info', text: `Selected ${ids.length}.` });
    },
    [project.tracks, project.resolution, trackName],
  );

  /**
   * Fill the selected stretch by listening to the audio.
   *
   * The range comes from the SELECTION, which is a deliberate constraint: you have to
   * point at the hole before it will write anything, so it can never overwrite work. The
   * server gap-fills on top of that as a second guard.
   */
  const [autoCharting, setAutoCharting] = useState(false);
  const handleAutoChart = useCallback(async () => {
    const notes = project.tracks[trackName].notes;
    const selected = notes.filter((n) => selection.has(n.id));
    if (selected.length < 2) {
      setMessage({
        kind: 'error',
        text: 'Mark the gap first: select a note either side of the stretch you want filled.',
      });
      return;
    }
    const fromTick = Math.min(...selected.map((n) => n.tick));
    const toTick = Math.max(...selected.map((n) => n.tick));

    setAutoCharting(true);
    setMessage({ kind: 'info', text: 'Listening to the audio…' });
    try {
      const result = await autoChartRange(projectRef.current.id, {
        fromTick,
        toTick,
        difficulty,
      });
      revisionRef.current = result.project.revision ?? 0;
      dispatch({ type: 'reset', project: result.project });
      setMessage({
        kind: 'info',
        text: `Found ${result.onsets} attacks and added ${result.added} notes. Check the frets — they are estimated from the audio's brightness, so treat them as a starting point.`,
      });
    } catch (error) {
      setMessage({ kind: 'error', text: `Auto-chart failed: ${(error as Error).message}` });
    } finally {
      setAutoCharting(false);
    }
  }, [project.tracks, trackName, selection, difficulty]);

  /** Select every note inside a named section, ready to copy or edit. */
  const handleSelectSection = useCallback(
    (fromTick: number, toTick: number, label: string) => {
      dispatch({ type: 'selectRange', track: trackName, fromTick, toTick });
      handleSeek(timing.tickToSec(fromTick));
      setMessage({ kind: 'info', text: `Selected "${label}".` });
    },
    [trackName, timing, handleSeek],
  );

  /**
   * Set the lead-in, in bars and beats.
   *
   * Normalised through the same helper the server uses, so the 2-bar minimum and the
   * beats-carry-into-bars rule hold wherever the value came from.
   */
  const handleLeadInChange = useCallback(
    (bars: number, beats: number) => {
      const beatsPerBar = timing.timeSignatureAt(0).numerator;
      const leadIn = normalizeLeadIn({ bars, beats }, beatsPerBar);
      dispatch({ type: 'setMeta', meta: { leadIn } });
    },
    [timing],
  );

  /**
   * Region drag on the waveform.
   *
   * Only the release enters undo history — a drag fires continuously, and one undo step
   * per pixel would bury everything else in the stack. Intermediate values still update
   * the project so the waveform and highway track the drag live.
   */
  const handleRegionChange = useCallback(
    (next: RegionSelection | null, committed: boolean) => {
      dispatch({
        type: 'setAudioRegion',
        region: next ? { startMs: next.startSec * 1000, endMs: next.endSec * 1000 } : null,
        transient: !committed,
      });
      if (!committed) return;
      // Moving the region by hand is the charter overriding the detector's alignment.
      if (project.audio.detected && !project.audio.detected.overridden) {
        dispatch({
          type: 'setAudioDetection',
          detected: { ...project.audio.detected, overridden: true },
        });
      }
      if (next) {
        setRegionSelecting(false);
        setMessage({
          kind: 'info',
          text: `Charting ${formatTime(next.startSec)} – ${formatTime(next.endSec)} of the upload. Only that section is exported.`,
        });
      }
    },
    [project.audio.detected],
  );

  /** Nudge the alignment by whole beats, for lining the grid up against the music by ear. */
  const nudgeRegionStart = useCallback(
    (beats: number) => {
      const current = timelineRef.current;
      const beatSec = 60 / Math.max(1, timing.bpmAt(0));
      const startMs = Math.max(0, (current.regionStartSec + beats * beatSec) * 1000);
      dispatch({
        type: 'setAudioRegion',
        region: { startMs, endMs: current.regionEndSec * 1000 },
      });
      if (project.audio.detected && !project.audio.detected.overridden) {
        dispatch({
          type: 'setAudioDetection',
          detected: { ...project.audio.detected, overridden: true },
        });
      }
    },
    [project.audio.detected, timing],
  );

  const clearRegion = useCallback(() => {
    dispatch({ type: 'setAudioRegion', region: null });
    setRegionSelecting(false);
  }, []);

  useEffect(() => {
    waveformRef.current?.setPlaybackRate(playbackRate);
    // Re-anchor: the clock's elapsed-time maths is scaled by the rate, so a rate change
    // has to reset the anchor or the frames since the last reading are counted at the
    // wrong speed.
    const clock = clockRef.current;
    clockRef.current = {
      ...clock,
      audioTime: currentTime(clock),
      wallClock: performance.now(),
      rate: playbackRate,
    };
    // A pending lead-in was timed at the old rate.
    if (clock.playing && clock.preRoll) startPreRoll(currentTime(clock));
  }, [playbackRate, startPreRoll]);

  // ---- saving ------------------------------------------------------------------

  const projectRef = useRef(project);
  projectRef.current = { ...project, revision: revisionRef.current };

  /**
   * Save, and take the server's revision back.
   *
   * The revision is what makes concurrent editing safe: the next save carries it, and the
   * server refuses anything built on a stale copy. Without it, two people on one song
   * overwrite each other silently.
   */
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const stored = await saveChart(projectRef.current.id, projectRef.current);
      revisionRef.current = stored.revision ?? 0;
      dispatch({ type: 'setMeta', meta: {}, transient: true });
      dispatch({ type: 'markSaved' });
      setConflict(false);
      /*
        Clear the failure a successful save has just resolved, and nothing else. Wiping
        the message outright meant every autosave — which fires 1.5s after any edit —
        swallowed whatever the last action had told you: "Selected \"Chorus\"", "added 14
        notes", gone before you had read it.
      */
      setMessage((current) => (current?.kind === 'error' ? null : current));
      return true;
    } catch (error) {
      if (error instanceof SaveConflictError) {
        setConflict(true);
        setMessage({ kind: 'error', text: error.message });
      } else {
        setMessage({ kind: 'error', text: `Save failed: ${(error as Error).message}` });
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  /** Discard local edits and take whatever is on the server. */
  const reloadFromServer = useCallback(async () => {
    try {
      const fresh = await fetchProject(projectRef.current.id);
      revisionRef.current = fresh.revision ?? 0;
      dispatch({ type: 'reset', project: fresh });
      setConflict(false);
      setMessage({ kind: 'info', text: 'Reloaded the version from the server.' });
    } catch (error) {
      setMessage({ kind: 'error', text: `Could not reload: ${(error as Error).message}` });
    }
  }, []);

  /** Overwrite the server's version with this one, deliberately. */
  const overwriteServer = useCallback(async () => {
    try {
      const fresh = await fetchProject(projectRef.current.id);
      revisionRef.current = fresh.revision ?? 0;
      const forced = { ...projectRef.current, revision: revisionRef.current };
      const stored = await saveChart(forced.id, forced);
      revisionRef.current = stored.revision ?? 0;
      dispatch({ type: 'markSaved' });
      setConflict(false);
      setMessage({ kind: 'info', text: 'Your version was saved over the other one.' });
    } catch (error) {
      setMessage({ kind: 'error', text: `Could not overwrite: ${(error as Error).message}` });
    }
  }, []);

  // Debounced autosave. Restarts on every edit, so a burst of note placements results
  // in one write rather than dozens.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, project, save]);

  /**
   * Losing work on the way out.
   *
   * `beforeunload` covers closing the tab, but NOT in-app navigation — clicking
   * "← Songs" is a client-side route change, so an edit made inside the autosave debounce
   * used to vanish with no warning. `pagehide` plus `sendBeacon` covers the cases
   * `beforeunload` misses entirely (a closed lid, a tab evicted on mobile), because a
   * normal fetch is cancelled the moment the document goes away.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const flush = () => {
      saveChartBeacon(projectRef.current.id, projectRef.current);
    };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('pagehide', flush);
    };
  }, [dirty]);

  /** Save any pending edit, then navigate. Used by the back link. */
  const leaveTo = useCallback(
    async (href: string) => {
      if (dirty) await save();
      router.push(href);
    },
    [dirty, save, router],
  );

  // ---- export ------------------------------------------------------------------

  const handleExport = useCallback(
    async (options: ExportOptions) => {
      setExporting(true);
      setMessage(null);
      try {
        // Export reads what is on disk, so flush pending edits first or the zip ships
        // a chart one autosave behind what the user is looking at.
        if (projectRef.current && dirty) await save();
        // A navigation, not a fetch — the browser streams the zip to disk. Warnings were
        // already shown by the dialog's dry run, so there is nothing left to report.
        exportSong(projectRef.current.id, options);
        setExportOpen(false);
        setMessage({ kind: 'info', text: 'Export started — check your downloads.' });
      } catch (error) {
        setMessage({ kind: 'error', text: `Export failed: ${(error as Error).message}` });
      } finally {
        setExporting(false);
      }
    },
    [dirty, save],
  );

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
   * true tempo — so the UI presents it with its confidence and the user confirms.
   */
  const detectTempoNow = useCallback(async (): Promise<TempoGuess | null> => {
    const buffer = waveformRef.current?.getDecodedBuffer();
    if (!buffer) {
      throw new Error('Audio is still decoding — try again in a moment.');
    }
    const { guess } = await import('web-audio-beat-detector');
    const current = timelineRef.current;
    // Analyse the charted region, not the whole upload: the tempo of the song you are
    // charting is the question, not the tempo of the album side it came from.
    return detectTempo(
      buffer,
      guess as GuessFn,
      current.regionStartSec,
      current.trimmed ? current.regionEndSec : undefined,
    );
  }, []);

  /**
   * Apply a detection result: anchor BPM at tick 0, and the region start on the beat it
   * found so bar 1 of the chart lands on bar 1 of the music.
   *
   * `alignRegion` is false when the charter asked for a tempo reading alone — re-aiming
   * the region under someone who has already lined it up by ear would undo their work.
   */
  const applyTempoGuess = useCallback(
    (result: TempoGuess, alignRegion: boolean) => {
      dispatch({ type: 'upsertBpm', marker: { tick: 0, bpm: result.bpm } });
      dispatch({
        type: 'setAudioDetection',
        detected: { ...result, overridden: false },
      });
      if (!alignRegion) return;

      const beatsPerBar = timing.timeSignatureAt(0).numerator;
      const startSec = regionStartForFirstBeat(result.firstBeatSec, result.bpm, beatsPerBar);
      const endMs = timelineRef.current.trimmed
        ? timelineRef.current.regionEndSec * 1000
        : (project.audio.durationMs ?? 0);
      dispatch({
        type: 'setAudioRegion',
        region: { startMs: startSec * 1000, endMs },
      });
    },
    [dispatch, project.audio.durationMs, timing],
  );

  /**
   * Detect the tempo ONCE, automatically, when a project arrives with nothing set.
   *
   * The old default was 120 BPM on every song, which is right for almost nothing and
   * meant every chart began by fixing the tempo by hand. Running detection on first open
   * makes the common case correct by default. It is deliberately conditional: an existing
   * anchor, any notes, or a previous detection all mean someone has already made a
   * decision here, and re-running would overwrite it.
   */
  const autoDetectedRef = useRef(false);
  useEffect(() => {
    if (autoDetectedRef.current) return;
    if (project.audio.detected) return;
    if (project.tracks.ExpertSingle.notes.length > 0) return;
    if (audioDuration <= 0) return;
    autoDetectedRef.current = true;

    void (async () => {
      try {
        const result = await detectTempoNow();
        if (!result) return;
        applyTempoGuess(result, true);
        setMessage({
          kind: 'info',
          text:
            result.confidence >= 0.6
              ? `Detected ${result.bpm} BPM and lined the song up to its first beat. Check it against the waveform.`
              : `Detected ${result.bpm} BPM, but the reading was unsteady — check the tempo and the start point before charting.`,
        });
      } catch {
        // Still decoding, or the browser refused. The Sync panel's button remains.
        autoDetectedRef.current = false;
      }
    })();
    // Runs on the transition to "audio is ready"; the ref makes it once-only regardless.
  }, [audioDuration, applyTempoGuess, detectTempoNow, project.audio.detected, project.tracks.ExpertSingle.notes.length]);

  // ---- keyboard ----------------------------------------------------------------

  const selectedNotes = useMemo(
    () => project.tracks[trackName].notes.filter((n) => selection.has(n.id)),
    [project.tracks, trackName, selection],
  );

  /**
   * Star power is placed point to point: arm the tool, click where the phrase starts,
   * click where it ends. It disarms itself afterwards so a stray click on the highway
   * cannot silently create a second phrase.
   */
  const toggleStarPowerTool = useCallback(() => {
    setStarPowerTool((current) => (current.active ? STAR_POWER_TOOL_OFF : STAR_POWER_TOOL_ARMED));
    setMessage(null);
  }, []);

  const handleStarPowerClick = useCallback(
    (tick: number) => {
      const result = starPowerClick(starPowerTool, tick);
      setStarPowerTool(result.state);
      if (result.kind === 'phrase') {
        dispatch({
          type: 'addStarPowerPhrase',
          track: trackName,
          tick: result.tick,
          length: result.length,
        });
        setMessage({ kind: 'info', text: 'Star power phrase added.' });
      } else if (result.kind === 'cancelled') {
        setMessage({
          kind: 'error',
          text: 'Start and end landed on the same beat, so no phrase was created.',
        });
      }
    },
    [starPowerTool, trackName],
  );

  /**
   * Fill the current difficulty by thinning Expert.
   *
   * Destructive, so it confirms when there is work to lose. Expert's star power phrases
   * come along, since a phrase is a passage of the song rather than of one difficulty.
   */
  const handleGenerateDifficulty = useCallback(() => {
    if (difficulty === 'Expert') return;
    const expert = project.tracks.ExpertSingle;
    if (expert.notes.length === 0) {
      setMessage({ kind: 'error', text: 'Chart Expert first — there is nothing to reduce.' });
      return;
    }
    const existing = project.tracks[trackName].notes.length;
    if (
      existing > 0 &&
      !window.confirm(
        `${difficulty} already has ${existing} notes. Generating replaces them all. Continue?`,
      )
    ) {
      return;
    }

    const notes = reduceNotes(expert.notes, project.resolution, difficulty);
    dispatch({
      type: 'replaceTrack',
      track: trackName,
      notes,
      starPower: expert.starPower.map((phrase) => ({ ...phrase })),
    });
    setMessage({
      kind: 'info',
      text: `${describeReduction(expert.notes.length, notes.length, difficulty)}. Undo if it is not what you wanted.`,
    });
  }, [difficulty, trackName, project.tracks, project.resolution]);

  // ---- live keyboard entry -------------------------------------------------------

  const liveEntryRef = useRef(createLiveEntryState());

  /**
   * The playhead RIGHT NOW, as a snapped tick.
   *
   * Read from the clock rather than from React state: `displayTime` only refreshes when
   * the audio element reports in, roughly four times a second, and a note placed a
   * quarter of a second behind where you heard it is worse than useless.
   */
  const liveTick = useCallback(() => {
    const chartSeconds = currentTime(clockRef.current);
    return snapTick(
      Math.max(0, timing.secToTick(chartSeconds)),
      project.resolution,
      snap,
      timing,
    );
  }, [timing, project.resolution, snap]);

  const placeLiveNote = useCallback(
    (key: string, lane: Lane, forced: boolean) => {
      const tick = liveTick();
      const id = newNoteId();
      dispatch({ type: 'addNote', track: trackName, tick, lane, forced, id });
      registerHeld(liveEntryRef.current, key, { id, lane, startTick: tick });
    },
    [liveTick, trackName],
  );

  /** Extend the selection's sustains to just before the next note on each lane. */
  const handleSustainToNext = useCallback(() => {
    const notes = project.tracks[trackName].notes;
    const changes = sustainSelectionToNext(selectedNotes, notes, {
      resolution: project.resolution,
    });
    if (changes.length === 0) {
      setMessage({ kind: 'error', text: 'Nothing to extend — no room before the next note.' });
      return;
    }
    dispatch({ type: 'setNoteLengths', track: trackName, changes });
  }, [project.tracks, project.resolution, trackName, selectedNotes]);

  /** Double-clicking a note on the highway removes it. */
  const handleDeleteNote = useCallback(
    (id: string) => {
      dispatch({ type: 'deleteNotes', track: trackName, ids: [id] });
    },
    [trackName],
  );

  const moveFret = useCallback(
    (delta: number) => {
      if (selection.size === 0) return;

      // The reducer clamps a move as a GROUP, so the selection keeps its shape rather
      // than collapsing notes onto each other at the edge of the fretboard. That is
      // right for dragging, but it means a selection already touching both ends cannot
      // move at all — and silently doing nothing is the worst possible response, since
      // it looks identical to a broken button. Detect it and say so.
      const frets = selectedNotes.filter((n) => n.lane !== 7).map((n) => n.lane);
      if (frets.length === 0) {
        setMessage({ kind: 'error', text: 'Open notes have no fret to move.' });
        return;
      }
      const blocked = delta > 0 ? Math.max(...frets) === 4 : Math.min(...frets) === 0;
      if (blocked) {
        setMessage({
          kind: 'error',
          text:
            delta > 0
              ? 'Cannot move up: the selection already reaches orange. Moving anyway would squash two frets into one.'
              : 'Cannot move down: the selection already reaches green.',
        });
        return;
      }

      setMessage(null);
      dispatch({
        type: 'moveNotes',
        track: trackName,
        ids: [...selection],
        deltaTick: 0,
        deltaLane: delta,
      });
    },
    [selection, selectedNotes, trackName],
  );

  const playheadTick = useMemo(
    () => snapTick(Math.max(0, timing.secToTick(displayTime)), project.resolution, snap, timing),
    [displayTime, timing, project.resolution, snap],
  );

  /**
   * Copy (or cut) the selection.
   *
   * The block lives in a ref, not state: it changes nothing on screen, and putting it in
   * state would re-render the whole editor on every copy. `clipboardLabel` mirrors it for
   * the toolbar, which is the only part that needs to re-render.
   */
  const handleCopy = useCallback(
    (cut: boolean) => {
      const block = copyNotes(selectedNotes);
      if (!block) {
        setMessage({ kind: 'error', text: 'Select some notes first — nothing to copy.' });
        return;
      }
      clipboardRef.current = block;
      setClipboardLabel(describeBlock(block, project.resolution));
      if (cut) {
        dispatch({ type: 'deleteNotes', track: trackName, ids: selectedNotes.map((n) => n.id) });
      }
      setMessage({
        kind: 'info',
        text: `${cut ? 'Cut' : 'Copied'} ${block.notes.length} note${block.notes.length === 1 ? '' : 's'}. Paste with Ctrl+V at the playhead.`,
      });
    },
    [selectedNotes, trackName, project.resolution],
  );

  /**
   * Paste at the playhead, into whichever difficulty is open.
   *
   * Pasting into a different difficulty from the one copied is the point, not an
   * accident: copy Expert, switch to Hard, paste, then thin it out.
   */
  const handlePaste = useCallback(() => {
    const block = clipboardRef.current;
    if (!block) {
      setMessage({ kind: 'error', text: 'Nothing copied yet — select notes and press Ctrl+C.' });
      return;
    }
    const notes = pasteAt(block, playheadTick);
    dispatch({ type: 'pasteNotes', track: trackName, notes });
    setMessage({
      kind: 'info',
      text: `Pasted ${notes.length} note${notes.length === 1 ? '' : 's'} into ${difficulty}.`,
    });
  }, [playheadTick, trackName, difficulty]);

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
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        dispatch({ type: 'selectAll', track: trackName });
        return;
      }
      if (mod && (event.key.toLowerCase() === 'c' || event.key.toLowerCase() === 'x')) {
        event.preventDefault();
        handleCopy(event.key.toLowerCase() === 'x');
        return;
      }
      if (mod && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        handlePaste();
        return;
      }
      if (mod) return;

      /**
       * ALT IS TOOLS.
       *
       * Bare letters now belong to note entry (A-G) and bare Space places an open note,
       * so every editor action that used to sit on a bare letter moved onto Alt. That
       * keeps the two sets from ever colliding: if you are playing along, nothing you
       * press can silently retag your selection.
       */
      if (event.altKey) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          moveFret(event.key === 'ArrowRight' ? 1 : -1);
          return;
        }
        const withSelection = (run: () => void) => {
          event.preventDefault();
          if (selection.size > 0) run();
          else setMessage({ kind: 'error', text: 'Select some notes first.' });
        };
        switch (event.key.toLowerCase()) {
          /*
            Convert rather than toggle, matching the note bar. Toggling was the wrong
            model: whether a note reads as a hammer-on is derived from its neighbours and
            the stored flag inverts that, so flipping the flag across a mixed selection
            turns half of it into the opposite of what was asked for.
          */
          case 'h':
            withSelection(() => handleConvertType('hopo'));
            return;
          case 't':
            withSelection(() => handleConvertType('tap'));
            return;
          case 'n':
            withSelection(() => handleConvertType('strum'));
            return;
          case 'o':
            withSelection(() =>
              dispatch({ type: 'setNotesLane', track: trackName, ids: [...selection], lane: 7 }),
            );
            return;
          case 's':
            withSelection(() => {
              for (const note of selectedNotes) {
                dispatch({ type: 'setNoteLength', track: trackName, id: note.id, length: 0 });
              }
            });
            return;
          case 'e':
            withSelection(handleSustainToNext);
            return;
          case 'p':
            event.preventDefault();
            toggleStarPowerTool();
            return;
          default:
            return;
        }
      }

      // ---- live note entry ----------------------------------------------------------
      // A S D F G and Space place notes at the playhead as the song plays. Handled
      // before the switch below so nothing else can claim those keys.
      if (isEntryKey(event.key)) {
        event.preventDefault();
        const { place } = pressKey(liveEntryRef.current, event.key, {
          repeat: event.repeat,
          shift: event.shiftKey,
        });
        if (place) placeLiveNote(event.key, place.lane, place.forced);
        return;
      }

      switch (event.key) {
        case 'Enter':
          // Play/pause moved here when Space became the open note.
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
          // Escape backs out of whatever is in progress, innermost first: an armed
          // star power placement before the selection.
          if (starPowerTool.active) setStarPowerTool(STAR_POWER_TOOL_OFF);
          else dispatch({ type: 'clearSelection' });
          break;
        case 'Home':
          event.preventDefault();
          handleSeek(0);
          break;
        // 1-5 and 0 still place a note at the playhead, for anyone who learned them
        // before A-G existed. Both schemes can coexist; the digits are not entry keys.
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
        default:
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isEntryKey(event.key)) return;
      const { note, length } = releaseKey(
        liveEntryRef.current,
        event.key,
        liveTick(),
        // Below an eighth note a hold is a tap, not a sustain — see releaseKey.
        project.resolution / 2,
      );
      if (note && length > 0) {
        dispatch({ type: 'setNoteLength', track: trackName, id: note.id, length });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    selection,
    trackName,
    togglePlay,
    handleSeek,
    save,
    playheadTick,
    moveFret,
    toggleStarPowerTool,
    starPowerTool.active,
    handleConvertType,
    handleSustainToNext,
  ]);

  const audioUrl = `/api/songs/${project.id}/audio`;
  const noteCount = project.tracks[trackName].notes.length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-4 border-b border-edge px-4 py-2">
        {/*
          A button, not a Link: leaving flushes the pending autosave first. A client-side
          route change does not fire beforeunload, so an edit made inside the debounce
          used to disappear on the way out.
        */}
        <button
          type="button"
          onClick={() => void leaveTo('/')}
          className="text-2xs uppercase tracking-widest text-faint hover:text-fg"
        >
          ← Songs
        </button>
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

      {/*
        A save clash is the one error that must not scroll past in a status line: someone
        else's work is at stake either way, so it blocks until a human chooses.
      */}
      {conflict && (
        <div className="flex flex-wrap items-center gap-3 border-b border-edge bg-panel2 px-4 py-2">
          <p className="text-2xs text-lane-orange">
            Someone else saved this song while you had it open. Your edits are still here,
            unsaved.
          </p>
          <div className="ml-auto flex gap-2">
            <button type="button" className="ch-button" onClick={() => void reloadFromServer()}>
              Discard mine, load theirs
            </button>
            <button type="button" className="ch-button" onClick={() => void overwriteServer()}>
              Keep mine, overwrite theirs
            </button>
          </div>
        </div>
      )}

      <TransportBar
        playing={playing}
        currentSeconds={displayTime}
        durationSeconds={timeline.trimmed ? timeline.totalSec : audioDuration + leadInSec}
        snap={snap}
        onSnapChange={setSnap}
        zoom={highwayZoom}
        onZoomChange={setHighwayZoom}
        playbackRate={playbackRate}
        onPlaybackRateChange={setPlaybackRate}
        onTogglePlay={togglePlay}
        onSeek={handleSeek}
        onSave={() => void save()}
        onExport={() => setExportOpen(true)}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        dirty={dirty}
        saving={saving}
        exporting={exporting}
        onShowHelp={() => setHelpOpen(true)}
        metronomeOn={metronomeOn}
        onToggleMetronome={() => setMetronomeOn((v) => !v)}
      />

      <WaveformPanel
        audioUrl={audioUrl}
        handleRef={waveformRef}
        onTimeUpdate={handleTimeUpdate}
        onReady={setAudioDuration}
        onError={(text) => setMessage({ kind: 'error', text })}
        zoom={waveZoom}
        leadInSec={timeline.leadInSec}
        leadInLabel={describeLeadIn(project.meta.leadIn)}
        region={
          project.audio.region
            ? {
                startSec: project.audio.region.startMs / 1000,
                endSec: project.audio.region.endMs / 1000,
              }
            : null
        }
        onRegionChange={handleRegionChange}
        selecting={regionSelecting}
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
          {/*
            Generating sits with the difficulty tabs because that is where you are when
            you notice Hard is empty. It replaces the difficulty, so it asks first.
          */}
          {difficulty !== 'Expert' && (
            <button
              type="button"
              className="ch-button my-1 ml-3 self-center"
              onClick={handleGenerateDifficulty}
              disabled={project.tracks.ExpertSingle.notes.length === 0}
              title={
                project.tracks.ExpertSingle.notes.length === 0
                  ? 'Chart Expert first — there is nothing to reduce'
                  : `Fill ${difficulty} by thinning the Expert chart`
              }
            >
              Generate from Expert
            </button>
          )}
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

      <NoteToolbar
        selectedNotes={selectedNotes}
        totalNotes={project.tracks[trackName].notes.length}
        onSelectAll={() => dispatch({ type: 'selectAll', track: trackName })}
        onClearSelection={() => dispatch({ type: 'clearSelection' })}
        onMoveFret={moveFret}
        onSetLane={(lane) =>
          dispatch({ type: 'setNotesLane', track: trackName, ids: [...selection], lane })
        }
        onConvertType={handleConvertType}
        onSelectByType={handleSelectByType}
        onClearSustain={() => {
          for (const note of selectedNotes) {
            dispatch({ type: 'setNoteLength', track: trackName, id: note.id, length: 0 });
          }
        }}
        onDelete={() => dispatch({ type: 'deleteNotes', track: trackName, ids: [...selection] })}
        onSustain={handleSustainToNext}
        onAutoChart={handleAutoChart}
        autoCharting={autoCharting}
        onCopy={handleCopy}
        onPaste={handlePaste}
        clipboardLabel={clipboardLabel}
        starPowerArmed={starPowerTool.active}
        starPowerHint={starPowerHint(starPowerTool)}
        onToggleStarPowerTool={toggleStarPowerTool}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
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
            starPowerTool={starPowerTool}
            onStarPowerClick={handleStarPowerClick}
            onDeleteNote={handleDeleteNote}
          />
          <KeyLegend />
        </div>

        {/*
          The panel is a reference surface, not something you look at while placing notes,
          so it folds away and hands its width to the highway.
        */}
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? 'Hide the panel' : 'Show the panel'}
          className="w-4 shrink-0 border-l border-edge bg-panel text-2xs text-faint hover:text-fg"
        >
          {sidebarOpen ? '›' : '‹'}
        </button>

        <aside
          className={`${sidebarOpen ? 'flex w-72' : 'hidden'} shrink-0 flex-col border-l border-edge bg-panel`}
        >
          <nav className="flex shrink-0 border-b border-edge">
            {(['sections', 'song', 'sync', 'check'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setSidebarTab(tab)}
                className={`ch-tab flex-1 ${sidebarTab === tab ? 'ch-tab-active' : ''}`}
              >
                {tab === 'sections'
                  ? 'Chart'
                  : tab === 'song'
                    ? 'Song'
                    : tab === 'sync'
                      ? 'Sync'
                      : 'Check'}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {sidebarTab === 'check' ? (
              <ChartCheckPanel
                project={project}
                onSeekToTick={(tick) => handleSeek(timing.tickToSec(tick))}
              />
            ) : sidebarTab === 'sections' ? (
              <SectionsPanel
                project={project}
                trackName={trackName}
                timing={timing}
                playheadTick={playheadTick}
                dispatch={dispatch}
                onSeekToTick={(tick) => handleSeek(timing.tickToSec(tick))}
                onSelectSection={handleSelectSection}
              />
            ) : sidebarTab === 'song' ? (
              <SongPropertiesPanel
                project={project}
                dispatch={dispatch}
                onAlbumChanged={(filename) =>
                  setMessage({ kind: 'info', text: `Album art updated (${filename}).` })
                }
                onRequestReimport={() => setReimportOpen(true)}
              />
            ) : (
              <SyncPanel
                project={project}
                timing={timing}
                timeline={timeline}
                playheadTick={playheadTick}
                dispatch={dispatch}
                onSeekToTick={(tick) => handleSeek(timing.tickToSec(tick))}
                onDetectTempo={detectTempoNow}
                onApplyTempo={applyTempoGuess}
                onLeadInChange={handleLeadInChange}
                onNudgeStart={nudgeRegionStart}
                onStartRegionSelect={() => setRegionSelecting(true)}
                onClearRegion={clearRegion}
                regionSelecting={regionSelecting}
              />
            )}
          </div>
        </aside>
      </div>

      <footer className="flex items-center gap-4 border-t border-edge bg-panel px-4 py-1.5 text-2xs text-faint">
        <span>{noteCount} notes in {difficulty}</span>
        <span>{selection.size} selected</span>
        <span>{project.tracks[trackName].starPower.length} star power</span>
        <button
          type="button"
          className="ml-auto text-2xs text-faint underline-offset-2 hover:text-fg hover:underline"
          onClick={() => setHelpOpen(true)}
        >
          Keyboard shortcuts
        </button>
      </footer>

      <ExportDialog
        songId={project.id}
        project={project}
        open={exportOpen}
        exporting={exporting}
        onClose={() => setExportOpen(false)}
        onExport={(options) => void handleExport(options)}
      />

      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />

      <ReimportDialog
        project={project}
        open={reimportOpen}
        onClose={() => setReimportOpen(false)}
        onApplied={(updated, note) => {
          // The server has already written this, so reset rather than marking dirty —
          // otherwise the autosave would immediately write it straight back.
          revisionRef.current = updated.revision ?? 0;
          dispatch({ type: 'reset', project: updated });
          setMessage({
            kind: 'info',
            text: note ?? `Re-imported: ${updated.tracks.ExpertSingle.notes.length} Expert notes.`,
          });
        }}
      />
    </div>
  );
}
