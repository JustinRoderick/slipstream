"use client";

import type { GamePhase, Steer } from "@/lib/game/types";
import type { SteerSource } from "@/lib/game/game-runner";
import { cn } from "@/lib/utils";

export interface HudSnapshot {
  phase: GamePhase;
  score: number;
  best: number;
  distance: number;
  speed: number;
  dodged: number;
  fps: number;
  steer: Steer;
  source: SteerSource;
  trackingLost: boolean;
  pauseReason: string | null;
}

export function ScoreHud({ hud, headTracking }: { hud: HudSnapshot; headTracking: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-4 font-mono text-sm text-white/90 md:p-6">
      <div className="space-y-1">
        <div className="text-3xl font-bold tabular-nums tracking-tight">
          {Math.floor(hud.score).toLocaleString()}
        </div>
        <div className="text-xs text-white/60">BEST {Math.floor(hud.best).toLocaleString()}</div>
      </div>
      <div className="space-y-1 text-right">
        <div className="tabular-nums">
          {Math.floor(hud.distance).toLocaleString()} <span className="text-white/50">m</span>
        </div>
        <div className="tabular-nums">
          {Math.round(hud.speed * 3.6).toLocaleString()} <span className="text-white/50">km/h</span>
        </div>
        <div className="tabular-nums text-white/60">{hud.dodged} dodged</div>
        <TrackingBadge hud={hud} headTracking={headTracking} />
      </div>
    </div>
  );
}

function TrackingBadge({ hud, headTracking }: { hud: HudSnapshot; headTracking: boolean }) {
  let color = "bg-zinc-400";
  let label = "Keyboard";
  if (hud.source === "keyboard") {
    color = "bg-sky-400";
    label = "Keyboard";
  } else if (headTracking && !hud.trackingLost) {
    color = "bg-emerald-400";
    label = "Head tracking · on-device";
  } else if (headTracking) {
    color = "bg-amber-400 animate-pulse";
    label = "Face not found";
  }
  return (
    <div className="mt-1 flex items-center justify-end gap-2 text-[11px] uppercase tracking-wide text-white/60">
      <span className={cn("inline-block size-2 rounded-full", color)} />
      {label}
    </div>
  );
}

/** Small crosshair showing where the steering command points. */
export function SteerIndicator({ steer, className }: { steer: Steer; className?: string }) {
  const x = 50 + steer.x * 45;
  const y = 50 - steer.y * 45;
  return (
    <div
      className={cn(
        "pointer-events-none relative size-20 rounded-md border border-white/20 bg-black/40 backdrop-blur-sm",
        className,
      )}
      aria-hidden
    >
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/15" />
      <div className="absolute left-0 top-1/2 h-px w-full bg-white/15" />
      <div
        className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(103,232,249,0.6)] transition-[left,top] duration-75"
        style={{ left: `${x}%`, top: `${y}%` }}
      />
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-white/25 bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-white/90">
      {children}
    </kbd>
  );
}
