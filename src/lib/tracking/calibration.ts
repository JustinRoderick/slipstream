import type { NeutralPose } from "./head-control-mapper";
import type { HeadPose } from "./types";

export interface CalibrationOptions {
  /** How long to sample the resting pose, ms. */
  durationMs: number;
  /** Refuse to finish with fewer samples than this (guards against a stalled camera). */
  minSamples: number;
}

const DEFAULT_OPTIONS: CalibrationOptions = { durationMs: 1500, minSamples: 12 };

/**
 * Captures the player's resting head pose by collecting samples for a short
 * window and taking the per-axis median (robust to the odd bad frame).
 */
export class NeutralPoseCalibrator {
  private readonly options: CalibrationOptions;
  private startedAt: number | null = null;
  private samples: HeadPose[] = [];
  private finished: NeutralPose | null = null;

  constructor(options: Partial<CalibrationOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(nowMs: number): void {
    this.startedAt = nowMs;
    this.samples = [];
    this.finished = null;
  }

  get isRunning(): boolean {
    return this.startedAt !== null && this.finished === null;
  }

  /**
   * 0..1 progress. Both the time window and the sample count must complete, so
   * the bar tracks whichever is further behind (a slow tracker or a hidden
   * face makes it wait rather than showing 100% too early).
   */
  progress(nowMs: number): number {
    if (this.startedAt === null) return 0;
    if (this.finished) return 1;
    const byTime = (nowMs - this.startedAt) / this.options.durationMs;
    const bySamples = this.samples.length / this.options.minSamples;
    return Math.max(0, Math.min(1, byTime, bySamples));
  }

  /**
   * Feed a tracker sample. Returns the neutral pose once the window is
   * complete, otherwise null. Samples with no face are ignored (the timer
   * keeps running so a hidden face just makes calibration take longer).
   */
  add(pose: HeadPose | null, nowMs: number): NeutralPose | null {
    if (this.startedAt === null || this.finished) return this.finished;
    if (pose) this.samples.push(pose);

    const elapsed = nowMs - this.startedAt;
    if (elapsed >= this.options.durationMs && this.samples.length >= this.options.minSamples) {
      this.finished = {
        yaw: median(this.samples.map((p) => p.yaw)),
        pitch: median(this.samples.map((p) => p.pitch)),
        x: median(this.samples.map((p) => p.x)),
        y: median(this.samples.map((p) => p.y)),
      };
      return this.finished;
    }
    return null;
  }

  get result(): NeutralPose | null {
    return this.finished;
  }

  reset(): void {
    this.startedAt = null;
    this.samples = [];
    this.finished = null;
  }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
