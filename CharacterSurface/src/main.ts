import "./style.css";
import * as THREE from "three";
import { buildGlyphAtlas } from "./glyphAtlas";
import { GLYPH_VERT, GLYPH_FRAG, TRACE_VERT, TRACE_FRAG } from "./shaders";
import { loadModel, sampleSurfacePoints, type LoadedModel, type SurfaceSample } from "./modelSurface";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const toggleButton = document.getElementById("toggle") as HTMLButtonElement;

// ---- tunables (ported from the 2D version) ----
const SPHERE_R = 1.0;
const TILT = -0.32;        // fixed lean of the sphere (radians)
const ROT_SPEED = 0.18;    // radians / second
const WAVE_GAP = 90;       // ms between successive waves of characters
const FLIGHT = 3000;       // ms a character takes to reach the sphere
const GLYPH_WORLD = 0.07;  // on-sphere glyph height in world units
const TRACE_SEGMENTS = 16; // polyline resolution of each red trace

// built-in paragraph shown for the "Sphere" source
const SPHERE_TEXT = `Our introductory fiction class guides students through the process of writing a short story. No prior writing experience is necessary. Through daily writing assignments and class meetings, students will learn about the key building blocks of fiction—language, character, and plot—and will each complete their own short story by the end of the course. In addition to submitting daily assignments, students will meet several times as a group with our instructors and have the opportunity to ask questions during office hours. Students will also meet individually with an editor and editorial assistant to discuss their own short stories, and will not only receive written feedback on their first drafts and final stories, but on all daily assignments.`;

// ---- renderer / scene / camera ----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0xfbf6f5, 1);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
const FOV_V = (45 * Math.PI) / 180;     // vertical field of view (radians)

// camera distance to the sphere centre, used to remap depth -> ink/alpha;
// recomputed by fitCamera() as the framing adapts to the viewport
let CAM_DIST = 4.2;

// content extents (world units) the camera must keep fully on-screen; updated
// by build() once the paragraph layout is known
const contentBounds = { halfW: SPHERE_R, top: SPHERE_R, bottom: -SPHERE_R };

// Pull the camera back just far enough that the sphere AND the paragraph below
// it both fit the current viewport — so on a narrow (portrait/mobile) screen
// the whole scene scales down instead of the text spilling off the sides.
function fitCamera(): void {
  const aspect = camera.aspect || 1;
  const margin = 1.08;                  // a little breathing room
  const centerY = (contentBounds.top + contentBounds.bottom) / 2;
  const halfH = ((contentBounds.top - contentBounds.bottom) / 2) * margin;
  const halfW = contentBounds.halfW * margin;

  const tanV = Math.tan(FOV_V / 2);
  const distForHeight = halfH / tanV;
  const distForWidth = halfW / (tanV * aspect);   // horizontal FOV = vertical * aspect
  const dist = Math.max(distForHeight, distForWidth, 1.5);

  camera.position.set(0, centerY, dist);
  camera.lookAt(0, centerY, 0);
  camera.updateProjectionMatrix();

  // depth remap keys off the camera's distance to the sphere centre (origin)
  CAM_DIST = camera.position.length();
  uniforms.uDepthMin.value = CAM_DIST - SPHERE_R;
  uniforms.uDepthMax.value = CAM_DIST + SPHERE_R;
}

// Unproject a screen pixel onto the z=0 plane (where the paragraph lives), so a
// DOM button's centre maps to a world point the glyphs can gather into.
function screenToWorld(clientX: number, clientY: number): THREE.Vector3 {
  const ndc = new THREE.Vector3(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1,
    0.5,
  );
  ndc.unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const t = -camera.position.z / dir.z;          // intersect z = 0 plane
  return camera.position.clone().add(dir.multiplyScalar(t));
}

