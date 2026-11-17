/**
 * RuneDeck — battlefield renderer (Three.js).
 *
 * A fixed perspective camera, pitched 47 degrees like a MOBA's, looks down the
 * Z axis so the whole arena fits one screen: Radiant on the left, Dire on the
 * right, the River between them. The frame is rendered in HDR and bloomed, so
 * lava, crystals and spell effects glow; every unit casts a real shadow.
 *
 * Built for a steady 60 FPS:
 *  - the terrain is painted by a procedural shader that is baked to a texture
 *    once; per frame only the water and the emissive glow are animated;
 *  - static props are merged into two meshes (lit and glowing);
 *  - render resolution steps down, and bloom switches off, on a GPU that cannot keep up.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { MAP, STRUCTURES, groundHeight, heroSpawn, riverCenter, riverDistance } from './shared.js';
import { GLSL_TO_LINEAR, createUnitLayer } from './units.js';

const TAU = Math.PI * 2;
const PITCH = THREE.MathUtils.degToRad(47);
/** Vertical field of view. Narrow enough that the far bank stays readable, wide enough to give the arena depth. */
const FOV = 30;
const SIN_P = Math.sin(PITCH);
const COS_P = Math.cos(PITCH);
/** Terrain plane, larger than the playable field so its edge can fade into the void. */
const GROUND_W = 64;
const GROUND_D = 36;
const VOID_COLOR = 0x05070f;
const LIGHT_DIR = new THREE.Vector3(-0.42, 0.78, 0.46).normalize();
const TEAM_COLOR = { radiant: 0x4fc3ff, dire: 0xff5a36 };
const RUNE_COLOR = { damage: 0xffa41a, haste: 0x5dffb0, regen: 0xb48cff };
const GOLD = 0xffd766;
const LIFESTEAL_COLOR = 0xff2a4a;
/**
 * Ability colours by side. The Aether Knight's are the classic gold and cyan;
 * Morgath casts the same spells in ember and violet, so a glance tells whose they are.
 */
const SPELL = {
  radiant: { slash: 0xffd766, shield: 0xffcf5a, bolt: 0x5ff0ff, boltCore: 0xeaffff, pillar: 0xffd766, pillarCore: 0xfff3c4, blink: 0x4aa8ff, blinkCore: 0xd6ebff },
  dire: { slash: 0xff8a3a, shield: 0xff7a2e, bolt: 0xc77dff, boltCore: 0xf3e2ff, pillar: 0xff5a2a, pillarCore: 0xffd2a0, blink: 0xb04aff, blinkCore: 0xecd6ff },
};
/** How far glowing materials are pushed past white, so the bloom pass picks them up. */
const GLOW_BOOST = 1.3;

/** Lanes and plazas for one quadrant; the layout is mirrored on both axes. */
const PATH = { bendX: 14, gateX: 16.5, gateZ: 3.5, lane: 1.15, link: 1.05, throne: 5, tower: 2.7, heroPad: 1.5 };

function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/** Mirrors `pathDist` in the terrain shader, so props stay off the roads. */
function pathDistance(x, z) {
  const qx = Math.abs(x);
  const qz = Math.abs(z);
  return Math.min(
    segmentDistance(qx, qz, 0, MAP.laneZ, PATH.bendX, MAP.laneZ) - PATH.lane,
    segmentDistance(qx, qz, PATH.bendX, MAP.laneZ, PATH.gateX, PATH.gateZ) - PATH.link,
    Math.hypot(qx - MAP.throneX, qz) - PATH.throne,
    Math.hypot(qx - MAP.towerX, qz - MAP.laneZ) - PATH.tower,
    Math.hypot(qx - MAP.heroX, qz) - PATH.heroPad,
  );
}

function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeOut = (k) => 1 - (1 - k) ** 3;

/* -------------------------------------------------------------------------- */
/* Shaders                                                                    */
/* -------------------------------------------------------------------------- */

const f = (value) => Number(value).toFixed(3);
const R = MAP.river;

