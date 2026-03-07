# Slipstream Head-Controlled 3D Flight Game Plan

## Goal

Build a browser game where the player pilots a ship through 3D obstacles using head movement, with smooth tracking, low-latency rendering, and scalable `.vv` content pipelines.

## Success Criteria

- Head movement feels intuitive in under 30 seconds of play.
- Camera-to-ship control latency stays under ~80ms on modern laptops.
- Baseline game loop supports spawning/scoring/collision/restart.
- Scene pipeline can scale from 2 sample `.vv` files to many level chunks.
- Mobile + desktop orientation both render correctly.

## Current Baseline (From `repomix-output.xml`)

- Existing window-mode camera logic using MediaPipe iris landmarks.
- `spatial-player` + `.vv` scene rendering.
- Worker-based landmark detection off main thread.
- Permission flow and WebGPU capability checks.
- Two sample `.vv` files in `public/`.

## Phase 0 - Migration Foundation (In Progress)

1. Migrate head-tracking worker and viewport page into `src/components`.
2. Wire `src/app/page.tsx` to the migrated scene view.
3. Add required dependencies (`spatial-player`, `@mediapipe/tasks-vision`).
4. Add COOP/COEP headers in `next.config.ts` for WebAssembly/threading compatibility.
5. Preserve current sample `.vv` files as the first playable environment.

### Immediate Improvements Added During Migration

- Guarded `navigator` access for safer runtime behavior.
- Kept worker-based tracking architecture to avoid render stalls.
- Kept orientation-aware `.vv` source switching (landscape/portrait).

## Phase 1 - Playable Flight Prototype

1. Define player ship model in game state (position, velocity, hit radius).
2. Map head inputs to ship steering:
   - Yaw (left/right) from normalized head X.
   - Pitch (up/down) from normalized head Y.
   - Optional depth/speed modulation from distance Z.
3. Add smoothing/dead-zone and sensitivity controls:
   - dead zone around neutral pose
   - max turn rate clamp
   - adaptive smoothing for jitter reduction
4. Build obstacle system:
   - lane-based or spline-based obstacle placement
   - deterministic seeded generation for reproducibility
5. Add collision + game states:
   - `ready`, `running`, `crashed`, `paused`, `finished`
6. Add HUD:
   - score, distance, speed, retry button

## Phase 2 - 3D Content & Level Streaming

1. Decide scene composition model:
   - **Option A:** one large `.vv` per full level
   - **Option B (recommended):** chunked `.vv` segments streamed in sequence
2. Implement chunk manager:
   - preload current + next N chunks
   - unload old chunks behind player
3. Define obstacle metadata file (`levels/*.json`):
   - chunk id
   - obstacle transforms
   - safe path width
4. Build authoring convention:
   - ship forward axis
   - world scale units
   - collision proxy shapes

## Phase 3 - Calibration & UX

1. Add 3-step calibration flow:
   - neutral head pose
   - max left/right comfortable range
   - max up/down comfortable range
2. Expose settings UI:
   - sensitivity
   - invert axis
   - comfort mode (reduced camera gain)
3. Add onboarding:
   - short tutorial run
   - live “you are here” reticle indicator

## Phase 4 - Performance Hardening

1. Instrument frame time and tracking latency.
2. Add adaptive quality:
   - reduce scene complexity on low FPS
   - lower camera processing frequency when needed
3. Reduce GC pressure in hot loops (reuse vectors/objects).
4. Validate on target browsers/devices and tune defaults.

## Phase 5 - Content Production Pipeline

1. Create canonical DCC workflow:
   - model in Blender
   - export GLB
   - convert GLB -> `.vv` via Splat voxelize tool
2. Define naming/versioning:
   - `public/levels/<level>/<chunk>.vv`
3. Add validation checklist:
   - scale check
   - orientation check
   - collision passability check
4. Keep a “golden run” replay for regression testing.

## Recommended Software for Scenes + Ship

- **Best all-around choice:** Blender (modeling/layout), then export GLB and convert to `.vv`.
- **Fast level blockout:** Blender geometry nodes or simple modular kit pieces.
- **Texture/material polish:** Blender + optional Substance Painter (if needed before voxel conversion).

## Integration Approach for Rocket + Scenes

1. Create ship in Blender at canonical scale.
2. Build level chunks in Blender with clear flight corridors.
3. Export each chunk + ship as GLB.
4. Convert each GLB to `.vv`.
5. Load chunk `.vv` files via a level manifest in the app.
6. Drive ship transform from head-tracking output in the game loop.

## Key Risks & Mitigations

- **Tracking jitter:** use filtered pose + dead-zone + calibration.
- **Player fatigue:** keep low default gain and optional comfort mode.
- **Asset throughput:** chunked scenes + naming/versioning discipline.
- **Performance regressions:** add telemetry from prototype stage onward.

## Clarifying Questions

1. Do you want “ship moves through world” or “world scrolls past mostly-stationary ship” as the primary feel?
2. Should the first playable version be desktop-only, or must mobile Safari/Chrome be first-class immediately?
3. Do you want realistic visuals or stylized/arcade visuals for initial content creation?
4. Should obstacles be handcrafted authored levels, procedural generation, or both?
5. Is there a target minimum FPS/device class we should optimize for in milestone 1?

## Next Execution Steps

1. Finish dependency install and compile validation.
2. Add explicit ship state + obstacle state data models.
3. Implement first collision pass with one sample obstacle lane.
4. Add calibration overlay and save profile in local storage.