// world anchor for a source button (its on-screen centre); falls back to a
// point just below the sphere when the button isn't laid out yet
function buttonAnchor(btn?: HTMLButtonElement | null): THREE.Vector3 {
  if (!btn) return new THREE.Vector3(0, -1.6, 0);
  const r = btn.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

let reflowTimer = 0;
function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  fitCamera();                       // immediate: keep the current scene framed
  // re-flow the paragraph to the new aspect once resizing settles (rebuilding
  // re-samples a model, so debounce to avoid reshuffling on every drag tick)
  if (!animating) {
    clearTimeout(reflowTimer);
    reflowTimer = window.setTimeout(() => {
      if (!animating && currentText) build(currentText);
    }, 200);
  }
}
window.addEventListener("resize", resize);

// ----- evenly distributed points on a sphere (Fibonacci spiral) -----
function fibPoint(i: number, n: number): THREE.Vector3 {
  const k = i + 0.5;
  const phi = Math.acos(1 - 2 * k / n);            // polar
  const theta = Math.PI * (1 + Math.sqrt(5)) * k;  // golden angle
  return new THREE.Vector3(
    Math.cos(theta) * Math.sin(phi),
    Math.sin(theta) * Math.sin(phi),
    Math.cos(phi),
  );
}

// ---- shared uniforms (one object referenced by both materials) ----
const uniforms = {
  uTime: { value: 0 },
  uRot: { value: 0 },
  uTilt: { value: TILT },
  uFlight: { value: FLIGHT },
  uOutBounce: { value: 0.2 },
  uInBounce: { value: 0.4 },
  uWaveSize: { value: 5 },
  uWaveGap: { value: WAVE_GAP },
  uSphereR: { value: SPHERE_R },
  uColorize: { value: 0 },
  uMorph: { value: 1 },              // 1 = full paragraph, 0 = collapsed to button
  uGlyphSize: { value: GLYPH_WORLD },
  uTex: { value: null as THREE.Texture | null },
  uDepthMin: { value: CAM_DIST - SPHERE_R },
  uDepthMax: { value: CAM_DIST + SPHERE_R },
};

// A self-contained set of glyphs (+ traces) for ONE paragraph. Each layer owns
// its morph/texture/colorize uniforms but SHARES time/rotation/sliders with the
// others, so two layers can collapse and expand simultaneously during a swap.
interface Layer {
  glyph: THREE.Mesh;
  trace: THREE.LineSegments;
  uMorph: { value: number };
  tex: THREE.Texture;
}
let currentLayer: Layer | null = null;

let startTime = performance.now();
// when false, time is frozen at 0 so glyphs rest in their readable paragraph
// layout (a static preview); the Animate button flips this on to start flight
let animating = false;

// ---- loaded GLB target surface (null = land on the plain sphere) ----
let loadedModel: LoadedModel | null = null;
let currentText = "";              // last-built paragraph, so resize can re-flow it

// ---- live, slider-controlled settings ----
const settings = {
  rotSpeed: ROT_SPEED,   // idle auto-spin rate (rad/s)
  showTraces: true,      // draw the red flight trails
};

function disposeLayer(layer: Layer | null): void {
  if (!layer) return;
  for (const obj of [layer.glyph, layer.trace]) {
    scene.remove(obj);
    obj.geometry.dispose();
    (obj.material as THREE.Material).dispose();
  }
  layer.tex.dispose();
}

interface CharLayout {
  ch: string;
  source: THREE.Vector3;
  sphere: THREE.Vector3;   // unit landing DIRECTION from the centre
  radius: number;          // distance from the centre to the landing point
  color: THREE.Color;      // surface colour adopted on arrival (white on sphere)
  order: number;        // launch rank: 0 = lands first (top of the sphere)
  jitter: number;
  curve: number;
  pull: number;
}

