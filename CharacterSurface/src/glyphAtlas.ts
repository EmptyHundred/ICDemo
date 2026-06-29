import * as THREE from "three";

export interface GlyphAtlas {
  texture: THREE.Texture;
  /** UV rect per character: [offsetX, offsetY, sizeX, sizeY] in 0..1 space. */
  uv: Map<string, [number, number, number, number]>;
  /** Font used to draw the atlas, so callers can measure advances consistently. */
  cellPx: number;
}

/**
 * Rasterize every unique character once into a square-cell texture atlas.
 * Glyphs are drawn white-on-transparent so the shader can tint them.
 */
export function buildGlyphAtlas(text: string): GlyphAtlas {
  const chars = Array.from(new Set(Array.from(text))).filter(c => c !== "\n");
  // always include a space so layout never misses it
  if (!chars.includes(" ")) chars.push(" ");

  const cellPx = 64;
  const fontPx = 48;
  const cols = Math.ceil(Math.sqrt(chars.length));
  const rows = Math.ceil(chars.length / cols);

  const canvas = document.createElement("canvas");
  canvas.width = cols * cellPx;
  canvas.height = rows * cellPx;
  const c = canvas.getContext("2d")!;
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.font = `${fontPx}px Georgia, "Times New Roman", serif`;
  c.fillStyle = "#ffffff";
  c.textAlign = "center";
  c.textBaseline = "middle";

  const uv = new Map<string, [number, number, number, number]>();
  chars.forEach((ch, i) => {
    const col = i % cols;
    const row = (i / cols) | 0;
    const px = col * cellPx;
    const py = row * cellPx;
    c.fillText(ch, px + cellPx / 2, py + cellPx / 2);
    // texture v is flipped relative to canvas y; account for that here
    const u0 = px / canvas.width;
    const v0 = 1 - (py + cellPx) / canvas.height;
    uv.set(ch, [u0, v0, cellPx / canvas.width, cellPx / canvas.height]);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  return { texture, uv, cellPx };
}
