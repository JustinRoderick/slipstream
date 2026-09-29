/**
 * A single head pose estimate derived from one camera frame.
 *
 * Coordinate conventions (camera frame, i.e. the *un-mirrored* video image):
 * - `yaw`   > 0 → face turned toward image-right (the user's own left).
 * - `pitch` > 0 → face tilted up (looking toward the ceiling).
 * - `roll`  > 0 → head tilted counter-clockwise as seen in the image.
 * - `x`     > 0 → head moved toward image-right (the user's own left), cm.
 * - `y`     > 0 → head moved up, cm.
 * - `z`       → distance from the camera in cm (sign depends on the source;
 *                use `Math.abs`).
 *
 * `HeadControlMapper` handles mirroring so gameplay code never has to think
 * about "image-left vs. user-left".
 */
export interface HeadPose {
  /** `performance.now()` (ms) when the source video frame was captured. */
  timestamp: number;
  yaw: number;
  pitch: number;
  roll: number;
  x: number;
  y: number;
  z: number;
  /** Nose tip in normalized image coordinates (0..1, origin top-left). */
  nose: { x: number; y: number };
  /** Where the pose came from: the metric transformation matrix or a landmark approximation. */
  source: "matrix" | "landmarks";
}

/** Raw detector output for one frame, as posted by the landmark worker. */
export interface LandmarkFrame {
  timestamp: number;
  /** Flattened x,y,z normalized landmarks (478 × 3), or null when no face is visible. */
  landmarks: Float32Array | null;
  /** 4×4 facial transformation matrix (16 floats), or null when unavailable. */
  matrix: Float32Array | null;
  /** Source image size in pixels. */
  width: number;
  height: number;
  /** Worker-side inference duration in ms. */
  inferenceMs: number;
}

export type WorkerDelegate = "GPU" | "CPU";

export type WorkerInbound =
  | {
      type: "init";
      wasmBasePath: string;
      modelPath: string;
      preferGpu: boolean;
    }
  | { type: "frame"; bitmap: ImageBitmap; timestamp: number }
  | { type: "stop" };

export type WorkerOutbound =
  | { type: "ready"; delegate: WorkerDelegate }
  /** The worker switched backend after benchmarking (e.g. slow GPU → CPU). */
  | { type: "delegate"; delegate: WorkerDelegate; reason: string }
  | { type: "error"; message: string }
  | ({ type: "frame" } & LandmarkFrame);
