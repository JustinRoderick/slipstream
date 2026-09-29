import {
  AsteroidField,
  DEFAULT_ASTEROID_FIELD_CONFIG,
  type AsteroidFieldConfig,
} from "./asteroid-field";
import { Rng } from "./rng";
import {
  createShipState,
  DEFAULT_SHIP_CONFIG,
  resetShip,
  updateShip,
  type ShipConfig,
  type ShipControlMode,
} from "./ship";
import type { Bounds, GameEvent, GameState, Steer } from "./types";

export interface DifficultyConfig {
  /** Forward speed at the start of a run, world units / s. */
  startSpeed: number;
  /** Forward speed once the ramp is complete. */
  endSpeed: number;
  /** Seconds until difficulty stops increasing. */
  rampSeconds: number;
  /** Seconds between spawns at the start / end of the ramp. */
  startSpawnInterval: number;
  endSpawnInterval: number;
}

export interface ScoringConfig {
  /** Points per world unit of distance. */
  perDistance: number;
  /** Points per dodged asteroid. */
  perDodge: number;
  /** Extra points for a dodge whose margin is under `nearMissMargin`. */
  nearMissBonus: number;
  nearMissMargin: number;
}

export interface GameConfig {
  bounds: Bounds;
  ship: ShipConfig;
  asteroids: AsteroidFieldConfig;
  difficulty: DifficultyConfig;
  scoring: ScoringConfig;
  /** Upper bound on a single simulation step, seconds. Long tab switches don't teleport asteroids. */
  maxStepSeconds: number;
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  bounds: { halfWidth: 13, halfHeight: 7.5 },
  ship: DEFAULT_SHIP_CONFIG,
  asteroids: DEFAULT_ASTEROID_FIELD_CONFIG,
  difficulty: {
    startSpeed: 42,
    endSpeed: 115,
    rampSeconds: 100,
    startSpawnInterval: 0.55,
    endSpawnInterval: 0.16,
  },
  scoring: {
    perDistance: 0.1,
    perDodge: 10,
    nearMissBonus: 15,
    nearMissMargin: 1.5,
  },
  maxStepSeconds: 0.05,
};

export interface GameEngineOptions {
  config?: DeepPartial<GameConfig>;
  seed?: number;
  /** Previously saved best score, if any. */
  best?: number;
}

/**
 * The whole game, minus rendering and input devices. Call `update(dt, steer)`
 * once per frame with the current steering command; read `state` to render.
 * Deterministic for a given seed and input sequence.
 */
export class GameEngine {
  readonly config: GameConfig;
  readonly state: GameState;
  /** Seed of the asteroid sequence; pass it back in to replay a run. */
  readonly seed: number;
  private readonly field: AsteroidField;
  private readonly rng: Rng;
  private spawnTimer = 0;

  constructor(options: GameEngineOptions = {}) {
    this.config = mergeConfig(DEFAULT_GAME_CONFIG, options.config);
    this.seed = options.seed ?? Date.now() >>> 0;
    this.rng = new Rng(this.seed);
    this.field = new AsteroidField(this.config.asteroids, this.rng);
    this.state = {
      phase: "ready",
      time: 0,
      distance: 0,
      score: 0,
      speed: this.config.difficulty.startSpeed,
      dodged: 0,
      ship: createShipState(this.config.ship),
      asteroids: this.field.asteroids,
      crash: null,
      pauseReason: null,
      steer: { x: 0, y: 0 },
      best: options.best ?? 0,
    };
  }

  /** Begins a fresh run from `ready` or `crashed`. */
  start(): GameEvent[] {
    const s = this.state;
    if (s.phase === "running" || s.phase === "paused") return [];
    this.resetRun();
    s.phase = "running";
    return [{ type: "started" }];
  }

  /** Back to the pre-run state (asteroids cleared, ship centred). */
  reset(): GameEvent[] {
    this.resetRun();
    this.state.phase = "ready";
    return [{ type: "reset" }];
  }

  pause(reason: string | null = null): GameEvent[] {
    const s = this.state;
    if (s.phase !== "running") return [];
    s.phase = "paused";
    s.pauseReason = reason;
    return [{ type: "paused", reason }];
  }

