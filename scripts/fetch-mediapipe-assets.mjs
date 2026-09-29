// Copies the MediaPipe WASM runtime out of node_modules and downloads the face
// landmarker model into `public/mediapipe/` so the app serves them itself.
//
// Why: the browser must never talk to a third-party server while the camera is
// on. With the runtime + model served same-origin, all face tracking runs
// locally and the only network traffic is the page's own static assets.
//
// Idempotent: existing files are left alone. Runs automatically before
// `dev` and `build` (see package.json).

import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The package's `exports` map hides package.json from require.resolve, so
// locate the wasm directory by path instead.
const wasmSrcDir = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const outDir = path.join(root, "public", "mediapipe");
const wasmOutDir = path.join(outDir, "wasm");

const WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_FILE = "face_landmarker.task";
// Refuse to accept a truncated/HTML error page as a model.
const MODEL_MIN_BYTES = 1_000_000;

async function exists(file, minBytes = 1) {
  try {
    const s = await stat(file);
    return s.isFile() && s.size >= minBytes;
  } catch {
    return false;
  }
}

async function copyWasm() {
  await mkdir(wasmOutDir, { recursive: true });
  for (const name of WASM_FILES) {
    const dest = path.join(wasmOutDir, name);
    if (await exists(dest)) continue;
    await copyFile(path.join(wasmSrcDir, name), dest);
    console.log(`[mediapipe-assets] copied ${name}`);
  }
}

async function downloadModel() {
  const dest = path.join(outDir, MODEL_FILE);
  if (await exists(dest, MODEL_MIN_BYTES)) return;

  console.log(`[mediapipe-assets] downloading ${MODEL_FILE} (one-time, ~3.7 MB)...`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) {
    throw new Error(`Model download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < MODEL_MIN_BYTES) {
    throw new Error(`Model download looks truncated (${bytes.byteLength} bytes)`);
  }
  await writeFile(dest, bytes);
  console.log(`[mediapipe-assets] saved ${path.relative(root, dest)}`);
}

try {
  await copyWasm();
  await downloadModel();
} catch (err) {
  console.error("[mediapipe-assets] failed:", err instanceof Error ? err.message : err);
  console.error(
    "[mediapipe-assets] The game needs public/mediapipe/face_landmarker.task to run head tracking.",
  );
  console.error(`[mediapipe-assets] Download it manually from:\n  ${MODEL_URL}`);
  process.exit(1);
}
