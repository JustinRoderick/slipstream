import {
  DEFAULT_HEAD_CONTROL_SETTINGS,
  type HeadControlSettings,
} from "../tracking/head-control-mapper";
import type { ShipControlMode } from "./ship";

/** Player-facing settings that survive a reload. Only local storage; nothing is sent anywhere. */
export interface PlayerSettings {
  head: Pick<
    HeadControlSettings,
    "mode" | "sensitivity" | "invertX" | "invertY" | "mirrorX" | "deadzone"
  >;
  shipControl: ShipControlMode;
  showCameraPreview: boolean;
  showDebug: boolean;
}

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  head: {
    mode: DEFAULT_HEAD_CONTROL_SETTINGS.mode,
    sensitivity: DEFAULT_HEAD_CONTROL_SETTINGS.sensitivity,
    invertX: DEFAULT_HEAD_CONTROL_SETTINGS.invertX,
    invertY: DEFAULT_HEAD_CONTROL_SETTINGS.invertY,
    mirrorX: DEFAULT_HEAD_CONTROL_SETTINGS.mirrorX,
    deadzone: DEFAULT_HEAD_CONTROL_SETTINGS.deadzone,
  },
  shipControl: "position",
  showCameraPreview: true,
  showDebug: false,
};

const SETTINGS_KEY = "slipstream.settings.v1";
const BEST_KEY = "slipstream.best.v1";

export function loadPlayerSettings(): PlayerSettings {
  if (typeof localStorage === "undefined") return DEFAULT_PLAYER_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_PLAYER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PlayerSettings>;
    return {
      ...DEFAULT_PLAYER_SETTINGS,
      ...parsed,
      head: { ...DEFAULT_PLAYER_SETTINGS.head, ...parsed.head },
    };
  } catch {
    return DEFAULT_PLAYER_SETTINGS;
  }
}

export function savePlayerSettings(settings: PlayerSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or disabled; settings just won't persist.
  }
}

export function loadBestScore(): number {
  if (typeof localStorage === "undefined") return 0;
  const n = Number(localStorage.getItem(BEST_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function saveBestScore(score: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(BEST_KEY, String(Math.floor(score)));
  } catch {
    // ignore
  }
}
