import "./style.css";
import * as THREE from "three";
import { buildWordCloud, updateWordDepth, type WordCloud } from "./wordCloud";
import { ADJECTIVES, NOUNS } from "./words";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const toggleButton = document.getElementById("toggle") as HTMLButtonElement;

// ---- tunables ----
const CLOUD_R = 1.0;       // radius the words sit on

// ---- renderer / scene / camera ----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0xfbf6f5, 1);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
const FOV_V = (45 * Math.PI) / 180;     // vertical field of view (radians)

// Pull the camera back far enough that the whole cloud fits the viewport, so on
// a narrow (portrait/mobile) screen it scales down instead of clipping.
function fitCamera(): void {
  const aspect = camera.aspect || 1;
  const margin = 1.35;                  // framing around the sphere
  const tanV = Math.tan(FOV_V / 2);
  const distForHeight = (CLOUD_R * margin) / tanV;
  const distForWidth = (CLOUD_R * margin) / (tanV * aspect);
  const dist = Math.max(distForHeight, distForWidth, 1.5);
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  fitCamera();
}
window.addEventListener("resize", resize);

// ---- the word cloud ----
let cloud: WordCloud = buildWordCloud(ADJECTIVES, NOUNS, CLOUD_R);
scene.add(cloud.group);

// ---- live settings ----
const settings = {
  rotSpeed: 0.18,        // idle auto-spin rate (rad/s)
};

// ---- drag-to-rotate: the cloud stays centred; dragging spins the sphere so
//      words rotate through the perspective (centre big, edges small, back hidden)
const drag = {
  active: false, pointerId: -1, lastX: 0, lastY: 0,
  velX: 0, velY: 0,      // rotation velocity carried as inertia after release
};
const DRAG_SPEED = 0.01;   // radians per pixel dragged
const PITCH_MIN = -1.4;    // clamp vertical tumble so it never fully flips
const PITCH_MAX = 1.4;
const INERTIA_DECAY = 0.94;

canvas.style.cursor = "grab";

canvas.addEventListener("pointerdown", (e) => {
  drag.active = true;
  drag.pointerId = e.pointerId;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  drag.velX = 0;
  drag.velY = 0;
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag.active || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.lastX;
  const dy = e.clientY - drag.lastY;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  rotateCloud(dx * DRAG_SPEED, dy * DRAG_SPEED);
  drag.velX = dx * DRAG_SPEED;
  drag.velY = dy * DRAG_SPEED;
});

function endDrag(e: PointerEvent): void {
  if (e.pointerId !== drag.pointerId) return;
  drag.active = false;
  drag.pointerId = -1;
  canvas.style.cursor = "grab";
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// Yaw around world Y, pitch around world X (pitch clamped so it never flips).
let pitch = 0;
function rotateCloud(yaw: number, dpitch: number): void {
  const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch + dpitch));
  const applied = next - pitch;
  pitch = next;
  cloud.group.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), applied);
  cloud.group.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), yaw);
}

// ---- render loop ----
function animate(): void {
  if (drag.active) {
    // user is steering
  } else if (Math.abs(drag.velX) > 0.0002 || Math.abs(drag.velY) > 0.0002) {
    rotateCloud(drag.velX, drag.velY);         // glide after a flick
    drag.velX *= INERTIA_DECAY;
    drag.velY *= INERTIA_DECAY;
  } else {
    rotateCloud(settings.rotSpeed * 0.016, 0); // idle auto-spin around Y
  }
  updateWordDepth(cloud);                        // perspective sizing + hide back
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// ---- options popup: spin-speed slider ----
const options = document.getElementById("options") as HTMLDivElement;
const closeButton = document.getElementById("opt-close") as HTMLButtonElement;
const speedSlider = document.getElementById("opt-speed") as HTMLInputElement;
const speedOut = document.getElementById("opt-speed-val") as HTMLOutputElement;

speedSlider.value = String(settings.rotSpeed);
speedOut.textContent = settings.rotSpeed.toFixed(2);
speedSlider.addEventListener("input", () => {
  settings.rotSpeed = parseFloat(speedSlider.value);
  speedOut.textContent = settings.rotSpeed.toFixed(2);
});

toggleButton.addEventListener("click", () => options.classList.toggle("hidden"));
closeButton.addEventListener("click", () => options.classList.add("hidden"));

// kick off
resize();
requestAnimationFrame(animate);
