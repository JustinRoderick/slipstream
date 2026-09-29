import { OneEuroFilter } from "./one-euro-filter";
import type { HeadPose } from "./types";

/**
 * Steering command for the ship, both axes in [-1, 1].
 * `x` > 0 → steer right, `y` > 0 → steer up.
 */
export interface Steer {
  x: number;
  y: number;
}

/** The player's resting head pose; everything is measured relative to this. */
export interface NeutralPose {
  yaw: number;
  pitch: number;
  x: number;
  y: number;
}

export type HeadControlMode = "rotation" | "position" | "blend";

export interface HeadControlSettings {
  /**
   * Which head signal drives the ship:
   * - `rotation`: turning/nodding the head (yaw/pitch angles).
   * - `position`: moving/leaning the head (x/y translation).
   * - `blend`: both added together, so either style of movement works.
   */
  mode: HeadControlMode;
  /** Overall gain. 1 = full deflection at the configured ranges. */
  sensitivity: number;
  /** Flip left/right. Off: turning your head right steers right. */
  invertX: boolean;
  /**
   * Flip up/down. On (default): moving your head UP steers the ship DOWN,
   * like pushing a flight stick forward, which is what makes it feel like
   * you are flying the ship rather than pointing at the screen.
   */
  invertY: boolean;
  /**
   * Front-facing cameras deliver an un-mirrored image, in which the user's
   * right appears on the left. Mirroring makes "user moves right" positive so
   * the ship follows the player the way a mirror would.
   */
  mirrorX: boolean;
  /** Radius around the neutral pose that is ignored, in normalized units. */
  deadzone: number;
  /** 0 = linear response, 1 = fully cubic (soft near center, sharp at the edges). */
  expo: number;
  /** Head yaw (degrees from neutral) needed for full left/right deflection. */
  yawRangeDeg: number;
  /** Head pitch (degrees from neutral) needed for full up/down deflection. */
  pitchRangeDeg: number;
  /** Head translation (cm from neutral) needed for full deflection. */
  xRangeCm: number;
  yRangeCm: number;
  /** One Euro filter tuning. */
  filterMinCutoff: number;
  filterBeta: number;
  /** When the face is lost, steering eases back to center with this time constant (seconds). */
  lostDecaySeconds: number;
  /**
   * A pose older than this (ms) counts as lost, e.g. when the camera stalls.
   * The effective threshold grows automatically on slow trackers (see `isLost`).
   */
  staleAfterMs: number;
}

export const DEFAULT_HEAD_CONTROL_SETTINGS: HeadControlSettings = {
  mode: "blend",
  sensitivity: 1,
  invertX: false,
  invertY: true,
  mirrorX: true,
  deadzone: 0.06,
  expo: 0.25,
  yawRangeDeg: 16,
  pitchRangeDeg: 12,
  xRangeCm: 7,
  yRangeCm: 5,
  filterMinCutoff: 1.2,
  filterBeta: 0.04,
  lostDecaySeconds: 0.6,
  staleAfterMs: 400,
};

/**
 * Maps head poses to steering commands.
 *
 * Pipeline per sample:
 *   pose − neutral → normalize by range → combine per mode → mirror → gain
 *   → One Euro filter → dead zone → expo curve → clamp → invert.
 *
 * Feed every tracker sample into `update()` (pass `null` when no face is
 * visible) and call `read()` from the game loop to get the current command.
 */
export class HeadControlMapper {
  private settings: HeadControlSettings;
  private neutral: NeutralPose | null = null;
  private readonly filterX: OneEuroFilter;
  private readonly filterY: OneEuroFilter;
  private current: Steer = { x: 0, y: 0 };
  private rawSignal: Steer = { x: 0, y: 0 };
  private lastPoseAt = -Infinity;
  private lastReadAt: number | null = null;
  private lastPose: HeadPose | null = null;
  /** Smoothed spacing between valid poses, ms (0 until two poses have arrived). */
  private sampleIntervalMs = 0;

  constructor(settings: Partial<HeadControlSettings> = {}) {
    this.settings = { ...DEFAULT_HEAD_CONTROL_SETTINGS, ...settings };
    this.filterX = new OneEuroFilter(this.settings.filterMinCutoff, this.settings.filterBeta);
    this.filterY = new OneEuroFilter(this.settings.filterMinCutoff, this.settings.filterBeta);
  }

  getSettings(): HeadControlSettings {
    return { ...this.settings };
  }

  setSettings(patch: Partial<HeadControlSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.filterX.minCutoff = this.filterY.minCutoff = this.settings.filterMinCutoff;
    this.filterX.beta = this.filterY.beta = this.settings.filterBeta;
  }

  getNeutral(): NeutralPose | null {
    return this.neutral ? { ...this.neutral } : null;
  }

