import type { TimingMap } from '../chart/timing';

/**
 * A metronome that follows the chart's tempo map.
 *
 * WHY NOT setInterval: JavaScript timers drift by tens of milliseconds and are throttled
 * in background tabs, which is exactly the error a metronome exists to expose. Instead
 * each click is SCHEDULED AHEAD against the AudioContext's own hardware clock, which is
 * the same clock the audio is played on. A short look-ahead window is refreshed by a
 * coarse timer; the timer only decides *when to schedule*, never when a click sounds.
 * This is the standard "A Tale of Two Clocks" approach and it is the only way to get
 * clicks that stay tight over a whole song.
 *
 * It follows the tempo map rather than a single BPM, so a song that changes tempo keeps
 * a correct click — and because beats come from `TimingMap.gridLines`, the clicks land on
 * exactly the same beats the highway draws.
 */

/** How far ahead clicks are scheduled, in seconds. */
const LOOKAHEAD_SEC = 0.25;
/** How often the scheduler wakes to top up that window, in milliseconds. */
const TICK_MS = 60;

export interface MetronomeOptions {
  /** Chart seconds at the moment `start` is called. */
  positionSec: number;
  /** Playback rate, so clicks track a slowed-down song. */
  rate: number;
  volume: number;
}

export class Metronome {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private timing: TimingMap | null = null;
  private resolution = 192;

  /** Chart seconds already scheduled — the scheduler never looks back past this. */
  private scheduledUpTo = 0;
  /** AudioContext time corresponding to `scheduledUpTo`. */
  private anchorContextTime = 0;
  private anchorChartSec = 0;
  private rate = 1;
  private volume = 0.4;

  setTiming(timing: TimingMap, resolution: number): void {
    this.timing = timing;
    this.resolution = resolution;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  /**
   * Begin clicking from `positionSec`.
   *
   * Safe to call when already running: it re-anchors, which is what a seek needs.
   */
  start(options: MetronomeOptions): void {
    if (!this.timing) return;
    // Created lazily and on a user gesture, since browsers refuse to start an
    // AudioContext any other way.
    this.context ??= new AudioContext();
    void this.context.resume();

    this.rate = options.rate > 0 ? options.rate : 1;
    this.volume = options.volume;
    this.anchorChartSec = options.positionSec;
    this.anchorContextTime = this.context.currentTime;
    this.scheduledUpTo = options.positionSec;

    if (this.timer === null) {
      this.timer = setInterval(() => this.schedule(), TICK_MS);
    }
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    void this.context?.close();
    this.context = null;
  }

  /** Fill the look-ahead window with any beats that fall inside it. */
  private schedule(): void {
    const context = this.context;
    const timing = this.timing;
    if (!context || !timing) return;

    // Chart time now, derived from the audio clock rather than from wall time.
    const elapsed = (context.currentTime - this.anchorContextTime) * this.rate;
    const chartNow = this.anchorChartSec + elapsed;
    const until = chartNow + LOOKAHEAD_SEC * this.rate;

    const fromTick = Math.max(0, timing.secToTick(this.scheduledUpTo));
    const toTick = Math.max(fromTick, timing.secToTick(until));

    // Beat lines only — the same beats the highway draws, so a click always coincides
    // with a line on screen.
    for (const line of timing.gridLines(fromTick, toTick, this.resolution)) {
      if (line.kind === 'sub') continue;
      const beatSec = timing.tickToSec(line.tick);
      if (beatSec < this.scheduledUpTo || beatSec > until) continue;

      const when =
        this.anchorContextTime + (beatSec - this.anchorChartSec) / this.rate;
      if (when >= context.currentTime) this.click(when, line.kind === 'measure');
    }

    this.scheduledUpTo = until;
  }

  /** One click. Downbeats are higher and louder, so bars are audible without counting. */
  private click(when: number, isMeasure: boolean): void {
    const context = this.context;
    if (!context) return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = isMeasure ? 1600 : 1000;
    oscillator.connect(gain);
    gain.connect(context.destination);

    const peak = this.volume * (isMeasure ? 1 : 0.6);
    // A very short percussive envelope: a click, not a beep. Ramps rather than steps,
    // because an abrupt gain change is audible as a pop in its own right.
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);

    oscillator.start(when);
    oscillator.stop(when + 0.06);
  }
}
