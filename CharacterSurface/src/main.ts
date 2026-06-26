import "./style.css";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const panel = document.getElementById("panel") as HTMLDivElement;
const textInput = document.getElementById("text") as HTMLTextAreaElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const toggleButton = document.getElementById("toggle") as HTMLButtonElement;

let W = 0, H = 0, DPR = 1, cx = 0, cy = 0, R = 0;

function resize(): void {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  cx = W / 2;
  cy = H * 0.32;
  R = Math.min(W, H) * 0.28;
}
window.addEventListener("resize", resize);
resize();

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ----- evenly distributed points on a sphere (Fibonacci spiral) -----
function fibPoint(i: number, n: number): Vec3 {
  const k = i + 0.5;
  const phi = Math.acos(1 - 2 * k / n);          // polar
  const theta = Math.PI * (1 + Math.sqrt(5)) * k; // golden angle
  return {
    x: Math.cos(theta) * Math.sin(phi),
    y: Math.sin(theta) * Math.sin(phi),
    z: Math.cos(phi),
  };
}

// ----- easing -----
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

interface Word {
  text: string;
  ux: number; uy: number; uz: number; // unit position on sphere
  sx: number;                          // exact source location of the char
  sy: number;
  launch: number;
  curve: number;
}

// ----- state -----
let words: Word[] = [];
let startTime = 0;
let rotation = 0;
const TILT = -0.32;            // fixed lean of the sphere
const ROT_SPEED = 0.18;        // radians / second (slow)
const STAGGER = 32;            // ms between each character launching
const FLIGHT = 1500;           // ms a word takes to reach the sphere
const PARA_SIZE = 16;          // paragraph font size (px)
const PARA_FONT = `${PARA_SIZE}px Georgia, serif`;

function buildWords(text: string): void {
  const tokens = text.trim().split(/\s+/).filter(Boolean);

  // --- lay the paragraph out as real wrapped text, then record the exact
  //     on-screen position of every individual CHARACTER ---
  ctx.font = PARA_FONT;
  const maxW = Math.min(W * 0.94, 900);
  const left = cx - maxW / 2;
  const lineH = PARA_SIZE * 2.2;
  const space = ctx.measureText(" ").width;

  // pass 1: place each character, tracking its line number
  const tmp: Array<{ ch: string; x: number; line: number }> = [];
  let penX = left, line = 0;
  for (const tok of tokens) {
    const wWidth = ctx.measureText(tok).width;
    if (penX > left && penX + wWidth > left + maxW) {
      penX = left;                 // wrap to next line
      line++;
    }
    let acc = 0;                   // walk the word char-by-char
    for (let c = 0; c < tok.length; c++) {
      const ch = tok[c];
      const cw = ctx.measureText(ch).width;
      tmp.push({ ch, x: penX + acc + cw / 2, line });
      acc += cw;
    }
    penX += wWidth + space;
  }
  const m = tmp.length;
  const lineCount = line + 1;
  const blockH = lineCount * lineH;

  // pass 2: position the block in the band between the sphere and the
  //         input panel, keeping clear of both
  const panelH = panel.classList.contains("hidden")
    ? 0 : (panel.offsetHeight || 80);
  const bottomLimit = H - panelH - 20;       // never overlap the input box
  const sphereBottom = cy + R * 1.10;
  let blockTop = sphereBottom + 18;
  // if it would collide with the panel, push it up to sit just above it
  if (blockTop + blockH > bottomLimit) {
    blockTop = Math.max(sphereBottom - 6, bottomLimit - blockH);
  }
  const firstBaseY = blockTop + PARA_SIZE / 2;

  words = tmp.map((t, i) => {
    const p = fibPoint(i, m);
    return {
      text: t.ch,
      ux: p.x, uy: p.y, uz: p.z,         // unit position on sphere
      sx: t.x,                           // exact source location of the char
      sy: firstBaseY + t.line * lineH,
      launch: i * STAGGER,
      // signed magnitude controlling how much its trace bows out
      curve: (Math.random() * 2 - 1) * 0.5 + (i % 2 ? 0.15 : -0.15),
    };
  });
  startTime = performance.now();
}

interface Point2D {
  x: number;
  y: number;
}

// control point that makes the S->T segment bow sideways
function controlPoint(sx: number, sy: number, tx: number, ty: number, curve: number): Point2D {
  const mx = (sx + tx) / 2, my = (sy + ty) / 2;
  const dx = tx - sx, dy = ty - sy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;   // unit normal
  const off = len * curve * 0.45;
  return { x: mx + nx * off, y: my + ny * off };
}

// pre-computed trig, refreshed once per frame (not per character)
const T = { cosR: 1, sinR: 0, cosT: Math.cos(TILT), sinT: Math.sin(TILT) };
function updateTrig(rot: number): void {
  T.cosR = Math.cos(rot); T.sinR = Math.sin(rot);
}

interface Projected {
  x: number;
  y: number;
  f: number;
  z: number;
}

