import type { Rng } from "./rng";
import type { Asteroid, Bounds, ShipState, Vec3 } from "./types";

export interface AsteroidFieldConfig {
  /** Pool size; also the max number of simultaneously active asteroids. */
  maxCount: number;
  /** Asteroids appear at this z (ahead of the ship, which sits at z = 0). */
  spawnZ: number;
  /** Depth jitter applied at spawn so waves don't arrive as flat walls. */
  spawnDepthJitter: number;
  /** Asteroids are recycled once they pass this z (behind the camera). */
  despawnZ: number;
  /** Spawn area = corridor bounds × this factor (a bit larger so edges aren't safe). */
  spawnSpreadFactor: number;
  minRadius: number;
  maxRadius: number;
  /** Minimum clear space between neighbouring asteroids (world units). Keeps the field passable. */
  minGap: number;
  /** Asteroids within this z-distance count as neighbours for the gap rule. */
  neighbourDepth: number;
  /** Rejection-sampling attempts before giving up on a spawn. */
  maxSpawnAttempts: number;
  /** Max lateral drift speed, world units / s. */
  maxDrift: number;
  /** Max spin, rad / s. */
  maxSpin: number;
  /**
   * Collision forgiveness: the asteroid's collision radius is its visual radius
   * times this. Slightly under 1 feels fair because the lumpy meshes rarely
   * fill their bounding sphere.
   */
  hitboxScale: number;
}

export const DEFAULT_ASTEROID_FIELD_CONFIG: AsteroidFieldConfig = {
  maxCount: 160,
  spawnZ: -240,
  spawnDepthJitter: 12,
  despawnZ: 16,
  spawnSpreadFactor: 1.15,
  minRadius: 0.9,
  maxRadius: 3.6,
  minGap: 2.4,
  neighbourDepth: 14,
  maxSpawnAttempts: 12,
  maxDrift: 1.2,
  maxSpin: 1.5,
  hitboxScale: 0.9,
};

export interface AsteroidHit {
  asteroid: Asteroid;
  at: Vec3;
}

export interface AsteroidPass {
  asteroid: Asteroid;
  /** Closest lateral approach to the ship, minus both radii (≥ 0). */
  margin: number;
}

export interface FieldStepResult {
  hit: AsteroidHit | null;
  passed: AsteroidPass[];
}

/**
 * The asteroid field: a fixed pool of asteroids that spawn far ahead, stream
 * toward the ship, and are recycled once they fly past.
 */
export class AsteroidField {
  readonly asteroids: Asteroid[];
  private nextId = 1;

  constructor(
    readonly config: AsteroidFieldConfig,
    private readonly rng: Rng,
  ) {
    this.asteroids = Array.from({ length: config.maxCount }, (_, i) => createAsteroid(i));
  }

  get activeCount(): number {
    let n = 0;
    for (const a of this.asteroids) if (a.active) n++;
    return n;
  }

  reset(): void {
    for (const a of this.asteroids) a.active = false;
  }

  /**
   * Tries to place one new asteroid. Returns it, or null if the pool is full or
   * no non-overlapping spot was found (the field is dense enough already).
   */
  spawn(bounds: Bounds): Asteroid | null {
    const slot = this.asteroids.find((a) => !a.active);
    if (!slot) return null;

    const c = this.config;
    const rng = this.rng;
    const halfW = bounds.halfWidth * c.spawnSpreadFactor;
    const halfH = bounds.halfHeight * c.spawnSpreadFactor;

    for (let attempt = 0; attempt < c.maxSpawnAttempts; attempt++) {
      // Square the roll so small rocks are common and big ones rare.
      const u = rng.next();
      const radius = c.minRadius + (c.maxRadius - c.minRadius) * u * u;
      const x = rng.spread(halfW);
      const y = rng.spread(halfH);
      const z = c.spawnZ - rng.next() * c.spawnDepthJitter;

      if (!this.hasRoom(x, y, z, radius)) continue;

      slot.id = this.nextId++;
      slot.active = true;
      slot.passed = false;
      slot.position.x = x;
      slot.position.y = y;
      slot.position.z = z;
      slot.radius = radius;
      slot.scale.x = radius * rng.range(0.75, 1.25);
      slot.scale.y = radius * rng.range(0.75, 1.25);
      slot.scale.z = radius * rng.range(0.75, 1.25);
      slot.drift.x = rng.spread(c.maxDrift);
      slot.drift.y = rng.spread(c.maxDrift);
      const ax = rng.spread(1);
      const ay = rng.spread(1);
      const az = rng.spread(1);
      const len = Math.hypot(ax, ay, az) || 1;
      slot.spinAxis.x = ax / len;
      slot.spinAxis.y = ay / len;
      slot.spinAxis.z = az / len;
      slot.spinSpeed = rng.spread(c.maxSpin);
      slot.spinAngle = rng.next() * Math.PI * 2;
      return slot;
    }
    return null;
  }

