// GPU shaders for the sphere-of-words animation. The flight path (sphere
// target, wave timing, easing, bowed bezier) is shared between the glyph and
// trace programs via FLIGHT_GLSL, which is prepended to each vertex shader.

// ----- shared GLSL: replicate the on-sphere target, control point and the
//       bezier flight path entirely on the GPU -----
const FLIGHT_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uRot;
  uniform float uTilt;
  uniform float uFlight;
  uniform float uOutBounce; // multiplier on the pull-back leaving the paragraph
  uniform float uInBounce;  // multiplier on the overshoot landing on the sphere
  uniform float uWaveSize;  // how many glyphs launch together per wave
  uniform float uWaveGap;   // ms between successive waves
  uniform float uMorph;     // 0 = clustered at the button, 1 = full paragraph

  attribute vec3 aSource;   // flat paragraph position (world)
  attribute vec3 aAnchor;   // button position glyphs collapse to / expand from
  attribute vec3 aSphere;   // unit position on the sphere
  attribute float aRadius;  // distance from centre to the landing point
  attribute float aIndex;   // sequential position in the paragraph
  attribute float aJitter;  // 0..1 per-glyph timing jitter within its wave
  attribute float aCurve;   // signed bow of its trace
  attribute float aPull;    // per-glyph anticipation / overshoot strength

  // resting position before flight: morphs between the button anchor (a single
  // point, glyphs gathered = the "button") and the spread-out paragraph layout
  vec3 restPos() {
    return mix(aAnchor, aSource, smoothstep(0.0, 1.0, uMorph));
  }

  // current landing target after spin + tilt. aSphere is a unit direction;
  // rotation preserves its length, so scaling by aRadius places the glyph at
  // the right distance along that (rotated) ray — on the sphere by default,
  // or on a loaded model's surface when aRadius is the raycast hit distance.
  vec3 sphereTarget() {
    vec3 sp = aSphere;
    float cr = cos(uRot), sr = sin(uRot);
    vec3 rotY = vec3(sp.x * cr + sp.z * sr, sp.y, -sp.x * sr + sp.z * cr);
    float ct = cos(uTilt), st = sin(uTilt);
    vec3 tilted = vec3(rotY.x, rotY.y * ct - rotY.z * st, rotY.y * st + rotY.z * ct);
    return tilted * aRadius;
  }

  // launch time derived from wave size so the slider takes effect live
  float launchTime() {
    float wave = floor(aIndex / max(uWaveSize, 1.0));
    return wave * uWaveGap + aJitter * uWaveGap * 0.6;
  }

  float progress() {
    return clamp((uTime - launchTime()) / uFlight, 0.0, 1.0);
  }

  // easeInOutBack: dips below 0 at the start (the glyph bounces backward out
  // of the paragraph before launching, scaled by uOutBounce) and rises above
  // 1 near the end (it overshoots and springs onto the sphere, scaled
  // independently by uInBounce). aPull adds per-glyph variation; the curve
  // still reaches exactly 1.
  float easeBack(float p) {
    if (p < 0.5) {
      float c2 = 1.70158 * aPull * uOutBounce * 1.525;
      float q = 2.0 * p;
      return (q * q * ((c2 + 1.0) * q - c2)) * 0.5;
    }
    float c2 = 1.70158 * aPull * uInBounce * 1.525;
    float q = 2.0 * p - 2.0;
    return (q * q * ((c2 + 1.0) * q + c2) + 2.0) * 0.5;
  }

  // quadratic bezier position at param p, rest -> bowed control -> target
  vec3 flightAt(vec3 target, float p) {
    vec3 origin = restPos();
    vec3 mid = mix(origin, target, 0.5);
    vec3 d = target - origin;
    float len = length(d);
    vec3 dir = len > 0.0001 ? d / len : vec3(0.0, 1.0, 0.0);
    vec3 ref = abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 perp = normalize(cross(dir, ref));
    vec3 ctrl = mid + perp * (len * aCurve * 0.45);
    float u = 1.0 - p;
    return u * u * origin + 2.0 * u * p * ctrl + p * p * target;
  }
`;

// ===================================================================
//  Glyphs: ONE instanced draw call. Billboarded quads, animated on GPU.
// ===================================================================
export const GLYPH_VERT = FLIGHT_GLSL + /* glsl */ `
  attribute vec4 aUv;       // atlas rect: offset.xy, size.xy
  attribute vec3 aColor;    // surface colour this glyph adopts on arrival
  uniform float uGlyphSize;
  uniform float uColorize;  // 1 while a model is loaded, 0 for the plain sphere

  varying vec2 vUv;
  varying float vDepth;
  varying vec3 vColor;
  varying float vTint;      // 0 = original ink, 1 = full surface colour
  varying float vFade;      // glyph opacity (fades while collapsed into a button)

  void main() {
    vec3 target = sphereTarget();
    float p = progress();
    float e = easeBack(p);               // anticipation + spring overshoot
    vec3 center = flightAt(target, e);

    // billboard: offset in view space so glyphs always face the camera
    vec4 mv = modelViewMatrix * vec4(center, 1.0);
    mv.xy += position.xy * uGlyphSize;
    gl_Position = projectionMatrix * mv;

    vDepth = -mv.z;
    vUv = aUv.xy + uv * aUv.zw;
    vColor = aColor;
    // ease the tint in over the flight so the colour "arrives" with the glyph
    vTint = uColorize * smoothstep(0.0, 1.0, p);
    // while morphed toward the button anchor (uMorph→0) glyphs pile up; fade
    // them so the cluster dissolves into the button instead of a messy blob
    vFade = smoothstep(0.0, 0.5, uMorph);
  }
`;

export const GLYPH_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D uTex;
  uniform float uDepthMin;
  uniform float uDepthMax;

  varying vec2 vUv;
  varying float vDepth;
  varying vec3 vColor;
  varying float vTint;
  varying float vFade;

  void main() {
    vec4 tex = texture2D(uTex, vUv);
    if (tex.a < 0.02) discard;
    float dN = clamp((vDepth - uDepthMin) / (uDepthMax - uDepthMin), 0.0, 1.0);
    float ink = (40.0 + dN * 70.0) / 255.0;        // near = dark, far = light
    float alpha = 0.45 + (1.0 - dN) * 0.55;        // far = faint
    // transition from the original near-black ink to the model surface colour
    vec3 rgb = mix(vec3(ink), vColor, vTint);
    gl_FragColor = vec4(rgb, tex.a * alpha * vFade);
  }
`;

// ===================================================================
//  Traces: ONE LineSegments draw call, each curve animated on GPU.
// ===================================================================
export const TRACE_VERT = FLIGHT_GLSL + /* glsl */ `
  attribute float aS;       // 0..1 position along this glyph's trail
  varying float vDepth;
  varying float vVisible;

  void main() {
    vec3 target = sphereTarget();
    float p = progress();
    float e = easeBack(p);                         // match the glyph's motion
    vec3 pos = flightAt(target, aS * e);           // trail spans source..glyph
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    vDepth = -mv.z;
    vVisible = p;
  }
`;

export const TRACE_FRAG = /* glsl */ `
  precision mediump float;
  uniform float uDepthMin;
  uniform float uDepthMax;
  varying float vDepth;
  varying float vVisible;

  void main() {
    if (vVisible <= 0.001) discard;
    float dN = clamp((vDepth - uDepthMin) / (uDepthMax - uDepthMin), 0.0, 1.0);
    float alpha = 0.05 + (1.0 - dN) * 0.13;
    gl_FragColor = vec4(208.0 / 255.0, 64.0 / 255.0, 58.0 / 255.0, alpha);
  }
`;