// lay the paragraph out as wrapped text and record each character's world
// position, then pair it with a landing sample. `makeTargets(count)` supplies
// those samples: the default lands them on the sphere, but when a model is
// loaded it returns `count` samples (point + colour) across the model surface.
function layout(text: string, makeTargets?: (count: number) => SurfaceSample[]): CharLayout[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);

  // measure advances in pixels with a fixed font, then scale to world units
  const meas = document.createElement("canvas").getContext("2d")!;
  const FONT_PX = 16;
  meas.font = `${FONT_PX}px Georgia, serif`;
  const worldPerPx = GLYPH_WORLD / FONT_PX;
  const lineH = FONT_PX * 2.2;
  const space = meas.measureText(" ").width;

  // pre-measure each token so we can size the wrap width to the text length
  const tokWidths = tokens.map(t => meas.measureText(t).width);
  const totalW = tokWidths.reduce((s, w) => s + w + space, 0);

  const blockTopY = -1.25;                   // just below the sphere

  // Choose a wrap width that makes the paragraph block roughly match the
  // viewport's aspect ratio: wide screens get short/wide paragraphs, narrow
  // (mobile) screens get tall/narrow ones. Matching the aspect minimises how
  // far the auto-fit camera must zoom out, so the glyphs stay as large as
  // possible instead of shrinking to fit an over-wide block on a phone.
  //   block width ≈ maxW, height ≈ (totalW / maxW) * lineH
  //   want width/height = aspect  →  maxW = sqrt(aspect * totalW * lineH)
  const aspect = (window.innerWidth || 1) / (window.innerHeight || 1);
  const minWpx = (2 * SPHERE_R) / worldPerPx;          // at least the sphere width
  const idealWpx = Math.sqrt(Math.max(aspect, 0.25) * totalW * lineH);
  const maxW = Math.max(minWpx, idealWpx);

  const placed: Array<{ ch: string; x: number; line: number }> = [];
  let penX = 0, line = 0;
  tokens.forEach((tok, ti) => {
    const wWidth = tokWidths[ti];
    if (penX > 0 && penX + wWidth > maxW) { penX = 0; line++; }
    let acc = 0;
    for (const ch of tok) {
      const cw = meas.measureText(ch).width;
      placed.push({ ch, x: penX + acc + cw / 2, line });
      acc += cw;
    }
    penX += wWidth + space;
  });

  const m = placed.length;

  // Landing samples: either evenly-distributed Fibonacci points on the sphere
  // (flat white colour, unused unless a model tints them), or the surface
  // samples from a loaded model. Sort by descending height so READING ORDER
  // matches TOP-TO-BOTTOM build order — launching glyphs in paragraph order
  // both empties the text in order AND fills the target from the top down.
  const targets: SurfaceSample[] = (makeTargets
    ? makeTargets(m)
    : Array.from({ length: m }, (_, i) => ({
        point: fibPoint(i, m), color: new THREE.Color(1, 1, 1),
      })))
    .slice()
    .sort((a, b) => b.point.y - a.point.y);    // top first

  // Glyphs launch in parallel WAVES; the wave size is a live uniform driven
  // by a slider, so timing here is reduced to a per-glyph jitter only.
  return placed.map((c, i) => {
    const sx = (c.x - maxW / 2) * worldPerPx;
    const sy = blockTopY - c.line * lineH * worldPerPx;
    const sample = targets[i] ?? { point: new THREE.Vector3(0, 0, 1), color: new THREE.Color(1, 1, 1) };
    const radius = sample.point.length() || SPHERE_R;
    return {
      ch: c.ch,
      source: new THREE.Vector3(sx, sy, 0),
      sphere: sample.point.clone().multiplyScalar(1 / radius),   // unit direction
      radius,
      color: sample.color,
      order: i,                                // reading order == top-down order
      // per-glyph timing jitter so a wave doesn't move in rigid lockstep
      jitter: Math.random(),
      curve: (Math.random() * 2 - 1) * 0.5 + (i % 2 ? 0.15 : -0.15),
      // randomized anticipation/overshoot strength for a livelier launch
      pull: 0.6 + Math.random() * 1.1,
    };
  });
}

