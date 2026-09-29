import * as THREE from "three";
import type { Bounds, GameState } from "./types";

export interface GameViewOptions {
  bounds: Bounds;
  maxAsteroids: number;
  /** How far ahead the corridor frames and starfield extend (world units). */
  depth?: number;
}

const STAR_COUNT = 1400;
const FRAME_COUNT = 10;

/**
 * Renders a `GameState` with three.js. Purely a view: it never mutates game
 * state and holds only visual-only state (camera lag, crash shake, etc.).
 *
 * World axes: the ship flies toward −Z, +Y is up, +X is the ship's right.
 */
export class GameView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly bounds: Bounds;
  private readonly depth: number;

  private readonly ship = new THREE.Group();
  private readonly shipBody: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly engineGlow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly asteroids: THREE.InstancedMesh;
  private readonly stars: THREE.Points;
  private readonly starPositions: Float32Array;
  private readonly frames: THREE.LineSegments[] = [];
  private readonly crashFlash: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

  private readonly tmpObject = new THREE.Object3D();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpAxis = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  private crashShake = 0;
  private lastPhase: GameState["phase"] | null = null;
  private frameOffset = 0;

  constructor(canvas: HTMLCanvasElement, options: GameViewOptions) {
    this.bounds = options.bounds;
    this.depth = options.depth ?? 300;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x03040a, 1);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, this.depth + 100);
    this.camera.position.set(0, 2.4, 10);

    this.scene.fog = new THREE.Fog(0x03040a, 90, this.depth);
    this.scene.add(new THREE.HemisphereLight(0x99aaff, 0x0a0a18, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, 12, 8);
    this.scene.add(sun);

    // Ship: a cone nose, two fins, and an engine glow. Placeholder geometry.
    const hull = new THREE.MeshStandardMaterial({
      color: 0xdfe6ff,
      metalness: 0.4,
      roughness: 0.45,
      emissive: 0x111a33,
    });
    this.shipBody = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.2, 12), hull);
    this.shipBody.rotation.x = -Math.PI / 2; // point the nose toward −Z
    this.ship.add(this.shipBody);
    const fin = new THREE.BoxGeometry(2.6, 0.08, 0.9);
    const finMesh = new THREE.Mesh(fin, hull);
    finMesh.position.set(0, -0.1, 0.5);
    this.ship.add(finMesh);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 0.7), hull);
    tail.position.set(0, 0.35, 0.6);
    this.ship.add(tail);
    this.engineGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x66ccff }),
    );
    this.engineGlow.position.set(0, 0, 1.15);
    this.ship.add(this.engineGlow);
    this.scene.add(this.ship);

    // Asteroids: one instanced low-poly rock; per-instance non-uniform scale makes them lumpy.
    const rock = new THREE.IcosahedronGeometry(1, 1);
    jitterVertices(rock, 0.18);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x8b8378,
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true,
    });
    this.asteroids = new THREE.InstancedMesh(rock, rockMat, options.maxAsteroids);
    this.asteroids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.asteroids.frustumCulled = false;
    for (let i = 0; i < options.maxAsteroids; i++) this.asteroids.setMatrixAt(i, this.zeroMatrix);
    this.scene.add(this.asteroids);

    // Starfield: points streaming past for a sense of speed.
    this.starPositions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      this.starPositions[i * 3] = (Math.random() * 2 - 1) * 120;
      this.starPositions[i * 3 + 1] = (Math.random() * 2 - 1) * 80;
      this.starPositions[i * 3 + 2] = -Math.random() * this.depth;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(this.starPositions, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xbfd0ff, size: 0.5, sizeAttenuation: true, fog: false }),
    );
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // Corridor frames: outline of the playable area, repeating into the distance.
    const frameGeo = rectangleOutline(this.bounds.halfWidth, this.bounds.halfHeight);
    const frameMat = new THREE.LineBasicMaterial({
      color: 0x2a6cff,
      transparent: true,
      opacity: 0.28,
    });
    for (let i = 0; i < FRAME_COUNT; i++) {
      const line = new THREE.LineSegments(frameGeo, frameMat);
      this.frames.push(line);
      this.scene.add(line);
    }

    // Full-screen-ish flash quad used on crash.
    this.crashFlash = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshBasicMaterial({
        color: 0xff4d3d,
        transparent: true,
        opacity: 0,
        depthTest: false,
      }),
    );
    this.crashFlash.renderOrder = 999;
    this.crashFlash.visible = false;
    this.camera.add(this.crashFlash);
    this.crashFlash.position.set(0, 0, -5);
    this.scene.add(this.camera);
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Syncs visuals to `state` and draws a frame. `dt` in seconds. */
  render(state: GameState, dt: number): void {
    const phaseChanged = state.phase !== this.lastPhase;
    if (phaseChanged) {
      if (state.phase === "crashed") this.crashShake = 1;
      if (state.phase === "running" && this.lastPhase !== "paused") this.crashShake = 0;
      this.lastPhase = state.phase;
    }

    this.syncShip(state);
    this.syncAsteroids(state);

    const moving = state.phase === "running";
    const speed = moving ? state.speed : 0;
    this.advanceStars(speed * dt);
    this.advanceFrames(speed * dt);
    this.updateCamera(state, dt);
    this.updateCrashEffects(state, dt);

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
    this.renderer.dispose();
  }

  private syncShip(state: GameState) {
    const { ship } = state;
    this.ship.position.set(ship.position.x, ship.position.y, ship.position.z);
    this.ship.rotation.set(ship.pitch, 0, ship.bank, "YXZ");
    this.ship.visible = state.phase !== "crashed" || this.crashShake > 0.35;
    const boost = state.phase === "running" ? 0.75 + (state.speed / 120) * 0.6 : 0.4;
    this.engineGlow.scale.setScalar(boost);
  }

  private syncAsteroids(state: GameState) {
    const list = state.asteroids;
    for (let i = 0; i < list.length && i < this.asteroids.count; i++) {
      const a = list[i];
      if (!a.active) {
        this.asteroids.setMatrixAt(i, this.zeroMatrix);
        continue;
      }
      this.tmpObject.position.set(a.position.x, a.position.y, a.position.z);
      this.tmpAxis.set(a.spinAxis.x, a.spinAxis.y, a.spinAxis.z);
      this.tmpQuat.setFromAxisAngle(this.tmpAxis, a.spinAngle);
      this.tmpObject.quaternion.copy(this.tmpQuat);
      this.tmpObject.scale.set(a.scale.x, a.scale.y, a.scale.z);
      this.tmpObject.updateMatrix();
      this.asteroids.setMatrixAt(i, this.tmpObject.matrix);
    }
    this.asteroids.instanceMatrix.needsUpdate = true;
  }

  private advanceStars(dz: number) {
    if (dz === 0) return;
    const p = this.starPositions;
    // Stars move slower than the world for parallax.
    const step = dz * 0.45;
    for (let i = 0; i < STAR_COUNT; i++) {
      let z = p[i * 3 + 2] + step;
      if (z > 15) z -= this.depth + 15;
      p[i * 3 + 2] = z;
    }
    (this.stars.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private advanceFrames(dz: number) {
    const spacing = this.depth / FRAME_COUNT;
    this.frameOffset = (this.frameOffset + dz) % spacing;
    for (let i = 0; i < FRAME_COUNT; i++) {
      const z = -i * spacing + this.frameOffset;
      this.frames[i].position.z = z > 5 ? z - this.depth : z;
    }
  }

  private updateCamera(state: GameState, dt: number) {
    const ship = state.ship.position;
    // The camera follows the ship partially so the corridor edges stay in view.
    this.camTarget.set(ship.x * 0.55, ship.y * 0.55 + 2.4, ship.z + 10.5);
    const k = 1 - Math.exp(-dt * 7);
    this.camera.position.lerp(this.camTarget, k);

    if (this.crashShake > 0) {
      const s = this.crashShake * 0.6;
      this.camera.position.x += (Math.random() * 2 - 1) * s;
      this.camera.position.y += (Math.random() * 2 - 1) * s;
    }

    this.lookTarget.set(ship.x * 0.4, ship.y * 0.4, ship.z - 45);
    this.camera.lookAt(this.lookTarget);
    this.camera.rotateZ(-state.ship.bank * 0.22);
  }

  private updateCrashEffects(state: GameState, dt: number) {
    if (state.phase === "crashed" && this.crashShake > 0) {
      this.crashShake = Math.max(0, this.crashShake - dt * 1.8);
    } else if (state.phase !== "crashed") {
      this.crashShake = 0;
    }
    const flash = state.phase === "crashed" ? this.crashShake * 0.55 : 0;
    this.crashFlash.visible = flash > 0.01;
    this.crashFlash.material.opacity = flash;
  }
}

function rectangleOutline(halfW: number, halfH: number): THREE.BufferGeometry {
  const pts = [
    -halfW,
    -halfH,
    0,
    halfW,
    -halfH,
    0,
    halfW,
    -halfH,
    0,
    halfW,
    halfH,
    0,
    halfW,
    halfH,
    0,
    -halfW,
    halfH,
    0,
    -halfW,
    halfH,
    0,
    -halfW,
    -halfH,
    0,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/** Pushes vertices in/out along their normal so the rock isn't a perfect polyhedron. */
function jitterVertices(geometry: THREE.BufferGeometry, amount: number) {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Shared corners must move together or the mesh tears; key by rounded position.
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let s = seen.get(key);
    if (s === undefined) {
      s = 1 + (Math.random() * 2 - 1) * amount;
      seen.set(key, s);
    }
    v.multiplyScalar(s);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}
