import * as THREE from "three";

// Warm red for adjectives (left hemisphere), dark ink for nouns (right).
const ADJ_COLOR = "#d76b66";
const NOUN_COLOR = "#4a3a39";

export interface WordCloudWord {
  sprite: THREE.Sprite;
  /** unit position on the sphere (before group rotation) */
  dir: THREE.Vector3;
  baseW: number;             // world width at full (front) size
  baseH: number;             // world height at full (front) size
}

export interface WordCloud {
  group: THREE.Group;
  words: WordCloudWord[];
  radius: number;
}

// deterministic pseudo-random in [0,1)
function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Render a word to a transparent canvas → billboarded sprite that faces camera.
function makeWordSprite(word: string, color: string, fontPx: number): THREE.Sprite {
  const pad = 8;
  const measure = document.createElement("canvas").getContext("2d")!;
  const font = `600 ${fontPx}px Georgia, "Times New Roman", serif`;
  measure.font = font;
  const textW = Math.ceil(measure.measureText(word).width);

  const canvas = document.createElement("canvas");
  canvas.width = textW + pad * 2;
  canvas.height = fontPx + pad * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(word, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.userData.aspect = canvas.width / canvas.height;
  return sprite;
}

/**
 * A sphere of VARY-SIZED words that don't overlap on screen. Words are sized
 * randomly, sorted biggest-first, then each is dropped onto the first evenly
 * spread candidate direction whose angular "cap" clears every already-placed
 * word's cap. Because a word's cap encloses its full front-facing footprint,
 * disjoint caps ⇒ no on-screen occlusion (they only ever shrink from there as
 * they rotate toward the rim). Adjectives keep left, nouns right.
 */
export function buildWordCloud(
  adjectives: string[],
  nouns: string[],
  radius: number,
): WordCloud {
  const measure = document.createElement("canvas").getContext("2d")!;
  const worldPerPx = radius / 512;

  // Size is NORMALLY distributed: most words cluster around a middle size with
  // gentle symmetric variation, so there are no jarring jumps between giant and
  // tiny words. (Box–Muller turns two uniforms into a Gaussian sample.)
  const MEAN_PX = 46, STD_PX = 11, MIN_PX = 24, MAX_PX = 56;
  const sizeFor = (seed: number): number => {
    const u1 = Math.max(1e-6, rand(seed));
    const u2 = rand(seed + 0.5);
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); // ~N(0,1)
    return Math.max(MIN_PX, Math.min(MAX_PX, MEAN_PX + g * STD_PX));
  };

  // build a big, size-varied queue (biggest first), interleaving the two halves
  const REPEAT = 10;
  const make = (words: string[], side: -1 | 1, color: string, seed0: number) =>
    Array.from({ length: words.length * REPEAT }, (_, i) => ({
      word: words[i % words.length], color, side,
      fontPx: sizeFor(seed0 + i * 3.1),
    })).sort((a, b) => b.fontPx - a.fontPx);
  const adj = make(adjectives, -1, ADJ_COLOR, 11);
  const noun = make(nouns, 1, NOUN_COLOR, 97);
  const queue: typeof adj = [];
  for (let i = 0; i < Math.max(adj.length, noun.length); i++) {
    if (adj[i]) queue.push(adj[i]);
    if (noun[i]) queue.push(noun[i]);
  }

  // dense evenly-spread candidate directions (Fibonacci sphere), reused for all
  const M = 4000;
  const golden = Math.PI * (1 + Math.sqrt(5));
  const cands: THREE.Vector3[] = [];
  for (let i = 0; i < M; i++) {
    const y = 1 - (2 * (i + 0.5)) / M;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    cands.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
  }
  const used = new Uint8Array(M);

  const group = new THREE.Group();
  const words: WordCloudWord[] = [];
  // each placed word keeps its centre + half-width/height (world units) and a
  // bounding angular radius for a cheap early-out
  const placed: Array<{ dir: THREE.Vector3; hw: number; hh: number; rho: number }> = [];

  const GAP = 10 * worldPerPx;                  // breathing room between words
  const SPREAD = 1.35;                          // reserve extra room = sparser
  const UP = new THREE.Vector3(0, 1, 0);
  const _t = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();

  for (const item of queue) {
    measure.font = `600 ${item.fontPx}px Georgia, "Times New Roman", serif`;
    const hw = SPREAD * 0.5 * (measure.measureText(item.word).width * worldPerPx) + GAP;
    const hh = SPREAD * 0.5 * (item.fontPx * worldPerPx) + GAP;
    const rho = Math.hypot(hw, hh) / radius;    // bounding angular radius

    let dir: THREE.Vector3 | null = null;
    for (let ci = 0; ci < M; ci++) {
      if (used[ci]) continue;
      const d = cands[ci];
      if (item.side < 0 ? d.x > 0.05 : d.x < -0.05) continue;   // keep to its side

      let free = true;
      for (const pl of placed) {
        const dot = Math.max(-1, Math.min(1, d.dot(pl.dir)));
        const ang = Math.acos(dot);
        if (ang > rho + pl.rho) continue;        // far enough: no chance to touch
        // rectangle test in pl's tangent plane: build a local right/up frame,
        // decompose the geodesic offset, compare to summed half-extents
        _u.copy(UP).addScaledVector(pl.dir, -UP.dot(pl.dir));
        if (_u.lengthSq() < 1e-6) _u.set(1, 0, 0); else _u.normalize();
        _r.crossVectors(_u, pl.dir).normalize();
        _t.copy(d).addScaledVector(pl.dir, -dot);   // tangent component
        const geo = ang * radius;                   // arc length to the candidate
        const tl = _t.length() || 1;
        const sx = Math.abs((_t.dot(_r) / tl) * geo);
        const sy = Math.abs((_t.dot(_u) / tl) * geo);
        if (sx < hw + pl.hw && sy < hh + pl.hh) { free = false; break; }
      }
      if (!free) continue;
      used[ci] = 1;
      dir = d;
      break;
    }
    if (!dir) continue;                          // no room left; skip

    placed.push({ dir, hw, hh, rho });
    const sprite = makeWordSprite(item.word, item.color, item.fontPx);
    const baseH = item.fontPx * worldPerPx;
    const baseW = baseH * (sprite.userData.aspect as number);
    sprite.position.copy(dir).multiplyScalar(radius);
    group.add(sprite);
    words.push({ sprite, dir, baseW, baseH });
  }

  return { group, words, radius };
}

