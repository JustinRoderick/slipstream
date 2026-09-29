"use client";

import type { TrackerStats, TrackerStatus } from "@/lib/tracking/head-tracker";
import type { NeutralPose, Steer } from "@/lib/tracking/head-control-mapper";
import type { HeadPose } from "@/lib/tracking/types";
import type { SteerSource } from "@/lib/game/game-runner";

export interface DebugSnapshot {
  trackerStatus: TrackerStatus;
  stats: TrackerStats | null;
  pose: HeadPose | null;
  neutral: NeutralPose | null;
  rawSteer: Steer;
  steer: Steer;
  source: SteerSource;
  renderFps: number;
  activeAsteroids: number;
  seed: number;
}

export function DebugPanel({ d }: { d: DebugSnapshot }) {
  const f = (n: number | undefined | null, digits = 2) => (n == null ? "—" : n.toFixed(digits));
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 w-72 rounded-lg border border-white/15 bg-black/70 p-3 font-mono text-[11px] leading-relaxed text-white/80 backdrop-blur md:bottom-6 md:right-6">
      <Row
        k="tracker"
        v={`${d.trackerStatus}${d.stats?.delegate ? ` · ${d.stats.delegate}` : ""}`}
      />
      <Row
        k="camera"
        v={d.stats ? `${d.stats.width}×${d.stats.height} · ${f(d.stats.fps, 0)} fps` : "—"}
      />
      <Row
        k="latency"
        v={
          d.stats
            ? `infer ${f(d.stats.inferenceMs, 1)} ms · e2e ${f(d.stats.latencyMs, 0)} ms`
            : "—"
        }
      />
      <Row k="render" v={`${f(d.renderFps, 0)} fps · ${d.activeAsteroids} rocks`} />
      <div className="my-1.5 h-px bg-white/10" />
      <Row k="source" v={`${d.source}${d.pose ? ` (${d.pose.source})` : ""}`} />
      <Row
        k="yaw/pitch/roll"
        v={d.pose ? `${f(d.pose.yaw, 1)}° ${f(d.pose.pitch, 1)}° ${f(d.pose.roll, 1)}°` : "—"}
      />
      <Row
        k="pos (cm)"
        v={d.pose ? `${f(d.pose.x, 1)} ${f(d.pose.y, 1)} ${f(Math.abs(d.pose.z), 0)}` : "—"}
      />
      <Row
        k="neutral"
        v={
          d.neutral
            ? `${f(d.neutral.yaw, 1)}° ${f(d.neutral.pitch, 1)}° · ${f(d.neutral.x, 1)} ${f(d.neutral.y, 1)}`
            : "not calibrated"
        }
      />
      <Row k="raw" v={`${f(d.rawSteer.x)} ${f(d.rawSteer.y)}`} />
      <Row k="steer" v={`${f(d.steer.x)} ${f(d.steer.y)}`} />
      <Row k="seed" v={String(d.seed)} />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-white/45">{k}</span>
      <span className="truncate tabular-nums">{v}</span>
    </div>
  );
}
