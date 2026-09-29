import type { HeadPose, LandmarkFrame } from "./types";

const RAD_TO_DEG = 180 / Math.PI;

/** MediaPipe Face Landmarker indices used here. */
export const LM = {
  NOSE_TIP: 1,
  FOREHEAD: 10,
  CHIN: 152,
  /** Outer corner of the subject's right eye (appears on image-left when un-mirrored). */
  RIGHT_EYE_OUTER: 33,
  /** Outer corner of the subject's left eye (appears on image-right when un-mirrored). */
  LEFT_EYE_OUTER: 263,
} as const;

/** Approximate real-world distance between the outer eye corners, cm. */
const OUTER_EYE_DISTANCE_CM = 9.0;
/** Assumed horizontal field of view of a typical laptop webcam. */
const ASSUMED_HFOV_DEG = 60;

interface Rigid {
  /** Rotation columns: r[c] = image of canonical basis vector c. */
  right: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
  t: [number, number, number];
}

/**
 * Reads a rigid transform out of a 16-float 4×4 matrix regardless of whether
 * it is stored column-major (three.js/OpenGL style) or row-major.
 *
 * Detection: a rigid transform has an affine row `0 0 0 1`. In column-major
 * storage that row lives at indices 3, 7, 11 (with 15 = 1) and the translation
 * at 12..14. In row-major storage it is the other way round. Because the head
 * is never at the camera origin, the translation is clearly non-zero, which
 * makes the layout unambiguous.
 */
export function readRigidTransform(data: ArrayLike<number>): Rigid {
  const colMajorAffine = Math.abs(data[3]) + Math.abs(data[7]) + Math.abs(data[11]);
  const rowMajorAffine = Math.abs(data[12]) + Math.abs(data[13]) + Math.abs(data[14]);
  const columnMajor = colMajorAffine <= rowMajorAffine;
  const m = (row: number, col: number) => (columnMajor ? data[col * 4 + row] : data[row * 4 + col]);
  return {
    right: [m(0, 0), m(1, 0), m(2, 0)],
    up: [m(0, 1), m(1, 1), m(2, 1)],
    forward: [m(0, 2), m(1, 2), m(2, 2)],
    t: [m(0, 3), m(1, 3), m(2, 3)],
  };
}

/**
 * Converts the facial transformation matrix (canonical face → camera metric
 * space) into yaw/pitch/roll in degrees plus translation in cm.
 *
 * MediaPipe's metric space is right-handed with the camera at the origin
 * looking down −Z, X to image-right and Y up; the canonical face looks toward
 * +Z (at the camera). So the third rotation column is the direction the face
 * is pointing.
 */
export function poseFromMatrix(
  data: ArrayLike<number>,
  nose: { x: number; y: number },
  timestamp: number,
): HeadPose {
  const { right, forward, t } = readRigidTransform(data);
  const [fx, fy, fz] = forward;
  const yaw = Math.atan2(fx, fz) * RAD_TO_DEG;
  const pitch = Math.atan2(fy, Math.hypot(fx, fz)) * RAD_TO_DEG;
  const roll = Math.atan2(right[1], right[0]) * RAD_TO_DEG;
  return {
    timestamp,
    yaw,
    pitch,
    roll,
    x: t[0],
    y: t[1],
    z: t[2],
    nose,
    source: "matrix",
  };
}

function landmark(landmarks: Float32Array, index: number) {
  const i = index * 3;
  return { x: landmarks[i], y: landmarks[i + 1], z: landmarks[i + 2] };
}

/**
 * Best-effort pose from 2D landmarks only. Used when the detector did not
 * return a transformation matrix. Angles are rough (they come from where the
 * nose sits inside the face outline) but the signs match `poseFromMatrix`.
 */
export function poseFromLandmarks(
  landmarks: Float32Array,
  width: number,
  height: number,
  timestamp: number,
): HeadPose {
  const aspect = width / height;
  // Work in "height units" so x and y distances are comparable.
  const px = (p: { x: number; y: number }) => ({ x: p.x * aspect, y: p.y });

  const nose = landmark(landmarks, LM.NOSE_TIP);
  const eyeR = px(landmark(landmarks, LM.RIGHT_EYE_OUTER));
  const eyeL = px(landmark(landmarks, LM.LEFT_EYE_OUTER));
  const chin = px(landmark(landmarks, LM.CHIN));
  const forehead = px(landmark(landmarks, LM.FOREHEAD));
  const noseP = px(nose);

  const eyeMid = { x: (eyeR.x + eyeL.x) / 2, y: (eyeR.y + eyeL.y) / 2 };
  const faceMid = { x: (chin.x + forehead.x) / 2, y: (chin.y + forehead.y) / 2 };
  const eyeDist = Math.max(1e-6, Math.hypot(eyeL.x - eyeR.x, eyeL.y - eyeR.y));
  const faceHeight = Math.max(1e-6, Math.hypot(chin.x - forehead.x, chin.y - forehead.y));

  // Nose displaced toward image-right ⇒ face turned toward image-right (positive yaw).
  const yaw = clamp(((noseP.x - eyeMid.x) / eyeDist) * 2, -1, 1) * 60;
  // Nose displaced upward in the image (smaller y) ⇒ looking up (positive pitch).
  const pitch = clamp((-(noseP.y - faceMid.y) / faceHeight) * 2.5, -1, 1) * 60;
  // Eye line tilted ⇒ roll. Image y grows downward, hence the negation.
  const roll = -Math.atan2(eyeL.y - eyeR.y, eyeL.x - eyeR.x) * RAD_TO_DEG;

  // Pinhole-camera estimate of position, same idea as the old iris-based code.
  const focalPx = width / (2 * Math.tan((ASSUMED_HFOV_DEG * Math.PI) / 360));
  const eyeDistPx = eyeDist * height;
  const z = (focalPx * OUTER_EYE_DISTANCE_CM) / Math.max(1, eyeDistPx);
  const x = ((nose.x - 0.5) * width * z) / focalPx;
  const y = (-(nose.y - 0.5) * height * z) / focalPx;

  return {
    timestamp,
    yaw,
    pitch,
    roll,
    x,
    y,
    z: -z,
    nose: { x: nose.x, y: nose.y },
    source: "landmarks",
  };
}

/** Turns a worker frame into a pose, or null when no face was found. */
export function poseFromFrame(frame: LandmarkFrame): HeadPose | null {
  if (!frame.landmarks || frame.landmarks.length < 478 * 3) return null;
  if (frame.matrix && frame.matrix.length === 16) {
    const nose = landmark(frame.landmarks, LM.NOSE_TIP);
    return poseFromMatrix(frame.matrix, { x: nose.x, y: nose.y }, frame.timestamp);
  }
  return poseFromLandmarks(frame.landmarks, frame.width, frame.height, frame.timestamp);
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