  /** Sets (or clears) the resting pose. Filters are reset so there is no jump. */
  setNeutral(neutral: NeutralPose | null): void {
    this.neutral = neutral ? { ...neutral } : null;
    this.filterX.reset();
    this.filterY.reset();
  }

  get isCalibrated(): boolean {
    return this.neutral !== null;
  }

  /** Last pose fed in (for debug displays). */
  get pose(): HeadPose | null {
    return this.lastPose;
  }

  /** Normalized signal before filtering/dead zone (for debug displays). */
  get raw(): Steer {
    return { ...this.rawSignal };
  }

  /** Ingest a tracker sample. `null` means the face was not detected this frame. */
  update(pose: HeadPose | null): Steer {
    if (!pose) {
      this.lastPose = null;
      return { ...this.current };
    }
    this.lastPose = pose;
    if (this.lastPoseAt !== -Infinity) {
      const gap = Math.max(0, pose.timestamp - this.lastPoseAt);
      this.sampleIntervalMs =
        this.sampleIntervalMs === 0
          ? gap
          : this.sampleIntervalMs + (gap - this.sampleIntervalMs) * 0.2;
    }
    this.lastPoseAt = pose.timestamp;

    const s = this.settings;
    const n = this.neutral ?? { yaw: pose.yaw, pitch: pose.pitch, x: pose.x, y: pose.y };

    const rot = {
      x: (pose.yaw - n.yaw) / s.yawRangeDeg,
      y: (pose.pitch - n.pitch) / s.pitchRangeDeg,
    };
    const pos = {
      x: (pose.x - n.x) / s.xRangeCm,
      y: (pose.y - n.y) / s.yRangeCm,
    };

    let x: number;
    let y: number;
    switch (s.mode) {
      case "rotation":
        x = rot.x;
        y = rot.y;
        break;
      case "position":
        x = pos.x;
        y = pos.y;
        break;
      default:
        x = rot.x + pos.x;
        y = rot.y + pos.y;
    }

    if (s.mirrorX) x = -x;
    x *= s.sensitivity;
    y *= s.sensitivity;
    this.rawSignal = { x, y };

    x = this.filterX.filter(x, pose.timestamp);
    y = this.filterY.filter(y, pose.timestamp);

    x = shapeAxis(x, s.deadzone, s.expo);
    y = shapeAxis(y, s.deadzone, s.expo);

    if (s.invertX) x = -x;
    if (s.invertY) y = -y;

    // `|| 0` turns -0 into 0 so debug output never shows "-0.00".
    this.current = { x: x || 0, y: y || 0 };
    return { ...this.current };
  }

  /**
   * Current steering command. When tracking is lost or stale the command
   * decays smoothly toward center instead of freezing or snapping.
   */
  read(nowMs: number): Steer {
    const dt = this.lastReadAt === null ? 0 : Math.max(0, (nowMs - this.lastReadAt) / 1000);
    this.lastReadAt = nowMs;

    if (this.isLost(nowMs) && dt > 0) {
      const k = Math.exp(-dt / Math.max(1e-3, this.settings.lostDecaySeconds));
      this.current = { x: this.current.x * k, y: this.current.y * k };
      if (Math.abs(this.current.x) < 1e-4) this.current.x = 0;
      if (Math.abs(this.current.y) < 1e-4) this.current.y = 0;
    }
    return { ...this.current };
  }

  /**
   * True when no usable pose has arrived recently. "Recently" is the larger of
   * `staleAfterMs` and ~2.5 sample intervals, so a slow tracker (e.g. 5 fps on
   * a weak GPU) is not misreported as lost between every two samples.
   */
  isLost(nowMs: number): boolean {
    if (this.lastPose === null) return true;
    const threshold = Math.max(this.settings.staleAfterMs, this.sampleIntervalMs * 2.5);
    return nowMs - this.lastPoseAt > threshold;
  }

  /** Smoothed time between valid poses, ms (for diagnostics). */
  get sampleInterval(): number {
    return this.sampleIntervalMs;
  }

  reset(): void {
    this.current = { x: 0, y: 0 };
    this.rawSignal = { x: 0, y: 0 };
    this.lastPose = null;
    this.lastPoseAt = -Infinity;
    this.lastReadAt = null;
    this.sampleIntervalMs = 0;
    this.filterX.reset();
    this.filterY.reset();
  }
}

/**
 * Dead zone (rescaled so the output stays continuous at the edge), then an
 * exponential response curve, then clamp to [-1, 1].
 */
export function shapeAxis(v: number, deadzone: number, expo: number): number {
  const mag = Math.abs(v);
  if (mag <= deadzone) return 0;
  const dz = Math.min(0.99, Math.max(0, deadzone));
  let out = Math.min(1, (mag - dz) / (1 - dz));
  out = out * (1 - expo) + out * out * out * expo;
  return v < 0 ? -out : out;
}