const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p) {
  float n = hash21(p);
  return vec2(n, hash21(p + n + 17.17));
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const GLSL_FIELD = /* glsl */ `
float riverCenter(float z) {
  return sin(z * ${f(R.freq1)}) * ${f(R.amp1)} + sin(z * ${f(R.freq2)} + ${f(R.phase2)}) * ${f(R.amp2)};
}
// Signed distance to the water's edge; negative in the River and the rune pool.
float riverDist(vec2 p) {
  float channel = abs(p.x - riverCenter(p.y)) - (${f(R.halfWidth)} + ${f(R.wobble)} * sin(p.y * ${f(R.wobbleFreq)} + ${f(R.wobblePhase)}));
  float pool = length(p) - ${f(R.poolRadius)};
  float h = clamp(0.5 + 0.5 * (pool - channel) / ${f(R.blend)}, 0.0, 1.0);
  return mix(pool, channel, h) - ${f(R.blend)} * h * (1.0 - h);
}
float outsideField(vec2 p) {
  vec2 d = abs(p) - vec2(${f(MAP.halfWidth + 0.6)}, ${f(MAP.halfDepth + 0.6)});
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
`;

/** One-off bake: colour in rgb, emissive strength (lava cracks, rune carvings) in alpha. */
const BAKE_FRAGMENT = /* glsl */ `
varying vec2 vUv;
${GLSL_NOISE}
${GLSL_FIELD}

float fbm(vec2 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec2(11.7, 5.3);
    amp *= 0.5;
  }
  return sum;
}

// x: distance to the nearest cell edge, y: random value per cell.
vec2 voronoi(vec2 x) {
  vec2 n = floor(x);
  vec2 u = fract(x);
  vec2 nearestCell = vec2(0.0);
  vec2 nearest = vec2(0.0);
  float best = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + hash22(n + g) - u;
      float d = dot(r, r);
      if (d < best) { best = d; nearest = r; nearestCell = g; }
    }
  }
  float edge = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = nearestCell + vec2(float(i), float(j));
      vec2 r = g + hash22(n + g) - u;
      vec2 between = r - nearest;
      if (dot(between, between) > 0.00001) edge = min(edge, dot(0.5 * (nearest + r), normalize(between)));
    }
  }
  return vec2(edge, hash21(n + nearestCell + 0.5));
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

float pathDist(vec2 p) {
  vec2 q = abs(p);
  float d = sdSegment(q, vec2(0.0, ${f(MAP.laneZ)}), vec2(${f(PATH.bendX)}, ${f(MAP.laneZ)})) - ${f(PATH.lane)};
  d = min(d, sdSegment(q, vec2(${f(PATH.bendX)}, ${f(MAP.laneZ)}), vec2(${f(PATH.gateX)}, ${f(PATH.gateZ)})) - ${f(PATH.link)});
  d = min(d, length(q - vec2(${f(MAP.throneX)}, 0.0)) - ${f(PATH.throne)});
  d = min(d, length(q - vec2(${f(MAP.towerX)}, ${f(MAP.laneZ)})) - ${f(PATH.tower)});
  d = min(d, length(q - vec2(${f(MAP.heroX)}, 0.0)) - ${f(PATH.heroPad)});
  return d;
}

float band(float d, float radius, float width) {
  return smoothstep(width, 0.0, abs(d - radius));
}

vec3 grass(vec2 p) {
  float broad = fbm(p * 0.28 + 3.0);
  float patchy = fbm(p * 1.4 + 17.0);
  float blades = vnoise(p * vec2(13.0, 17.0));
  vec3 c = mix(vec3(0.035, 0.27, 0.15), vec3(0.10, 0.47, 0.22), broad);
  c = mix(c, vec3(0.20, 0.60, 0.27), smoothstep(0.52, 0.80, patchy) * 0.55);
  c *= 0.84 + 0.30 * blades;
  vec2 cell = floor(p * 1.5);
  float bloom = step(0.86, hash21(cell + 11.0))
              * smoothstep(0.17, 0.07, length(fract(p * 1.5) - 0.2 - 0.6 * hash22(cell + 5.0)));
  vec3 petal = mix(vec3(0.70, 0.95, 1.0), vec3(1.0, 0.93, 0.55), step(0.5, hash21(cell + 23.0)));
  return mix(c, petal, bloom);
}

vec3 cobble(vec2 p) {
  vec2 v = voronoi(p * 1.7);
  vec3 stone = mix(vec3(0.46, 0.52, 0.58), vec3(0.74, 0.77, 0.76), v.y);
  stone *= 0.82 + 0.26 * vnoise(p * 11.0);
  stone *= 0.90 + 0.14 * smoothstep(0.05, 0.35, v.x);
  return mix(vec3(0.10, 0.17, 0.15), stone, smoothstep(0.02, 0.10, v.x));
}

vec4 obsidian(vec2 p) {
  vec2 plate = voronoi(p * 0.5 + 9.0);
  float grain = fbm(p * 0.9 + 21.0);
  vec3 c = mix(vec3(0.050, 0.043, 0.062), vec3(0.135, 0.110, 0.140), plate.y * 0.55 + grain * 0.45);
  c *= 0.78 + 0.34 * vnoise(p * 9.0);
  c += vec3(0.16, 0.13, 0.18) * pow(vnoise(vec2(p.x * 2.2 + p.y * 1.4, p.y * 7.0)), 5.0) * 0.8;
  c *= 0.80 + 0.20 * smoothstep(0.0, 0.12, plate.x);
  vec2 crack = voronoi(p * 0.72 + vec2(3.0, 41.0));
  float region = smoothstep(0.38, 0.60, fbm(p * 0.20 + 57.0));
  float core = smoothstep(0.065, 0.0, crack.x) * region;
  float heat = smoothstep(0.40, 0.0, crack.x) * region;
  c = mix(c, vec3(0.30, 0.045, 0.02), heat * 0.6);
  return vec4(c, clamp(core * 0.9 + heat * 0.22, 0.0, 1.0));
}

vec4 basalt(vec2 p) {
  vec2 q = p * vec2(0.95, 1.45);
  q.x += 0.5 * floor(q.y);
  vec2 u = fract(q);
  float edge = min(min(u.x, 1.0 - u.x), min(u.y, 1.0 - u.y));
  vec3 slab = mix(vec3(0.17, 0.15, 0.18), vec3(0.29, 0.25, 0.27), hash21(floor(q) + 3.0));
  slab *= 0.80 + 0.30 * vnoise(p * 9.0);
  float joint = smoothstep(0.075, 0.02, edge);
  return vec4(mix(slab, vec3(0.42, 0.07, 0.02), joint), joint * 0.42);
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(${f(GROUND_W)}, ${f(GROUND_D)});
  vec2 q = abs(p);
  float dire = step(riverCenter(p.y), p.x);
  float rd = riverDist(p);
  float pd = pathDist(p) + (fbm(p * 1.3 + 31.0) - 0.5) * 0.45;
  float onPath = smoothstep(0.10, -0.10, pd);

  vec3 col;
  float glow = 0.0;
  if (dire < 0.5) {
    col = grass(p);
    col = mix(col, col * vec3(0.62, 0.66, 0.55), smoothstep(0.8, 0.0, pd) * 0.7);
    col = mix(col, cobble(p), onPath);
  } else {
    vec4 rock = obsidian(p);
    vec4 road = basalt(p);
    col = mix(rock.rgb, road.rgb, onPath);
    glow = mix(rock.a, road.a, onPath);
    float kerb = band(pd, 0.0, 0.13);
    col = mix(col, vec3(0.48, 0.09, 0.02), kerb * 0.6);
    glow = max(glow, kerb * 0.5);
  }

  // Rune circles carved into the plazas.
  float throneD = length(q - vec2(${f(MAP.throneX)}, 0.0));
  float towerD = length(q - vec2(${f(MAP.towerX)}, ${f(MAP.laneZ)}));
  float heroD = length(q - vec2(${f(MAP.heroX)}, 0.0));
  float ticks = step(0.5, fract(atan(q.y, q.x - ${f(MAP.throneX)}) * 3.8197));
  float carve = band(throneD, 4.48, 0.05) + band(throneD, 4.20, 0.11) * ticks * 0.7 + band(throneD, 3.90, 0.035)
              + band(towerD, 2.25, 0.05) + band(heroD, 1.15, 0.045);
  carve = clamp(carve, 0.0, 1.0);
  col = mix(col, mix(vec3(0.20, 0.52, 0.80), vec3(0.50, 0.10, 0.03), dire), carve * 0.65);
  glow = max(glow, carve * 0.8);

  // Contact shading at the foot of each structure.
  col *= mix(0.64, 1.0, smoothstep(3.1, 4.3, throneD));
  col *= mix(0.68, 1.0, smoothstep(1.7, 2.6, towerD));

  // River banks: a wet shore over a darker bed.
  float shore = smoothstep(1.0, 0.0, rd);
  vec3 bed = mix(vec3(0.40, 0.45, 0.36), vec3(0.11, 0.10, 0.12), dire) * (0.78 + 0.32 * vnoise(p * 6.0));
  col = mix(col, bed, shore * 0.85);
  col *= 1.0 - 0.4 * smoothstep(0.3, -0.3, rd);
  glow *= 1.0 - shore;

  // Beyond the field the ground crumbles into the void.
  float outside = outsideField(p);
  col *= 1.0 - 0.45 * smoothstep(-0.2, 0.7, outside);
  col = mix(col, mix(vec3(0.020, 0.040, 0.085), vec3(0.070, 0.022, 0.030), dire), smoothstep(1.0, 4.2, outside));
  glow *= 1.0 - smoothstep(0.8, 3.6, outside);

  gl_FragColor = vec4(col, glow);
}
`;

const BAKE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const TERRAIN_VERTEX = /* glsl */ `
varying vec2 vPos;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPos = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/** Per-frame terrain: the baked map plus animated water and pulsing emissive. */
const TERRAIN_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uTime;
uniform vec3 uVoid;
varying vec2 vPos;
${GLSL_NOISE}
${GLSL_FIELD}
${GLSL_TO_LINEAR}

float flow(vec2 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 3; i++) {
    sum += amp * vnoise(p);
    p = p * 2.02 + vec2(7.1, 3.7);
    amp *= 0.5;
  }
  return sum;
}

vec3 water(vec2 p, float rd) {
  float t = uTime;
  vec2 q = vec2(p.x - riverCenter(p.y), p.y);
  float n1 = flow(q * vec2(1.5, 0.5) + vec2(0.0, -t * 0.5));
  float n2 = flow(q * vec2(2.6, 1.0) + vec2(n1 * 1.6 + 3.0, -t * 0.85));
  vec3 c = mix(vec3(0.10, 0.66, 0.74), vec3(0.02, 0.27, 0.50), smoothstep(0.1, -1.7, rd));
  c += vec3(0.30, 0.95, 1.0) * pow(n2, 3.0) * 1.5;

  // Current streaks running downstream.
  float streak = sin((q.y * 1.1 - t * 1.5 + n1 * 5.0) * 3.0) * 0.5 + 0.5;
  c += vec3(0.55, 1.0, 1.0) * smoothstep(0.86, 1.0, streak) * (0.15 + 0.5 * n2) * 0.6;

  // Rings spreading from the rune pad.
  float r = length(p);
  float pad = sin(r * 6.0 - t * 3.0) * 0.5 + 0.5;
  c += vec3(0.45, 1.0, 1.0) * smoothstep(0.75, 1.0, pad) * smoothstep(3.8, 2.0, r) * 0.35;

  // Scattered drip ripples.
  vec2 cell = floor(p * 0.5);
  vec2 centre = (cell + 0.2 + 0.6 * hash22(cell)) * 2.0;
  float age = fract(t * 0.35 + hash21(cell + 9.0));
  c += vec3(0.6, 1.0, 1.0) * smoothstep(0.07, 0.0, abs(length(p - centre) - age * 0.9)) * (1.0 - age) * 0.5;

  // Foam lapping at the banks.
  float foam = smoothstep(-0.42, -0.02, rd) * (0.55 + 0.45 * sin(rd * 20.0 + t * 2.4 + n1 * 7.0));
  return mix(c, vec3(0.82, 1.0, 1.0), clamp(foam, 0.0, 1.0) * 0.75);
}

void main() {
  vec2 p = vPos;
  vec4 base = texture2D(uMap, p / vec2(${f(GROUND_W)}, ${f(GROUND_D)}) + 0.5);
  vec3 col = base.rgb;
  float rd = riverDist(p);
  float dire = smoothstep(-0.3, 0.3, p.x - riverCenter(p.y));
  float outside = outsideField(p);
  float inField = 1.0 - smoothstep(1.0, 4.2, outside);

  float pulse = 0.72 + 0.28 * sin(uTime * 1.7 + p.x * 0.9 + p.y * 1.3);
  vec3 lava = mix(vec3(0.95, 0.14, 0.02), vec3(1.0, 0.80, 0.28), smoothstep(0.3, 0.95, base.a)) * pulse * 1.3;
  vec3 arcane = vec3(0.30, 0.82, 1.0) * (0.8 + 0.2 * sin(uTime * 1.2 + p.x));
  vec3 emissive = mix(arcane, lava, dire) * base.a;
  col += emissive;

  // The River lights its banks.
  col += vec3(0.05, 0.42, 0.50) * exp(-max(rd, 0.0) * 1.5) * 0.45 * inField;
  float wet = rd < 0.4 ? smoothstep(0.32, -0.06, rd) * inField : 0.0;
  vec3 stream = wet > 0.0 ? water(p, rd) : vec3(0.0);
  col = mix(col, stream, wet);

  float fade = smoothstep(3.4, 5.3, outside);
  vec3 lin = toLinear(mix(col, uVoid, fade));
  // Energy past white, for the bloom: molten cracks, arcane veins and the brightest water.
  lin += toLinear(emissive) * ${f(0.55)} * (1.0 - wet) * (1.0 - fade);
  lin += vec3(0.08, 0.45, 0.60) * pow(max(stream.g - 0.78, 0.0) * 3.0, 2.0) * wet * (1.0 - fade);
  gl_FragColor = vec4(lin, 1.0);
  #include <colorspace_fragment>
}
`;

const PARTICLE_VERTEX = /* glsl */ `
attribute vec4 aSeed;   // x: cycles per second, y: sway, z: phase, w: size in world units
attribute vec3 aColor;
attribute float aRise;
uniform float uTime;
uniform float uPixels;  // device pixels that one world unit covers at a distance of one unit
varying vec3 vColor;
varying float vAlpha;
void main() {
  float life = fract(uTime * aSeed.x + aSeed.z);
  vec3 p = position;
  p.y += life * aRise;
  p.x += sin(uTime * (0.6 + aSeed.x * 3.0) + aSeed.z * 40.0) * aSeed.y;
  p.z += cos(uTime * (0.5 + aSeed.x * 2.0) + aSeed.z * 23.0) * aSeed.y * 0.6;
  vAlpha = sin(life * 3.14159) * (0.55 + 0.45 * sin(uTime * 4.0 + aSeed.z * 90.0));
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  // Nearer motes are drawn larger: this is what gives the air its depth.
  gl_PointSize = max(aSeed.w * uPixels / gl_Position.w, 1.5);
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
${GLSL_TO_LINEAR}
void main() {
  float falloff = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(toLinear(vColor) * ${f(1.6)}, falloff * falloff * vAlpha);
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/* Geometry batching                                                          */
/* -------------------------------------------------------------------------- */

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const C = new THREE.Vector3();
const EDGE = new THREE.Vector3();
const NORMAL = new THREE.Vector3();
const LOW = new THREE.Color();
const HIGH = new THREE.Color();
const TINT = new THREE.Color();

/**
 * Collects flat-shaded triangles from many primitives into one geometry.
 * Each piece gets a bottom-to-top colour gradient; `facet` bakes simple
 * directional shading into the colours for unlit, glowing pieces.
 */
class Batch {
  positions = [];
  normals = [];
  colors = [];

  add(geometry, matrix, bottom, top = bottom, facet = 0) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const source = flat.getAttribute('position');
    flat.computeBoundingBox();
    const minY = flat.boundingBox.min.y;
    const spanY = Math.max(flat.boundingBox.max.y - minY, 1e-6);
    LOW.set(bottom);
    HIGH.set(top);

    for (let i = 0; i < source.count; i += 3) {
      A.fromBufferAttribute(source, i);
      B.fromBufferAttribute(source, i + 1);
      C.fromBufferAttribute(source, i + 2);
      const heights = [(A.y - minY) / spanY, (B.y - minY) / spanY, (C.y - minY) / spanY];
      A.applyMatrix4(matrix);
      B.applyMatrix4(matrix);
      C.applyMatrix4(matrix);
      NORMAL.subVectors(B, A).cross(EDGE.subVectors(C, A)).normalize();

      let shade = 1;
      let shine = 0;
      if (facet) {
        const lit = Math.max(NORMAL.dot(LIGHT_DIR), 0);
        shade = 1 - facet + facet * lit;
        shine = lit ** 6 * facet * 0.6;
      }
      [A, B, C].forEach((vertex, n) => {
        this.positions.push(vertex.x, vertex.y, vertex.z);
        this.normals.push(NORMAL.x, NORMAL.y, NORMAL.z);
        TINT.lerpColors(LOW, HIGH, heights[n]);
        this.colors.push(TINT.r * shade + shine, TINT.g * shade + shine, TINT.b * shade + shine);
      });
    }
    if (flat !== geometry) flat.dispose();
  }

  geometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    return geometry;
  }

  build(material) {
    return new THREE.Mesh(this.geometry(), material);
  }
}

/** A hexagonal prism with a pointed tip. */
function crystalGeometry(radius, height) {
  const body = new THREE.CylinderGeometry(radius * 0.8, radius, height * 0.7, 6).translate(0, height * 0.35, 0).toNonIndexed();
  const tip = new THREE.ConeGeometry(radius * 0.8, height * 0.3, 6).translate(0, height * 0.85, 0).toNonIndexed();
  const merged = new Float32Array(body.attributes.position.count * 3 + tip.attributes.position.count * 3);
  merged.set(body.attributes.position.array, 0);
  merged.set(tip.attributes.position.array, body.attributes.position.count * 3);
  body.dispose();
  tip.dispose();
  return new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(merged, 3));
}

const EULER = new THREE.Euler();
const QUAT = new THREE.Quaternion();
const MATRIX = new THREE.Matrix4();
const POSITION = new THREE.Vector3();
const SCALE = new THREE.Vector3();

/**
 * Drawing helpers that add primitives to a lit and a glowing batch. Every shape
 * sits with its base at (x, y, z), so `rx`/`rz` lean it about its foot.
 * Options: top (gradient colour), glow, rx, ry, rz, sx, sy, sz.
 */
function pen(solid, glow, ox = 0, oz = 0) {
  const put = (geometry, color, x, y, z, o = {}) => {
    EULER.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    MATRIX.compose(POSITION.set(ox + x, y, oz + z), QUAT.setFromEuler(EULER), SCALE.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
    (o.glow ? glow : solid).add(geometry, MATRIX, color, o.top ?? color, o.glow ? 0.42 : 0);
    geometry.dispose();
  };
  return {
    box: (color, x, y, z, w, h, d, o) => put(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), color, x, y, z, o),
    cyl: (color, x, y, z, top, bottom, h, sides = 8, o) =>
      put(new THREE.CylinderGeometry(top, bottom, h, sides).translate(0, h / 2, 0), color, x, y, z, o),
    cone: (color, x, y, z, r, h, sides = 6, o) => put(new THREE.ConeGeometry(r, h, sides).translate(0, h / 2, 0), color, x, y, z, o),
    gem: (color, x, y, z, r, h, o) =>
      put(new THREE.OctahedronGeometry(1).scale(r, h / 2, r).translate(0, h / 2, 0), color, x, y, z, o),
    crystal: (color, x, y, z, r, h, o) => put(crystalGeometry(r, h), color, x, y, z, o),
    /** Centred on (x, y, z) rather than resting on it. */
    rock: (color, x, y, z, r, o) => put(new THREE.IcosahedronGeometry(r, 0), color, x, y, z, o),
  };
}

/** Lean a shape away from (or, with a negative angle, towards) its structure's axis. */
const lean = (angle, amount) => ({ rz: -Math.cos(angle) * amount, rx: Math.sin(angle) * amount });

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

function radiantTower(p) {
  p.cyl(0x8794ab, 0, 0, 0, 1.55, 1.8, 0.35, 8, { top: 0xc9d2e2 });
  p.cyl(0x7b88a2, 0, 0.35, 0, 1.2, 1.4, 0.3, 8, { top: 0xb9c4d8 });
  p.cyl(0x93a0b8, 0, 0.65, 0, 0.78, 1.0, 2.5, 8, { top: 0xe6ecf7 });
  p.cyl(0xc9a24a, 0, 3.15, 0, 0.98, 0.84, 0.2, 8, { top: 0xf7e3a0 });
  p.cyl(0x76839c, 0, 3.35, 0, 1.15, 0.92, 0.45, 8, { top: 0xb4bfd2 });
  for (let i = 0; i < 8; i += 2) {
    const a = (i / 8) * TAU + TAU / 16;
    p.box(0x8794ab, Math.cos(a) * 1.0, 3.8, Math.sin(a) * 1.0, 0.34, 0.32, 0.34, { top: 0xcbd4e2, ry: -a });
  }
  p.cyl(0x1b55b0, 0, 3.8, 0, 0.16, 0.62, 0.55, 8, { top: 0x4aa3f0 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + TAU / 8;
    p.box(0x2f9cff, Math.cos(a) * 0.9, 1.0, Math.sin(a) * 0.9, 0.14, 1.6, 0.14, { glow: true, top: 0xe2fbff, ry: -a });
  }
  p.box(0x1b55b0, 0, 1.5, 0.98, 0.56, 1.3, 0.05, { top: 0x4aa3f0, rx: 0.1 });
  p.gem(0xf7e3a0, 0, 2.55, 1.06, 0.12, 0.3, { glow: true, top: 0xffffff });
}

function direTower(p) {
  p.cyl(0x1b161f, 0, 0, 0, 1.5, 1.85, 0.4, 6, { top: 0x3a3142 });
  p.cyl(0x15121a, 0, 0.4, 0, 0.62, 1.15, 3.0, 6, { top: 0x4f4160, ry: 0.3 });
  p.cyl(0xff6a14, 0, 1.0, 0, 1.03, 1.07, 0.1, 6, { glow: true, top: 0xffd27a, ry: 0.3 });
  p.cyl(0xff6a14, 0, 2.1, 0, 0.84, 0.88, 0.09, 6, { glow: true, top: 0xffd27a, ry: 0.3 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.4;
    p.cone(0x120f16, Math.cos(a) * 1.25, 0.2, Math.sin(a) * 1.25, 0.3, 1.5 + (i % 2) * 0.5, 4, { top: 0x65527a, ...lean(a, 0.32) });
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    p.cone(0x1a1520, Math.cos(a) * 0.62, 3.2, Math.sin(a) * 0.62, 0.22, 1.5, 4, { top: 0x8a7399, ...lean(a, -0.3) });
  }
}

function radiantThrone(p) {
  p.cyl(0x8794ab, 0, 0, 0, 3.0, 3.25, 0.35, 12, { top: 0xc5cfdf });
  p.cyl(0x7b88a2, 0, 0.35, 0, 2.45, 2.65, 0.35, 12, { top: 0xbcc7da });
  p.cyl(0xc9a24a, 0, 0.7, 0, 2.0, 2.12, 0.12, 12, { top: 0xf7e3a0 });
  p.cyl(0x93a0b8, 0, 0.82, 0, 1.6, 1.85, 0.5, 8, { top: 0xdfe6f2 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + TAU / 8;
    const x = Math.cos(a) * 2.2;
    const z = Math.sin(a) * 2.2;
    p.cyl(0x93a0b8, x, 0.7, z, 0.2, 0.27, 2.0, 6, { top: 0xe6ecf7 });
    p.cyl(0xc9a24a, x, 2.7, z, 0.31, 0.22, 0.14, 6, { top: 0xf7e3a0 });
    p.gem(0x2f9cff, x, 2.88, z, 0.22, 0.75, { glow: true, top: 0xe8fcff });
  }
  p.crystal(0x1f78dc, 0, 1.3, 0, 0.8, 3.7, { glow: true, top: 0xc9f6ff });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.3;
    p.crystal(0x1a68cc, Math.cos(a) * 0.75, 1.2, Math.sin(a) * 0.75, 0.34, 1.5 + (i % 2) * 0.6, {
      glow: true,
      top: 0x9fe9ff,
      ...lean(a, 0.42),
    });
  }
  p.box(0x1b55b0, 0, 0.5, 3.02, 1.0, 0.75, 0.06, { top: 0x4aa3f0 });
  p.gem(0xf7e3a0, 0, 0.62, 3.1, 0.16, 0.42, { glow: true, top: 0xffffff });
}

function direThrone(p) {
  p.cyl(0x1a151e, 0, 0, 0, 2.95, 3.3, 0.4, 7, { top: 0x3a3044 });
  p.cyl(0xff6a14, 0, 0.4, 0, 2.6, 2.64, 0.08, 7, { glow: true, top: 0xffc45a });
  p.cyl(0x16121a, 0, 0.4, 0, 2.25, 2.5, 0.45, 7, { top: 0x45394f });
  p.cyl(0x120f15, 0, 0.85, 0, 1.45, 1.9, 0.7, 6, { top: 0x4f4160 });
  p.cyl(0xff8a24, 0, 1.55, 0, 1.2, 1.2, 0.06, 6, { glow: true, top: 0xffe28a });
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + 0.2;
    p.cone(0x100d14, Math.cos(a) * 1.95, 0.6, Math.sin(a) * 1.95, 0.44, 3.1 + (i % 2) * 0.9, 4, { top: 0x75608a, ...lean(a, 0.26) });
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.8;
    p.cone(0x18131d, Math.cos(a) * 1.0, 1.4, Math.sin(a) * 1.0, 0.3, 2.5, 4, { top: 0x8a7399, ...lean(a, -0.26) });
  }
}

function rubble(p, def) {
  const dire = def.side === 'dire';
  const random = seededRandom(def.x * 31 + def.z * 17 + 5);
  const count = def.kind === 'throne' ? 16 : 9;
  for (let i = 0; i < count; i++) {
    const a = random() * TAU;
    const d = random() * def.radius * 0.9;
    const r = 0.3 + random() * 0.45;
    p.rock(dire ? 0x15121a : 0x6f7a8f, Math.cos(a) * d, r * 0.4, Math.sin(a) * d, r, {
      top: dire ? 0x4f4160 : 0xc5cfdf,
      sy: 0.65,
      ry: random() * TAU,
    });
  }
}

function woodenBridge(p, z0) {
  const half = MAP.bridgeHalfLength;
  const arch = (x) => 0.14 + 0.26 * Math.cos((x / half) * (Math.PI / 2));
  const slope = (x) => Math.atan(-0.26 * (Math.PI / (2 * half)) * Math.sin((x / half) * (Math.PI / 2)));
  const planks = [0x6b4526, 0x7a5230, 0x5d3b20];
  const count = 15;
  for (let i = 0; i < count; i++) {
    const x = -half + ((i + 0.5) * 2 * half) / count;
    p.box(planks[i % 3], x, arch(x), z0, (2 * half) / count - 0.04, 0.1, 2.5, { top: 0xa87a48, rz: slope(x), ry: ((i * 7) % 5) * 0.012 - 0.024 });
  }
  const posts = [-2.95, -1.5, 0, 1.5, 2.95];
  for (const side of [-1, 1]) {
    const z = z0 + side * 1.16;
    for (let i = 0; i < 6; i++) {
      const x = -half + ((i + 0.5) * 2 * half) / 6;
      p.box(0x432a16, x, arch(x) - 0.16, z, (2 * half) / 6 + 0.04, 0.16, 0.18, { top: 0x6b4526, rz: slope(x) });
    }
    posts.forEach((x, i) => {
      p.box(0x52351c, x, arch(x) - 0.1, z, 0.17, 1.0, 0.17, { top: 0x94683a });
      p.box(0x3a2412, x, arch(x) + 0.9, z, 0.24, 0.08, 0.24, { top: 0x6b4526 });
      if (i === 0) return;
      const from = posts[i - 1];
      const mid = (from + x) / 2;
      const rise = arch(x) - arch(from);
      p.box(0x6b4526, mid, (arch(x) + arch(from)) / 2 + 0.66, z, Math.hypot(x - from, rise), 0.09, 0.09, {
        top: 0xa87a48,
        rz: Math.atan2(rise, x - from),
      });
    });
    for (const x of [-1.5, 1.5]) p.cyl(0x33200f, x, -0.3, z0 + side * 0.95, 0.14, 0.17, 0.75, 6, { top: 0x52351c });
  }
}

function stoneBridge(p, z0, addHalo) {
  const half = MAP.bridgeHalfLength;
  const arch = (x) => 0.42 * Math.cos((x / half) * (Math.PI / 2));
  const slope = (x) => Math.atan(-0.42 * (Math.PI / (2 * half)) * Math.sin((x / half) * (Math.PI / 2)));
  const count = 9;
  const length = (2 * half) / count;
  for (let i = 0; i < count; i++) {
    const x = -half + (i + 0.5) * length;
    const stone = i % 2 ? 0x76818f : 0x6a7483;
    p.box(stone, x, arch(x) - 0.28, z0, length + 0.03, 0.4, 2.7, { top: i % 2 ? 0xb9c2ce : 0xa9b3c0, rz: slope(x) });
    for (const side of [-1, 1]) {
      p.box(0x7d8796, x, arch(x) + 0.08, z0 + side * 1.24, length + 0.03, 0.42, 0.24, { top: 0xcfd6df, rz: slope(x) });
    }
  }
  for (const x of [-1.25, 1.25]) p.box(0x525c6b, x, -0.4, z0, 0.55, 0.6, 2.5, { top: 0x7d8796 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (half + 0.05);
      const z = z0 + sz * 1.28;
      const flame = sx < 0 ? 0x59d2ff : 0xff8a3a;
      p.box(0x687282, x, 0, z, 0.44, 1.2, 0.44, { top: 0xb5bfcd });
      p.box(0x8d97a8, x, 1.2, z, 0.58, 0.12, 0.58, { top: 0xdfe5ec });
      p.gem(flame, x, 1.36, z, 0.17, 0.46, { glow: true, top: 0xffffff });
      addHalo(x, 1.6, z, 2.0, flame, 0.5);
    }
  }
}

function runePad(p) {
  p.cyl(0x4d5d72, 0, -0.12, 0, 1.75, 2.05, 0.42, 8, { top: 0x9fb0c4 });
  // Four-sided cylinders read as diamonds from above.
  p.cyl(0x38445a, 0, 0.3, 0, 1.42, 1.5, 0.09, 4, { top: 0x6f8196 });
  p.cyl(0x39d8f2, 0, 0.39, 0, 1.2, 1.2, 0.035, 4, { glow: true, top: 0x9ff7ff });
  p.cyl(0x2a3446, 0, 0.39, 0, 1.06, 1.06, 0.05, 4, { top: 0x46546a });
  p.cyl(0x7af3ff, 0, 0.44, 0, 0.4, 0.4, 0.03, 4, { glow: true, top: 0xe6ffff });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const x = Math.cos(a) * 1.62;
    const z = Math.sin(a) * 1.62;
    p.cone(0x5e7088, x, 0.26, z, 0.17, 0.75, 4, { top: 0xcfe0ee });
    p.gem(0x7af3ff, x, 1.0, z, 0.08, 0.24, { glow: true, top: 0xffffff });
  }
  // Stepping stones from each bank.
  for (const [x, z] of [[-3.2, 0.15], [-2.55, -0.12], [2.55, 0.14], [3.2, -0.1]]) {
    p.cyl(0x66758a, x, -0.06, z, 0.3, 0.36, 0.14, 7, { top: 0xa9b8c8 });
  }
}

/**
 * A hero, built from separately hinged parts so it can stride and swing: the
 * legs pivot at the hips, the arms at the shoulders and the sword at the hand.
 * The Aether Knight wears a winged, crested helm and carries a kite shield and
 * a straight blade of light. Morgath is broader, horned and spiked, with a
 * jagged molten greatsword.
 */
function buildHero(side, solidMaterial, glowMaterial, glowTexture) {
  const radiant = side === 'radiant';
  const cloth = radiant ? [0x1648b8, 0x58b8ff] : [0x5a0c14, 0xc8381f];
  const light = radiant ? [0x59d2ff, 0xeaffff] : [0xff6a1a, 0xffe6a8];
  const steel = radiant ? [0x76849f, 0xe4eaf5] : [0x2b2433, 0x71607c];
  const dark = radiant ? [0x2c3550, 0x56627f] : [0x141118, 0x3b3044];
  const gold = radiant ? [0xb98a2c, 0xf7e3a0] : [0x7a2a14, 0xf0803a];
  const size = radiant ? 1.3 : 1.4;
  const girth = radiant ? 1 : 1.16;

  /** One hinged part: `draw` places its shapes relative to the pivot at (x, y, z). */
  const part = (x, y, z, draw) => {
    const solid = new Batch();
    const glow = new Batch();
    draw(pen(solid, glow));
    const group = new THREE.Group();
    group.position.set(x, y, z);
    if (solid.positions.length) {
      const mesh = solid.build(solidMaterial);
      mesh.castShadow = true;
      group.add(mesh);
    }
    if (glow.positions.length) group.add(glow.build(glowMaterial));
    return group;
  };

  const torso = part(0, 0, 0, (p) => {
    p.cyl(gold[0], 0, 0.66, 0, 0.33 * girth, 0.31 * girth, 0.1, 8, { top: gold[1] });
    p.cyl(steel[0], 0, 0.74, 0, 0.44 * girth, 0.31 * girth, 0.66, 8, { top: steel[1] });
    p.gem(light[0], 0, 1.0, 0.36 * girth, 0.09, 0.22, { glow: true, top: light[1] });
    p.cyl(dark[0], 0, 1.4, 0, 0.13, 0.15, 0.1, 6, { top: dark[1] });
    p.rock(steel[0], 0, 1.68, 0, 0.26, { top: radiant ? 0xf4f7ff : steel[1] });
    p.box(light[0], 0, 1.62, 0.2, 0.3, 0.07, 0.1, { glow: true, top: light[1] });
    if (radiant) {
      // Crest, helm wings and a full cape.
      p.box(cloth[0], 0, 1.86, -0.04, 0.07, 0.34, 0.5, { top: cloth[1] });
      for (const sx of [-1, 1]) {
        p.rock(steel[1], sx * 0.5, 1.36, 0, 0.23, { top: 0xffffff, sy: 0.85 });
        p.box(gold[0], sx * 0.27, 1.7, -0.06, 0.05, 0.34, 0.2, { top: gold[1], rz: -sx * 0.55 });
      }
      p.box(cloth[0], 0, 0.4, -0.46, 0.74, 1.05, 0.06, { top: cloth[1], rx: 0.22 });
    } else {
      // Horns, spiked pauldrons, a molten core and a cape in tatters.
      for (const sx of [-1, 1]) {
        p.cone(dark[1], sx * 0.2, 1.76, 0, 0.09, 0.5, 5, { top: gold[1], rz: -sx * 0.75 });
        p.rock(dark[1], sx * 0.56, 1.38, 0, 0.29, { top: steel[1], sy: 0.85 });
        p.cone(dark[0], sx * 0.62, 1.5, 0, 0.09, 0.42, 5, { top: gold[1], rz: -sx * 0.5 });
        p.cone(dark[0], sx * 0.5, 1.56, -0.12, 0.07, 0.3, 5, { top: gold[1], rz: -sx * 0.2, rx: -0.4 });
        p.box(light[0], sx * 0.16, 0.92, 0.37 * girth, 0.05, 0.3, 0.04, { glow: true, top: light[1], rz: sx * 0.35 });
      }
      [-0.26, 0, 0.26].forEach((x, i) => p.box(cloth[0], x, 0.42 + i * 0.12, -0.5, 0.22, 1.0 - i * 0.12, 0.05, { top: cloth[1], rx: 0.26 }));
    }
  });

  const legs = [1, -1].map((sx) =>
    part(sx * 0.17 * girth, 0.7, 0, (p) => {
      p.box(dark[0], 0, -0.7, 0.03, 0.24, 0.16, 0.38, { top: dark[1] });
      p.box(steel[0], 0, -0.56, 0, 0.2, 0.56, 0.24, { top: steel[1] });
    }),
  );

  // Shield arm (the hero's left, +X).
  const shieldArm = part(0.55 * girth, 1.3, 0, (p) => {
    p.box(steel[0], 0, -0.52, 0, 0.16, 0.52, 0.18, { top: steel[1] });
    if (radiant) {
      p.cyl(gold[0], 0.07, -0.3, 0.2, 0.42, 0.42, 0.05, 10, { top: gold[1], rx: Math.PI / 2 });
      p.cyl(cloth[0], 0.07, -0.3, 0.25, 0.34, 0.34, 0.04, 10, { top: cloth[1], rx: Math.PI / 2 });
    } else {
      p.cyl(dark[0], 0.07, -0.3, 0.2, 0.44, 0.44, 0.06, 7, { top: dark[1], rx: Math.PI / 2 });
      p.cone(light[0], 0.07, -0.3, 0.26, 0.13, 0.26, 5, { glow: true, top: light[1], rx: Math.PI / 2 });
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU;
        p.cone(gold[0], 0.07 + Math.cos(a) * 0.4, -0.3 + Math.sin(a) * 0.4, 0.2, 0.05, 0.2, 4, { top: gold[1], rz: a - Math.PI / 2 });
      }
    }
  });

  // Sword arm (the hero's right, -X), with the blade hinged at the hand.
  const swordArm = part(-0.55 * girth, 1.3, 0, (p) => p.box(steel[0], 0, -0.52, 0, 0.16, 0.52, 0.18, { top: steel[1] }));
  const blade = part(-0.07, -0.5, 0.14, (p) => {
    p.box(gold[0], 0, -0.1, 0, 0.08, 0.2, 0.08, { top: gold[1] });
    if (radiant) {
      p.box(gold[0], 0, 0.08, 0, 0.36, 0.07, 0.1, { top: gold[1] });
      p.box(light[0], 0, 0.14, 0, 0.12, 1.25, 0.04, { glow: true, top: light[1] });
      p.cone(light[1], 0, 1.39, 0, 0.06, 0.18, 4, { glow: true });
    } else {
      p.box(dark[0], 0, 0.08, 0, 0.46, 0.09, 0.12, { top: gold[1] });
      p.box(dark[0], 0, 0.16, 0, 0.1, 1.3, 0.07, { top: dark[1] });
      p.box(light[0], 0, 0.16, 0, 0.24, 1.36, 0.04, { glow: true, top: light[1] });
      p.cone(light[1], 0, 1.52, 0, 0.12, 0.3, 4, { glow: true });
      // Barbs down both edges.
      for (const [y, sx] of [[0.5, 1], [0.78, -1], [1.06, 1], [1.3, -1]]) {
        p.cone(light[0], sx * 0.12, y, 0, 0.07, 0.22, 4, { glow: true, top: light[1], rz: -sx * 1.2 });
      }
    }
  });
  swordArm.add(blade);

  const body = new THREE.Group();
  body.add(torso, ...legs, shieldArm, swordArm);
  body.rotation.y = radiant ? 0.75 : -0.75;
  body.scale.setScalar(size);

  // Team ring: four arcs that slowly turn under the hero's feet.
  const arcs = new Batch();
  const flat = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    const arc = new THREE.RingGeometry(0.86, 1.02, 10, 1, (i / 4) * TAU + 0.18, TAU / 4 - 0.36);
    arcs.add(arc, flat, TEAM_COLOR[side]);
    arc.dispose();
  }
  const ring = arcs.build(
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.position.y = 0.06;

  // A soft contact shadow under the real one, so the feet never look detached.
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glowTexture, color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
  );
  shadow.position.y = 0.04;

  const group = new THREE.Group();
  group.add(shadow, ring, body);
  return { group, body, ring, legs, shieldArm, swordArm, blade, size };
}

/** Trees, crystals, rocks and the rim that frames the arena. */
function scatterScenery(p, addHalo) {
  const random = seededRandom(20_261_117);
  const taken = [];
  const free = (x, z, gap) => taken.every(([tx, tz, tg]) => Math.hypot(x - tx, z - tz) > gap + tg);
  const clear = (x, z, pad) =>
    pathDistance(x, z) > pad &&
    riverDistance(x, z) > pad + 0.3 &&
    STRUCTURES.every((s) => Math.hypot(x - s.x, z - s.z) > s.radius + pad + 1);
  const inside = (x, z) => Math.abs(x) < MAP.halfWidth + 0.4 && Math.abs(z) < MAP.halfDepth + 0.4;

  // `openField` is the chance a prop may stand inside the playable area, which stays mostly clear.
  const scatter = (count, sign, gap, pad, openField, build) => {
    let made = 0;
    for (let tries = 0; tries < count * 60 && made < count; tries++) {
      const x = sign * (3.4 + random() * 22.6);
      const z = (random() * 2 - 1) * 15.6;
      if (!clear(x, z, pad) || !free(x, z, gap)) continue;
      if (inside(x, z) && random() > openField) continue;
      taken.push([x, z, gap]);
      build(x, z);
      made++;
    }
  };

  // --- Radiant: forest, bushes, boulders and blue crystal outcrops.
  scatter(11, -1, 0.7, 1.3, 0.8, (x, z) => {
    const s = 0.8 + random() * 0.6;
    const count = 3 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const a = random() * TAU;
      const d = i === 0 ? 0 : (0.25 + random() * 0.25) * s;
      const h = (i === 0 ? 1.6 : 0.6 + random() * 0.7) * s;
      p.crystal(0x1a68cc, x + Math.cos(a) * d, -0.05, z + Math.sin(a) * d, (i === 0 ? 0.2 : 0.14) * s, h, {
        glow: true,
        top: 0xb9f4ff,
        ...lean(a, i === 0 ? 0.08 : 0.3 + random() * 0.3),
      });
    }
    addHalo(x, 0.9 * s, z, 3.4 * s, 0x3fb8ff, 0.42);
  });
  scatter(66, -1, 0.75, 1.6, 0.13, (x, z) => {
    const s = 0.8 + random() * 0.7;
    const ry = random() * TAU;
    const dark = [0x0f5a34, 0x147046, 0x0d6b4f][Math.floor(random() * 3)];
    p.cyl(0x4a3020, x, 0, z, 0.1 * s, 0.15 * s, 0.5 * s, 5, { top: 0x6b4830 });
    if (random() < 0.72) {
      p.cone(dark, x, 0.35 * s, z, 0.8 * s, 1.1 * s, 7, { top: 0x2f9c5c, ry });
      p.cone(dark, x, 0.95 * s, z, 0.62 * s, 1.0 * s, 7, { top: 0x45b96e, ry: ry + 0.4 });
      p.cone(dark, x, 1.5 * s, z, 0.42 * s, 0.9 * s, 7, { top: 0x7fe0a0, ry: ry + 0.8 });
    } else {
      p.rock(dark, x, 1.15 * s, z, 0.85 * s, { top: 0x6fd690, ry, sy: 0.9 });
      p.rock(dark, x + 0.4 * s, 0.85 * s, z + 0.2 * s, 0.5 * s, { top: 0x55c47c, ry });
    }
  });
  scatter(26, -1, 0.4, 1.0, 0.5, (x, z) => {
    const r = 0.26 + random() * 0.26;
    p.rock(0x17703f, x, r * 0.5, z, r, { top: 0x62cf83, sy: 0.75, ry: random() * TAU });
  });
  scatter(16, -1, 0.5, 1.0, 0.45, (x, z) => {
    const r = 0.3 + random() * 0.4;
    p.rock(0x5d687b, x, r * 0.35, z, r, { top: 0xb7c1d0, sy: 0.7, ry: random() * TAU });
  });

  // --- Dire: obsidian shards, molten crystals, charred trees and slag.
  scatter(10, 1, 0.7, 1.3, 0.8, (x, z) => {
    const s = 0.8 + random() * 0.6;
    const count = 3 + Math.floor(random() * 2);
    for (let i = 0; i < count; i++) {
      const a = random() * TAU;
      const d = i === 0 ? 0 : (0.25 + random() * 0.25) * s;
      const h = (i === 0 ? 1.3 : 0.5 + random() * 0.6) * s;
      p.crystal(0xd8320e, x + Math.cos(a) * d, -0.05, z + Math.sin(a) * d, (i === 0 ? 0.2 : 0.14) * s, h, {
        glow: true,
        top: 0xffd27a,
        ...lean(a, i === 0 ? 0.1 : 0.3 + random() * 0.3),
      });
    }
    addHalo(x, 0.8 * s, z, 3.4 * s, 0xff5a1a, 0.42);
  });
  scatter(50, 1, 0.6, 1.5, 0.16, (x, z) => {
    const s = 0.7 + random() * 0.9;
    const a = random() * TAU;
    p.cone(0x0f0c13, x, -0.1, z, 0.34 * s, 2.0 * s, 4, { top: 0x6a5880, ...lean(a, random() * 0.3) });
    if (random() < 0.6) {
      p.cone(0x120f16, x + Math.cos(a) * 0.45 * s, -0.1, z + Math.sin(a) * 0.45 * s, 0.24 * s, 1.1 * s, 4, {
        top: 0x57466a,
        ...lean(a, 0.35 + random() * 0.2),
      });
    }
  });
  scatter(9, 1, 0.7, 1.5, 0.3, (x, z) => {
    const s = 0.9 + random() * 0.5;
    p.cyl(0x1a1216, x, 0, z, 0.07 * s, 0.17 * s, 1.9 * s, 5, { top: 0x45343a, rz: (random() - 0.5) * 0.2 });
    for (let i = 0; i < 3; i++) {
      const a = random() * TAU;
      p.cyl(0x1a1216, x, (0.9 + i * 0.35) * s, z, 0.03 * s, 0.06 * s, 0.8 * s, 4, { top: 0x45343a, ...lean(a, 0.9) });
    }
  });
  scatter(22, 1, 0.5, 1.0, 0.45, (x, z) => {
    const r = 0.3 + random() * 0.45;
    p.rock(0x15121a, x, r * 0.35, z, r, { top: 0x4a3d58, sy: 0.7, ry: random() * TAU });
  });

  // --- Rim: a broken wall of rock around the playable field.
  const edgeX = MAP.halfWidth + 0.8;
  const edgeZ = MAP.halfDepth + 0.8;
  const rim = (x, z) => {
    if (riverDistance(x, z) < 1.2) return;
    const dire = x > riverCenter(z);
    const r = 0.45 + random() * 0.5;
    const jx = x + (random() - 0.5) * 0.5;
    const jz = z + (random() - 0.5) * 0.5;
    p.rock(dire ? 0x110e15 : 0x4f5a6c, jx, r * 0.3, jz, r, { top: dire ? 0x54445f : 0xaab5c4, sy: 0.8 + random() * 0.5, ry: random() * TAU });
    if (dire && random() < 0.4) p.cone(0x0f0c13, jx, 0, jz, 0.26, 1.2 + random(), 4, { top: 0x6a5880, ...lean(random() * TAU, 0.2) });
    if (!dire && random() < 0.3) p.rock(0x17703f, jx + 0.3, r * 0.9, jz, r * 0.45, { top: 0x62cf83 });
  };
  for (let x = -edgeX; x <= edgeX; x += 1.25) {
    rim(x, -edgeZ);
    rim(x, edgeZ);
  }
  for (let z = -edgeZ + 1.25; z < edgeZ; z += 1.25) {
    rim(-edgeX, z);
    rim(edgeX, z);
  }
}

function buildParticles() {
  const random = seededRandom(77);
  const count = 760;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const rises = new Float32Array(count);
  const color = new THREE.Color();
  const mix = (from, to, t) => color.setHex(from, THREE.LinearSRGBColorSpace).lerp(TINT.setHex(to, THREE.LinearSRGBColorSpace), t);

  for (let i = 0; i < count; i++) {
    const z = (random() * 2 - 1) * 15;
    let x;
    let y = 0.2 + random() * 1.4;
    let speed;
    let sway;
    let size;
    if (i < 150) {
      // Radiant motes: slow, drifting, blue-green.
      x = -2.8 - random() * 23;
      speed = 0.05 + random() * 0.07;
      sway = 0.3 + random() * 0.5;
      size = 0.1 + random() * 0.12;
      rises[i] = 3 + random() * 2;
      mix(0x8fe8ff, 0xcfffd8, random());
    } else if (i < 330) {
      // Dire embers: faster, hotter.
      x = 2.8 + random() * 23;
      speed = 0.12 + random() * 0.18;
      sway = 0.15 + random() * 0.35;
      size = 0.07 + random() * 0.1;
      rises[i] = 4 + random() * 3;
      mix(0xff5a1a, 0xffc04a, random());
    } else if (i < 480) {
      // Fireflies over the Radiant woods: they wander at head height and blink rather than rise.
      x = -3.5 - random() * 21;
      y = 0.8 + random() * 3.6;
      speed = 0.02 + random() * 0.03;
      sway = 1.1 + random() * 1.6;
      size = 0.13 + random() * 0.12;
      rises[i] = (random() - 0.5) * 1.2;
      mix(0xd8ff7a, 0xfff2a0, random());
    } else if (i < 650) {
      // Embers carried high over the Dire wastes, well above the units.
      x = 3 + random() * 22;
      y = 1 + random() * 3;
      speed = 0.06 + random() * 0.1;
      sway = 0.5 + random() * 0.9;
      size = 0.09 + random() * 0.14;
      rises[i] = 6 + random() * 6;
      mix(0xff3a10, 0xffb040, random());
    } else {
      // River sparkles: low over the water.
      x = riverCenter(z) + (random() - 0.5) * 3.6;
      y = 0.1;
      speed = 0.15 + random() * 0.2;
      sway = 0.1;
      size = 0.08 + random() * 0.08;
      rises[i] = 0.8 + random() * 0.8;
      mix(0xa8fbff, 0xffffff, random() * 0.5);
    }
    positions.set([x, y, z], i * 3);
    seeds.set([speed, sway, random(), size], i * 4);
    colors.set([color.r, color.g, color.b], i * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aRise', new THREE.BufferAttribute(rises, 1));
  const uniforms = { uTime: { value: 0 }, uPixels: { value: 30 } };
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  // The vertex shader moves points outside the bounds Three.js would compute.
  points.frustumCulled = false;
  return { points, uniforms };
}

function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* -------------------------------------------------------------------------- */
/* Battlefield                                                                */
/* -------------------------------------------------------------------------- */

export function createBattlefield(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(VOID_COLOR, 1);
  // Units and heroes move, so the shadow map is redrawn every frame.
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 2, 400);
  camera.position.set(0, SIN_P * 70, COS_P * 70);
  camera.lookAt(0, 0, 0);

  // The frame is drawn in linear HDR, bloomed, then converted for the screen.
  // A GPU without float render targets draws the scene directly instead.
  let composer = null;
  let bloomPass = null;
  if (renderer.extensions.has('EXT_color_buffer_float')) {
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.3, 0.9);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }
  const render = () => (composer ? composer.render() : renderer.render(scene, camera));

  scene.add(new THREE.HemisphereLight(0xdbeaff, 0x2a2233, 1.0));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.9);
  sun.position.copy(LIGHT_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 22, bottom: -22, near: 1, far: 140 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const solidMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.04 });
  const glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  glowMaterial.color.setScalar(GLOW_BOOST);

  // Glows are added in linear light, where a soft falloff spreads far wider than it does on screen.
  // These ramps are the on-screen ones raised to the display gamma; the bloom pass supplies the outer haze.
  const glowTexture = canvasTexture(128, 128, (g, w) => {
    const gradient = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.18, 'rgba(255, 255, 255, 0.46)');
    gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.16)');
    gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.04)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = gradient;
    g.fillRect(0, 0, w, w);
  });
  const beamTexture = canvasTexture(64, 256, (g, w, h) => {
    const rise = g.createLinearGradient(0, h, 0, 0);
    rise.addColorStop(0, 'rgba(255, 255, 255, 1)');
    rise.addColorStop(0.35, 'rgba(255, 255, 255, 0.3)');
    rise.addColorStop(0.7, 'rgba(255, 255, 255, 0.06)');
    rise.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = rise;
    g.fillRect(0, 0, w, h);
    const across = g.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(255, 255, 255, 0)');
    across.addColorStop(0.25, 'rgba(255, 255, 255, 0.2)');
    across.addColorStop(0.5, 'rgba(255, 255, 255, 1)');
    across.addColorStop(0.75, 'rgba(255, 255, 255, 0.2)');
    across.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = across;
    g.fillRect(0, 0, w, h);
  });

  /* ---------------------------------------------------------------- Terrain */

  const bakeWidth = Math.min(4096, renderer.capabilities.maxTextureSize);
  const terrainTarget = new THREE.WebGLRenderTarget(bakeWidth, Math.round((bakeWidth * GROUND_D) / GROUND_W), {
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  terrainTarget.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  {
    const bakeMaterial = new THREE.ShaderMaterial({
      vertexShader: BAKE_VERTEX,
      fragmentShader: BAKE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMaterial);
    quad.frustumCulled = false;
    renderer.setRenderTarget(terrainTarget);
    renderer.render(quad, camera);
    renderer.setRenderTarget(null);
    quad.geometry.dispose();
    bakeMaterial.dispose();
  }

  const terrainUniforms = {
    uMap: { value: terrainTarget.texture },
    uTime: { value: 0 },
    uVoid: { value: new THREE.Color().setHex(VOID_COLOR, THREE.LinearSRGBColorSpace) },
  };
  const groundGeometry = new THREE.PlaneGeometry(GROUND_W, GROUND_D).rotateX(-Math.PI / 2);
  scene.add(
    new THREE.Mesh(
      groundGeometry,
      new THREE.ShaderMaterial({ uniforms: terrainUniforms, vertexShader: TERRAIN_VERTEX, fragmentShader: TERRAIN_FRAGMENT }),
    ),
  );
  // The terrain shader is unlit, so a transparent catcher just above it shows the shadows.
  const shadowCatcher = new THREE.Mesh(groundGeometry, new THREE.ShadowMaterial({ color: 0x02040a, opacity: 0.6, depthWrite: false }));
  shadowCatcher.position.y = 0.02;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  /* ---------------------------------------------------------------- Halos */

  const halos = [];
  function addHalo(x, y, z, size, color, opacity = 0.6) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    // Nudged towards the camera so the glow blooms over its source.
    sprite.position.set(x, y + SIN_P * 0.7, z + COS_P * 0.7);
    sprite.scale.setScalar(size);
    scene.add(sprite);
    halos.push({ sprite, size, opacity, phase: halos.length * 1.7 });
    return sprite;
  }

  /* ---------------------------------------------------------------- Scenery */

  {
    const solid = new Batch();
    const glow = new Batch();
    const p = pen(solid, glow);
    woodenBridge(p, -MAP.laneZ);
    stoneBridge(p, MAP.laneZ, addHalo);
    runePad(p);
    scatterScenery(p, addHalo);
    const props = solid.build(solidMaterial);
    props.castShadow = true;
    props.receiveShadow = true;
    scene.add(props, glow.build(glowMaterial));
  }

  /* ---------------------------------------------------------------- Structures */

  const structures = new Map();
  for (const def of STRUCTURES) {
    const radiant = def.side === 'radiant';
    const throne = def.kind === 'throne';
    const solid = new Batch();
    const glow = new Batch();
    const p = pen(solid, glow);
    if (throne) (radiant ? radiantThrone : direThrone)(p);
    else (radiant ? radiantTower : direTower)(p);

    const floatBatch = new Batch();
    const fp = pen(floatBatch, floatBatch);
    if (radiant) fp.gem(0x1668d8, 0, throne ? -0.8 : -0.7, 0, throne ? 0.5 : 0.46, throne ? 1.6 : 1.4, { glow: true, top: 0x9fe9ff });
    else fp.rock(0xff4a10, 0, 0, 0, throne ? 0.85 : 0.44, { glow: true, top: 0xffe28a });
    const floater = floatBatch.build(glowMaterial);
    const floatY = throne ? (radiant ? 6.1 : 3.9) : radiant ? 4.85 : 4.75;

    const body = solid.build(solidMaterial);
    body.castShadow = true;
    body.receiveShadow = true;
    const group = new THREE.Group();
    group.position.set(def.x, 0, def.z);
    group.add(body, glow.build(glowMaterial), floater);

    const rubbleBatch = new Batch();
    rubble(pen(rubbleBatch, rubbleBatch), def);
    const ruins = rubbleBatch.build(solidMaterial);
    ruins.position.set(def.x, 0, def.z);
    ruins.castShadow = true;
    ruins.receiveShadow = true;
    ruins.visible = false;
    scene.add(group, ruins);

    // A faint circle on the ground shows how far the structure can fire.
    const range = new THREE.Mesh(
      new THREE.RingGeometry(def.range - 0.07, def.range, 96).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: TEAM_COLOR[def.side], transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }),
    );
    range.position.set(def.x, 0.06, def.z);
    scene.add(range);

    const halo = addHalo(def.x, floatY, def.z, throne ? 7.5 : 4.2, radiant ? 0x2f9cff : 0xff5a1a, radiant ? 0.34 : 0.5);
    structures.set(def.id, { def, group, floater, floatY, ruins, halo, range, atk: -1, shake: 0, collapse: -1, phase: structures.size * 1.3 });
  }

  /* ---------------------------------------------------------------- Heroes and rune */

  const heroes = {};
  for (const side of ['radiant', 'dire']) {
    const hero = buildHero(side, solidMaterial, glowMaterial, glowTexture);
    const spawn = heroSpawn(side);
    hero.group.position.set(spawn.x, 0, spawn.z);
    scene.add(hero.group);
    heroes[side] = hero;
  }

  const runeRing = new THREE.Mesh(
    new THREE.RingGeometry(1.86, 1.96, 4).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7af3ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  runeRing.position.y = 0.5;
  scene.add(runeRing);
  const padHalo = addHalo(0, 0.6, 0, 6, 0x4fe6ff, 0.45);

  // One floating gem per rune kind; only the kind waiting on the pad is shown.
  const runeGems = {};
  for (const [kind, low, high] of [['damage', 0xffa41a, 0xfff6c8], ['haste', 0x2fe08a, 0xe6fff2], ['regen', 0x8a5cff, 0xf0e6ff]]) {
    const batch = new Batch();
    pen(batch, batch).gem(low, 0, -0.55, 0, 0.42, 1.1, { glow: true, top: high });
    runeGems[kind] = batch.build(glowMaterial);
    scene.add(runeGems[kind]);
  }
  const runeBeam = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: beamTexture, color: RUNE_COLOR.damage, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  runeBeam.center.set(0.5, 0);
  runeBeam.scale.set(1.5, 6, 1);
  runeBeam.position.set(0, 0.45, 0);
  const runeHalo = addHalo(0, 1.6, 0, 4.2, RUNE_COLOR.damage, 0.7);
  scene.add(runeBeam);

  // Where the hero has been told to walk: a green ring that stays until it arrives.
  const waypoint = new THREE.Group();
  {
    const green = { color: 0x6dffa8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide };
    waypoint.add(
      new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ ...green, opacity: 0.9 })),
      new THREE.Mesh(new THREE.RingGeometry(0.78, 0.84, 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ ...green, opacity: 0.55 })),
      new THREE.Mesh(new THREE.CircleGeometry(0.14, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ ...green, opacity: 0.9 })),
    );
    waypoint.visible = false;
    waypoint.renderOrder = 4;
    scene.add(waypoint);
  }

  const particles = buildParticles();
  scene.add(particles.points);

  /* ---------------------------------------------------------------- Deploy preview */

  // A glowing placement circle that follows the cursor while a card is armed:
  // green rim over a blue fill where the card may land, red where it may not.
  const previewMaterial = (opacity, blending = THREE.AdditiveBlending) =>
    new THREE.MeshBasicMaterial({ transparent: true, opacity, blending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const previewRing = new THREE.Mesh(new THREE.RingGeometry(0.87, 1, 72).rotateX(-Math.PI / 2), previewMaterial(1));
  const previewHalo = new THREE.Mesh(new THREE.RingGeometry(1, 1.3, 72).rotateX(-Math.PI / 2), previewMaterial(0.4));
  const previewDisc = new THREE.Mesh(new THREE.CircleGeometry(0.87, 48).rotateX(-Math.PI / 2), previewMaterial(0.38));
  // Shades the part of the field where troops and buildings cannot be placed.
  const forbidden = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), previewMaterial(0.2, THREE.NormalBlending));
  forbidden.material.color.set(0xff3030);
  const previewParts = [forbidden, previewDisc, previewHalo, previewRing];
  let previewRadius = 1;
  for (const mesh of previewParts) {
    mesh.visible = false;
    mesh.renderOrder = 5;
    scene.add(mesh);
  }

  /* ---------------------------------------------------------------- Effects */

  const fxGroup = new THREE.Group();
  scene.add(fxGroup);
  const ringGeometry = new THREE.RingGeometry(0.88, 1, 56).rotateX(-Math.PI / 2);
  const effects = [];

  /** `update(k, dt)` runs every frame with k from 0 to 1; `done` cleans up. */
  function effect(duration, update, done, delay = 0) {
    effects.push({ age: -delay, duration, update, done });
  }

  /**
   * Whether new effects should be skipped: the view is not being drawn (a hidden
   * tab keeps receiving snapshots) or too many are already alive. Without this a
   * minute in the background would return as one enormous burst.
   */
  const muted = () => effects.length > 600 || performance.now() - lastTime > 1_500;

  function additive(color, opacity = 1) {
    return { color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false };
  }

  function ring(x, z, color, from, to, duration, delay = 0) {
    if (muted()) return;
    const mesh = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ ...additive(color, 0), side: THREE.DoubleSide }));
    mesh.position.set(x, 0.08, z);
    mesh.visible = false;
    fxGroup.add(mesh);
    effect(
      duration,
      (k) => {
        mesh.visible = true;
        mesh.scale.setScalar(from + (to - from) * easeOut(k));
        mesh.material.opacity = (1 - k) * 0.95;
      },
      () => {
        fxGroup.remove(mesh);
        mesh.material.dispose();
      },
      delay,
    );
  }

  function flash(x, y, z, color, size, duration, delay = 0) {
    if (muted()) return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(color, 0) }));
    sprite.position.set(x, y + SIN_P, z + COS_P);
    fxGroup.add(sprite);
    effect(
      duration,
      (k) => {
        sprite.scale.setScalar(size * (0.4 + 0.6 * easeOut(k)));
        sprite.material.opacity = 1 - k * k;
      },
      () => {
        fxGroup.remove(sprite);
        sprite.material.dispose();
      },
      delay,
    );
  }

  /** A pillar of light. Sprites stay upright on screen, so height is scaled by the camera pitch. */
  function beam(x, z, color, width, height, duration, delay = 0) {
    if (muted()) return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: beamTexture, ...additive(color, 0) }));
    sprite.center.set(0.5, 0);
    sprite.position.set(x, 0.05, z);
    fxGroup.add(sprite);
    effect(
      duration,
      (k) => {
        sprite.scale.set(width * (1 - 0.5 * k), height * COS_P * (0.6 + 0.4 * easeOut(k)), 1);
        sprite.material.opacity = Math.sin(Math.min(1, k * 4) * (Math.PI / 2)) * (1 - k);
      },
      () => {
        fxGroup.remove(sprite);
        sprite.material.dispose();
      },
      delay,
    );
  }

  function sparks(x, y, z, color, count, speed, duration, size = 0.36) {
    if (muted()) return;
    const material = new THREE.SpriteMaterial({ map: glowTexture, ...additive(color) });
    const bits = Array.from({ length: count }, () => {
      const sprite = new THREE.Sprite(material);
      const angle = Math.random() * TAU;
      const spread = speed * (0.35 + Math.random() * 0.65);
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(size * (0.6 + Math.random() * 0.8));
      fxGroup.add(sprite);
      return { sprite, vx: Math.cos(angle) * spread, vy: speed * (0.5 + Math.random()), vz: Math.sin(angle) * spread };
    });
    effect(
      duration,
      (k, dt) => {
        material.opacity = 1 - k * k;
        for (const bit of bits) {
          bit.vy -= 9 * dt;
          bit.sprite.position.x += bit.vx * dt;
          bit.sprite.position.y = Math.max(0.05, bit.sprite.position.y + bit.vy * dt);
          bit.sprite.position.z += bit.vz * dt;
        }
      },
      () => {
        for (const bit of bits) fxGroup.remove(bit.sprite);
        material.dispose();
      },
    );
  }

  function explosion(x, z, radius) {
    flash(x, 0.8, z, 0xfff0b0, radius * 2.4, 0.4);
    flash(x, 0.8, z, 0xff6a14, radius * 4, 0.7);
    ring(x, z, 0xffffff, 0.3, radius * 0.9, 0.3);
    ring(x, z, 0xffb040, 0.3, radius, 0.55);
    ring(x, z, 0xff5a14, 0.2, radius * 1.35, 0.85, 0.06);
    sparks(x, 0.5, z, 0xffa033, 22, 7, 0.9, 0.42);
  }

  /** Motes that drift upwards and fade: healing light, or the sparks of a burning pillar when `speed` is high. */
  function rise(x, z, radius, color, count, duration, speed = 1) {
    if (muted()) return;
    const material = new THREE.SpriteMaterial({ map: glowTexture, ...additive(color) });
    const bits = Array.from({ length: count }, () => {
      const sprite = new THREE.Sprite(material);
      const angle = Math.random() * TAU;
      const reach = Math.sqrt(Math.random()) * radius;
      sprite.position.set(x + Math.cos(angle) * reach, 0.1 + Math.random() * 0.7, z + Math.sin(angle) * reach);
      sprite.scale.setScalar(0.25 + Math.random() * 0.3);
      fxGroup.add(sprite);
      return { sprite, speed: (1.4 + Math.random() * 2.2) * speed };
    });
    effect(
      duration,
      (k, dt) => {
        material.opacity = Math.sin(Math.min(1, k * 5) * (Math.PI / 2)) * (1 - k * k);
        for (const bit of bits) bit.sprite.position.y += bit.speed * dt;
      },
      () => {
        for (const bit of bits) fxGroup.remove(bit.sprite);
        material.dispose();
      },
    );
  }

  /** Projectile looks. Their materials are shared by every bolt in flight and never disposed. */
  const BOLTS = {
    energy: { color: 0x3fa8ff, core: 0xeaffff, size: 1.7 },
    magma: { color: 0xff5a14, core: 0xffe9a0, size: 1.9 },
    arcane: { color: 0x4f8cff, core: 0xdfeaff, size: 1.15 },
    boltRadiant: { color: 0x59d2ff, core: 0xffffff, size: 0.8 },
    boltDire: { color: 0xff7a3a, core: 0xfff0c0, size: 0.8 },
  };
  for (const style of Object.values(BOLTS)) {
    style.head = new THREE.SpriteMaterial({ map: glowTexture, ...additive(style.color) });
    style.heart = new THREE.SpriteMaterial({ map: glowTexture, ...additive(style.core) });
    style.tail = new THREE.SpriteMaterial({ map: glowTexture, ...additive(style.color, 0.45) });
  }

  /**
   * A glowing projectile that homes on a moving target. `aim()` returns the
   * target's current position, or null once it is gone; the bolt then finishes
   * its flight to the last place it saw.
   */
  function bolt(kind, from, aim, speed) {
    const goal = muted() ? null : aim();
    if (!goal) return;
    const style = BOLTS[kind];
    const head = new THREE.Sprite(style.head);
    const heart = new THREE.Sprite(style.heart);
    // Small bolts fly in numbers, so they get a shorter trail and no muzzle flash.
    const small = style.size < 1;
    const tails = Array.from({ length: small ? 1 : 2 }, () => new THREE.Sprite(style.tail));
    head.scale.setScalar(style.size);
    heart.scale.setScalar(style.size * 0.45);
    tails.forEach((tail, i) => tail.scale.setScalar(style.size * (0.75 - i * 0.22)));

    const at = new THREE.Vector3(from.x, from.y, from.z);
    const heading = new THREE.Vector3(goal.x - at.x, goal.y - at.y, goal.z - at.z).normalize();
    const place = () => {
      head.position.copy(at);
      heart.position.set(at.x, at.y + SIN_P * 0.15, at.z + COS_P * 0.15);
      tails.forEach((tail, i) => tail.position.copy(at).addScaledVector(heading, -(i + 1) * style.size * 0.38));
    };
    place();
    fxGroup.add(...tails, head, heart);
    if (!small) flash(from.x, from.y, from.z, style.color, style.size * 1.5, 0.18);

    effect(
      4,
      (_k, dt) => {
        Object.assign(goal, aim());
        heading.set(goal.x - at.x, goal.y - at.y, goal.z - at.z);
        const gap = heading.length();
        if (gap <= speed * dt) return true;
        at.addScaledVector(heading.divideScalar(gap), speed * dt);
        place();
        return false;
      },
      () => {
        fxGroup.remove(head, heart, ...tails);
        flash(goal.x, goal.y, goal.z, style.color, style.size * 1.8, 0.22);
        if (style.size > 1.4) sparks(goal.x, goal.y, goal.z, style.core, 5, 3, 0.35, 0.25);
      },
    );
  }

  const rayTexture = canvasTexture(64, 4, (g, w, h) => {
    const across = g.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(255, 255, 255, 0)');
    across.addColorStop(0.25, 'rgba(255, 255, 255, 0.2)');
    across.addColorStop(0.5, 'rgba(255, 255, 255, 1)');
    across.addColorStop(0.75, 'rgba(255, 255, 255, 0.2)');
    across.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = across;
    g.fillRect(0, 0, w, h);
  });
  const VIEW_DIR = new THREE.Vector3();

  /** A straight beam between two points, drawn as a ribbon that faces the camera. */
  function ray(from, to, color, width, duration) {
    if (muted()) return;
    VIEW_DIR.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2).sub(camera.position);
    const across = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z)
      .cross(VIEW_DIR)
      .normalize()
      .multiplyScalar(width / 2);
    const corners = [
      [from, -1],
      [from, 1],
      [to, 1],
      [to, -1],
    ].flatMap(([p, s]) => [p.x + across.x * s, p.y + across.y * s, p.z + across.z * s]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: rayTexture, ...additive(color), side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    fxGroup.add(mesh);
    effect(
      duration,
      (k) => {
        mesh.material.opacity = 1 - k * k;
      },
      () => {
        fxGroup.remove(mesh);
        geometry.dispose();
        mesh.material.dispose();
      },
    );
  }

  /** A Golem's fists hitting the ground: shockwave rings and flying rubble, after `delay` seconds. */
  function slam(x, z, color, delay) {
    ring(x, z, 0xd8c8a8, 0.3, 2.6, 0.5, delay);
    ring(x, z, color, 0.2, 3.4, 0.7, delay + 0.05);
    flash(x, 0.5, z, color, 5, 0.35, delay);
    effect(0.01, () => {}, () => sparks(x, 0.3, z, 0xb9ad98, 12, 5, 0.6, 0.34), delay);
  }

  /** A meteor that arcs from the caster's Throne onto the marked target circle. */
  function fireball(side, to, radius, travel) {
    const throne = STRUCTURES.find((s) => s.side === side && s.kind === 'throne');
    const from = { x: throne.x, y: throne.height, z: throne.z };
    const target = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ ...additive(0xff7a1a, 0), side: THREE.DoubleSide }));
    target.position.set(to.x, 0.1, to.z);
    target.scale.setScalar(radius);
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(0xffa033) }));
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(0xfff6d0) }));
    head.scale.setScalar(3.6);
    core.scale.setScalar(1.5);
    fxGroup.add(target, head, core);
    flash(from.x, from.y, from.z, 0xffa033, 6, 0.4);

    let trail = 0;
    effect(
      travel,
      (k, dt) => {
        const x = from.x + (to.x - from.x) * k;
        const z = from.z + (to.z - from.z) * k;
        const y = from.y + (0.4 - from.y) * k + Math.sin(k * Math.PI) * 6;
        head.position.set(x, y, z);
        core.position.set(x, y + SIN_P * 0.2, z + COS_P * 0.2);
        target.material.opacity = 0.35 + 0.5 * k;
        trail += dt;
        if (trail > 0.025) {
          trail = 0;
          flash(x, y - SIN_P, z - COS_P, 0xff6a14, 2, 0.4);
        }
      },
      () => {
        fxGroup.remove(target, head, core);
        for (const sprite of [target, head, core]) sprite.material.dispose();
        explosion(to.x, to.z, radius);
      },
    );
  }

  /* ---------------------------------------------------------------- Hero abilities */

  /** A colour pushed past white, so the bloom pass makes it glow. */
  const hot = (hex, boost = 1.6) => new THREE.Color(hex).multiplyScalar(boost);

  // A crescent that brightens from its tail to its leading edge. With additive
  // blending black is invisible, so the gradient lives in the vertex colours.
  const SLASH_SWEEP = 1.7;
  const slashGeometry = (() => {
    const segments = 26;
    const positions = [];
    const colors = [];
    const index = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = SLASH_SWEEP * (0.5 - t);
      const inner = 1 - 0.36 * Math.sin(Math.PI * t) ** 0.7;
      const glow = t ** 1.6;
      positions.push(Math.cos(angle) * inner, Math.sin(angle) * inner, 0, Math.cos(angle), Math.sin(angle), 0);
      colors.push(0, 0, 0, glow, glow, glow);
      if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2 + 1, i * 2 - 2, i * 2 + 1, i * 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(index);
    return geometry;
  })();

  /**
   * A sword cut: a crescent of light swept round in front of a hero facing
   * `facing`. The cut lies flat, so the camera above always sees its full arc;
   * `cant` tips it off level (positive sweeps left to right, negative right to left).
   */
  function slash(x, y, z, facing, color, size, cant) {
    if (muted()) return;
    // Local X points the way the hero faces. The crescent is modelled upright and laid over onto its side.
    const holder = new THREE.Group();
    holder.position.set(x, y, z);
    holder.rotation.y = facing - Math.PI / 2;
    const plane = new THREE.Group();
    plane.rotation.x = cant - Math.sign(cant) * (Math.PI / 2);
    const outer = new THREE.Mesh(slashGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, ...additive(hot(color, 2.2), 0), side: THREE.DoubleSide }));
    const core = new THREE.Mesh(slashGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, ...additive(hot(0xfff8e0, 1.6), 0), side: THREE.DoubleSide }));
    outer.scale.setScalar(size);
    core.scale.setScalar(size * 0.93);
    plane.add(outer, core);
    holder.add(plane);
    holder.visible = false;
    fxGroup.add(holder);
    effect(
      0.28,
      (k) => {
        holder.visible = true;
        // The leading edge travels from behind one shoulder, across the front, and past the other.
        const turn = 2.75 - 2.6 * easeOut(k);
        outer.rotation.z = core.rotation.z = turn;
        outer.material.opacity = Math.sin(Math.min(1, k * 3) * (Math.PI / 2)) * (1 - k * k);
        core.material.opacity = outer.material.opacity * 0.8;
      },
      () => {
        fxGroup.remove(holder);
        outer.material.dispose();
        core.material.dispose();
      },
    );
  }

  /** A camera-facing ribbon through `points` ([x, y, z] each): one stroke of lightning. */
  function ribbonGeometry(points, width) {
    const positions = [];
    const uvs = [];
    const index = [];
    const last = points.length - 1;
    points.forEach((point, i) => {
      const before = points[Math.max(0, i - 1)];
      const after = points[Math.min(last, i + 1)];
      EDGE.set(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
      VIEW_DIR.set(point[0], point[1], point[2]).sub(camera.position);
      EDGE.cross(VIEW_DIR).normalize().multiplyScalar(width / 2);
      positions.push(point[0] - EDGE.x, point[1] - EDGE.y, point[2] - EDGE.z, point[0] + EDGE.x, point[1] + EDGE.y, point[2] + EDGE.z);
      uvs.push(0, i / last, 1, i / last);
      if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2 + 1, i * 2 - 2, i * 2 + 1, i * 2);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    return geometry;
  }

  /**
   * Thunder Strike: jagged bolts fall from the sky onto (x, z), then arcs keep
   * crawling over the ground for `linger` seconds, as long as the stun lasts.
   */
  function lightning(x, z, colors, radius, linger) {
    if (muted()) return;
    const jagged = (from, to, joints, wobble) =>
      Array.from({ length: joints + 1 }, (_, i) => {
        const t = i / joints;
        // The kinks shrink towards the ground so the bolt lands on its mark.
        const kink = i === 0 || i === joints ? 0 : wobble * (1 - t * 0.6);
        return [
          from[0] + (to[0] - from[0]) * t + (Math.random() - 0.5) * kink,
          from[1] + (to[1] - from[1]) * t + (Math.random() - 0.5) * kink * 0.4,
          from[2] + (to[2] - from[2]) * t + (Math.random() - 0.5) * kink * 0.5,
        ];
      });
    const strike = (delay, life, power) => {
      const sky = [x + (Math.random() - 0.5) * 6, 20, z - 2 + (Math.random() - 0.5) * 2];
      const trunk = jagged(sky, [x, 0.1, z], 12, 2.2);
      const strokes = [
        [trunk, colors.bolt, 1.25, 0.8],
        [trunk, colors.boltCore, 0.4, 1],
      ];
      // Forks split off the trunk and die out in the air.
      for (const joint of [3, 6, 8]) {
        const [fx0, fy0, fz0] = trunk[joint];
        const reach = 2 + Math.random() * 2.5;
        const fork = jagged(trunk[joint], [fx0 + (Math.random() - 0.5) * reach * 2, fy0 - reach * 1.2, fz0 + (Math.random() - 0.5) * reach], 4, 1);
        strokes.push([fork, colors.bolt, 0.42, 0.7]);
      }
      const meshes = strokes.map(([points, color, width, opacity]) => {
        const mesh = new THREE.Mesh(
          ribbonGeometry(points, width),
          new THREE.MeshBasicMaterial({ map: rayTexture, ...additive(hot(color, 1.9), 0), side: THREE.DoubleSide }),
        );
        mesh.userData.opacity = opacity * power;
        mesh.frustumCulled = false;
        mesh.visible = false;
        fxGroup.add(mesh);
        return mesh;
      });
      effect(
        life,
        (k) => {
          const flicker = k < 0.2 ? 1 : 0.4 + 0.6 * Math.abs(Math.sin(k * 34));
          for (const mesh of meshes) {
            mesh.visible = true;
            mesh.material.opacity = mesh.userData.opacity * flicker * (1 - k * k);
          }
        },
        () => {
          for (const mesh of meshes) {
            fxGroup.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
          }
        },
        delay,
      );
    };
    strike(0, 0.3, 1);
    strike(0.09, 0.26, 0.8);
    strike(0.2, 0.3, 0.9);

    flash(x, 1.2, z, colors.boltCore, radius * 2.6, 0.35);
    flash(x, 0.8, z, colors.bolt, radius * 5, 0.65);
    flash(x, 14, z - 2, colors.bolt, 10, 0.35);
    ring(x, z, colors.boltCore, 0.3, radius, 0.32);
    ring(x, z, colors.bolt, 0.3, radius * 1.15, 0.6, 0.06);
    ring(x, z, colors.bolt, radius, radius, linger);
    sparks(x, 0.5, z, colors.bolt, 22, 8, 0.8, 0.34);
    sparks(x, 0.5, z, colors.boltCore, 10, 5, 0.6, 0.26);

    let since = 0;
    effect(linger, (_k, dt) => {
      since += dt;
      if (since < 0.08) return;
      since = 0;
      const angle = Math.random() * TAU;
      const reach = Math.sqrt(Math.random()) * radius * 0.95;
      const from = { x: x + Math.cos(angle) * reach, y: 0.12, z: z + Math.sin(angle) * reach };
      const to = { x: from.x + (Math.random() - 0.5) * 1.8, y: 0.2 + Math.random() * 1.1, z: from.z + (Math.random() - 0.5) * 1.8 };
      ray(from, to, colors.bolt, 0.2, 0.14);
    });
  }

  // Streaks of light that thin out towards the sky; the columns of a pillar turn it about its axis.
  const pillarTexture = canvasTexture(128, 256, (g, w, h) => {
    const random = seededRandom(11);
    for (let i = 0; i < 34; i++) {
      g.fillStyle = `rgba(255, 255, 255, ${(0.12 + random() * 0.5).toFixed(3)})`;
      g.fillRect(random() * w, 0, 1 + random() * 7, h);
    }
    const rise = g.createLinearGradient(0, h, 0, 0);
    rise.addColorStop(0, 'rgba(255, 255, 255, 1)');
    rise.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
    rise.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = rise;
    g.fillRect(0, 0, w, h);
  });
  pillarTexture.wrapS = THREE.RepeatWrapping;
  const pillarGeometry = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true).translate(0, 0.5, 0);
  const sealGeometry = new THREE.RingGeometry(0.86, 1, 6).rotateX(-Math.PI / 2);
  const sigilGeometry = new THREE.RingGeometry(0.52, 0.6, 3).rotateX(-Math.PI / 2);
  const poolGeometry = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  const PILLAR_HEIGHT = 30;

  /**
   * Divine Judgment: after `delay` seconds a pillar of light falls from orbit
   * onto (x, z) and burns for `duration`, pulsing a shockwave on every damage tick.
   */
  function pillar(x, z, radius, colors, delay, duration, tick) {
    if (muted()) return;
    const lit = (geometry, color, boost, map) => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, ...additive(hot(color, boost), 0), side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      return mesh;
    };
    const column = lit(pillarGeometry, colors.pillar, 1.1, pillarTexture);
    const core = lit(pillarGeometry, colors.pillarCore, 1.3, pillarTexture);
    const pool = lit(poolGeometry, colors.pillar, 1, glowTexture);
    const seal = lit(sealGeometry, colors.pillar, 1.6);
    const sigils = [lit(sigilGeometry, colors.pillarCore, 1.6), lit(sigilGeometry, colors.pillarCore, 1.6)];
    const haze = new THREE.Sprite(new THREE.SpriteMaterial({ map: beamTexture, ...additive(colors.pillar, 0) }));
    column.scale.set(radius * 0.5, PILLAR_HEIGHT, radius * 0.5);
    core.scale.set(radius * 0.2, PILLAR_HEIGHT, radius * 0.2);
    pool.scale.setScalar(radius * 1.15);
    pool.position.y = 0.07;
    seal.scale.setScalar(radius);
    seal.position.y = 0.1;
    sigils.forEach((sigil, i) => {
      sigil.scale.setScalar(radius);
      sigil.position.y = 0.11;
      sigil.rotation.y = i * Math.PI;
    });
    haze.center.set(0.5, 0);
    haze.scale.set(radius * 1.5, PILLAR_HEIGHT * COS_P, 1);
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.add(pool, seal, ...sigils, haze, column, core);
    group.visible = false;
    fxGroup.add(group);

    // A closing circle warns of the strike; the pillar lands with the first tick of damage.
    ring(x, z, colors.pillar, radius, radius * 0.3, delay);
    ring(x, z, colors.pillarCore, radius * 1.05, radius * 1.05, delay);

    let emitted = 0;
    let ticks = 0;
    effect(
      duration,
      (k, dt) => {
        group.visible = true;
        const t = k * duration;
        const arrive = Math.min(1, t / 0.2);
        const power = arrive * Math.min(1, (duration - t) / 0.5) * (0.86 + 0.14 * Math.sin(t * 24));
        // The light falls out of the sky, then holds.
        column.position.y = core.position.y = (1 - easeOut(arrive)) * PILLAR_HEIGHT;
        column.rotation.y += dt * 1.5;
        core.rotation.y -= dt * 2.6;
        seal.rotation.y += dt * 0.8;
        sigils[0].rotation.y -= dt * 1.6;
        sigils[1].rotation.y -= dt * 1.6;
        column.material.opacity = 0.42 * power;
        core.material.opacity = 0.6 * power;
        haze.material.opacity = 0.22 * power;
        pool.material.opacity = 0.45 * power;
        seal.material.opacity = 0.9 * power;
        sigils[0].material.opacity = sigils[1].material.opacity = 0.8 * power;

        emitted += dt;
        if (emitted > 0.1) {
          emitted = 0;
          rise(x, z, radius * 0.85, colors.pillarCore, 8, 0.85, 5);
        }
        if (t >= ticks * tick) {
          ticks++;
          ring(x, z, colors.pillar, 0.5, radius, 0.45);
          ring(x, z, colors.pillarCore, 0.3, radius * 0.7, 0.3);
          sparks(x, 0.4, z, colors.pillar, 12, 7.5, 0.75, 0.3);
          flash(x, 0.6, z, colors.pillarCore, radius * 1.1, 0.25);
        }
      },
      () => {
        fxGroup.remove(group);
        for (const mesh of [column, core, pool, seal, ...sigils, haze]) mesh.material.dispose();
        ring(x, z, colors.pillar, radius * 0.6, radius * 1.4, 0.5);
        sparks(x, 0.6, z, colors.pillarCore, 18, 6, 0.9, 0.3);
      },
      delay,
    );
  }

  /**
   * A fading copy of a hero in the pose it holds right now, left where it stood:
   * the afterimage of a dash or a blink. `facing` turns it, or null keeps the hero's own heading.
   */
  function ghost(side, x, z, facing, color, duration, delay = 0) {
    if (muted()) return;
    const hero = heroes[side];
    const material = new THREE.MeshBasicMaterial(additive(hot(color, 1.2), 0));
    const copy = hero.body.clone();
    copy.traverse((node) => {
      if (!node.isMesh) return;
      node.material = material;
      node.castShadow = false;
    });
    copy.position.set(x, groundHeight(x, z) + 0.05, z);
    if (facing !== null) copy.rotation.set(0, facing, 0);
    copy.visible = false;
    fxGroup.add(copy);
    effect(
      duration,
      (k) => {
        copy.visible = true;
        material.opacity = 0.6 * (1 - k) ** 1.5;
        copy.scale.setScalar(hero.size * (1 + 0.08 * k));
      },
      () => {
        fxGroup.remove(copy);
        material.dispose();
      },
      delay,
    );
  }

  let slashes = 0;

  const fx = {
    // Primitives the unit layer builds its attack and death effects from.
    bolt,
    ray,
    slam,
    sparks,
    ring,
    flash,
    beam,
    rise,

    /** A hero's sword cut. Successive cuts come from alternate sides. */
    heroSlash(side, x, y, z, facing) {
      slash(x, y, z, facing, SPELL[side].slash, 1.9, slashes++ % 2 ? -0.32 : 0.32);
    },

    /** Lifesteal: life drawn out of the victim along a crimson thread back to the hero. */
    drain(from, to) {
      ray(from, to, LIFESTEAL_COLOR, 0.34, 0.26);
      flash(to.x, to.y, to.z, LIFESTEAL_COLOR, 2.6, 0.32);
      rise(to.x, to.z, 0.6, 0xff6a7a, 4, 0.6, 2);
    },

    /** An Aegis Shield giving out: the sphere bursts into shards. */
    shieldBreak(side, x, y, z) {
      const color = SPELL[side].shield;
      sparks(x, y, z, color, 16, 5, 0.6, 0.3);
      ring(x, z, color, 1.6, 2.6, 0.35);
      flash(x, y, z, color, 4.5, 0.3);
    },

    /** Bounty paid for a kill: a burst of coins. The HUD floats the amount above it. */
    gold(x, y, z) {
      sparks(x, y, z, GOLD, 7, 3.4, 0.7, 0.26);
      flash(x, y, z, 0xfff1b8, 2.2, 0.35);
      ring(x, z, GOLD, 0.2, 1.1, 0.4);
    },

    card(card, side, x, z) {
      const team = TEAM_COLOR[side];
      if (card.id === 'fireball') {
        fireball(side, { x, z }, card.radius, card.travelMs / 1000);
      } else if (card.id === 'healing_wave') {
        for (let i = 0; i < 3; i++) ring(x, z, i === 1 ? 0xd8ffe6 : 0x3dff8f, 0.3, card.radius, 0.8, i * 0.14);
        flash(x, 1, z, 0x3dff8f, card.radius * 2.6, 0.8);
        rise(x, z, card.radius, 0x7dffb0, 34, 1.5);
      } else {
        // Summoning flare where the troops or the building appear.
        ring(x, z, team, 0.2, card.radius, 0.5);
        ring(x, z, 0xffffff, 0.2, card.radius * 1.3, 0.75, 0.08);
        beam(x, z, team, card.radius * 1.4, 6, 0.7);
        flash(x, 0.8, z, team, card.radius * 2.6, 0.5);
        sparks(x, 0.4, z, team, 12, 4, 0.8);
      }
    },

    /** `event` is the server's cast event: who cast, where the hero stood (x, z) and where the ability landed (tx, tz). */
    cast({ side, key, x, z, tx, tz }, ability) {
      const colors = SPELL[side];
      if (key === 'Q') {
        // Slash Dash: afterimages down the path, a streak of light, and a wide cut where it ends.
        const facing = Math.atan2(tx - x, tz - z);
        for (let i = 0; i < 4; i++) {
          ghost(side, x + ((tx - x) * i) / 4, z + ((tz - z) * i) / 4, facing, colors.slash, 0.55, i * 0.04);
        }
        ray({ x, y: 1.2, z }, { x: tx, y: 1.2, z: tz }, colors.slash, 1.8, 0.42);
        ray({ x, y: 1.25, z }, { x: tx, y: 1.25, z: tz }, 0xfff8e0, 0.5, 0.3);
        slash(tx, 1.3, tz, facing, colors.slash, 2.7, 0.5);
        slash(tx, 1.3, tz, facing, colors.slash, 2.3, -0.5);
        ring(tx, tz, colors.slash, 0.4, 2.4, 0.35);
        flash(tx, 1.3, tz, 0xfff6d0, 4.6, 0.3);
        sparks(tx, 1, tz, colors.slash, 14, 6, 0.55);
      } else if (key === 'W') {
        // Aegis Shield: the sphere itself is drawn on the hero for as long as the shield holds.
        ring(x, z, colors.shield, 0.4, 2.8, 0.5);
        ring(x, z, 0xffffff, 0.3, 2.2, 0.35, 0.05);
        beam(x, z, colors.shield, 2.4, 5, 0.5);
        flash(x, 1.4, z, colors.shield, 6, 0.45);
        sparks(x, 1.2, z, colors.shield, 12, 4, 0.6, 0.28);
      } else if (key === 'E') {
        lightning(tx, tz, colors, ability.radius, ability.stunMs / 1000);
      } else if (key === 'R') {
        pillar(tx, tz, ability.radius, colors, ability.delayMs / 1000, ability.durationMs / 1000, ability.tickMs / 1000);
      }
    },

    /** `event` is the server's item event: a relic bought, a blink from (x, z) to (tx, tz), or a rune drunk. */
    item({ side, key, x, z, tx, tz, bought, rune }) {
      const colors = SPELL[side];
      if (bought) {
        const color = key === 'Z' ? colors.blink : LIFESTEAL_COLOR;
        for (let i = 0; i < 2; i++) ring(x, z, color, 0.3, 2.6, 0.6, i * 0.14);
        beam(x, z, color, 1.6, 7, 0.8);
        flash(x, 1.3, z, color, 5, 0.5);
        sparks(x, 1.2, z, GOLD, 16, 5, 0.9, 0.28);
      } else if (key === 'Z') {
        // Blink Boots: the hero winks out in a flash, leaving a ghost, and arrives in a brighter one.
        ghost(side, x, z, null, colors.blink, 0.5);
        ring(x, z, colors.blink, 1.8, 0.2, 0.3);
        beam(x, z, colors.blink, 0.9, 9, 0.35);
        flash(x, 1.2, z, colors.blinkCore, 5, 0.3);
        ray({ x, y: 1.2, z }, { x: tx, y: 1.2, z: tz }, colors.blink, 0.45, 0.28);
        flash(tx, 1.2, tz, colors.blinkCore, 5.5, 0.45);
        flash(tx, 1.2, tz, colors.blink, 7.5, 0.65);
        ring(tx, tz, colors.blink, 0.3, 2.8, 0.45);
        ring(tx, tz, 0xffffff, 0.2, 1.8, 0.3, 0.04);
        beam(tx, tz, colors.blink, 1.7, 10, 0.5);
        sparks(tx, 0.8, tz, colors.blinkCore, 16, 5, 0.6);
      } else if (rune) {
        // The bottled rune, drunk.
        const color = RUNE_COLOR[rune];
        for (let i = 0; i < 3; i++) ring(x, z, color, 0.3, 3.2, 0.6, i * 0.13);
        beam(x, z, color, 2, 9, 0.8);
        flash(x, 1.3, z, color, 6.5, 0.5);
        sparks(x, 1, z, color, 18, 5.5, 0.9);
        rise(x, z, 1.4, color, 14, 1.1, 1.6);
      }
    },

    rune(kind) {
      const color = RUNE_COLOR[kind];
      beam(0, 0, color, 2.6, 13, 1.2);
      ring(0, 0, color, 0.4, 3.4, 0.9);
      ring(0, 0, 0xffffff, 0.4, 3.4, 1.1, 0.15);
      flash(0, 1.4, 0, color, 7, 0.8);
      sparks(0, 1, 0, color, 20, 5, 1.0);
    },

    runeTaken(kind) {
      const color = RUNE_COLOR[kind];
      ring(0, 0, color, 2.4, 0.3, 0.45);
      flash(0, 1.6, 0, color, 6, 0.5);
      sparks(0, 1.4, 0, color, 18, 6, 0.9);
    },

    ping(x, z) {
      for (let i = 0; i < 3; i++) ring(x, z, i === 1 ? 0xffffff : 0xffd766, 0.2, 1.7, 0.8, i * 0.22);
      beam(x, z, 0xffe9a0, 0.5, 5, 1.0);
    },

    /** A closing ring where the hero was told to go (or, in red, whom to attack). */
    marker(x, z, hostile) {
      const color = hostile ? 0xff5a4a : 0x6dffa8;
      ring(x, z, color, 1.3, 0.3, 0.34);
      ring(x, z, color, 0.8, 0.2, 0.34, 0.08);
      flash(x, 0.2, z, color, 1.8, 0.3);
    },

    /** A structure takes a hit: it shudders, and flashes if the blow was heavy. */
    hit(id, heavy) {
      const view = structures.get(id);
      if (!view) return;
      view.shake = Math.max(view.shake, heavy ? 0.3 : 0.1);
      if (heavy) flash(view.def.x, view.def.height * 0.45, view.def.z, 0xffc880, 4.5, 0.3);
    },

    destroyed(id) {
      const view = structures.get(id);
      if (!view || view.collapse >= 0) return;
      const { x, z, height, radius } = view.def;
      view.collapse = 0;
      view.halo.visible = false;
      view.range.visible = false;
      flash(x, height * 0.5, z, 0xffffff, radius * 5, 0.5);
      flash(x, height * 0.4, z, view.def.side === 'radiant' ? 0x59d2ff : 0xff6a14, radius * 8, 1.0);
      for (let i = 0; i < 3; i++) ring(x, z, 0xffe9c0, 0.4, radius * 2.4, 0.9, i * 0.15);
      sparks(x, height * 0.5, z, 0xffd9a0, 28, 8, 1.3, 0.5);
    },
  };

  /* ---------------------------------------------------------------- Units */

  const structureList = [...structures.values()];
  const units = createUnitLayer({
    scene,
    Batch,
    pen,
    lean,
    solidMaterial,
    glowMaterial,
    pitch: PITCH,
    heroes,
    fx,
    colors: { spell: SPELL, rune: RUNE_COLOR, lifesteal: LIFESTEAL_COLOR },
    glowTexture,
    // Attacks aimed at a Tower or Throne land part-way up it; a fallen one is no target.
    structurePoint(id) {
      const view = structureList[-id - 1];
      return view && view.collapse < 0 ? { x: view.def.x, y: view.def.height * 0.4, z: view.def.z } : null;
    },
  });

  /* ---------------------------------------------------------------- Frame loop */

  let width = 1;
  let height = 1;
  let pixelsPerUnit = 30;
  let time = 0;
  let lastTime = 0;
  let frameId = 0;
  let running = false;
  let fps = 60;
  let cpuMs = 0;
  /** Render-resolution multiplier. It steps down if frames run long, to hold 60 FPS on weak GPUs. */
  let quality = 1;
  /** Set from the console (runedeck.lockQuality) to keep full quality whatever the frame rate. */
  let qualityLocked = false;
  let sampleFrames = 0;
  let sampleTime = 0;
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);

  function applyResolution() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * quality;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    if (composer) {
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      // Bloom is the first thing a struggling GPU gives up.
      bloomPass.enabled = quality > 0.7;
    }
    particles.uniforms.uPixels.value = (height * ratio) / (2 * tanHalfFov);
  }

  /** Corners the camera must keep in view: the field on the ground, and head-room for what stands at the back. */
  const FRAME_POINTS = [-1, 1].flatMap((side) => [
    [side * (MAP.halfWidth + 1.2), 0, MAP.halfDepth + 0.7],
    [side * (MAP.halfWidth + 1.2), 0, -MAP.halfDepth - 0.4],
    [side * (MAP.halfWidth + 1.2), 2.6, -MAP.halfDepth],
    [side * MAP.towerX, 6.6, -MAP.laneZ],
  ]);

  /** Bounds of those corners in normalised screen space, with the camera `distance` from the field's centre. */
  function frameAt(distance) {
    camera.position.set(0, SIN_P * distance, COS_P * distance);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const box = { halfWidth: 0, top: -Infinity, bottom: Infinity };
    for (const [x, y, z] of FRAME_POINTS) {
      A.set(x, y, z).project(camera);
      box.halfWidth = Math.max(box.halfWidth, Math.abs(A.x));
      box.top = Math.max(box.top, A.y);
      box.bottom = Math.min(box.bottom, A.y);
    }
    return box;
  }

  const api = {
    fx,
    /** Called once per rendered frame with (dt seconds, timestamp ms). */
    onFrame: null,

    get pixelsPerUnit() {
      return pixelsPerUnit;
    },

    /** Fits the whole field into the area the HUD leaves free (`insets` in CSS pixels). */
    resize(nextWidth, nextHeight, insets = { top: 0, bottom: 0 }) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      const safeHeight = Math.max(height - insets.top - insets.bottom, 120);

      // Pull the camera back along its line of sight until the field just fits the free area.
      camera.clearViewOffset();
      camera.aspect = width / height;
      let near = 20;
      let far = 320;
      for (let i = 0; i < 24; i++) {
        const distance = (near + far) / 2;
        const box = frameAt(distance);
        if (box.halfWidth <= 1 && (box.top - box.bottom) * 0.5 * height <= safeHeight) far = distance;
        else near = distance;
      }
      const box = frameAt(far);
      // Then slide the picture, as a shift lens would, so the field sits in the middle of that area.
      const centre = (0.5 - (box.top + box.bottom) / 4) * height;
      camera.setViewOffset(width, height, 0, centre - (insets.top + safeHeight / 2), width, height);
      // Scale at the centre of the field; nearer things are drawn larger and farther ones smaller.
      pixelsPerUnit = height / (2 * far * tanHalfFov);
      applyResolution();
      if (!running) render();
    },

    start() {
      if (running) return;
      running = true;
      sampleFrames = -30;
      sampleTime = 0;
      lastTime = performance.now();
      frameId = requestAnimationFrame(frame);
    },

    stop() {
      running = false;
      cancelAnimationFrame(frameId);
    },

    /** Restores every structure and clears units and effects, ready for a new match. */
    reset() {
      // Finishing an effect can start another (a meteor ends in an explosion), so drain in passes.
      for (let pass = 0; effects.length && pass < 4; pass++) {
        for (const item of effects.splice(0)) item.done?.();
      }
      for (const view of structures.values()) {
        view.atk = -1;
        view.range.visible = true;
        view.shake = 0;
        view.collapse = -1;
        view.group.visible = true;
        view.group.scale.set(1, 1, 1);
        view.group.position.set(view.def.x, 0, view.def.z);
        view.ruins.visible = false;
        view.halo.visible = true;
      }
      units.clear();
      api.setRune(null);
      api.setWaypoint(null);
      api.setPreview(null);
    },

    /**
     * Applies a server snapshot. Units glide to their new positions, and every
     * unit or structure whose attack counter changed swings or fires.
     */
    sync(state) {
      state.structures.forEach(([hp, atk, targetId], index) => {
        const view = structureList[index];
        if (view.atk !== -1 && atk !== view.atk && hp > 0) {
          const { def } = view;
          bolt(def.side === 'radiant' ? 'energy' : 'magma', { x: def.x, y: def.muzzle, z: def.z }, () => units.point(targetId), def.shotSpeed);
        }
        view.atk = atk;
      });
      units.sync(state.units);
    },

    /** Smoothed position of a side's hero: { x, y, z, facing, dead }, or null. */
    heroView: (side) => units.hero(side),

    /** Id of the enemy unit or structure of `side` at a ground point, or 0 for open ground. */
    pickTarget(x, z, side) {
      const id = units.pick(x, z, side);
      if (id) return id;
      // As with units, a click anywhere up a Tower's height counts.
      const index = structureList.findIndex(({ def, collapse }) => {
        if (def.side === side || collapse >= 0) return false;
        const nearest = Math.min(def.z, Math.max(def.z - (def.height * 0.8) / Math.tan(PITCH), z));
        return Math.hypot(def.x - x, nearest - z) < def.radius + 0.3;
      });
      return index === -1 ? 0 : -(index + 1);
    },

    /** World position to CSS pixels inside the canvas. */
    project(x, y, z) {
      A.set(x, y, z).project(camera);
      return { x: (A.x * 0.5 + 0.5) * width, y: (0.5 - A.y * 0.5) * height };
    },

    /** Client coordinates to the point on the ground under them. */
    pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.ray.intersectPlane(groundPlane, B) ? { x: B.x, z: B.z } : null;
    },

    /** Shows the rune waiting on the River pad: a kind from RUNES, or null for an empty pad. */
    setRune(kind) {
      for (const name in runeGems) runeGems[name].visible = name === kind;
      runeBeam.visible = runeHalo.visible = Boolean(kind);
      if (!kind) return;
      runeBeam.material.color.set(RUNE_COLOR[kind]);
      runeHalo.material.color.set(RUNE_COLOR[kind]);
    },

    /** Marks where the hero is walking to ({ x, z }), or clears the mark with null. */
    setWaypoint(point) {
      waypoint.visible = Boolean(point);
      if (point) waypoint.position.set(point.x, groundHeight(point.x, point.z) + 0.09, point.z);
    },

    /** `preview` is null or { x, z, radius, valid, side, restricted }. */
    setPreview(preview) {
      previewRing.visible = previewHalo.visible = previewDisc.visible = Boolean(preview);
      forbidden.visible = Boolean(preview?.restricted);
      if (!preview) return;
      previewRadius = preview.radius;
      previewRing.material.color.set(preview.valid ? 0x4dff9a : 0xff3b30);
      previewHalo.material.color.set(preview.valid ? 0x4dff9a : 0xff3b30);
      previewDisc.material.color.set(preview.valid ? 0x2f9cff : 0xff3b30);
      for (const mesh of [previewRing, previewHalo, previewDisc]) mesh.position.set(preview.x, 0.1, preview.z);
      if (preview.restricted) {
        // Everything from the near bank of the River to the enemy's edge.
        const bank = R.halfWidth + 0.7;
        const far = MAP.halfWidth + 1;
        const sign = preview.side === 'radiant' ? 1 : -1;
        forbidden.scale.set(far + bank, 1, (MAP.halfDepth + 1) * 2);
        forbidden.position.set((sign * (far - bank)) / 2, 0.09, 0);
      }
    },

    /** Diagnostics: hold full resolution and bloom even when the frame rate drops. */
    lockQuality(locked = true) {
      qualityLocked = locked;
      if (locked && quality !== 1) {
        quality = 1;
        applyResolution();
      }
    },

    stats() {
      return {
        fps: Math.round(fps),
        quality,
        cpuMs: +cpuMs.toFixed(2),
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        units: units.count(),
        pixelRatio: renderer.getPixelRatio(),
      };
    },
  };

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function frame(now) {
    if (!running) return;
    frameId = requestAnimationFrame(frame);
    const began = performance.now();
    // A frame queued before start() carries an older timestamp; time must never run backwards.
    const dt = Math.min(Math.max(0, (now - lastTime) / 1000), 0.1);
    lastTime = now;
    time += dt;
    if (dt > 0) fps += (1 / dt - fps) * 0.08;

    // Once a second's worth of frames averages under 45 FPS, render fewer pixels.
    // The first frames after start are skipped so load-time hitches do not count.
    if (++sampleFrames > 0) {
      sampleTime += dt;
      if (sampleFrames >= 60) {
        if (sampleTime / sampleFrames > 1 / 45 && quality > 0.5 && !qualityLocked) {
          quality = Math.max(0.5, quality - 0.17);
          applyResolution();
        }
        sampleFrames = 0;
        sampleTime = 0;
      }
    }

    terrainUniforms.uTime.value = time;
    particles.uniforms.uTime.value = time;

    for (const view of structures.values()) {
      const radiant = view.def.side === 'radiant';
      view.floater.position.y = view.floatY + Math.sin(time * 1.5 + view.phase) * 0.14;
      view.floater.rotation.y += dt * (radiant ? 0.9 : -0.6);
      if (!radiant) view.floater.scale.setScalar(1 + 0.08 * Math.sin(time * 3 + view.phase));

      if (view.shake > 0) {
        view.shake = Math.max(0, view.shake - dt);
        view.group.position.x = view.def.x + Math.sin(time * 90) * view.shake * 0.3;
        view.group.position.z = view.def.z + Math.cos(time * 70) * view.shake * 0.2;
      }
      if (view.collapse >= 0 && view.collapse < 1) {
        view.collapse = Math.min(1, view.collapse + dt / 0.9);
        view.group.scale.y = 1 - 0.96 * view.collapse ** 2;
        if (view.collapse === 1) {
          view.group.visible = false;
          view.ruins.visible = true;
        }
      }
    }

    units.update(dt, time);

    if (previewRing.visible) {
      const pulse = Math.sin(time * 6);
      previewRing.scale.setScalar(previewRadius * (1 + 0.025 * pulse));
      previewHalo.scale.setScalar(previewRadius * (1 + 0.05 * pulse));
      previewDisc.scale.setScalar(previewRadius);
      previewHalo.material.opacity = 0.4 + 0.15 * pulse;
    }

    runeRing.rotation.y = time * 0.5;
    runeRing.material.opacity = 0.5 + 0.25 * Math.sin(time * 2);
    for (const name in runeGems) {
      runeGems[name].position.y = 1.75 + Math.sin(time * 2) * 0.16;
      runeGems[name].rotation.y = time * 1.6;
    }
    pillarTexture.offset.x = time * 0.3;
    if (waypoint.visible) {
      waypoint.scale.setScalar(1 + 0.12 * Math.sin(time * 7));
      waypoint.rotation.y = time * 1.2;
    }
    padHalo.material.opacity = 0.4 + 0.12 * Math.sin(time * 2);

    for (const halo of halos) {
      if (!halo.sprite.visible) continue;
      const pulse = 0.5 + 0.5 * Math.sin(time * 1.8 + halo.phase);
      halo.sprite.scale.setScalar(halo.size * (0.94 + 0.1 * pulse));
      if (halo.sprite !== padHalo) halo.sprite.material.opacity = halo.opacity * (0.8 + 0.2 * pulse);
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      const item = effects[i];
      item.age += dt;
      if (item.age < 0) continue;
      const k = Math.min(item.age / item.duration, 1);
      // An update may return true to finish early, as a bolt does on impact.
      if (item.update(k, dt) === true || k >= 1) {
        item.done?.();
        effects.splice(i, 1);
      }
    }

    api.onFrame?.(dt, now);
    render();
    cpuMs += (performance.now() - began - cpuMs) * 0.1;
  }

  // Compile every shader now, during the pre-match countdown, so the first
  // deploy preview or spell effect does not stall a frame mid-match.
  for (const mesh of previewParts) mesh.visible = true;
  renderer.compile(scene, camera);

  api.reset();
  return api;
}
