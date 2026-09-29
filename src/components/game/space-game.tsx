"use client";

import { Keyboard, ScanFace, Settings2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { GameEngine } from "@/lib/game/game-engine";
import { GameRunner, type RunnerFrameInfo } from "@/lib/game/game-runner";
import { GameView } from "@/lib/game/game-view";
import { KeyboardInput } from "@/lib/game/keyboard-input";
import {
  DEFAULT_PLAYER_SETTINGS,
  loadBestScore,
  loadPlayerSettings,
  saveBestScore,
  savePlayerSettings,
  type PlayerSettings,
} from "@/lib/game/settings-store";
import type { GameEvent } from "@/lib/game/types";
import { NeutralPoseCalibrator } from "@/lib/tracking/calibration";
import { HeadControlMapper } from "@/lib/tracking/head-control-mapper";
import { HeadTracker, type TrackerStatus } from "@/lib/tracking/head-tracker";
import type { HeadPose, LandmarkFrame } from "@/lib/tracking/types";
import { CameraPreview, drawPreviewOverlay } from "./camera-preview";
import { DebugPanel, type DebugSnapshot } from "./debug-panel";
import { Kbd, ScoreHud, SteerIndicator, type HudSnapshot } from "./hud";
import { SettingsPanel } from "./settings-panel";

type Stage = "intro" | "starting" | "calibrating" | "playing" | "error";
type InputMode = "head" | "keyboard";

/** Pause automatically after the face has been missing for this long. */
const LOST_PAUSE_MS = 2500;
/** Resume automatically once the face has been back for this long. */
const FOUND_RESUME_MS = 700;

const INITIAL_HUD: HudSnapshot = {
  phase: "ready",
  score: 0,
  best: 0,
  distance: 0,
  speed: 0,
  dodged: 0,
  fps: 0,
  steer: { x: 0, y: 0 },
  source: "none",
  trackingLost: false,
  pauseReason: null,
};

export default function SpaceGame() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const engineRef = useRef<GameEngine | null>(null);
  const viewRef = useRef<GameView | null>(null);
  const runnerRef = useRef<GameRunner | null>(null);
  const keyboardRef = useRef<KeyboardInput | null>(null);
  const mapperRef = useRef<HeadControlMapper | null>(null);
  const trackerRef = useRef<HeadTracker | null>(null);
  const calibratorRef = useRef(new NeutralPoseCalibrator());

  const stageRef = useRef<Stage>("intro");
  const settingsRef = useRef<PlayerSettings>(DEFAULT_PLAYER_SETTINGS);
  const neutralNoseRef = useRef<{ x: number; y: number } | null>(null);
  const lostSinceRef = useRef<number | null>(null);
  const foundSinceRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const [stage, setStageState] = useState<Stage>("intro");
  const [inputMode, setInputMode] = useState<InputMode>("head");
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<PlayerSettings>(DEFAULT_PLAYER_SETTINGS);
  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [debug, setDebug] = useState<DebugSnapshot | null>(null);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const setStage = useCallback((next: Stage) => {
    stageRef.current = next;
    setStageState(next);
  }, []);

  const showToast = useCallback((text: string, ms = 1400) => {
    setToast(text);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  /** Applies settings to the live objects and persists them. */
  const applySettings = useCallback((next: PlayerSettings) => {
    settingsRef.current = next;
    setSettingsState(next);
    savePlayerSettings(next);
    mapperRef.current?.setSettings(next.head);
    engineRef.current?.setShipControl(next.shipControl);
  }, []);

  // ---- Engine / view / runner lifecycle -------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const initial = loadPlayerSettings();
    settingsRef.current = initial;
    setSettingsState(initial);

    const engine = new GameEngine({ best: loadBestScore() });
    engine.setShipControl(initial.shipControl);
    const view = new GameView(canvas, {
      bounds: engine.config.bounds,
      maxAsteroids: engine.config.asteroids.maxCount,
    });
    const keyboard = new KeyboardInput();
    keyboard.attach(window);
    const mapper = new HeadControlMapper(initial.head);

    engineRef.current = engine;
    viewRef.current = view;
    keyboardRef.current = keyboard;
    mapperRef.current = mapper;

    const onEvents = (events: GameEvent[]) => {
      for (const e of events) {
        if (e.type === "crashed") {
          if (e.isBest) saveBestScore(e.score);
        }
      }
    };

    const onFrame = (info: RunnerFrameInfo) => {
      const s = engine.state;
      const now = performance.now();
      const headActive = trackerRef.current?.status === "tracking";
      const lost = headActive ? mapper.isLost(now) : false;

      // Auto-pause when the face disappears mid-run; auto-resume when it's back.
      if (headActive && stageRef.current === "playing") {
        if (lost) {
          foundSinceRef.current = null;
          lostSinceRef.current ??= now;
          if (s.phase === "running" && now - lostSinceRef.current > LOST_PAUSE_MS) {
            engine.pause("tracking");
          }
        } else {
          lostSinceRef.current = null;
          foundSinceRef.current ??= now;
          if (
            s.phase === "paused" &&
            s.pauseReason === "tracking" &&
            now - foundSinceRef.current > FOUND_RESUME_MS
          ) {
            engine.resume();
          }
        }
      }

      setHud({
        phase: s.phase,
        score: s.score,
        best: s.best,
        distance: s.distance,
        speed: s.speed,
        dodged: s.dodged,
        fps: info.fps,
        steer: info.steer,
        source: info.source,
        trackingLost: lost,
        pauseReason: s.pauseReason,
      });

      if (settingsRef.current.showDebug) {
        const tracker = trackerRef.current;
        let active = 0;
        for (const a of s.asteroids) if (a.active) active++;
        setDebug({
          trackerStatus: tracker?.status ?? "idle",
          stats: tracker ? { ...tracker.stats } : null,
          pose: mapper.pose,
          neutral: mapper.getNeutral(),
          rawSteer: mapper.raw,
          steer: info.steer,
          source: info.source,
          renderFps: info.fps,
          activeAsteroids: active,
          seed: engine.seed,
        });
      }
    };

    const runner = new GameRunner({
      engine,
      view,
      keyboard,
      head: mapper,
      onEvents,
      onFrame,
      hudHz: 12,
    });
    runnerRef.current = runner;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      view.resize(Math.floor(rect.width), Math.floor(rect.height));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const onVisibility = () => {
      if (document.hidden) engine.pause("hidden");
    };
    document.addEventListener("visibilitychange", onVisibility);

    runner.start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      runner.stop();
      keyboard.detach();
      trackerRef.current?.stop();
      trackerRef.current = null;
      view.dispose();
      engineRef.current = null;
      viewRef.current = null;
      runnerRef.current = null;
      keyboardRef.current = null;
      mapperRef.current = null;
    };
  }, []);

  // ---- Calibration ------------------------------------------------------------------------
  const beginCalibration = useCallback(() => {
    const engine = engineRef.current;
    const mapper = mapperRef.current;
    if (!engine || !mapper) return;
    engine.reset();
    mapper.reset();
    calibratorRef.current.start(performance.now());
    setCalibrationProgress(0);
    setStage("calibrating");
  }, [setStage]);

  const handleSample = useCallback(
    (pose: HeadPose | null, frame: LandmarkFrame) => {
      const mapper = mapperRef.current;
      const engine = engineRef.current;
      if (!mapper || !engine) return;
      const now = performance.now();

      // Always feed the mapper so "face found / lost" stays accurate; while
      // calibrating, its steering output is ignored anyway (the game is reset).
      mapper.update(pose);

      if (stageRef.current === "calibrating") {
        const cal = calibratorRef.current;
        const neutral = cal.add(pose, now);
        setCalibrationProgress(cal.progress(now));
        if (neutral) {
          mapper.setNeutral(neutral);
          neutralNoseRef.current = pose?.nose ?? null;
          setStage("playing");
          engine.start();
          showToast("GO!");
        }
      }

      const overlay = overlayRef.current;
      if (overlay && settingsRef.current.showCameraPreview) {
        drawPreviewOverlay(overlay, pose?.nose ?? null, neutralNoseRef.current, frame.landmarks);
      }
    },
    [setStage, showToast],
  );

  // ---- Start flows -------------------------------------------------------------------------
  const startWithCamera = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrorText(
        "This browser can't access the camera here. Camera access needs HTTPS (or localhost).",
      );
      setStage("error");
      return;
    }

    trackerRef.current?.stop();
    setErrorText(null);
    setInputMode("head");
    setStage("starting");
    setStatusText("Starting camera…");

    const tracker = new HeadTracker({
      video,
      onSample: handleSample,
      onStatus: (status: TrackerStatus, detail) => {
        if (status === "starting-camera") setStatusText("Starting camera…");
        if (status === "loading-model") setStatusText("Loading face model (runs on your device)…");
        if (status === "error") {
          setErrorText(detail ?? "Head tracking failed");
          setStage("error");
        }
      },
    });
    trackerRef.current = tracker;
    await tracker.start();
    if (trackerRef.current !== tracker || tracker.status !== "tracking") return;
    beginCalibration();
  }, [beginCalibration, handleSample, setStage]);

  const startKeyboardOnly = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setInputMode("keyboard");
    setErrorText(null);
    setStage("playing");
    engineRef.current?.start();
    showToast("Arrow keys / WASD to steer");
  }, [setStage, showToast]);

  const restart = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.state.phase === "ready" || engine.state.phase === "crashed") {
      engine.start();
      showToast("GO!");
    }
  }, [showToast]);

  const recalibrate = useCallback(() => {
    if (trackerRef.current?.status !== "tracking") return;
    setShowSettings(false);
    beginCalibration();
  }, [beginCalibration]);

  // ---- Hotkeys -----------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")
      )
        return;
      const engine = engineRef.current;
      if (!engine) return;

      switch (e.code) {
        case "Space":
        case "Enter":
          if (stageRef.current === "playing") {
            e.preventDefault();
            if (engine.state.phase === "paused") engine.resume();
            else restart();
          }
          break;
        case "KeyP":
        case "Escape":
          if (stageRef.current === "playing") {
            if (showSettings) setShowSettings(false);
            else engine.togglePause();
          }
          break;
        case "KeyC":
          recalibrate();
          break;
        case "Backquote":
          applySettings({ ...settingsRef.current, showDebug: !settingsRef.current.showDebug });
          break;
        case "KeyV":
          applySettings({
            ...settingsRef.current,
            showCameraPreview: !settingsRef.current.showCameraPreview,
          });
          break;
        case "KeyI": {
          const next = !settingsRef.current.head.invertY;
          applySettings({
            ...settingsRef.current,
            head: { ...settingsRef.current.head, invertY: next },
          });
          showToast(next ? "Head up → ship down" : "Head up → ship up");
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applySettings, recalibrate, restart, showSettings, showToast]);

  const headTracking = inputMode === "head" && stage !== "intro";

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 select-none overflow-hidden bg-[#03040a] text-white"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />

      <CameraPreview
        videoRef={videoRef}
        overlayRef={overlayRef}
        visible={
          headTracking &&
          settings.showCameraPreview &&
          (stage === "calibrating" || stage === "playing")
        }
      />

      {stage === "playing" ? (
        <>
          <ScoreHud hud={hud} headTracking={headTracking} />
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 md:bottom-6">
            <SteerIndicator steer={hud.steer} />
          </div>
          <div className="absolute right-4 top-4 md:right-6 md:top-6">
            <Button
              variant="ghost"
              size="icon"
              className="pointer-events-auto text-white/70 hover:bg-white/10 hover:text-white"
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Settings"
            >
              <Settings2 />
            </Button>
          </div>
          {settings.showDebug && debug ? <DebugPanel d={debug} /> : null}
          {showSettings ? (
            <SettingsPanel
              settings={settings}
              onChange={applySettings}
              onClose={() => setShowSettings(false)}
              onRecalibrate={recalibrate}
              headTracking={trackerRef.current?.status === "tracking"}
            />
          ) : null}

          {hud.phase === "paused" ? (
            <Overlay>
              <h2 className="text-2xl font-semibold">
                {hud.pauseReason === "tracking" ? "Can't see your face" : "Paused"}
              </h2>
              <p className="mt-2 text-white/70">
                {hud.pauseReason === "tracking"
                  ? "Center your face in the camera and the game will resume."
                  : hud.pauseReason === "hidden"
                    ? "Press Space to keep flying."
                    : "Press Space or P to resume."}
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <Button onClick={() => engineRef.current?.resume()}>Resume</Button>
              </div>
            </Overlay>
          ) : null}

          {hud.phase === "crashed" ? (
            <Overlay>
              <div className="text-xs uppercase tracking-[0.3em] text-red-300">Impact</div>
              <div className="mt-2 text-5xl font-bold tabular-nums">
                {Math.floor(hud.score).toLocaleString()}
              </div>
              <div className="mt-1 text-white/60">
                {Math.floor(hud.distance).toLocaleString()} m · {hud.dodged} dodged
                {hud.score >= hud.best && hud.score > 0 ? " · new best" : ""}
              </div>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Button size="lg" onClick={restart}>
                  Fly again <Kbd>Space</Kbd>
                </Button>
                {headTracking ? (
                  <Button size="lg" variant="secondary" onClick={recalibrate}>
                    Recalibrate <Kbd>C</Kbd>
                  </Button>
                ) : null}
              </div>
            </Overlay>
          ) : null}

          {hud.phase === "running" && hud.trackingLost && headTracking ? (
            <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 rounded-full border border-amber-300/40 bg-amber-500/15 px-4 py-1.5 text-sm text-amber-200">
              Face not found — steering is easing to center
            </div>
          ) : null}
        </>
      ) : null}

      {stage === "intro" ? (
        <Overlay wide>
          <div className="mb-5 flex justify-center">
            <div className="flex size-16 items-center justify-center rounded-full border border-white/20 bg-white/10">
              <ScanFace className="size-8" />
            </div>
          </div>
          <h1 className="text-4xl font-bold tracking-tight">Slipstream</h1>
          <p className="mx-auto mt-3 max-w-md text-white/70">
            Fly through an asteroid field using only your head. Turn or lean to steer: look{" "}
            <span className="text-white">up</span> to dive, <span className="text-white">down</span>{" "}
            to climb, left and right to bank, just like a flight stick.
          </p>

          <div className="mx-auto mt-6 max-w-md rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-4 text-left text-sm text-emerald-100">
            <div className="flex items-center gap-2 font-semibold text-emerald-200">
              <ShieldCheck className="size-4" /> Your camera stays private
            </div>
            <p className="mt-1.5 text-emerald-100/80">
              Face tracking runs entirely on your device with an on-device model (MediaPipe in
              WebAssembly). The video never leaves your browser: nothing is uploaded, recorded, or
              stored, and no third-party servers are contacted while you play. The preview thumbnail
              is just for you and can be turned off.
            </p>
          </div>

          <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <Button size="lg" onClick={startWithCamera}>
              <ScanFace /> Enable camera &amp; fly
            </Button>
            <Button size="lg" variant="secondary" onClick={startKeyboardOnly}>
              <Keyboard /> Play with keyboard
            </Button>
          </div>
          <p className="mt-5 text-xs text-white/45">
            <Kbd>Space</Kbd> restart · <Kbd>P</Kbd> pause · <Kbd>C</Kbd> recalibrate · <Kbd>I</Kbd>{" "}
            flip up/down · <Kbd>`</Kbd> debug · <Kbd>V</Kbd> camera preview · arrows / WASD steer by
            hand
          </p>
        </Overlay>
      ) : null}

      {stage === "starting" ? (
        <Overlay>
          <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <p className="text-white/80">{statusText}</p>
          <p className="mt-2 text-xs text-white/45">
            Everything loads from this site and runs locally.
          </p>
        </Overlay>
      ) : null}

      {stage === "calibrating" ? (
        <Overlay>
          <h2 className="text-2xl font-semibold">Hold still</h2>
          <p className="mt-2 text-white/70">
            Look at the center of the screen in a comfortable position. This becomes your neutral
            pose.
          </p>
          <div className="mx-auto mt-5 h-1.5 w-64 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-cyan-300 transition-[width] duration-150"
              style={{ width: `${Math.round(calibrationProgress * 100)}%` }}
            />
          </div>
          {hud.trackingLost || calibrationProgress === 0 ? (
            <p className="mt-3 text-xs text-amber-200/80">
              Make sure your face is visible in the camera.
            </p>
          ) : null}
        </Overlay>
      ) : null}

      {stage === "error" ? (
        <Overlay>
          <h2 className="text-2xl font-semibold">Camera unavailable</h2>
          <p className="mt-2 text-white/70">{errorText}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button onClick={startWithCamera}>Try again</Button>
            <Button variant="secondary" onClick={startKeyboardOnly}>
              <Keyboard /> Play with keyboard
            </Button>
          </div>
        </Overlay>
      ) : null}

      {toast ? (
        <div className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 text-4xl font-black tracking-widest text-cyan-200 drop-shadow-[0_0_20px_rgba(103,232,249,0.8)]">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function Overlay({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/55 p-6 backdrop-blur-[2px]">
      <div
        className={`w-full rounded-2xl border border-white/10 bg-zinc-950/80 p-8 text-center shadow-2xl ${
          wide ? "max-w-xl" : "max-w-md"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
