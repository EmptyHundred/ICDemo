import * as THREE from "three";

// Warm red for adjectives (left hemisphere), dark ink for nouns (right).
const ADJ_COLOR = "#d76b66";
const NOUN_COLOR = "#4a3a39";

export interface WordCloudWord {
  sprite: THREE.Sprite;
  /** unit position on the sphere (before group rotation) */
  dir: THREE.Vector3;
  baseScale: number;         // world height of the word at full (front) size
  aspect: number;            // texture width / height
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
function makeWordSprite(word: string, color: string): THREE.Sprite {
  const fontPx = 56;
  const pad = 10;
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
 * A sphere of words: N points spread evenly over the sphere by the Fibonacci
 * spiral, one word per point (adjectives on the left half, nouns on the right;
 * pools cycle). Every word is a camera-facing sprite positioned on the sphere;
 * `updateWordDepth` then sizes/fades them per frame to convey the 3D surface.
 */
export function buildWordCloud(
  adjectives: string[],
  nouns: string[],
  radius: number,
): WordCloud {
  const N = 400;
  const golden = Math.PI * (1 + Math.sqrt(5));
  const group = new THREE.Group();
  const words: WordCloudWord[] = [];
  let ai = 0, ni = 0;

  for (let i = 0; i < N; i++) {
    // even points on the unit sphere (Fibonacci spiral)
    const y = 1 - (2 * (i + 0.5)) / N;         // −1 .. 1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const dir = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);

    const onLeft = dir.x < 0;
    const pool = onLeft ? adjectives : nouns;
    const word = pool[(onLeft ? ai++ : ni++) % pool.length];
    const sprite = makeWordSprite(word, onLeft ? ADJ_COLOR : NOUN_COLOR);

    const aspect = sprite.userData.aspect as number;
    // slight per-word size variety
    const baseScale = (0.1 + rand(i * 2.3) * 0.05) * (radius / 1.0);
    sprite.position.copy(dir).multiplyScalar(radius);
    group.add(sprite);
    words.push({ sprite, dir, baseScale, aspect });
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
    const scale = w.baseScale * (0.35 + 0.65 * t);
    w.sprite.scale.set(scale * w.aspect, scale, 1);
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