// rotate a unit vector around Y (continuous) then tilt around X, then
// project to screen. Writes into `out` to avoid per-call allocation.
const camZfactor = 3.2;
function place(ux: number, uy: number, uz: number, out: Projected): void {
  const x = ux * T.cosR + uz * T.sinR;
  const z = -ux * T.sinR + uz * T.cosR;
  const y = uy;
  const z2 = y * T.sinT + z * T.cosT;
  const px = x * R;
  const py = (y * T.cosT - z * T.sinT) * R;
  const pz = z2 * R;
  const camZ = R * camZfactor;
  const f = camZ / (camZ - pz);
  out.x = cx + px * f;
  out.y = cy + py * f;
  out.f = f;
  out.z = pz;
}

interface Item {
  w: Word;
  x: number;
  y: number;
  f: number;
  z: number;
  prog: number;
  cx2: number;
  cy2: number;
  bucket: number;
  alpha: number;
  ink: number;
}

// reusable scratch objects / arrays (allocated once, not per frame)
const out: Projected = { x: 0, y: 0, f: 1, z: 0 };
let items: Item[] = [];               // one persistent record per character
// font buckets: quantize size so ctx.font changes rarely, grouped by depth
const FONT_BUCKETS = 8;
const fontCache: string[] = [];

function ensureItems(): void {
  if (items.length !== words.length) {
    items = words.map(w => ({ w, x: w.sx, y: w.sy, f: 0.7, z: -R, prog: 0,
                              cx2: 0, cy2: 0, bucket: 0, alpha: 1, ink: 80 }));
  }
}

function draw(now: number): void {
  rotation += ROT_SPEED * 0.016;
  const elapsed = now - startTime;
  updateTrig(rotation);
  ensureItems();

  ctx.clearRect(0, 0, W, H);

  // soft radial glow behind the sphere
  const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.5);
  g.addColorStop(0, "rgba(244,210,208,0.55)");
  g.addColorStop(1, "rgba(251,246,245,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // ---- the source paragraph: ONLY characters that haven't launched yet.
  //      Once a character launches it leaves the paragraph entirely — the
  //      flying glyph IS that same character, so there's no duplicate. ----
  ctx.font = PARA_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(74,58,57,0.85)";
  for (const w of words) {
    if (elapsed < w.launch) ctx.fillText(w.text, w.sx, w.sy);
  }

  // ---- compute each character's current position along its curved path ----
  const invR2 = 1 / (2 * R);
  for (const it of items) {
    const w = it.w;
    const t = (elapsed - w.launch) / FLIGHT;
    place(w.ux, w.uy, w.uz, out);
    const ctrl = controlPoint(w.sx, w.sy, out.x, out.y, w.curve);
    it.cx2 = ctrl.x; it.cy2 = ctrl.y;
    it.z = out.z;

    if (t <= 0) { it.prog = 0; it.x = w.sx; it.y = w.sy; it.f = 0.7; }
    else {
      const p = t < 1 ? t : 1;
      const e = easeOut(p);
      const u = 1 - e, A = u * u, B = 2 * u * e, C = e * e;
      it.x = A * w.sx + B * ctrl.x + C * out.x;
      it.y = A * w.sy + B * ctrl.y + C * out.y;
      it.f = 0.7 + (out.f - 0.7) * e;
      it.prog = p;
    }
    const depth = (it.z + R) * invR2;            // 0 back .. 1 front
    it.alpha = 0.45 + depth * 0.55;
    it.ink = (40 + (1 - depth) * 70) | 0;
    it.bucket = Math.min(FONT_BUCKETS - 1, ((9 + it.f * 9 - 9) / 9 * FONT_BUCKETS) | 0);
  }

  // ---- red traces: ONE batched path per alpha band ----
  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  for (let band = 0; band < 5; band++) {
    const alpha = 0.05 + (band + 0.5) / 5 * 0.13;
    ctx.strokeStyle = `rgba(208,64,58,${alpha.toFixed(3)})`;
    ctx.beginPath();
    let any = false;
    for (const it of items) {
      if (it.prog <= 0) continue;
      const depth = (it.z + R) * invR2;
      if (((depth * 5) | 0) !== band) continue;
      ctx.moveTo(it.w.sx, it.w.sy);
      ctx.quadraticCurveTo(it.cx2, it.cy2, it.x, it.y);
      any = true;
    }
    if (any) ctx.stroke();
  }

  // ---- characters, painted back-to-front, grouped by font bucket ----
  items.sort((a, b) => a.z - b.z);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let lastBucket = -1, lastFill = "";
  for (const it of items) {
    if (it.prog <= 0) continue;
    if (it.bucket !== lastBucket) {
      const size = 9 + (it.bucket + 0.5) / FONT_BUCKETS * 9;
      ctx.font = fontCache[it.bucket] ||
        (fontCache[it.bucket] = `${size.toFixed(1)}px Georgia, serif`);
      lastBucket = it.bucket;
    }
    const fill = `rgba(${it.ink},${it.ink},${it.ink + 4},${it.alpha.toFixed(2)})`;
    if (fill !== lastFill) { ctx.fillStyle = fill; lastFill = fill; }
    ctx.fillText(it.w.text, it.x, it.y);
  }

  requestAnimationFrame(draw);
}

// ----- controls -----
runButton.addEventListener("click", () => {
  buildWords(textInput.value || " ");
});
toggleButton.addEventListener("click", () => {
  panel.classList.toggle("hidden");
});

// kick off
buildWords(textInput.value);
requestAnimationFrame(draw);
