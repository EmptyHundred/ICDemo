import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface LoadedModel {
  /** Root object, recentred at the origin and scaled to fit `targetR`. */
  root: THREE.Object3D;
  /** Meshes inside `root`, used as raycast targets. */
  meshes: THREE.Mesh[];
  /** Radius the model was normalized to (its bounding sphere now has this radius). */
  targetR: number;
}

export interface SurfaceSample {
  /** Landing point in the model's centred/scaled space. */
  point: THREE.Vector3;
  /** Approximate surface colour at that point (sRGB, 0..1 per channel). */
  color: THREE.Color;
}

const loader = new GLTFLoader();

/**
 * Parse a GLB ArrayBuffer, then recentre and uniformly scale the whole model
 * so its bounding sphere sits at the origin with radius `targetR`. The
 * transform is applied to the root object (a wrapper Group), so nested mesh
 * hierarchies and their parent transforms are preserved — world matrices, and
 * therefore raycasts, stay correct. This puts the model exactly where the
 * word-sphere lives, so a ray from a sphere point toward the centre lands on
 * the model surface.
 */
export function loadModel(buffer: ArrayBuffer, targetR: number): Promise<LoadedModel> {
  return new Promise((resolve, reject) => {
    loader.parse(buffer, "", (gltf) => {
      const inner = gltf.scene;
      inner.updateMatrixWorld(true);

      const meshes: THREE.Mesh[] = [];
      inner.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
      });
      if (meshes.length === 0) {
        reject(new Error("GLB contains no meshes"));
        return;
      }

      // bounding sphere of the model as authored (world space)
      const box = new THREE.Box3().setFromObject(inner);
      const sphere = new THREE.Sphere();
      box.getBoundingSphere(sphere);
      const scale = sphere.radius > 1e-6 ? targetR / sphere.radius : 1;

      // wrap so a single parent transform recentres + normalizes everything
      const root = new THREE.Group();
      root.add(inner);
      inner.position.sub(sphere.center);     // model centre -> origin (pre-scale)
      root.scale.setScalar(scale);
      root.updateMatrixWorld(true);

      resolve({ root, meshes, targetR });
    }, (err) => reject(err));
  });
}

// Per-mesh helper that returns the surface colour (sRGB 0..1) at a triangle
// point given its vertex indices and barycentric weights. Reads a base-colour
// texture if present (sampling its pixels via an offscreen canvas), otherwise
// the material's flat colour; vertex colours are folded in when present.
interface MeshColorReader {
  uv?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  colorAttr?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  baseColor: THREE.Color;               // material colour, sRGB
  tex?: { data: ImageData; w: number; h: number };
}

function makeColorReader(mesh: THREE.Mesh): MeshColorReader {
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | undefined;
  const geom = mesh.geometry;

  const baseColor = new THREE.Color(1, 1, 1);
  if (material && (material as THREE.MeshStandardMaterial).color) {
    // pull the factor as sRGB so it composes with sRGB texels
    (material as THREE.MeshStandardMaterial).color.getRGB(baseColor, THREE.SRGBColorSpace);
  }

  const reader: MeshColorReader = {
    uv: geom.getAttribute("uv") as THREE.BufferAttribute | undefined,
    colorAttr: geom.getAttribute("color") as THREE.BufferAttribute | undefined,
    baseColor,
  };

  const map = material && (material as THREE.MeshStandardMaterial).map;
  const image = map?.image as (HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined);
  if (map && image && reader.uv) {
    const w = (image as HTMLImageElement).width;
    const h = (image as HTMLImageElement).height;
    if (w && h) {
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      if (cx) {
        cx.drawImage(image as CanvasImageSource, 0, 0, w, h);
        try {
          reader.tex = { data: cx.getImageData(0, 0, w, h), w, h };
        } catch {
          // tainted canvas (cross-origin texture) — fall back to base colour
        }
      }
    }
  }
  return reader;
}

