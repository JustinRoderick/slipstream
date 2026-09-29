/**
 * One Euro Filter (Casiez, Roussel & Vogel, 2012).
 *
 * An adaptive low-pass filter for noisy, human-driven input: it smooths hard
 * when the signal is still (kills jitter) and relaxes when the signal moves
 * fast (keeps latency low). Ideal for head-tracking cursors.
 *
 * - `minCutoff` (Hz): smoothing at rest. Lower = smoother but laggier.
 * - `beta`: how quickly smoothing relaxes with speed. Higher = less lag on fast moves.
 * - `dCutoff` (Hz): cutoff for the internal derivative estimate.
 */
export class OneEuroFilter {
  private prevValue: number | null = null;
  private prevDerivative = 0;
  private prevTime: number | null = null;

  constructor(
    public minCutoff = 1.0,
    public beta = 0.0,
    public dCutoff = 1.0,
  ) {}

  /** Feed a sample; `timeMs` must be monotonic. Returns the filtered value. */
  filter(value: number, timeMs: number): number {
    if (this.prevValue === null || this.prevTime === null) {
      this.prevValue = value;
      this.prevTime = timeMs;
      this.prevDerivative = 0;
      return value;
    }

    const dt = Math.max(1e-3, (timeMs - this.prevTime) / 1000);
    this.prevTime = timeMs;

    const rawDerivative = (value - this.prevValue) / dt;
    const dAlpha = smoothingFactor(dt, this.dCutoff);
    const derivative = lerp(this.prevDerivative, rawDerivative, dAlpha);
    this.prevDerivative = derivative;

    const cutoff = this.minCutoff + this.beta * Math.abs(derivative);
    const alpha = smoothingFactor(dt, cutoff);
    const filtered = lerp(this.prevValue, value, alpha);
    this.prevValue = filtered;
    return filtered;
  }

  /** Current filtered value (or null before the first sample). */
  get value(): number | null {
    return this.prevValue;
  }

  reset(): void {
    this.prevValue = null;
    this.prevDerivative = 0;
    this.prevTime = null;
  }
}

function smoothingFactor(dt: number, cutoff: number) {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
