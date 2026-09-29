export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Steering input, both axes in [-1, 1]; +x = right, +y = up. */
export interface Steer {
  x: number;
  y: number;
}

/** Half-extents of the rectangular corridor the ship can fly in (world units). */
export interface Bounds {
  halfWidth: number;
  halfHeight: number;
}

export type GamePhase = "ready" | "running" | "paused" | "crashed";

export interface ShipState {
  /** World position. The ship always sits at z = 0; the world moves past it. */
  position: Vec3;
  /** Lateral velocity (world units / s). */
  velocity: Vec2;
  /** Collision radius. */
  radius: number;
  /** Visual roll around the forward axis, radians (positive = right wing down). */
  bank: number;
  /** Visual pitch, radians (positive = nose up). */
  pitch: number;
}

export interface Asteroid {
  id: number;
  active: boolean;
  position: Vec3;
  /** Collision radius. */
  radius: number;
  /** Per-axis visual scale (non-uniform for a lumpy look); mean ≈ radius. */
  scale: Vec3;
  /** Slow lateral drift, world units / s. */
  drift: Vec2;
  /** Spin axis (unit) and angular speed (rad/s), visual only. */
  spinAxis: Vec3;
  spinSpeed: number;
  spinAngle: number;
  /** Set once the asteroid has flown past the ship without hitting it. */
  passed: boolean;
}

export interface CrashInfo {
  asteroidId: number;
  at: Vec3;
  time: number;
}

export interface GameState {
  phase: GamePhase;
  /** Seconds spent in the running phase this run. */
  time: number;
  /** Forward distance travelled this run (world units). */
  distance: number;
  score: number;
  /** Current forward speed (world units / s). */
  speed: number;
  /** Asteroids that flew past without a hit. */
  dodged: number;
  ship: ShipState;
  /** Fixed-size pool; check `active`. */
  asteroids: Asteroid[];
  crash: CrashInfo | null;
  pauseReason: string | null;
  /** Steering command applied during the last update (for HUD/debug). */
  steer: Steer;
  best: number;
}

export type GameEvent =
  | { type: "started" }
  | { type: "paused"; reason: string | null }
  | { type: "resumed" }
  | { type: "crashed"; crash: CrashInfo; score: number; isBest: boolean }
  | { type: "dodged"; asteroidId: number; margin: number }
  | { type: "reset" };
