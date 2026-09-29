import type { Bounds, ShipState, Steer } from "./types";

export type ShipControlMode = "position" | "rate";

export interface ShipConfig {
  radius: number;
  /**
   * - `position`: the steering command picks a target spot in the corridor and
   *   the ship flies there on a damped spring. Predictable: hold your head
   *   still and the ship holds its place. Default.
   * - `rate`: the steering command sets lateral velocity, like a joystick.
   */
  control: ShipControlMode;
  /** Spring stiffness toward the target position (position mode). */
  stiffness: number;
  /** Spring damping (≈ 2·√stiffness is critically damped). */
  damping: number;
  /** Cap on lateral speed, world units / s. */
  maxSpeed: number;
  /** Full-deflection lateral speed (rate mode). */
  rateSpeed: number;
  /** How quickly velocity follows the command in rate mode (1/s). */
  rateResponse: number;
  /** Visual bank per unit of lateral velocity, radians. */
  bankPerVelocity: number;
  maxBank: number;
  /** Visual pitch per unit of vertical velocity, radians. */
  pitchPerVelocity: number;
  maxPitch: number;
  /** How fast the visual attitude settles (1/s). */
  attitudeResponse: number;
}

export const DEFAULT_SHIP_CONFIG: ShipConfig = {
  radius: 0.7,
  control: "position",
  stiffness: 70,
  damping: 16,
  maxSpeed: 34,
  rateSpeed: 16,
  rateResponse: 8,
  bankPerVelocity: 0.05,
  maxBank: 0.9,
  pitchPerVelocity: 0.035,
  maxPitch: 0.6,
  attitudeResponse: 10,
};

export function createShipState(config: ShipConfig): ShipState {
  return {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0 },
    radius: config.radius,
    bank: 0,
    pitch: 0,
  };
}

export function resetShip(ship: ShipState): void {
  ship.position.x = 0;
  ship.position.y = 0;
  ship.position.z = 0;
  ship.velocity.x = 0;
  ship.velocity.y = 0;
  ship.bank = 0;
  ship.pitch = 0;
}

/** Advances the ship by `dt` seconds under the given steering command. Mutates `ship`. */
export function updateShip(
  ship: ShipState,
  steer: Steer,
  bounds: Bounds,
  config: ShipConfig,
  dt: number,
): void {
  const sx = clamp(steer.x, -1, 1);
  const sy = clamp(steer.y, -1, 1);
  const { position: p, velocity: v } = ship;

  if (config.control === "position") {
    const targetX = sx * bounds.halfWidth;
    const targetY = sy * bounds.halfHeight;
    // Semi-implicit Euler on a damped spring: stable for the dt range a browser produces.
    v.x += ((targetX - p.x) * config.stiffness - v.x * config.damping) * dt;
    v.y += ((targetY - p.y) * config.stiffness - v.y * config.damping) * dt;
  } else {
    const k = 1 - Math.exp(-config.rateResponse * dt);
    v.x += (sx * config.rateSpeed - v.x) * k;
    v.y += (sy * config.rateSpeed - v.y) * k;
  }

  const speed = Math.hypot(v.x, v.y);
  if (speed > config.maxSpeed) {
    const s = config.maxSpeed / speed;
    v.x *= s;
    v.y *= s;
  }

  p.x += v.x * dt;
  p.y += v.y * dt;

  // Keep the ship inside the corridor; kill velocity into the wall so it doesn't stick.
  if (p.x > bounds.halfWidth) {
    p.x = bounds.halfWidth;
    if (v.x > 0) v.x = 0;
  } else if (p.x < -bounds.halfWidth) {
    p.x = -bounds.halfWidth;
    if (v.x < 0) v.x = 0;
  }
  if (p.y > bounds.halfHeight) {
    p.y = bounds.halfHeight;
    if (v.y > 0) v.y = 0;
  } else if (p.y < -bounds.halfHeight) {
    p.y = -bounds.halfHeight;
    if (v.y < 0) v.y = 0;
  }

  // Visual attitude follows velocity: bank into turns, pitch into climbs.
  const targetBank = clamp(-v.x * config.bankPerVelocity, -config.maxBank, config.maxBank);
  const targetPitch = clamp(v.y * config.pitchPerVelocity, -config.maxPitch, config.maxPitch);
  const a = 1 - Math.exp(-config.attitudeResponse * dt);
  ship.bank += (targetBank - ship.bank) * a;
  ship.pitch += (targetPitch - ship.pitch) * a;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
