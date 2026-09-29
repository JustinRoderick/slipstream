/// Web Worker: runs MediaPipe Face Landmarker off the main thread.
///
/// Everything here executes inside the browser. The WASM runtime and the model
/// are fetched from this site's own `/mediapipe/` path (see
/// scripts/fetch-mediapipe-assets.mjs) and camera frames never leave the
/// device: they arrive as transferred ImageBitmaps, are inferred on, and are
/// closed immediately.
///
/// NOTE: this must run as a *classic* worker. MediaPipe's WASM loader relies on
/// `importScripts` to install its `ModuleFactory` global; module workers break it.

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { WorkerDelegate, WorkerInbound, WorkerOutbound } from "./types";

interface WorkerScope {
  postMessage(message: WorkerOutbound, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerInbound>) => void) | null;
}

const scope = self as unknown as WorkerScope;

/** Inference slower than this (median ms) on the GPU makes us try the CPU. */
const SLOW_GPU_MS = 120;
/** Frames ignored after (re)creating a landmarker: shader compilation / warm-up. */
const WARMUP_FRAMES = 3;
/** Frames measured per backend when benchmarking. */
const BENCH_FRAMES = 8;

let landmarker: FaceLandmarker | null = null;
let lastTimestamp = -1;
let initPromise: Promise<void> | null = null;
let paths: { wasmBasePath: string; modelPath: string } | null = null;

// Backend benchmarking state.
let benchSamples: number[] = [];
let framesSinceCreate = 0;
let gpuMedian: number | null = null;
let benchPhase: "gpu" | "cpu" | "done" = "done";
let swapping = false;

async function createLandmarker(which: WorkerDelegate): Promise<FaceLandmarker> {
  if (!paths) throw new Error("Worker not initialised");
  const vision = await FilesetResolver.forVisionTasks(paths.wasmBasePath);
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: paths.modelPath, delegate: which },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    // The 4×4 head transform is what gives us yaw/pitch for steering.
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

function install(next: FaceLandmarker) {
  const old = landmarker;
  landmarker = next;
  framesSinceCreate = 0;
  benchSamples = [];
  old?.close();
}

async function init(preferGpu: boolean) {
  const order: WorkerDelegate[] = preferGpu ? ["GPU", "CPU"] : ["CPU"];
  let lastError: unknown = null;
  for (const which of order) {
    try {
      install(await createLandmarker(which));
      benchPhase = which === "GPU" ? "gpu" : "done";
      scope.postMessage({ type: "ready", delegate: which });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  scope.postMessage({
    type: "error",
    message: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

/**
 * Some environments (software WebGL, certain mobile browsers) run the GPU
 * delegate far slower than XNNPACK on the CPU. Measure, and keep the faster one.
 */
function recordInference(ms: number) {
  if (benchPhase === "done" || swapping) return;
  framesSinceCreate++;
  if (framesSinceCreate <= WARMUP_FRAMES) return;
  benchSamples.push(ms);
  if (benchSamples.length < BENCH_FRAMES) return;

  const med = median(benchSamples);
  if (benchPhase === "gpu") {
    gpuMedian = med;
    if (med <= SLOW_GPU_MS) {
      benchPhase = "done";
      return;
    }
    void swapTo("CPU", `GPU inference ${med.toFixed(0)} ms/frame; trying CPU`);
  } else if (benchPhase === "cpu") {
    benchPhase = "done";
    if (gpuMedian !== null && gpuMedian < med) {
      void swapTo("GPU", `CPU ${med.toFixed(0)} ms vs GPU ${gpuMedian.toFixed(0)} ms; back to GPU`);
    }
  }
}

async function swapTo(which: WorkerDelegate, reason: string) {
  swapping = true;
  try {
    install(await createLandmarker(which));
    benchPhase = which === "CPU" ? "cpu" : "done";
    scope.postMessage({ type: "delegate", delegate: which, reason });
  } catch {
    // Keep the current backend; nothing else to do.
    benchPhase = "done";
  } finally {
    swapping = false;
  }
}

function detect(bitmap: ImageBitmap, timestamp: number) {
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    if (!landmarker) return;
    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const ts = timestamp <= lastTimestamp ? lastTimestamp + 1 : timestamp;
    lastTimestamp = ts;

    const started = performance.now();
    const result = landmarker.detectForVideo(bitmap, ts);
    const inferenceMs = performance.now() - started;
    recordInference(inferenceMs);

    const face = result.faceLandmarks?.[0];
    let landmarks: Float32Array | null = null;
    let matrix: Float32Array | null = null;
    if (face && face.length > 0) {
      landmarks = new Float32Array(face.length * 3);
      for (let i = 0; i < face.length; i++) {
        landmarks[i * 3] = face[i].x;
        landmarks[i * 3 + 1] = face[i].y;
        landmarks[i * 3 + 2] = face[i].z;
      }
      const m = result.facialTransformationMatrixes?.[0];
      if (m && m.data.length === 16) matrix = Float32Array.from(m.data);
    }

    const transfer: Transferable[] = [];
    if (landmarks) transfer.push(landmarks.buffer);
    if (matrix) transfer.push(matrix.buffer);
    scope.postMessage(
      { type: "frame", timestamp, landmarks, matrix, width, height, inferenceMs },
      transfer,
    );
  } catch (err) {
    scope.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    bitmap.close();
  }
}

scope.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      paths = { wasmBasePath: msg.wasmBasePath, modelPath: msg.modelPath };
      initPromise ??= init(msg.preferGpu);
      break;
    case "frame":
      if (landmarker) {
        detect(msg.bitmap, msg.timestamp);
      } else {
        // Not ready yet: drop the frame, but always release the bitmap.
        msg.bitmap.close();
        scope.postMessage({
          type: "frame",
          timestamp: msg.timestamp,
          landmarks: null,
          matrix: null,
          width: 0,
          height: 0,
          inferenceMs: 0,
        });
      }
      break;
    case "stop":
      landmarker?.close();
      landmarker = null;
      break;
  }
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
