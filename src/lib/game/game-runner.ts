import type { HeadControlMapper } from "../tracking/head-control-mapper";
import type { GameEngine } from "./game-engine";
import type { GameView } from "./game-view";
import type { KeyboardInput } from "./keyboard-input";
import type { GameEvent, Steer } from "./types";

export type SteerSource = "head" | "keyboard" | "none";

export interface RunnerFrameInfo {
  /** Render frames per second (smoothed). */
  fps: number;
  steer: Steer;
  source: SteerSource;
}

export interface GameRunnerOptions {
  engine: GameEngine;
  view: GameView;
  keyboard: KeyboardInput;
  /** Optional: when absent the game is keyboard-only. */
  head?: HeadControlMapper | null;
  onEvents?: (events: GameEvent[]) => void;
  /** Called at most `hudHz` times per second with fresh frame info. */
  onFrame?: (info: RunnerFrameInfo) => void;
  hudHz?: number;
}

/**
 * The per-frame loop: pick a steering source, step the engine, draw the view.
 * Keyboard input takes priority while keys are held so the game can always
 * be driven by hand (testing, accessibility, no camera).
 */
export class GameRunner {
  private readonly engine: GameEngine;
  private readonly view: GameView;
  private readonly keyboard: KeyboardInput;
  private head: HeadControlMapper | null;
  private readonly onEvents?: (events: GameEvent[]) => void;
  private readonly onFrame?: (info: RunnerFrameInfo) => void;
  private readonly hudIntervalMs: number;

  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private lastHudAt = 0;
  private fps = 0;
  private lastSteer: Steer = { x: 0, y: 0 };
  private lastSource: SteerSource = "none";

  constructor(options: GameRunnerOptions) {
    this.engine = options.engine;
    this.view = options.view;
    this.keyboard = options.keyboard;
    this.head = options.head ?? null;
    this.onEvents = options.onEvents;
    this.onFrame = options.onFrame;
    this.hudIntervalMs = 1000 / (options.hudHz ?? 12);
  }

  setHeadMapper(mapper: HeadControlMapper | null): void {
    this.head = mapper;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  get steer(): Steer {
    return { ...this.lastSteer };
  }

  get source(): SteerSource {
    return this.lastSource;
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp huge gaps (tab switch, debugger) so the sim doesn't explode.
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    if (dt > 0) this.fps = this.fps === 0 ? 1 / dt : this.fps + (1 / dt - this.fps) * 0.1;

    const keyboardSteer = this.keyboard.update(dt);
    let steer: Steer;
    let source: SteerSource;
    if (this.keyboard.isActive(now)) {
      steer = keyboardSteer;
      source = "keyboard";
    } else if (this.head) {
      steer = this.head.read(now);
      source = this.head.isLost(now) ? "none" : "head";
    } else {
      steer = { x: 0, y: 0 };
      source = "none";
    }
    this.lastSteer = steer;
    this.lastSource = source;

    const events = this.engine.update(dt, steer);
    if (events.length && this.onEvents) this.onEvents(events);

    this.view.render(this.engine.state, dt);

    if (this.onFrame && now - this.lastHudAt >= this.hudIntervalMs) {
      this.lastHudAt = now;
      this.onFrame({ fps: this.fps, steer, source });
    }
  };
}