const _bary = { u: 0, v: 0 };
function readColor(
  r: MeshColorReader, i0: number, i1: number, i2: number, out: THREE.Color,
): void {
  out.copy(r.baseColor);

  if (r.tex && r.uv) {
    const w0 = 1 - _bary.u - _bary.v, w1 = _bary.u, w2 = _bary.v;
    let tu = r.uv.getX(i0) * w0 + r.uv.getX(i1) * w1 + r.uv.getX(i2) * w2;
    let tv = r.uv.getY(i0) * w0 + r.uv.getY(i1) * w1 + r.uv.getY(i2) * w2;
    tu = tu - Math.floor(tu);                  // wrap (repeat)
    tv = tv - Math.floor(tv);
    const px = Math.min(r.tex.w - 1, (tu * r.tex.w) | 0);
    // glTF UV origin is top-left; ImageData rows run top-down, so flip v
    const py = Math.min(r.tex.h - 1, ((1 - tv) * r.tex.h) | 0);
    const idx = (py * r.tex.w + px) * 4;
    const d = r.tex.data.data;
    out.r *= d[idx] / 255;
    out.g *= d[idx + 1] / 255;
    out.b *= d[idx + 2] / 255;
  }

  if (r.colorAttr) {
    const w0 = 1 - _bary.u - _bary.v, w1 = _bary.u, w2 = _bary.v;
    out.r *= r.colorAttr.getX(i0) * w0 + r.colorAttr.getX(i1) * w1 + r.colorAttr.getX(i2) * w2;
    out.g *= r.colorAttr.getY(i0) * w0 + r.colorAttr.getY(i1) * w1 + r.colorAttr.getY(i2) * w2;
    out.b *= r.colorAttr.getZ(i0) * w0 + r.colorAttr.getZ(i1) * w1 + r.colorAttr.getZ(i2) * w2;
  }
}

/**
 * Sample `count` points spread EVENLY across the model's surface, by area,
 * each carrying the model's surface colour at that point.
 *
 * Projecting evenly-spaced sphere directions onto an irregular model clusters
 * points where the surface is near-spherical and thins them where it bulges or
 * dents (and concavities make many rays share one hit). Sampling the triangles
 * directly, weighted by triangle area, instead gives uniform surface density.
 *
 * Points are returned in the model's centred/scaled space, so each glyph's
 * landing ray is simply `direction = normalize(point)`, `radius = point.length()`.
 */
export function sampleSurfacePoints(model: LoadedModel, count: number): SurfaceSample[] {
  // gather every triangle in world space, tracking cumulative area for
  // area-weighted selection, and which mesh / vertices it came from
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3();
  const tris: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [];
  const triMeshIdx: number[] = [];
  const triVerts: Array<[number, number, number]> = [];
  const cumArea: number[] = [];
  let total = 0;

  const readers = model.meshes.map(makeColorReader);

  model.meshes.forEach((mesh, meshIdx) => {
    const geom = mesh.geometry;
    const pos = geom.getAttribute("position");
    if (!pos) return;
    const index = geom.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    mesh.updateWorldMatrix(true, false);
    const mat = mesh.matrixWorld;

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mat);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mat);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mat);
      ab.subVectors(b, a); ac.subVectors(c, a);
      const area = cross.crossVectors(ab, ac).length() * 0.5;
      if (area <= 0) continue;
      total += area;
      tris.push([a.clone(), b.clone(), c.clone()]);
      triMeshIdx.push(meshIdx);
      triVerts.push([i0, i1, i2]);
      cumArea.push(total);
    }
  });

  const samples: SurfaceSample[] = [];
  if (tris.length === 0 || total <= 0) return samples;

  // binary search the cumulative-area table for an area-weighted triangle
  const pick = (r: number): number => {
    let lo = 0, hi = cumArea.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumArea[mid] < r) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  for (let i = 0; i < count; i++) {
    const t = pick(Math.random() * total);
    const [p0, p1, p2] = tris[t];
    // uniform barycentric coordinates within the chosen triangle
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    _bary.u = u; _bary.v = v;
    const point = new THREE.Vector3(
      p0.x + u * (p1.x - p0.x) + v * (p2.x - p0.x),
      p0.y + u * (p1.y - p0.y) + v * (p2.y - p0.y),
      p0.z + u * (p1.z - p0.z) + v * (p2.z - p0.z),
    );
    const color = new THREE.Color();
    const [j0, j1, j2] = triVerts[t];
    readColor(readers[triMeshIdx[t]], j0, j1, j2, color);
    samples.push({ point, color });
  }
  return samples;
}
