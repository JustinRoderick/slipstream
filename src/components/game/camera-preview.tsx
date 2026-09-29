"use client";

import type { RefObject } from "react";
import { cn } from "@/lib/utils";

interface CameraPreviewProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HTMLCanvasElement | null>;
  visible: boolean;
}

/**
 * Mirrored webcam thumbnail with a landmark overlay so the player can see what
 * the tracker sees. The <video> is always mounted (the tracker reads frames
 * from it); when hidden it's collapsed to a transparent 1px box rather than
 * `display: none` so playback is never throttled.
 */
export function CameraPreview({ videoRef, overlayRef, visible }: CameraPreviewProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-4 left-4 overflow-hidden rounded-lg border border-white/20 bg-black/60 shadow-lg md:bottom-6 md:left-6",
        visible ? "h-[120px] w-[160px] opacity-100" : "h-px w-px opacity-0",
      )}
    >
      {/* scale-x-[-1] mirrors the feed so it behaves like a mirror. */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
      />
      <canvas
        ref={overlayRef}
        width={160}
        height={120}
        className="absolute inset-0 h-full w-full"
      />
      {visible ? (
        <div className="absolute inset-x-0 bottom-0 bg-black/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300">
          local only · never uploaded
        </div>
      ) : null}
    </div>
  );
}

/**
 * Draws the tracker's view of the face onto the preview overlay. Coordinates
 * are normalized image coordinates; x is flipped to match the mirrored video.
 */
export function drawPreviewOverlay(
  canvas: HTMLCanvasElement,
  nose: { x: number; y: number } | null,
  neutralNose: { x: number; y: number } | null,
  outline: Float32Array | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const mx = (x: number) => (1 - x) * w;

  if (outline) {
    ctx.fillStyle = "rgba(103, 232, 249, 0.55)";
    for (let i = 0; i < outline.length; i += 3) {
      ctx.fillRect(mx(outline[i]) - 0.5, outline[i + 1] * h - 0.5, 1, 1);
    }
  }

  if (neutralNose) {
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1;
    const cx = mx(neutralNose.x);
    const cy = neutralNose.y * h;
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.stroke();
  }

  if (nose) {
    ctx.fillStyle = "#34d399";
    ctx.beginPath();
    ctx.arc(mx(nose.x), nose.y * h, 3.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = "rgba(251,191,36,0.9)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("no face", w / 2, h / 2);
  }
}