  resume(): GameEvent[] {
    const s = this.state;
    if (s.phase !== "paused") return [];
    s.phase = "running";
    s.pauseReason = null;
    return [{ type: "resumed" }];
  }

  togglePause(): GameEvent[] {
    return this.state.phase === "paused" ? this.resume() : this.pause("user");
  }

  /** Switches how steering moves the ship. Safe to call mid-run. */
  setShipControl(mode: ShipControlMode): void {
    this.config.ship.control = mode;
  }

  /**
   * Advances the simulation. `dt` in seconds. Returns the events that happened
   * this step so the UI/audio layer can react without polling.
   */
  update(dt: number, steer: Steer): GameEvent[] {
    const s = this.state;
    const events: GameEvent[] = [];
    if (s.phase !== "running") return events;

    const step = Math.min(Math.max(0, dt), this.config.maxStepSeconds);
    if (step === 0) return events;

    s.steer.x = steer.x;
    s.steer.y = steer.y;
    s.time += step;

    const d = this.config.difficulty;
    const ramp = clamp01(s.time / d.rampSeconds);
    const eased = 1 - (1 - ramp) * (1 - ramp);
    s.speed = d.startSpeed + (d.endSpeed - d.startSpeed) * eased;
    const spawnInterval =
      d.startSpawnInterval + (d.endSpawnInterval - d.startSpawnInterval) * eased;

    updateShip(s.ship, steer, this.config.bounds, this.config.ship, step);

    const travelled = s.speed * step;
    s.distance += travelled;

    this.spawnTimer += step;
    // Time-based spawning; the interval shrinks with difficulty faster than the
    // speed grows, so the field gets denser (not just faster) over a run.
    while (this.spawnTimer >= spawnInterval) {
      this.spawnTimer -= spawnInterval;
      this.field.spawn(this.config.bounds);
    }

    const { hit, passed } = this.field.step(step, s.speed, s.ship);

    const scoring = this.config.scoring;
    for (const p of passed) {
      s.dodged++;
      s.score += scoring.perDodge;
      if (p.margin < scoring.nearMissMargin) s.score += scoring.nearMissBonus;
      events.push({ type: "dodged", asteroidId: p.asteroid.id, margin: p.margin });
    }
    s.score += travelled * scoring.perDistance;

    if (hit) {
      s.phase = "crashed";
      s.crash = { asteroidId: hit.asteroid.id, at: hit.at, time: s.time };
      const finalScore = Math.floor(s.score);
      s.score = finalScore;
      const isBest = finalScore > s.best;
      if (isBest) s.best = finalScore;
      events.push({ type: "crashed", crash: s.crash, score: finalScore, isBest });
    }

    return events;
  }

  private resetRun() {
    const s = this.state;
    s.time = 0;
    s.distance = 0;
    s.score = 0;
    s.speed = this.config.difficulty.startSpeed;
    s.dodged = 0;
    s.crash = null;
    s.pauseReason = null;
    s.steer.x = 0;
    s.steer.y = 0;
    resetShip(s.ship);
    this.field.reset();
    this.spawnTimer = 0;
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeConfig(base: GameConfig, patch?: DeepPartial<GameConfig>): GameConfig {
  if (!patch) return structuredCloneConfig(base);
  return {
    bounds: { ...base.bounds, ...patch.bounds },
    ship: { ...base.ship, ...patch.ship },
    asteroids: { ...base.asteroids, ...patch.asteroids },
    difficulty: { ...base.difficulty, ...patch.difficulty },
    scoring: { ...base.scoring, ...patch.scoring },
    maxStepSeconds: patch.maxStepSeconds ?? base.maxStepSeconds,
  };
}

function structuredCloneConfig(c: GameConfig): GameConfig {
  return {
    bounds: { ...c.bounds },
    ship: { ...c.ship },
    asteroids: { ...c.asteroids },
    difficulty: { ...c.difficulty },
    scoring: { ...c.scoring },
    maxStepSeconds: c.maxStepSeconds,
  };
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