// Per-frame depth: near words (front, +z after rotation) are big & opaque; words
// curving to the rim shrink & dim; the far hemisphere is hidden. The steep
// gradient makes the arrangement read as a solid rotating sphere.
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
export function updateWordDepth(cloud: WordCloud): void {
  cloud.group.getWorldQuaternion(_q);
  for (const w of cloud.words) {
    _dir.copy(w.dir).applyQuaternion(_q);
    const facing = _dir.z;                     // +1 = toward camera, −1 = away
    if (facing <= 0) { w.sprite.visible = false; continue; }
    w.sprite.visible = true;

    const t = facing;                          // 0 (rim) .. 1 (centre/front)
    // front words at full size; toward the rim they only shrink (never grow),
    // so packing at full size keeps them from ever overlapping
    const k = 0.55 + 0.45 * t;
    w.sprite.scale.set(w.baseW * k, w.baseH * k, 1);
    (w.sprite.material as THREE.SpriteMaterial).opacity =
      Math.min(1, 0.2 + 1.2 * t) * Math.min(1, facing / 0.08);
    w.sprite.renderOrder = facing;             // paint back-to-front
  }
}

export function disposeWordCloud(cloud: WordCloud): void {
  for (const { sprite } of cloud.words) {
    const mat = sprite.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
  cloud.group.removeFromParent();
}
