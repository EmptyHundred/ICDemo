import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ---------------------------------------------------------------------------
// A 3D glass hourglass: the form is a surface of revolution (LatheGeometry)
// rendered with a Fresnel shader — mostly transparent face-on, ramping to white
// at grazing angles so only the silhouette and rims glow, like real thin glass.
// A perspective camera with OrbitControls spins / zooms it; a glowing pink mote
// (a camera-facing sprite) hangs in the upper bowl. The blue gradient is pinned
// to the screen so it stays put while the glass orbits.
// ---------------------------------------------------------------------------

const canvas = document.getElementById("stage") as HTMLCanvasElement;

// ---- form tunables (world units) ----
const R = 1.0;             // max radius (at the top & bottom rims)
const HY = 1.34;           // half-height of the silhouette
const NECK = 0.018;        // radius at the pinch so it never fully collapses
const PROFILE_N = 200;     // samples along the lathe profile
const RADIAL_N = 128;      // radial segments around the lathe

// half-width of an hourglass at normalized height u in [-1, 1]
// sin profile: ~vertical sides at the rims, steep straight-ish flanks at neck
function profileR(u: number): number {
  return NECK + (R - NECK) * Math.sin((Math.abs(u) * Math.PI) / 2);
}

// ---- renderer / scene / perspective camera ----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setClearColor(0x3568bf, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0.15, 4.6);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2.2;
controls.maxDistance = 9;
controls.enablePan = false;
controls.autoRotate = true;          // gentle idle spin
controls.autoRotateSpeed = 0.6;

function resize(): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

// ---- screen-pinned vertical gradient background (drawn behind everything) ----
const bgGeo = new THREE.PlaneGeometry(2, 2);
const bgMat = new THREE.ShaderMaterial({
  depthTest: false,
  depthWrite: false,
  uniforms: { uTop: { value: new THREE.Color(0x3f78d4) }, uBot: { value: new THREE.Color(0x2c569f) } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.999, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform vec3 uTop; uniform vec3 uBot;
    void main() {
      float t = smoothstep(0.0, 1.0, vUv.y);
      vec3 col = mix(uBot, uTop, t);
      float d = distance(vUv, vec2(0.5, 0.56));
      col += 0.05 * (1.0 - smoothstep(0.0, 0.75, d));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const bg = new THREE.Mesh(bgGeo, bgMat);
bg.frustumCulled = false;
bg.renderOrder = -10;
scene.add(bg);

// ---------------------------------------------------------------------------
// glass surface — a LatheGeometry (the profile revolved around Y) shaded with
// a Fresnel material: facets seen straight-on are nearly transparent, facets
// seen edge-on (the silhouette / rims) ramp up to white. That viewing-angle
// falloff is the whole "glass" look — no lines, just a thin shell.
// ---------------------------------------------------------------------------

// build the half-profile (x = radius, y = height) the lathe spins around Y
const profile: THREE.Vector2[] = [];
for (let i = 0; i <= PROFILE_N; i++) {
  const u = -1 + (2 * i) / PROFILE_N;          // -1 (bottom) .. +1 (top)
  profile.push(new THREE.Vector2(profileR(u), u * HY));
}
const glassGeo = new THREE.LatheGeometry(profile, RADIAL_N);

const glassMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,                 // thin shell: don't occlude its own far wall
  side: THREE.DoubleSide,            // see the inside of the glass too
  blending: THREE.AdditiveBlending,  // edges add light onto the blue
  uniforms: {
    uColor: { value: new THREE.Color(0xffffff) },
    uPower: { value: 3.2 },          // higher = thinner, sharper rim
    uBase: { value: 0.04 },          // faint tint across the whole body
    uRim: { value: 1.0 },            // brightness at the silhouette
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldNormal;
    varying vec3 vViewDir;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      vViewDir = normalize(cameraPosition - worldPos.xyz);
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vWorldNormal;
    varying vec3 vViewDir;
    uniform vec3 uColor;
    uniform float uPower;
    uniform float uBase;
    uniform float uRim;
    void main() {
      // two-sided: flip the normal so back faces light up at the edge too
      vec3 n = normalize(vWorldNormal);
      n *= sign(dot(n, vViewDir));
      float facing = clamp(dot(n, normalize(vViewDir)), 0.0, 1.0);
      // Fresnel: ~0 facing the camera, ->1 at grazing (silhouette) angles
      float fresnel = pow(1.0 - facing, uPower);
      float alpha = uBase + uRim * fresnel;
      gl_FragColor = vec4(uColor, alpha);
    }
  `,
});

const glass = new THREE.Mesh(glassGeo, glassMat);
glass.frustumCulled = false;
scene.add(glass);

// ---------------------------------------------------------------------------
// the glowing pink mote (a single sand grain suspended in the upper bowl)
// ---------------------------------------------------------------------------
function moteTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, "rgba(255,170,185,1)");
  g.addColorStop(0.3, "rgba(244,110,140,1)");
  g.addColorStop(0.6, "rgba(232,80,115,0.55)");
  g.addColorStop(1.0, "rgba(232,80,115,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

const moteMat = new THREE.SpriteMaterial({
  map: moteTexture(),
  color: 0xffffff,
  transparent: true,
  depthWrite: false,
});
const mote = new THREE.Sprite(moteMat);
const MOTE_Y = 0.5;
mote.position.set(0, MOTE_Y, 0);
mote.scale.set(0.05, 0.11, 1);
scene.add(mote);

// ---- render loop ----
const clock = new THREE.Clock();
function animate(): void {
  const t = clock.getElapsedTime();
  const pulse = 0.85 + 0.15 * Math.sin(t * 2.2);
  moteMat.opacity = pulse;
  mote.scale.set(0.05 * pulse, 0.11 * pulse, 1);
  mote.position.y = MOTE_Y + 0.01 * Math.sin(t * 0.9);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

resize();
requestAnimationFrame(animate);
