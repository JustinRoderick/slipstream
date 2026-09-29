import { poseFromFrame } from "./head-pose";
import type {
  HeadPose,
  LandmarkFrame,
  WorkerDelegate,
  WorkerInbound,
  WorkerOutbound,
} from "./types";

export type TrackerStatus =
  | "idle"
  | "starting-camera"
  | "loading-model"
  | "tracking"
  | "stopped"
  | "error";

export interface TrackerStats {
  delegate: WorkerDelegate | null;
  /** Detections per second actually achieved. */
  fps: number;
  /** Smoothed worker inference time, ms. */
  inferenceMs: number;
  /** End-to-end frame capture → pose available, ms (smoothed). */
  latencyMs: number;
  /** Video stream size. */
  width: number;
  height: number;
}

export interface HeadTrackerOptions {
  /** The <video> element that will display/hold the camera stream. */
  video: HTMLVideoElement;
  /** Same-origin base path of the MediaPipe WASM files. */
  wasmBasePath?: string;
  /** Same-origin path of the face landmarker model. */
  modelPath?: string;
  /** Try the GPU delegate first (falls back to CPU automatically). */
  preferGpu?: boolean;
  /** Cap on detections per second. Camera frames beyond this are skipped. */
  maxDetectionsPerSecond?: number;
  onSample: (pose: HeadPose | null, frame: LandmarkFrame) => void;
  onStatus?: (status: TrackerStatus, detail?: string) => void;
}

/**
 * Owns the webcam stream and the landmark worker, and pumps frames between
 * them. Emits one `onSample` per processed frame (pose or `null` when no face).
 *
 * Privacy: the stream is only ever attached to the given <video> element and
 * handed to the local worker as ImageBitmaps; nothing is uploaded or stored.
 */
export class HeadTracker {
  private readonly video: HTMLVideoElement;
  private readonly wasmBasePath: string;
  private readonly modelPath: string;
  private readonly preferGpu: boolean;
  private readonly minFrameIntervalMs: number;
  private readonly onSample: HeadTrackerOptions["onSample"];
  private readonly onStatus: HeadTrackerOptions["onStatus"];

  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private rafId = 0;
  private running = false;
  private inFlight = false;
  private lastSentAt = -Infinity;
  private lastVideoTime = -1;
  private fpsWindowStart = 0;
  private fpsWindowCount = 0;

  private _status: TrackerStatus = "idle";
  readonly stats: TrackerStats = {
    delegate: null,
    fps: 0,
    inferenceMs: 0,
    latencyMs: 0,
    width: 0,
    height: 0,
  };

  constructor(options: HeadTrackerOptions) {
    this.video = options.video;
    this.wasmBasePath = options.wasmBasePath ?? "/mediapipe/wasm";
    this.modelPath = options.modelPath ?? "/mediapipe/face_landmarker.task";
    this.preferGpu = options.preferGpu ?? true;
    this.minFrameIntervalMs = 1000 / (options.maxDetectionsPerSecond ?? 30);
    this.onSample = options.onSample;
    this.onStatus = options.onStatus;
  }

  get status(): TrackerStatus {
    return this._status;
  }

  /** Requests the camera, boots the worker, and starts pumping frames. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      this.setStatus("starting-camera");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      if (!this.running) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (this.running) this.fail("Camera stream ended");
        });
      }

      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      this.stats.width = this.video.videoWidth;
      this.stats.height = this.video.videoHeight;

      this.setStatus("loading-model");
      await this.startWorker();
      if (!this.running) return;

      this.setStatus("tracking");
      this.fpsWindowStart = performance.now();
      this.fpsWindowCount = 0;
      this.rafId = requestAnimationFrame(this.pump);
    } catch (err) {
      this.fail(describeCameraError(err));
    }
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.worker?.postMessage({ type: "stop" } satisfies WorkerInbound);
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video.srcObject) this.video.srcObject = null;
    this.inFlight = false;
    if (this._status !== "error") this.setStatus("stopped");
  }

  private startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Classic worker on purpose (see landmark-worker.ts header).
      const worker = new Worker(new URL("./landmark-worker.ts", import.meta.url));
      this.worker = worker;

      worker.onerror = (e) => {
        reject(new Error(e.message || "Landmark worker failed to load"));
      };
      worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
        const msg = event.data;
        switch (msg.type) {
          case "ready":
            this.stats.delegate = msg.delegate;
            resolve();
            break;
          case "delegate":
            this.stats.delegate = msg.delegate;
            // Reset the smoothed timings so the new backend is measured fresh.
            this.stats.inferenceMs = 0;
            this.stats.latencyMs = 0;
            break;
          case "error":
            if (this._status === "loading-model") reject(new Error(msg.message));
            else this.fail(msg.message);
            break;
          case "frame":
            this.handleFrame(msg);
            break;
        }
      };

      const origin = self.location.origin;
      worker.postMessage({
        type: "init",
        wasmBasePath: new URL(this.wasmBasePath, origin).href,
        modelPath: new URL(this.modelPath, origin).href,
        preferGpu: this.preferGpu,
      } satisfies WorkerInbound);
    });
  }

  /**
   * Runs every animation frame and forwards at most one *new* camera frame to
   * the worker at a time ("latest frame wins"); backlog would only add latency.
   */
  private pump = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.pump);

    const video = this.video;
    const now = performance.now();
    if (
      this.inFlight ||
      !this.worker ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.currentTime === this.lastVideoTime ||
      now - this.lastSentAt < this.minFrameIntervalMs
    ) {
      return;
    }

    this.inFlight = true;
    this.lastSentAt = now;
    this.lastVideoTime = video.currentTime;

    createImageBitmap(video).then(
      (bitmap) => {
        if (!this.running || !this.worker) {
          bitmap.close();
          this.inFlight = false;
          return;
        }
        this.worker.postMessage({ type: "frame", bitmap, timestamp: now } satisfies WorkerInbound, [
          bitmap,
        ]);
      },
      () => {
        // The video element can be briefly unreadable (e.g. right after a resize); just retry next frame.
        this.inFlight = false;
      },
    );
  };

  private handleFrame(frame: LandmarkFrame) {
    this.inFlight = false;
    if (!this.running) return;

    const now = performance.now();
    this.stats.inferenceMs = smooth(this.stats.inferenceMs, frame.inferenceMs);
    this.stats.latencyMs = smooth(this.stats.latencyMs, now - frame.timestamp);
    if (frame.width) {
      this.stats.width = frame.width;
      this.stats.height = frame.height;
    }

    this.fpsWindowCount++;
    const windowMs = now - this.fpsWindowStart;
    if (windowMs >= 1000) {
      this.stats.fps = (this.fpsWindowCount * 1000) / windowMs;
      this.fpsWindowStart = now;
      this.fpsWindowCount = 0;
    }

    this.onSample(poseFromFrame(frame), frame);
  }

  private fail(message: string) {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.setStatus("error", message);
  }

  private setStatus(status: TrackerStatus, detail?: string) {
    this._status = status;
    this.onStatus?.(status, detail);
  }
}

function smooth(prev: number, next: number, alpha = 0.15) {
  return prev === 0 ? next : prev + (next - prev) * alpha;
}

export function describeCameraError(err: unknown): string {
  if (err instanceof DOMException || (err instanceof Error && "name" in err)) {
    switch ((err as DOMException).name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera access was denied. Allow camera access for this site and try again.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera was found on this device.";
      case "NotReadableError":
      case "AbortError":
        return "The camera is already in use by another application.";
    }
  }
  return err instanceof Error ? err.message : "Failed to start head tracking";
}