// Build a self-contained Layer for `text`, landing on the current target
// (sphere or loaded model), gathered at `anchor`. `morphStart` seeds the
// layer's private morph value. Shares time/rotation/slider uniforms via spread
// (the spread copies the {value} object references), but gets its own morph,
// texture and colorize so layers animate independently.
function makeLayer(text: string, anchor: THREE.Vector3, morphStart: number): Layer {
  const model = loadedModel;
  const chars = layout(text || " ",
    model ? (count) => sampleSurfacePoints(model, count) : undefined);
  const n = chars.length;

  const anchorPt = anchor;
  const uMorph = { value: morphStart };
  const uColorize = { value: model ? 1 : 0 };

  // measure how wide/tall everything reaches (sphere + paragraph) so the
  // camera can frame it all, then refit — this keeps the text on-screen on
  // narrow viewports instead of letting it spill off the sides
  let halfW = SPHERE_R, top = SPHERE_R, bottom = -SPHERE_R;
  for (const c of chars) {
    halfW = Math.max(halfW, Math.abs(c.source.x) + GLYPH_WORLD);
    top = Math.max(top, c.source.y + GLYPH_WORLD);
    bottom = Math.min(bottom, c.source.y - GLYPH_WORLD);
  }
  contentBounds.halfW = halfW;
  contentBounds.top = top;
  contentBounds.bottom = bottom;
  fitCamera();

  const atlas = buildGlyphAtlas(text || " ");
  const tex = atlas.texture;
  // per-layer uniform set: shared holders + this layer's private ones
  const layerUniforms = { ...uniforms, uMorph, uColorize, uTex: { value: tex } };

  // per-instance attribute buffers, filled once
  const aSource = new Float32Array(n * 3);
  const aAnchor = new Float32Array(n * 3);
  const aSphere = new Float32Array(n * 3);
  const aRadius = new Float32Array(n);
  const aColor = new Float32Array(n * 3);
  const aUv = new Float32Array(n * 4);
  const aIndex = new Float32Array(n);
  const aJitter = new Float32Array(n);
  const aCurve = new Float32Array(n);
  const aPull = new Float32Array(n);

  // tight scatter around the anchor so the collapsed cluster reads as a small
  // button-sized blob rather than a single stacked point
  const SCATTER = GLYPH_WORLD * 1.5;
  chars.forEach((c, i) => {
    aSource.set([c.source.x, c.source.y, c.source.z], i * 3);
    aAnchor.set([
      anchorPt.x + (Math.random() * 2 - 1) * SCATTER,
      anchorPt.y + (Math.random() * 2 - 1) * SCATTER,
      anchorPt.z,
    ], i * 3);
    aSphere.set([c.sphere.x, c.sphere.y, c.sphere.z], i * 3);
    aRadius[i] = c.radius;
    aColor.set([c.color.r, c.color.g, c.color.b], i * 3);
    const rect = atlas.uv.get(c.ch) ?? [0, 0, 0, 0];
    aUv.set(rect, i * 4);
    aIndex[i] = c.order;
    aJitter[i] = c.jitter;
    aCurve[i] = c.curve;
    aPull[i] = c.pull;
  });

  // ---- glyph instanced geometry (a unit quad) ----
  const quad = new THREE.InstancedBufferGeometry();
  quad.instanceCount = n;
  quad.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0,  0.5, -0.5, 0,  -0.5, 0.5, 0,  0.5, 0.5, 0,
  ], 3));
  quad.setAttribute("uv", new THREE.Float32BufferAttribute([
    0, 0,  1, 0,  0, 1,  1, 1,
  ], 2));
  quad.setIndex([0, 1, 2, 2, 1, 3]);
  quad.setAttribute("aSource", new THREE.InstancedBufferAttribute(aSource, 3));
  quad.setAttribute("aAnchor", new THREE.InstancedBufferAttribute(aAnchor, 3));
  quad.setAttribute("aSphere", new THREE.InstancedBufferAttribute(aSphere, 3));
  quad.setAttribute("aRadius", new THREE.InstancedBufferAttribute(aRadius, 1));
  quad.setAttribute("aColor", new THREE.InstancedBufferAttribute(aColor, 3));
  quad.setAttribute("aUv", new THREE.InstancedBufferAttribute(aUv, 4));
  quad.setAttribute("aIndex", new THREE.InstancedBufferAttribute(aIndex, 1));
  quad.setAttribute("aJitter", new THREE.InstancedBufferAttribute(aJitter, 1));
  quad.setAttribute("aCurve", new THREE.InstancedBufferAttribute(aCurve, 1));
  quad.setAttribute("aPull", new THREE.InstancedBufferAttribute(aPull, 1));

  const glyphMat = new THREE.ShaderMaterial({
    uniforms: layerUniforms,
    vertexShader: GLYPH_VERT,
    fragmentShader: GLYPH_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const glyph = new THREE.Mesh(quad, glyphMat);
  glyph.frustumCulled = false;
  scene.add(glyph);

  // ---- trace geometry: a polyline per glyph, expanded to line segments ----
  const segVerts = TRACE_SEGMENTS * 2;       // 2 endpoints per segment
  const tSource = new Float32Array(n * segVerts * 3);
  const tAnchor = new Float32Array(n * segVerts * 3);
  const tSphere = new Float32Array(n * segVerts * 3);
  const tRadius = new Float32Array(n * segVerts);
  const tIndex = new Float32Array(n * segVerts);
  const tJitter = new Float32Array(n * segVerts);
  const tCurve = new Float32Array(n * segVerts);
  const tPull = new Float32Array(n * segVerts);
  const tS = new Float32Array(n * segVerts);

  for (let i = 0; i < n; i++) {
    const c = chars[i];
    const r = c.radius;
    const ax = aAnchor[i * 3], ay = aAnchor[i * 3 + 1], az = aAnchor[i * 3 + 2];
    for (let s = 0; s < TRACE_SEGMENTS; s++) {
      const s0 = s / TRACE_SEGMENTS;
      const s1 = (s + 1) / TRACE_SEGMENTS;
      const base = (i * segVerts + s * 2);
      for (let e = 0; e < 2; e++) {
        const v = base + e;
        tSource.set([c.source.x, c.source.y, c.source.z], v * 3);
        tAnchor.set([ax, ay, az], v * 3);
        tSphere.set([c.sphere.x, c.sphere.y, c.sphere.z], v * 3);
        tRadius[v] = r;
        tIndex[v] = c.order;
        tJitter[v] = c.jitter;
        tCurve[v] = c.curve;
        tPull[v] = c.pull;
        tS[v] = e === 0 ? s0 : s1;
      }
    }
  }

  const traceGeo = new THREE.BufferGeometry();
  traceGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * segVerts * 3), 3));
  traceGeo.setAttribute("aSource", new THREE.Float32BufferAttribute(tSource, 3));
  traceGeo.setAttribute("aAnchor", new THREE.Float32BufferAttribute(tAnchor, 3));
  traceGeo.setAttribute("aSphere", new THREE.Float32BufferAttribute(tSphere, 3));
  traceGeo.setAttribute("aRadius", new THREE.Float32BufferAttribute(tRadius, 1));
  traceGeo.setAttribute("aIndex", new THREE.Float32BufferAttribute(tIndex, 1));
  traceGeo.setAttribute("aJitter", new THREE.Float32BufferAttribute(tJitter, 1));
  traceGeo.setAttribute("aCurve", new THREE.Float32BufferAttribute(tCurve, 1));
  traceGeo.setAttribute("aPull", new THREE.Float32BufferAttribute(tPull, 1));
  traceGeo.setAttribute("aS", new THREE.Float32BufferAttribute(tS, 1));

  const traceMat = new THREE.ShaderMaterial({
    uniforms: layerUniforms,
    vertexShader: TRACE_VERT,
    fragmentShader: TRACE_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const trace = new THREE.LineSegments(traceGeo, traceMat);
  trace.frustumCulled = false;
  trace.visible = settings.showTraces;
  scene.add(trace);

  return { glyph, trace, uMorph, tex };
}

// Replace the current layer with a freshly built one (the common, single-layer
// path). `anchor` is where glyphs gather; default just below the sphere.
function build(text: string, anchor?: THREE.Vector3): void {
  disposeLayer(currentLayer);
  currentText = text;
  currentLayer = makeLayer(text, anchor ?? new THREE.Vector3(0, -1.6, 0), 1);
  // rebuilding drops back to the static preview; Figuration starts the flight
  animating = false;
  startTime = performance.now();
}

// begin the figuration flight from the current paragraph layout
function startAnimation(): void {
  animating = true;
  startTime = performance.now();
}

// Tween a layer's morph holder between values over `ms` (0 = collapsed into a
// button, 1 = full paragraph). Each call drives its own holder, so two layers
// can morph simultaneously.
function morphHolder(holder: { value: number }, target: number, ms: number): Promise<void> {
  const from = holder.value;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOut
      holder.value = from + (target - from) * e;
      if (k < 1) { requestAnimationFrame(step); }
      else { holder.value = target; resolve(); }
    };
    requestAnimationFrame(step);
  });
}

