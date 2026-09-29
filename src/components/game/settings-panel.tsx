"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlayerSettings } from "@/lib/game/settings-store";
import type { HeadControlMode } from "@/lib/tracking/head-control-mapper";
import type { ShipControlMode } from "@/lib/game/ship";

interface SettingsPanelProps {
  settings: PlayerSettings;
  onChange: (next: PlayerSettings) => void;
  onClose: () => void;
  onRecalibrate: () => void;
  headTracking: boolean;
}

export function SettingsPanel({
  settings,
  onChange,
  onClose,
  onRecalibrate,
  headTracking,
}: SettingsPanelProps) {
  const head = settings.head;
  const setHead = (patch: Partial<PlayerSettings["head"]>) =>
    onChange({ ...settings, head: { ...head, ...patch } });

  return (
    <div className="pointer-events-auto absolute right-4 top-20 w-80 rounded-xl border border-white/15 bg-zinc-950/90 p-4 text-sm text-white shadow-2xl backdrop-blur md:right-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Controls</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close settings">
          <X />
        </Button>
      </div>

      <div className="space-y-4">
        <Field label="Head input">
          <select
            className="w-full rounded-md border border-white/15 bg-white/5 px-2 py-1.5"
            value={head.mode}
            onChange={(e) => setHead({ mode: e.target.value as HeadControlMode })}
          >
            <option value="blend">Turn or lean (blend)</option>
            <option value="rotation">Turn head only</option>
            <option value="position">Lean / move head only</option>
          </select>
        </Field>

        <Field label={`Sensitivity · ${head.sensitivity.toFixed(2)}×`}>
          <input
            type="range"
            min={0.4}
            max={2.5}
            step={0.05}
            value={head.sensitivity}
            onChange={(e) => setHead({ sensitivity: Number(e.target.value) })}
            className="w-full"
          />
        </Field>

        <Field label={`Dead zone · ${Math.round(head.deadzone * 100)}%`}>
          <input
            type="range"
            min={0}
            max={0.3}
            step={0.01}
            value={head.deadzone}
            onChange={(e) => setHead({ deadzone: Number(e.target.value) })}
            className="w-full"
          />
        </Field>

        <div className="space-y-2">
          <Toggle
            label="Head up → ship down (flight stick)"
            checked={head.invertY}
            onChange={(v) => setHead({ invertY: v })}
          />
          <Toggle
            label="Invert left / right"
            checked={head.invertX}
            onChange={(v) => setHead({ invertX: v })}
          />
          <Toggle
            label="Mirror camera (on for front cameras)"
            checked={head.mirrorX}
            onChange={(v) => setHead({ mirrorX: v })}
          />
        </div>

        <Field label="Ship response">
          <select
            className="w-full rounded-md border border-white/15 bg-white/5 px-2 py-1.5"
            value={settings.shipControl}
            onChange={(e) =>
              onChange({ ...settings, shipControl: e.target.value as ShipControlMode })
            }
          >
            <option value="position">Head position picks the spot (recommended)</option>
            <option value="rate">Head offset sets speed (joystick)</option>
          </select>
        </Field>

        <div className="space-y-2">
          <Toggle
            label="Show camera preview"
            checked={settings.showCameraPreview}
            onChange={(v) => onChange({ ...settings, showCameraPreview: v })}
          />
          <Toggle
            label="Show debug panel"
            checked={settings.showDebug}
            onChange={(v) => onChange({ ...settings, showDebug: v })}
          />
        </div>

        {headTracking ? (
          <Button variant="secondary" className="w-full" onClick={onRecalibrate}>
            Recalibrate neutral pose (C)
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs uppercase tracking-wide text-white/60">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-cyan-400"
      />
    </label>
  );
}