  private hasRoom(x: number, y: number, z: number, radius: number): boolean {
    const c = this.config;
    for (const other of this.asteroids) {
      if (!other.active) continue;
      if (Math.abs(other.position.z - z) > c.neighbourDepth) continue;
      const d = Math.hypot(other.position.x - x, other.position.y - y);
      if (d < other.radius + radius + c.minGap) return false;
    }
    return true;
  }

  /**
   * Moves every active asteroid toward the ship by `speed·dt`, recycles the
   * ones that are behind the camera, and reports the first collision plus any
   * asteroids that cleared the ship this step.
   *
   * Collision uses a swept test (closest point on the asteroid's movement
   * segment to the ship) so fast asteroids can't tunnel through the ship
   * between frames.
   */
  step(dt: number, speed: number, ship: ShipState): FieldStepResult {
    const c = this.config;
    const result: FieldStepResult = { hit: null, passed: [] };
    const sp = ship.position;

    for (const a of this.asteroids) {
      if (!a.active) continue;

      const prevX = a.position.x;
      const prevY = a.position.y;
      const prevZ = a.position.z;

      a.position.x += a.drift.x * dt;
      a.position.y += a.drift.y * dt;
      a.position.z += speed * dt;
      a.spinAngle += a.spinSpeed * dt;

      const hitRadius = ship.radius + a.radius * c.hitboxScale;

      // Collision is tested before recycling so an asteroid can never cross
      // the ship and leave the field within the same step unnoticed.
      if (!result.hit && !a.passed) {
        const closest = closestPointOnSegment(
          prevX,
          prevY,
          prevZ,
          a.position.x,
          a.position.y,
          a.position.z,
          sp.x,
          sp.y,
          sp.z,
        );
        const d = Math.hypot(closest.x - sp.x, closest.y - sp.y, closest.z - sp.z);
        if (d < hitRadius) {
          result.hit = { asteroid: a, at: closest };
          continue;
        }
      }

      // Fully past the ship's plane without a hit ⇒ dodged.
      if (!a.passed && a.position.z - a.radius > sp.z + ship.radius) {
        a.passed = true;
        const lateral = Math.hypot(a.position.x - sp.x, a.position.y - sp.y);
        result.passed.push({ asteroid: a, margin: Math.max(0, lateral - hitRadius) });
      }

      if (a.position.z - a.radius > c.despawnZ) {
        a.active = false;
      }
    }

    return result;
  }
}

function createAsteroid(index: number): Asteroid {
  return {
    id: -(index + 1),
    active: false,
    position: { x: 0, y: 0, z: 0 },
    radius: 1,
    scale: { x: 1, y: 1, z: 1 },
    drift: { x: 0, y: 0 },
    spinAxis: { x: 0, y: 1, z: 0 },
    spinSpeed: 0,
    spinAngle: 0,
    passed: false,
  };
}

function closestPointOnSegment(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  px: number,
  py: number,
  pz: number,
): Vec3 {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-12) return { x: ax, y: ay, z: az };
  let t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: ax + dx * t, y: ay + dy * t, z: az + dz * t };
}