// ---- drag-to-rotate state ----
const drag = {
  active: false,
  pointerId: -1,
  lastX: 0,
  lastY: 0,
  velX: 0,        // rotation velocity carried as inertia after release (rad/px)
};
const DRAG_ROT = 0.01;     // radians of spin per pixel dragged horizontally
const DRAG_TILT = 0.006;   // radians of tilt per pixel dragged vertically
const TILT_MIN = -1.4;     // clamp so the sphere never flips fully over
const TILT_MAX = 1.4;
const INERTIA_DECAY = 0.92;

canvas.style.cursor = "grab";

canvas.addEventListener("pointerdown", (e) => {
  drag.active = true;
  drag.pointerId = e.pointerId;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  drag.velX = 0;
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag.active || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.lastX;
  const dy = e.clientY - drag.lastY;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  uniforms.uRot.value += dx * DRAG_ROT;
  uniforms.uTilt.value = Math.max(TILT_MIN, Math.min(TILT_MAX, uniforms.uTilt.value + dy * DRAG_TILT));
  drag.velX = dx * DRAG_ROT;        // remember last motion for release inertia
});

function endDrag(e: PointerEvent): void {
  if (e.pointerId !== drag.pointerId) return;
  drag.active = false;
  drag.pointerId = -1;
  canvas.style.cursor = "grab";
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---- render loop: the ONLY per-frame CPU work is advancing the uniforms ----
function animate(now: number): void {
  if (drag.active) {
    // user is steering; auto-spin and inertia are suppressed
  } else if (Math.abs(drag.velX) > 0.0002) {
    uniforms.uRot.value += drag.velX;        // glide after a flick
    drag.velX *= INERTIA_DECAY;
  } else {
    uniforms.uRot.value += settings.rotSpeed * 0.016; // idle auto-spin
  }
  // frozen at 0 until Animate is pressed, so glyphs rest in their paragraph
  uniforms.uTime.value = animating ? now - startTime : 0;
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// ---- options popup: sliders bound live to the animation ----
const options = document.getElementById("options") as HTMLDivElement;
const closeButton = document.getElementById("opt-close") as HTMLButtonElement;
const speedSlider = document.getElementById("opt-speed") as HTMLInputElement;
const flightSlider = document.getElementById("opt-flight") as HTMLInputElement;
const outBounceSlider = document.getElementById("opt-outbounce") as HTMLInputElement;
const inBounceSlider = document.getElementById("opt-inbounce") as HTMLInputElement;
const waveSlider = document.getElementById("opt-wave") as HTMLInputElement;
const speedOut = document.getElementById("opt-speed-val") as HTMLOutputElement;
const flightOut = document.getElementById("opt-flight-val") as HTMLOutputElement;
const outBounceOut = document.getElementById("opt-outbounce-val") as HTMLOutputElement;
const inBounceOut = document.getElementById("opt-inbounce-val") as HTMLOutputElement;
const waveOut = document.getElementById("opt-wave-val") as HTMLOutputElement;

function syncSliders(): void {
  speedSlider.value = String(settings.rotSpeed);
  flightSlider.value = String(uniforms.uFlight.value);
  outBounceSlider.value = String(uniforms.uOutBounce.value);
  inBounceSlider.value = String(uniforms.uInBounce.value);
  waveSlider.value = String(uniforms.uWaveSize.value);
  speedOut.textContent = settings.rotSpeed.toFixed(2);
  flightOut.textContent = (uniforms.uFlight.value / 1000).toFixed(2) + "s";
  outBounceOut.textContent = uniforms.uOutBounce.value.toFixed(2) + "×";
  inBounceOut.textContent = uniforms.uInBounce.value.toFixed(2) + "×";
  waveOut.textContent = String(uniforms.uWaveSize.value);
}
syncSliders();

speedSlider.addEventListener("input", () => {
  settings.rotSpeed = parseFloat(speedSlider.value);
  speedOut.textContent = settings.rotSpeed.toFixed(2);
});
flightSlider.addEventListener("input", () => {
  uniforms.uFlight.value = parseFloat(flightSlider.value);
  flightOut.textContent = (uniforms.uFlight.value / 1000).toFixed(2) + "s";
});
outBounceSlider.addEventListener("input", () => {
  uniforms.uOutBounce.value = parseFloat(outBounceSlider.value);
  outBounceOut.textContent = uniforms.uOutBounce.value.toFixed(2) + "×";
});
inBounceSlider.addEventListener("input", () => {
  uniforms.uInBounce.value = parseFloat(inBounceSlider.value);
  inBounceOut.textContent = uniforms.uInBounce.value.toFixed(2) + "×";
});
waveSlider.addEventListener("input", () => {
  uniforms.uWaveSize.value = parseFloat(waveSlider.value);
  waveOut.textContent = String(uniforms.uWaveSize.value);
});

toggleButton.addEventListener("click", () => options.classList.toggle("hidden"));
closeButton.addEventListener("click", () => options.classList.add("hidden"));

// ---- sources: Sphere (built-in) + one per model folder ----
// Vite statically discovers every model folder under /models at build time:
// model.glb gives the 3D surface, desc.txt gives the paragraph. Drop a new
// folder with those two files in and it appears automatically.
const modelGlbs = import.meta.glob("../models/*/model.glb", {
  query: "?url", import: "default", eager: true,
}) as Record<string, string>;
const modelDescs = import.meta.glob("../models/*/desc.txt", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

interface Source { key: string; label: string; desc: string; glbUrl?: string; }
const folderOf = (path: string) => path.split("/").slice(-2, -1)[0];

const SPHERE_KEY = "__sphere__";
const sources: Source[] = [
  { key: SPHERE_KEY, label: "Sphere", desc: SPHERE_TEXT },   // plain sphere, no glb
  ...Object.keys(modelGlbs)
    .map((glbPath) => {
      const folder = folderOf(glbPath);
      const descPath = Object.keys(modelDescs).find(p => folderOf(p) === folder);
      return {
        key: folder,
        label: folder,
        glbUrl: modelGlbs[glbPath],
        desc: descPath ? modelDescs[descPath] : SPHERE_TEXT,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label)),
];
const sourceByKey = (key: string) => sources.find(s => s.key === key)!;

// load a model's GLB (cached after first fetch); null target = plain sphere
const modelCache = new Map<string, LoadedModel>();
async function applyTarget(src: Source): Promise<void> {
  if (!src.glbUrl) { loadedModel = null; return; }
  let model = modelCache.get(src.key) ?? null;
  if (!model) {
    const buffer = await (await fetch(src.glbUrl)).arrayBuffer();
    model = await loadModel(buffer, SPHERE_R);
    modelCache.set(src.key, model);
  }
  loadedModel = model;
}

// ---- active paragraph + the button list (every source EXCEPT the active) ----
const sourceBar = document.getElementById("source-bar") as HTMLDivElement;
let activeKey = SPHERE_KEY;          // the source whose paragraph is shown
let busy = false;                    // guard against overlapping swaps

const FADE_MS = 350;                 // must match the .source-btn opacity transition

function buttonFor(key: string): HTMLButtonElement | null {
  return sourceBar.querySelector(`button[data-key="${key}"]`);
}

// create a button (initially faded out); call fadeInButton next frame to show
function createButton(src: Source): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "source-btn faded";
  btn.textContent = src.label;
  btn.dataset.key = src.key;
  btn.title = "Double-click to break into words";
  btn.addEventListener("dblclick", () => { void swapTo(src.key); });
  return btn;
}

function fadeInButton(btn: HTMLButtonElement): void {
  // next frame so the browser registers the faded start state and transitions
  requestAnimationFrame(() => btn.classList.remove("faded"));
}

// fade a button out, then remove it from the DOM
function fadeOutButton(btn: HTMLButtonElement): Promise<void> {
  btn.classList.add("faded");
  return new Promise((resolve) => setTimeout(() => { btn.remove(); resolve(); }, FADE_MS));
}

// initial render (no animation): one button per non-active source
function renderButtons(): void {
  sourceBar.replaceChildren();
  for (const src of sources) {
    if (src.key === activeKey) continue;
    const btn = createButton(src);
    btn.classList.remove("faded");   // shown immediately on first paint
    sourceBar.appendChild(btn);
  }
}

// Swap the active paragraph with a button's source. Collapse and expand happen
// SIMULTANEOUSLY as two layers: the current paragraph gathers into a new button
// at the rear, while the double-clicked button's words break apart into the new
// paragraph — both at once.
const MORPH_MS = 700;
async function swapTo(key: string): Promise<void> {
  if (busy || key === activeKey) return;
  busy = true;
  animating = false;                 // morph-driven, not flight-driven
  try {
    const oldKey = activeKey;
    const clicked = buttonFor(key);
    const expandAnchor = buttonAnchor(clicked);   // new paragraph springs from here

    // the old source reappears as a button at the rear (the collapse target)
    const reborn = createButton(sourceByKey(oldKey));
    sourceBar.appendChild(reborn);
    fadeInButton(reborn);
    const collapseAnchor = buttonAnchor(reborn);

    // collapsing layer: rebuild the CURRENT paragraph anchored at the rear
    // button (no visual change at morph=1), keeping the old target surface
    disposeLayer(currentLayer);
    const collapsing = makeLayer(currentText, collapseAnchor, 1);

    // expanding layer: the NEW paragraph on its target surface, gathered at the
    // clicked button, starting collapsed
    activeKey = key;
    if (clicked) void fadeOutButton(clicked);
    const newSrc = sourceByKey(key);
    await applyTarget(newSrc);        // switch target surface for the new layer
    const expanding = makeLayer(newSrc.desc, expandAnchor, 0);
    currentText = newSrc.desc;
    currentLayer = expanding;

    // run both morphs at the same time, then drop the collapsed layer
    await Promise.all([
      morphHolder(collapsing.uMorph, 0, MORPH_MS),
      morphHolder(expanding.uMorph, 1, MORPH_MS),
    ]);
    disposeLayer(collapsing);
  } catch (err) {
    console.error("Swap failed:", err);
    if (currentLayer) currentLayer.uMorph.value = 1;
  } finally {
    busy = false;
  }
}

renderButtons();

// ---- Figuration button: build the active paragraph onto its shape ----
const animateButton = document.getElementById("animate-btn") as HTMLButtonElement;
animateButton.addEventListener("click", startAnimation);

// ---- show / hide toggles ----
const traceCheck = document.getElementById("opt-trace") as HTMLInputElement;
const textboxCheck = document.getElementById("opt-textbox") as HTMLInputElement;
const panel = document.getElementById("panel") as HTMLDivElement;

traceCheck.addEventListener("change", () => {
  settings.showTraces = traceCheck.checked;
  if (currentLayer) currentLayer.trace.visible = settings.showTraces;
});
textboxCheck.addEventListener("change", () => {
  panel.classList.toggle("hidden", !textboxCheck.checked);
});

// kick off — size the viewport, then build the default Sphere paragraph
resize();
build(sourceByKey(activeKey).desc);
requestAnimationFrame(animate);
