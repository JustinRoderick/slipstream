import type { Steer } from "./types";

const LEFT = new Set(["ArrowLeft", "KeyA"]);
const RIGHT = new Set(["ArrowRight", "KeyD"]);
const UP = new Set(["ArrowUp", "KeyW"]);
const DOWN = new Set(["ArrowDown", "KeyS"]);

/**
 * Arrow keys / WASD steering. Used as a fallback when there is no camera and
 * as an override while a key is held, so the game is always testable.
 *
 * Output ramps toward ±1 rather than snapping, which makes keyboard play feel
 * closer to the analog head input.
 */
export class KeyboardInput {
  private readonly held = new Set<string>();
  private readonly current: Steer = { x: 0, y: 0 };
  private target: HTMLElement | Window | null = null;
  private lastActiveAt = -Infinity;

  /** Seconds to reach full deflection. */
  rampSeconds = 0.12;
  /** Seconds to return to center after release. */
  releaseSeconds = 0.08;
  /** Keyboard keeps priority over head tracking for this long after the last key-up (ms). */
  holdoverMs = 250;

  attach(target: HTMLElement | Window = window): void {
    this.detach();
    this.target = target;
    target.addEventListener("keydown", this.onKeyDown as EventListener);
    target.addEventListener("keyup", this.onKeyUp as EventListener);
    window.addEventListener("blur", this.onBlur);
  }

  detach(): void {
    if (!this.target) return;
    this.target.removeEventListener("keydown", this.onKeyDown as EventListener);
    this.target.removeEventListener("keyup", this.onKeyUp as EventListener);
    window.removeEventListener("blur", this.onBlur);
    this.target = null;
    this.held.clear();
  }

  /** True while steering keys are held (or were released moments ago). */
  isActive(nowMs: number): boolean {
    return this.held.size > 0 || nowMs - this.lastActiveAt < this.holdoverMs;
  }

  /** Advance the ramp; call once per frame. */
  update(dt: number): Steer {
    const tx = (this.any(RIGHT) ? 1 : 0) - (this.any(LEFT) ? 1 : 0);
    const ty = (this.any(UP) ? 1 : 0) - (this.any(DOWN) ? 1 : 0);
    this.current.x = approach(
      this.current.x,
      tx,
      dt,
      tx === 0 ? this.releaseSeconds : this.rampSeconds,
    );
    this.current.y = approach(
      this.current.y,
      ty,
      dt,
      ty === 0 ? this.releaseSeconds : this.rampSeconds,
    );
    return { ...this.current };
  }

  get steer(): Steer {
    return { ...this.current };
  }

  static isSteeringKey(code: string): boolean {
    return LEFT.has(code) || RIGHT.has(code) || UP.has(code) || DOWN.has(code);
  }

  private any(set: Set<string>) {
    for (const k of set) if (this.held.has(k)) return true;
    return false;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!KeyboardInput.isSteeringKey(e.code)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    this.held.add(e.code);
    this.lastActiveAt = performance.now();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.held.delete(e.code)) return;
    this.lastActiveAt = performance.now();
  };

  private onBlur = () => {
    this.held.clear();
  };
}

/** Moves `value` toward `target` at a rate that covers 1.0 in `seconds`. */
function approach(value: number, target: number, dt: number, seconds: number) {
  const maxDelta = seconds <= 0 ? Infinity : dt / seconds;
  const delta = target - value;
  if (Math.abs(delta) <= maxDelta) return target;
  return value + Math.sign(delta) * maxDelta;
}
