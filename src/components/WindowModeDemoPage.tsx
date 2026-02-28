"use client";

import { useEffect, useRef, useState } from "react";
import { ScanFace } from "lucide-react";

type Pt = { x: number; y: number };
type Iris = { center: Pt; edges: Pt[] };

const DEFAULT_HFOV_DEG = 60;
const WORLD_TO_VOXEL_SCALE = 0.0075;
const SCREEN_SCALE = 0.2 * 1.684;
const SCREEN_POSITION = [0.0, 0.0, -0.5];
const SCREEN_TARGET = [0.0, 0.0, 0.0];

const RIGHT_IRIS_IDX = 468;
const LEFT_IRIS_IDX = 473;

export default function WindowModeDemoPage() {
  const isPortrait = useIsPortrait();
  const isWebGpuSupported =
    typeof navigator !== "undefined" && "gpu" in navigator;

  const vvUrl = isPortrait
    ? "/target_visualization_mobile.vv"
    : "/target_visualization.vv";

  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [numFramesFaceHidden, setNumFramesFaceHidden] = useState(0);
  const [showTiltInstruction, setShowTiltInstruction] = useState(false);

  const vvRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const irisDistRightRef = useRef<number | null>(null);
  const irisDistLeftRef = useRef<number | null>(null);
  const isPortraitRef = useRef(isPortrait);
  const numFramesFaceHiddenRef = useRef(numFramesFaceHidden);

  useEffect(() => {
    import("spatial-player/src/index.js" as any);
  }, []);

  useEffect(() => {
    isPortraitRef.current = isPortrait;
  }, [isPortrait]);

  useEffect(() => {
    numFramesFaceHiddenRef.current = numFramesFaceHidden;
  }, [numFramesFaceHidden]);

  useEffect(() => {
    const savedPermission = getCookie("camera_permission_granted");
    if (savedPermission === "true") {
      setHasPermission(true);
    }
  }, []);

  useEffect(() => {
    if (!hasPermission) return;
    setShowTiltInstruction(true);
    const timer = window.setTimeout(() => setShowTiltInstruction(false), 3000);
    return () => window.clearTimeout(timer);
  }, [hasPermission]);

  useEffect(() => {
    if (!hasPermission) return;

    let running = true;
    let worker: Worker | undefined;

    async function init() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 160 },
            height: { ideal: 120 },
          },
          audio: false,
        });
        const video = videoRef.current;
        if (!video) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const videoEl: HTMLVideoElement = video;

        videoEl.srcObject = stream;
        await videoEl.play();

        worker = new Worker(new URL("./LandmarkWorker.tsx", import.meta.url), {
          type: "module",
        });

        worker.postMessage({
          type: "init",
          payload: {
            wasmPath:
              "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
            modelPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          },
        });

        let lastTime = -1;
        let landmarkingReady = false;
        let landmarkingInFlight = false;
        let lastVideoTime = -1;
        let latestLandmarks: any[] | null = null;

        worker.onmessage = (e: MessageEvent) => {
          if (e.data.type === "landmarks") {
            latestLandmarks = e.data.payload?.[0] ?? null;
            landmarkingInFlight = false;
            if (latestLandmarks) {
              setNumFramesFaceHidden(0);
            } else {
              setNumFramesFaceHidden(numFramesFaceHiddenRef.current + 1);
            }
          }

          if (e.data.type === "ready") {
            landmarkingReady = true;
          }
        };

        function extractIris(landmarks: any[], idx: number): Iris {
          const edges = [];
          for (let i = 0; i < 4; i++) {
            const landmark = landmarks[idx + 1 + i];
            edges.push({ x: landmark.x, y: landmark.y });
          }
          return {
            center: { x: landmarks[idx].x, y: landmarks[idx].y },
            edges,
          };
        }

        function focalLengthPixels(imageWidthPx: number, hFovDeg: number) {
          const fovRad = (hFovDeg * Math.PI) / 180;
          return imageWidthPx / (2 * Math.tan(fovRad / 2));
        }

        function irisDistance(iris: Iris, hFovDeg = DEFAULT_HFOV_DEG): number {
          const irisDiameterMm = 11.7;
          const dx =
            (((iris.edges[0].x - iris.edges[2].x) +
              (iris.edges[1].x - iris.edges[3].x)) /
              2.0) *
            videoEl.videoWidth;
          const dy =
            (((iris.edges[0].y - iris.edges[2].y) +
              (iris.edges[1].y - iris.edges[3].y)) /
              2.0) *
            videoEl.videoHeight;
          const irisSize = Math.sqrt(dx * dx + dy * dy);
          const fpx = focalLengthPixels(videoEl.videoWidth, hFovDeg);
          return (fpx * (irisDiameterMm / 10)) / irisSize;
        }

        function irisPosition(
          iris: Iris,
          distanceCm: number,
          hFovDeg = DEFAULT_HFOV_DEG,
        ) {
          const width = videoEl.videoWidth;
          const height = videoEl.videoHeight;
          const fpx = focalLengthPixels(width, hFovDeg);
          const x = -(iris.center.x * width - width / 2) * (distanceCm / fpx);
          const y =
            -(iris.center.y * height - height / 2) * (distanceCm / fpx);
          return { x, y, z: distanceCm };
        }

        function loop() {
          if (!running) return;
          const currentTime = performance.now();
          const dt = currentTime - lastTime;
          lastTime = currentTime;

          if (
            landmarkingReady &&
            !landmarkingInFlight &&
            videoEl.currentTime !== lastVideoTime
          ) {
            const videoTimestamp = Math.round(videoEl.currentTime * 1000);
            createImageBitmap(videoEl).then((bitmap) => {
              worker?.postMessage(
                { type: "frame", payload: { bitmap, timestamp: videoTimestamp } },
                [bitmap],
              );
            });
            landmarkingInFlight = true;
            lastVideoTime = videoEl.currentTime;
          }

          if (latestLandmarks) {
            const irisRight = extractIris(latestLandmarks, RIGHT_IRIS_IDX);
            const irisLeft = extractIris(latestLandmarks, LEFT_IRIS_IDX);

            const irisTargetDistRight = irisDistance(irisRight);
            const irisTargetDistLeft = irisDistance(irisLeft);
            let irisDistRight = irisDistRightRef.current;
            let irisDistLeft = irisDistLeftRef.current;

            const distanceDecay = 1.0 - Math.pow(0.99, dt);
            irisDistRight =
              irisDistRight != null
                ? irisDistRight + (irisTargetDistRight - irisDistRight) * distanceDecay
                : irisTargetDistRight;
            irisDistLeft =
              irisDistLeft != null
                ? irisDistLeft + (irisTargetDistLeft - irisDistLeft) * distanceDecay
                : irisTargetDistLeft;

            irisDistRightRef.current = irisDistRight;
            irisDistLeftRef.current = irisDistLeft;

            const minDist = Math.min(irisDistLeft, irisDistRight);
            const irisPosRight = irisPosition(irisRight, minDist);
            const irisPosLeft = irisPosition(irisLeft, minDist);

            if (customElements.get("vv-player") && vvRef.current) {
              const avgPos = [
                (irisPosRight.x + irisPosLeft.x) / 2.0,
                (irisPosRight.y + irisPosLeft.y) / 2.0,
                (irisPosRight.z + irisPosLeft.z) / 2.0,
              ];

              avgPos[1] -= isPortraitRef.current ? 30.0 : 20.0;

              (vvRef.current as any).setCamera("portal", {
                eyePosWorld: avgPos,
                screenScale: SCREEN_SCALE,
                worldToVoxelScale: WORLD_TO_VOXEL_SCALE,
                screenPos: SCREEN_POSITION,
                screenTarget: SCREEN_TARGET,
              });
            }
          }

          requestAnimationFrame(loop);
        }

        requestAnimationFrame(loop);
      } catch (e: any) {
        setError(e?.message ?? "Failed to initialize");
      }
    }

    init();

    return () => {
      running = false;
      worker?.terminate();
      const video = videoRef.current;
      const stream = video?.srcObject as MediaStream | null;
      stream?.getTracks()?.forEach((track) => track.stop());
    };
  }, [hasPermission]);

  async function requestCameraPermission() {
    setIsRequestingPermission(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 160 },
          height: { ideal: 120 },
        },
        audio: false,
      });
      stream.getTracks().forEach((track) => track.stop());
      setCookie("camera_permission_granted", "true", 365);
      setHasPermission(true);
    } catch {
      setError(
        "Camera access is required for this experience. Please allow camera access and refresh.",
      );
    } finally {
      setIsRequestingPermission(false);
    }
  }

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center">
      {!hasPermission ? (
        <div className="w-full max-w-md px-6 text-center">
          <div className="mb-6 flex justify-center">
            <div className="w-20 h-20 rounded-full bg-white/10 border border-white/20 flex items-center justify-center">
              <ScanFace className="w-10 h-10" />
            </div>
          </div>
          <h1 className="text-3xl font-bold mb-4">Slipstream Head Control</h1>
          <p className="text-gray-300 mb-6">
            Camera-based head tracking drives the ship viewpoint. Processing stays
            local in the browser.
          </p>
          <button
            onClick={requestCameraPermission}
            disabled={isRequestingPermission}
            className="w-full bg-white text-black font-semibold py-3 px-6 rounded-lg hover:bg-gray-200 disabled:opacity-60"
          >
            {isRequestingPermission ? "Requesting Access..." : "Allow Camera Access"}
          </button>
          {error ? <p className="mt-4 text-red-400">{error}</p> : null}
        </div>
      ) : (
        <div className="w-full h-screen p-2 md:p-4">
          <video ref={videoRef} playsInline muted className="hidden" />
          <div
            className={`w-full h-full rounded-lg overflow-hidden border border-white/20 ${
              isPortrait ? "aspect-9/16" : "aspect-video"
            }`}
          >
            {!isWebGpuSupported ? (
              <div className="w-full h-full flex items-center justify-center text-center px-6">
                WebGPU is not supported on this browser.
              </div>
            ) : (
              <>
                {/* @ts-expect-error custom element from spatial-player */}
                <vv-player
                  ref={vvRef}
                  src={vvUrl}
                  bounding-box="hide"
                  top-color="0 0 0 1"
                  bot-color="0 0 0 1"
                  video-controls="hide"
                  style={{ width: "100%", height: "100%", display: "block" }}
                />
                {numFramesFaceHidden > 3 ? (
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="bg-black/70 border border-white/30 rounded-xl px-6 py-4 text-center">
                      <div className="font-semibold">CAN&apos;T FIND USER</div>
                      <div className="text-sm text-gray-300 mt-1">
                        Center your face in the camera frame.
                      </div>
                    </div>
                  </div>
                ) : null}
                {showTiltInstruction ? (
                  <div className="absolute inset-0 pointer-events-none flex items-end justify-center pb-10">
                    <div className="bg-white/10 border border-white/30 rounded-xl px-4 py-2">
                      Tilt your head
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function useIsPortrait() {
  const [isPortrait, setIsPortrait] = useState(false);
  useEffect(() => {
    const update = () => setIsPortrait(window.innerHeight > window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return isPortrait;
}

function setCookie(name: string, value: string, days = 365) {
  const expires = new Date();
  expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/;SameSite=Lax`;
}

function getCookie(name: string): string | null {
  const nameEq = `${name}=`;
  const cookieParts = document.cookie.split(";");
  for (let i = 0; i < cookieParts.length; i++) {
    let c = cookieParts[i];
    while (c.charAt(0) === " ") c = c.substring(1, c.length);
    if (c.indexOf(nameEq) === 0) return c.substring(nameEq.length, c.length);
  }
  return null;
}
