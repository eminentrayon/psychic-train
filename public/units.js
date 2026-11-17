/**
 * RuneDeck — unit render layer.
 *
 * Draws everything that moves: lane creeps, card troops, Frost Towers and both
 * heroes, with their health bars, ground rings and attack animations. Positions
 * come from server snapshots and are smoothed between them.
 *
 * Each unit type is one instanced mesh per side, and all health bars and all
 * ground decals are one draw call each, so a full battlefield costs about
 * thirty draw calls however many units are on it.
 *
 * The two heroes are the exception: each is a small rig of hinged parts that
 * strides, swings its sword and wears its buffs (Aegis sphere, rune auras,
 * the Lifesteal Blade's crimson wisps).
 */

import * as THREE from 'three';

import { FLAG, MATCH, SIDES, UNITS, UNIT_TYPES, groundHeight } from './shared.js';

const TAU = Math.PI * 2;
const CAPACITY = 128;
/** Seconds a unit takes to reach its newest snapshot position; a little over the snapshot interval. */
const LERP_S = (MATCH.snapshotMs / 1000) * 1.2;
const SWING_S = 0.34;
const DEATH_S = 0.4;
/** A jump longer than this is a blink or a respawn and is shown instantly. */
const TELEPORT = 6.4;

const PALETTE = {
  radiant: {
    team: 0x4fc3ff,
    bar: [0.31, 0.76, 1.0],
    armor: [0x6f7f9c, 0xe6ecf7],
    cloth: [0x1648b8, 0x58b8ff],
    robe: [0x232c6a, 0x5a6fd0],
    stone: [0x5e6878, 0xc3cbda],
    glow: [0x39b8ff, 0xeaffff],
    skin: 0xd9c2a8,
  },
  dire: {
    team: 0xff5a36,
    bar: [1.0, 0.33, 0.24],
    armor: [0x2c2433, 0x7a6788],
    cloth: [0x8f141c, 0xff6a4a],
    robe: [0x3a1838, 0x8a3a6a],
    stone: [0x2a2530, 0x6e5f7a],
    glow: [0xff6a1a, 0xfff0c0],
    skin: 0xb8a59a,
  },
};

/* -------------------------------------------------------------------------- */
/* Models. Every unit faces +Z and stands on the origin.                      */
/* -------------------------------------------------------------------------- */

const MODELS = {
  melee(p, c) {
    for (const x of [-0.13, 0.13]) p.box(c.armor[0], x, 0, 0, 0.16, 0.34, 0.2, { top: c.armor[1] });
    p.cyl(c.cloth[0], 0, 0.3, 0, 0.3, 0.22, 0.44, 6, { top: c.cloth[1] });
    p.rock(c.armor[1], 0, 0.92, 0, 0.2);
    p.box(c.glow[0], 0, 0.88, 0.16, 0.2, 0.05, 0.06, { glow: true, top: c.glow[1] });
    p.cyl(c.armor[0], -0.37, 0.56, 0.16, 0.24, 0.24, 0.05, 8, { top: c.cloth[1], rx: Math.PI / 2 });
    p.box(c.armor[1], 0.37, 0.44, 0.2, 0.07, 0.62, 0.04, { top: 0xffffff, rx: 0.9 });
  },

  ranged(p, c) {
    p.cone(c.cloth[0], 0, 0, 0, 0.34, 0.82, 7, { top: c.cloth[1] });
    p.rock(c.skin, 0, 0.92, 0, 0.17);
    p.cone(c.cloth[0], 0, 0.98, -0.02, 0.21, 0.32, 6, { top: c.cloth[1] });
    p.cyl(0x4a3020, 0.35, 0, 0.14, 0.03, 0.04, 1.15, 5, { top: 0x8a6a40 });
    p.gem(c.glow[0], 0.35, 1.1, 0.14, 0.11, 0.28, { glow: true, top: c.glow[1] });
  },

  /** Armored sword soldier: full helm with a plume, a kite shield and a long blade. */
  footman(p, c) {
    for (const x of [-0.16, 0.16]) p.box(c.armor[0], x, 0, 0, 0.2, 0.46, 0.24, { top: c.armor[1] });
    p.cyl(c.armor[0], 0, 0.42, 0, 0.38, 0.27, 0.54, 8, { top: c.armor[1] });
    p.cyl(c.cloth[0], 0, 0.4, 0, 0.3, 0.3, 0.1, 8, { top: c.cloth[1] });
    for (const x of [-0.42, 0.42]) p.rock(c.armor[1], x, 0.98, 0, 0.17);
    p.rock(c.armor[0], 0, 1.22, 0, 0.23, { top: c.armor[1] });
    p.box(c.cloth[0], 0, 1.36, -0.04, 0.07, 0.26, 0.36, { top: c.cloth[1] });
    p.box(c.glow[0], 0, 1.18, 0.19, 0.24, 0.05, 0.06, { glow: true, top: c.glow[1] });
    p.box(c.cloth[0], -0.46, 0.4, 0.27, 0.48, 0.7, 0.07, { top: c.cloth[1] });
    p.box(0xe3b755, -0.46, 0.68, 0.31, 0.15, 0.15, 0.03, { top: 0xfff1b8 });
    p.box(0xb98a2c, 0.48, 0.6, 0.2, 0.22, 0.05, 0.07, { top: 0xf7e3a0 });
    p.box(c.armor[1], 0.48, 0.64, 0.2, 0.08, 0.82, 0.035, { top: 0xffffff, rx: 0.5 });
  },

  /** Hooded mage: a long robe, a shadowed face with lit eyes, and a staff topped by a blue crystal. */
  archer(p, c) {
    p.cone(c.robe[0], 0, 0, 0, 0.42, 1.08, 7, { top: c.robe[1] });
    p.cyl(c.cloth[0], 0, 0.8, 0, 0.26, 0.36, 0.13, 7, { top: c.cloth[1] });
    p.rock(0x0c0f1a, 0, 1.14, 0.04, 0.18);
    p.cone(c.robe[0], 0, 1.0, -0.05, 0.28, 0.5, 7, { top: c.robe[1], rx: -0.14 });
    for (const x of [-0.07, 0.07]) p.box(0x59b8ff, x, 1.13, 0.2, 0.05, 0.04, 0.04, { glow: true, top: 0xeaffff });
    p.cyl(0x3a2a48, 0.44, 0, 0.16, 0.03, 0.04, 1.5, 5, { top: 0x7a6a98 });
    p.gem(0x2f7cff, 0.44, 1.42, 0.16, 0.15, 0.4, { glow: true, top: 0xe8f6ff });
  },

  /** Rock colossus, drawn at 2.5x: a boulder torso, hanging fists and a molten core. */
  golem(p, c) {
    for (const x of [-0.2, 0.2]) p.cyl(c.stone[0], x, 0, 0, 0.15, 0.19, 0.42, 6, { top: c.stone[1] });
    p.rock(c.stone[0], 0, 0.74, 0, 0.44, { top: c.stone[1], sy: 0.92 });
    p.cyl(c.cloth[0], 0, 0.38, 0, 0.37, 0.34, 0.08, 8, { top: c.cloth[1] });
    for (const x of [-0.52, 0.52]) {
      p.rock(c.stone[0], x, 0.9, 0, 0.23, { top: c.stone[1] });
      p.cyl(c.stone[0], x * 1.13, 0.3, 0.06, 0.12, 0.16, 0.55, 6, { top: c.stone[1] });
      p.rock(c.stone[0], x * 1.13, 0.22, 0.1, 0.2, { top: c.stone[1] });
    }
    p.rock(c.stone[0], 0, 1.22, 0.05, 0.2, { top: c.stone[1] });
    for (const x of [-0.08, 0.08]) p.box(c.glow[0], x, 1.21, 0.21, 0.07, 0.05, 0.05, { glow: true, top: c.glow[1] });
    p.gem(c.glow[0], 0, 0.54, 0.35, 0.14, 0.38, { glow: true, top: c.glow[1] });
    p.box(c.glow[0], 0.21, 0.82, 0.33, 0.03, 0.26, 0.03, { glow: true, top: c.glow[1], rz: 0.5 });
    p.box(c.glow[0], -0.24, 0.6, 0.33, 0.03, 0.22, 0.03, { glow: true, top: c.glow[1], rz: -0.7 });
  },

  /** Crystalline turret: a stone footing with a team band and a tall ice spire. */
  frost_tower(p, c, lean) {
    p.cyl(0x55657c, 0, 0, 0, 0.8, 0.95, 0.3, 6, { top: 0xa9bacd });
    p.cyl(c.cloth[0], 0, 0.3, 0, 0.66, 0.7, 0.13, 6, { top: c.cloth[1] });
    p.cyl(0x6f8399, 0, 0.43, 0, 0.42, 0.6, 0.5, 6, { top: 0xcfe0ee });
    p.crystal(0x2a8fe8, 0, 0.85, 0, 0.36, 1.9, { glow: true, top: 0xe8fcff });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5;
      p.crystal(0x1f78dc, Math.cos(a) * 0.45, 0.6, Math.sin(a) * 0.45, 0.16, 0.85, { glow: true, top: 0xb9f4ff, ...lean(a, 0.5) });
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Shaders                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The hand-written shaders work in display (sRGB) colours. The frame is linear
 * HDR, so each one decodes its result with this before the standard output conversion.
 */
export const GLSL_TO_LINEAR = /* glsl */ `
vec3 toLinear(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;

/** Camera-facing quads: X is screen-right and the camera's up vector tilts with its pitch. */
const barVertex = (sinPitch, cosPitch) => /* glsl */ `
attribute vec3 aAnchor;
attribute vec2 aSize;
attribute vec4 aFill;   // rgb colour, a = health fraction
varying vec2 vUv;
varying vec4 vFill;
varying float vAspect;
void main() {
  vUv = uv;
  vFill = aFill;
  vAspect = aSize.x / aSize.y;
  vec3 world = aAnchor + vec3(position.x * aSize.x, position.y * aSize.y * ${cosPitch.toFixed(4)}, -position.y * aSize.y * ${sinPitch.toFixed(4)});
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const BAR_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec4 vFill;
varying float vAspect;
${GLSL_TO_LINEAR}
void main() {
  float frameX = 0.2 / vAspect;
  vec2 edge = min(vUv, 1.0 - vUv);
  float inner = (vUv.x - frameX) / (1.0 - 2.0 * frameX);
  vec3 col = inner <= vFill.a ? vFill.rgb * (0.65 + 0.7 * vUv.y) : vec3(0.05, 0.06, 0.1);
  if (edge.y < 0.2 || edge.x < frameX) col = vec3(0.0);
  gl_FragColor = vec4(toLinear(col), 0.95);
  #include <colorspace_fragment>
}
`;

const DECAL_VERTEX = /* glsl */ `
attribute vec3 aAnchor;
attribute vec4 aParams;   // x: radius, y: kind (0 shadow, 1 team ring, 2 thin range ring), z: opacity
attribute vec3 aTint;
varying vec2 vUv;
varying vec4 vParams;
varying vec3 vTint;
void main() {
  vUv = uv;
  vParams = aParams;
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * vec4(aAnchor + position * aParams.x, 1.0);
}
`;

const DECAL_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec4 vParams;
varying vec3 vTint;
${GLSL_TO_LINEAR}
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = vParams.y < 0.5 ? smoothstep(1.0, 0.25, r)
          : vParams.y < 1.5 ? smoothstep(0.1, 0.03, abs(r - 0.86))
          : smoothstep(0.014, 0.004, abs(r - 0.98));
  gl_FragColor = vec4(toLinear(vTint), a * vParams.z);
  #include <colorspace_fragment>
}
`;

function instancedQuads(plane, attributes, material, renderOrder) {
  const geometry = new THREE.InstancedBufferGeometry().copy(plane);
  plane.dispose();
  const arrays = {};
  for (const [name, size, count] of attributes) {
    arrays[name] = new Float32Array(count * size);
    const attribute = new THREE.InstancedBufferAttribute(arrays[name], size);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
  }
  geometry.instanceCount = 0;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return { mesh, geometry, arrays };
}

/** Shortest turn from one heading to another, taking `amount` (0..1) of it. */
function turn(from, to, amount) {
  const delta = ((((to - from + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return from + delta * Math.min(1, amount);
}

/* -------------------------------------------------------------------------- */
/* Layer                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param kit.scene          scene to draw into
 * @param kit.Batch, kit.pen, kit.lean   geometry helpers from battlefield.js
 * @param kit.heroes         hero models built by the battlefield, by side
 * @param kit.fx             effect primitives: bolt, ray, slam, sparks, ring, flash, beam, rise, heroSlash, drain, shieldBreak
 * @param kit.colors         { spell: by side, rune: by kind, lifesteal }
 * @param kit.glowTexture    soft round sprite texture
 * @param kit.structurePoint id (negative) -> aim point on a Tower or Throne, or null if it has fallen
 */
export function createUnitLayer({ scene, Batch, pen, lean, solidMaterial, glowMaterial, pitch, heroes, fx, colors, glowTexture, structurePoint }) {
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);
  const tanPitch = Math.tan(pitch);

  /* ---------------------------------------------------------------- Instanced unit meshes */

  const WHITE = new THREE.Color(1, 1, 1);
  const FLASH = new THREE.Color(2.4, 2.4, 2.4);
  const kinds = new Map();
  for (const type of UNIT_TYPES) {
    if (!MODELS[type]) continue;
    for (const side of SIDES) {
      const solid = new Batch();
      const glow = new Batch();
      MODELS[type](pen(solid, glow), PALETTE[side], lean);
      const meshes = [solidMaterial, glowMaterial].map((material, i) => {
        const mesh = new THREE.InstancedMesh((i ? glow : solid).geometry(), material, CAPACITY);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Allocates the per-instance colour buffer, used for hit flashes and the frost tint.
        mesh.setColorAt(0, WHITE);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = i === 0;
        mesh.receiveShadow = i === 0;
        scene.add(mesh);
        return mesh;
      });
      kinds.set(`${type}:${side}`, { meshes, count: 0 });
    }
  }

  const bars = instancedQuads(
    new THREE.PlaneGeometry(1, 1),
    [['aAnchor', 3, CAPACITY], ['aSize', 2, CAPACITY], ['aFill', 4, CAPACITY]],
    new THREE.ShaderMaterial({ vertexShader: barVertex(sinPitch, cosPitch), fragmentShader: BAR_FRAGMENT, transparent: true, depthTest: false, depthWrite: false }),
    10,
  );
  const decals = instancedQuads(
    new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    [['aAnchor', 3, CAPACITY * 3], ['aParams', 4, CAPACITY * 3], ['aTint', 3, CAPACITY * 3]],
    new THREE.ShaderMaterial({ vertexShader: DECAL_VERTEX, fragmentShader: DECAL_FRAGMENT, transparent: true, depthWrite: false }),
    1,
  );
  scene.add(bars.mesh, decals.mesh);

  // These run for every unit on every frame, so they write straight into the buffers.
  function addBar(x, y, z, width, height, fraction, rgb) {
    if (bars.geometry.instanceCount >= CAPACITY) return;
    const i = bars.geometry.instanceCount++;
    const { aAnchor, aSize, aFill } = bars.arrays;
    aAnchor[i * 3] = x;
    aAnchor[i * 3 + 1] = y;
    aAnchor[i * 3 + 2] = z;
    aSize[i * 2] = width;
    aSize[i * 2 + 1] = height;
    aFill[i * 4] = rgb[0];
    aFill[i * 4 + 1] = rgb[1];
    aFill[i * 4 + 2] = rgb[2];
    aFill[i * 4 + 3] = fraction;
  }

  const tint = new THREE.Color();
  function addDecal(x, y, z, radius, kind, opacity, hex) {
    if (decals.geometry.instanceCount >= CAPACITY * 3) return;
    const i = decals.geometry.instanceCount++;
    const { aAnchor, aParams, aTint } = decals.arrays;
    tint.setHex(hex, THREE.LinearSRGBColorSpace);
    aAnchor[i * 3] = x;
    aAnchor[i * 3 + 1] = y;
    aAnchor[i * 3 + 2] = z;
    aParams[i * 4] = radius;
    aParams[i * 4 + 1] = kind;
    aParams[i * 4 + 2] = opacity;
    aTint[i * 3] = tint.r;
    aTint[i * 3 + 1] = tint.g;
    aTint[i * 3 + 2] = tint.b;
  }

  /* ---------------------------------------------------------------- Hero extras */

  const additive = (color, opacity) => ({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  /** A colour pushed past white, so the bloom pass makes it glow. */
  const hot = (hex, boost = 1.6) => new THREE.Color(hex).multiplyScalar(boost);
  const shellGeometry = new THREE.IcosahedronGeometry(1, 3);
  const latticeGeometry = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.03, 1));
  const hoopGeometry = new THREE.TorusGeometry(1.15, 0.024, 6, 56);
  const auraGeometry = new THREE.IcosahedronGeometry(1, 2);

  for (const side of SIDES) {
    const hero = heroes[side];
    const spell = colors.spell[side];
    const sprite = (hex, size) => {
      const node = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(hot(hex), 1) }));
      node.scale.setScalar(size);
      return node;
    };

    // Aegis Shield: a sphere of energy, a lattice turning inside it and two hoops orbiting it.
    const shell = new THREE.Mesh(shellGeometry, new THREE.MeshBasicMaterial({ ...additive(hot(spell.shield, 1.1), 0.2), side: THREE.DoubleSide }));
    const lattice = new THREE.LineSegments(latticeGeometry, new THREE.LineBasicMaterial(additive(hot(spell.shield, 2.2), 0.8)));
    const hoops = [0, 1].map(() => {
      const hoop = new THREE.Mesh(hoopGeometry, new THREE.MeshBasicMaterial(additive(hot(0xfff3c4, 2.2), 0.9)));
      hoop.rotation.order = 'YXZ';
      return hoop;
    });
    const shield = new THREE.Group();
    shield.position.y = 1.4;
    shield.add(shell, lattice, ...hoops);

    // Double Damage: a flickering shell of amber fire.
    const power = new THREE.Mesh(auraGeometry, new THREE.MeshBasicMaterial({ ...additive(hot(colors.rune.damage, 1.4), 0.22), side: THREE.DoubleSide }));
    power.position.y = 1.35;

    // Lifesteal Blade: crimson wisps circling the hero. Stun: sparks circling its head.
    const wisps = [0, 1, 2].map(() => sprite(colors.lifesteal, 0.5));
    const stars = [0, 1, 2].map(() => sprite(0xfff2a0, 0.42));

    for (const node of [shield, power, ...wisps, ...stars]) {
      node.visible = false;
      hero.group.add(node);
    }
    Object.assign(hero, { shield, shell, lattice, hoops, power, wisps, stars });
  }

  /* ---------------------------------------------------------------- Views */

  /** id -> view of a unit in the latest snapshot. */
  const views = new Map();
  /** Fallen units, still drawn while they shrink away. */
  const dying = [];
  const heroViews = { radiant: null, dire: null };
  let stamp = 0;

  function createView(id, type, side, x, z, hp, atk) {
    const def = UNITS[type];
    return {
      id,
      type,
      def,
      side,
      kind: kinds.get(`${type}:${side}`),
      palette: PALETTE[side],
      scale: def.scale ?? 1,
      x,
      z,
      y: groundHeight(x, z),
      fromX: x,
      fromZ: z,
      toX: x,
      toZ: z,
      t: 1,
      facing: side === 'radiant' ? Math.PI / 2 : -Math.PI / 2,
      hp,
      atk,
      targetId: 0,
      flags: 0,
      swing: 0,
      spawn: 0,
      flash: 0,
      moving: 0,
      /** Stride phase, advanced by the ground covered. */
      gait: 0,
      /** Seconds since the Aegis Shield went up, and since the last buff particles were shed. */
      shieldAge: 0,
      shed: 0,
      life: 1,
      phase: (id * 2.399) % TAU,
      stamp: 0,
    };
  }

  /** Where attacks aimed at `id` should land: chest height on a unit, mid-height on a structure. */
  function point(id) {
    if (id < 0) return structurePoint(id);
    const view = views.get(id);
    if (!view || view.flags & FLAG.dead) return null;
    return { x: view.x, y: view.y + view.def.height * 0.55, z: view.z };
  }

  function sync(list) {
    stamp++;
    for (const [id, typeIndex, sideIndex, x, z, hp, atk, targetId, flags] of list) {
      let view = views.get(id);
      if (!view) {
        view = createView(id, UNIT_TYPES[typeIndex], SIDES[sideIndex], x, z, hp, atk);
        views.set(id, view);
        if (view.type === 'hero') heroViews[view.side] = view;
      } else if (Math.hypot(x - view.x, z - view.z) > TELEPORT) {
        Object.assign(view, { x, z, fromX: x, fromZ: z, toX: x, toZ: z, t: 1 });
      } else {
        Object.assign(view, { fromX: view.x, fromZ: view.z, toX: x, toZ: z, t: 0 });
      }
      if (hp < view.hp) view.flash = 1;
      const before = view.flags;
      view.hp = hp;
      view.flags = flags;
      view.stamp = stamp;
      if (view.type === 'hero') {
        if ((before ^ flags) & FLAG.dead) heroChanged(view);
        if (flags & FLAG.shielded & ~before) view.shieldAge = 0;
        // The shield ran out or was beaten down.
        if (before & FLAG.shielded & ~flags && !(flags & FLAG.dead)) fx.shieldBreak(view.side, view.x, view.y + 1.4, view.z);
      }
      if (atk !== view.atk) {
        view.atk = atk;
        view.targetId = targetId;
        if (!(flags & FLAG.dead)) attack(view);
      }
    }
    for (const view of views.values()) {
      if (view.stamp === stamp) continue;
      views.delete(view.id);
      if (view.type === 'hero') heroViews[view.side] = null;
      else die(view);
    }
  }

  /** Plays the unit's attack: a projectile, an ice beam, a ground slam or a melee swing. */
  function attack(view) {
    view.swing = 1;
    const { def } = view;
    const target = point(view.targetId);
    if (!target) return;
    if (def.shot) {
      const kind = def.shot === 'arcane' ? 'arcane' : view.side === 'radiant' ? 'boltRadiant' : 'boltDire';
      const hand = { x: view.x + Math.cos(view.facing) * 0.4, y: view.y + def.height * 0.85, z: view.z - Math.sin(view.facing) * 0.4 };
      fx.bolt(kind, hand, () => point(view.targetId), def.shotSpeed);
    } else if (def.beam) {
      fx.ray({ x: view.x, y: view.y + def.height, z: view.z }, target, 0x9fe9ff, 0.5, 0.28);
      fx.flash(target.x, target.y, target.z, 0xbff4ff, 1.6, 0.3);
    } else if (def.slam) {
      // The fists land a moment after the wind-up, just short of the building.
      const gap = Math.hypot(target.x - view.x, target.z - view.z) || 1;
      const reach = Math.min(gap, def.radius + 1.1);
      fx.slam(view.x + ((target.x - view.x) / gap) * reach, view.z + ((target.z - view.z) / gap) * reach, view.palette.glow[0], SWING_S * 0.5);
    } else if (view.type === 'hero') {
      // A sword cut: a crescent of light in front of the hero, sparks where it bites.
      const heading = Math.atan2(target.x - view.x, target.z - view.z);
      fx.heroSlash(view.side, view.x + Math.sin(heading) * 0.75, view.y + 1.45, view.z + Math.cos(heading) * 0.75, heading);
      fx.sparks(target.x, target.y, target.z, colors.spell[view.side].slash, 7, 3, 0.32, 0.24);
      if (view.flags & FLAG.lifesteal) fx.drain(target, { x: view.x, y: view.y + 1.3, z: view.z });
    } else {
      // Dozens of troops swing every second, so their hits are a single cheap flash.
      fx.flash(target.x, target.y, target.z, 0xfff2c8, 1.1, 0.18);
    }
  }

  /** Shatter: a burst of fragments in the unit's colours while its model sinks away. */
  function die(view) {
    const { def, palette } = view;
    const big = view.scale;
    const y = view.y + def.height * 0.5;
    const frost = view.type === 'frost_tower';
    fx.sparks(view.x, y, view.z, frost ? 0xbff4ff : palette.glow[0], Math.round(8 * big), 3.5 + big, 0.7, 0.3 * big);
    fx.sparks(view.x, y, view.z, frost ? 0x6fb8ff : palette.cloth[1], Math.round(6 * big), 2.5 + big, 0.55, 0.22 * big);
    fx.ring(view.x, view.z, frost ? 0xbff4ff : palette.team, 0.2, def.radius * 2.4, 0.45);
    if (big > 2) fx.flash(view.x, y, view.z, palette.glow[0], 5 * big, 0.5);
    view.life = 1;
    dying.push(view);
  }

  function heroChanged(view) {
    const { palette } = view;
    if (view.flags & FLAG.dead) {
      fx.sparks(view.x, view.y + 1.2, view.z, palette.glow[1], 22, 6, 1.0, 0.45);
      fx.sparks(view.x, view.y + 1.2, view.z, palette.cloth[1], 14, 4, 0.8, 0.35);
      for (let i = 0; i < 2; i++) fx.ring(view.x, view.z, palette.team, 0.3, 3, 0.7, i * 0.15);
      fx.flash(view.x, view.y + 1.2, view.z, palette.glow[1], 7, 0.6);
    } else {
      fx.beam(view.toX, view.toZ, palette.team, 2, 9, 0.9);
      fx.ring(view.toX, view.toZ, palette.team, 0.3, 2.6, 0.6);
    }
  }

  /* ---------------------------------------------------------------- Frame */

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const color = new THREE.Color();

  /** Advances a view's smoothing and animation clocks. */
  function advance(view, dt) {
    view.t = Math.min(1, view.t + dt / LERP_S);
    const x = view.fromX + (view.toX - view.fromX) * view.t;
    const z = view.fromZ + (view.toZ - view.fromZ) * view.t;
    const vx = dt > 0 ? (x - view.x) / dt : 0;
    const vz = dt > 0 ? (z - view.z) / dt : 0;
    const walking = Math.hypot(vx, vz) > 0.5;
    view.x = x;
    view.z = z;
    view.y = groundHeight(x, z);
    view.moving += ((walking ? 1 : 0) - view.moving) * Math.min(1, dt * 10);
    view.gait += Math.hypot(vx, vz) * dt * 2.5;

    // Face the target while fighting, otherwise the way it is walking.
    const target = view.swing > 0 || !walking ? point(view.targetId) : null;
    if (target) view.facing = turn(view.facing, Math.atan2(target.x - x, target.z - z), dt * 14);
    else if (walking) view.facing = turn(view.facing, Math.atan2(vx, vz), dt * 10);

    view.swing = Math.max(0, view.swing - dt / SWING_S);
    view.spawn = Math.min(1, view.spawn + dt / 0.3);
    view.flash = Math.max(0, view.flash - dt * 4.5);
  }

  /** Body pose for this frame: [lunge forwards, lean into the blow, bob while walking]. The array is reused. */
  const POSE = [0, 0, 0];
  function pose(view, time) {
    const { def } = view;
    const blow = Math.sin((1 - view.swing) * Math.PI) * (view.swing > 0 ? 1 : 0);
    const lunge = def.shot || def.building ? 0 : blow * 0.38 * view.scale;
    const lean = def.building ? 0 : def.slam ? blow * 0.5 : def.shot ? -blow * 0.16 : blow * 0.36;
    const bob = view.moving * Math.abs(Math.sin(time * 9 + view.phase)) * 0.09 * view.scale;
    POSE[0] = lunge;
    POSE[1] = lean;
    POSE[2] = bob;
    return POSE;
  }

  function draw(view, time) {
    const { def, kind, palette } = view;
    const [lunge, lean, bob] = pose(view, time);
    const grow = 1 - (1 - view.spawn) ** 3;
    const size = view.scale * grow * (0.25 + 0.75 * view.life) * (def.building ? 1 + Math.sin((1 - view.swing) * Math.PI) * 0.06 * (view.swing > 0 ? 1 : 0) : 1);
    const heading = def.building ? 0 : view.facing;

    position.set(view.x + Math.sin(heading) * lunge, view.y + bob - (1 - view.life) * def.height * 0.5, view.z + Math.cos(heading) * lunge);
    euler.set(lean, heading, 0);
    matrix.compose(position, quaternion.setFromEuler(euler), scale.setScalar(size));

    // Instance colour: frost tint while slowed, gold while stunned, a white flash when hit.
    if (view.flags & FLAG.slowed) color.setRGB(0.55, 0.85, 1.5);
    else if (view.flags & FLAG.stunned) color.setRGB(1.35, 1.2, 0.55);
    else color.setRGB(1, 1, 1);
    color.lerp(FLASH, view.flash * 0.7);

    const i = kind.count++;
    if (i >= CAPACITY) return;
    for (const mesh of kind.meshes) {
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, color);
    }

    const ground = view.y + 0.04;
    addDecal(view.x, ground, view.z, def.radius * 1.6, 0, 0.3 * view.life, 0x000000);
    addDecal(view.x, ground + 0.01, view.z, Math.max(def.radius * 1.35, 0.3 * view.scale + 0.25), 1, 0.9 * view.life, palette.team);
    if (def.building && view.life === 1) addDecal(view.x, ground, view.z, def.range, 2, 0.5, 0x9fe9ff);
    if (view.life === 1) {
      const width = Math.min(2.6, Math.max(1.1, def.radius * 2.4));
      addBar(view.x, view.y + def.height * grow + 0.4, view.z, width, view.scale > 2 ? 0.26 : 0.18, view.hp / def.hp, palette.bar);
    }
  }

  function drawHero(view, time, dt) {
    const hero = heroes[view.side];
    const { flags } = view;
    const dead = Boolean(flags & FLAG.dead);
    hero.group.visible = !dead;
    if (dead) return;
    const [lunge, lean, bob] = pose(view, time);
    hero.group.position.set(view.x, view.y, view.z);
    hero.body.position.set(Math.sin(view.facing) * lunge, 0.05 + bob, Math.cos(view.facing) * lunge);
    hero.body.rotation.set(lean, view.facing, 0, 'YXZ');
    hero.ring.rotation.y = time * 0.9;
    // Lit from within for a moment when struck.
    hero.body.scale.setScalar(hero.size * (1 + view.flash * 0.06));

    // Stride: the legs scissor and the shield arm swings against them, in step with the ground covered.
    const stride = Math.sin(view.gait) * 0.8 * view.moving;
    hero.legs[0].rotation.x = stride;
    hero.legs[1].rotation.x = -stride;
    hero.shieldArm.rotation.x = -stride * 0.5 - view.moving * 0.15;
    // Sword arm: wind up over the shoulder, cut down in front, recover. The blade turns at the wrist to extend the arm.
    const t = view.swing > 0 ? 1 - view.swing : 1;
    let arm = stride * 0.5;
    let wrist = 0;
    if (t < 0.22) {
      arm = -3.4 * (t / 0.22);
      wrist = 3 * (t / 0.22);
    } else if (t < 0.55) {
      arm = -3.4 + 2.5 * (1 - (1 - (t - 0.22) / 0.33) ** 3);
      wrist = 3;
    } else if (t < 1) {
      const settle = (t - 0.55) / 0.45;
      arm = -0.9 * (1 - settle) + stride * 0.5 * settle;
      wrist = 3 * (1 - settle);
    }
    hero.swordArm.rotation.x = arm;
    hero.blade.rotation.x = wrist;

    // Aegis Shield: pops open, then turns for as long as it holds; it flares when it soaks a blow.
    const shielded = Boolean(flags & FLAG.shielded);
    hero.shield.visible = shielded;
    if (shielded) {
      view.shieldAge += dt;
      const open = Math.min(1, view.shieldAge / 0.28);
      const overshoot = 1 + 2.2 * (open - 1) ** 3 + 1.2 * (open - 1) ** 2;
      hero.shield.scale.setScalar(1.8 * (0.35 + 0.65 * overshoot));
      hero.lattice.rotation.set(time * 0.7, time * 1.4, 0);
      hero.shell.rotation.y = -time * 0.5;
      hero.shell.material.opacity = 0.17 + 0.05 * Math.sin(time * 5) + 0.3 * view.flash;
      hero.hoops[0].rotation.set(1.05, time * 2.2, 0);
      hero.hoops[1].rotation.set(-1.05, -time * 1.7, 0);
    }

    const empowered = Boolean(flags & FLAG.empowered);
    hero.power.visible = empowered;
    if (empowered) {
      hero.power.scale.setScalar(1.5 + Math.sin(time * 9) * 0.1);
      hero.power.rotation.y = time * 2;
    }

    const stunned = Boolean(flags & FLAG.stunned);
    const vampiric = Boolean(flags & FLAG.lifesteal);
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * TAU;
      hero.stars[i].visible = stunned;
      hero.stars[i].position.set(Math.cos(time * 6 + angle) * 0.55, 3.1, Math.sin(time * 6 + angle) * 0.55);
      hero.wisps[i].visible = vampiric;
      hero.wisps[i].position.set(Math.cos(time * 2.4 + angle) * 1.05, 0.9 + 0.5 * Math.sin(time * 3 + angle * 2), Math.sin(time * 2.4 + angle) * 1.05);
    }

    // Auras on the ground, and what the running buffs shed into the air.
    const ground = view.y + 0.05;
    if (vampiric) addDecal(view.x, ground, view.z, 1.5, 1, 0.75, colors.lifesteal);
    if (empowered) addDecal(view.x, ground, view.z, 1.85, 1, 0.8, colors.rune.damage);
    if (flags & FLAG.hasted) addDecal(view.x, ground, view.z, 1.85, 1, 0.8, colors.rune.haste);
    if (flags & FLAG.regen) addDecal(view.x, ground, view.z, 1.85, 1, 0.8, colors.rune.regen);
    view.shed += dt;
    if (view.shed > 0.09) {
      view.shed = 0;
      // Haste leaves a streak of light behind a running hero; Arcane Regen lifts motes around it.
      if (flags & FLAG.hasted && view.moving > 0.5) fx.flash(view.x, view.y + 0.9, view.z, colors.rune.haste, 2.4, 0.4);
      if (flags & FLAG.regen) fx.rise(view.x, view.z, 0.9, colors.rune.regen, 2, 0.8, 1.2);
      if (empowered) fx.rise(view.x, view.z, 0.7, colors.rune.damage, 1, 0.6, 1.6);
    }
  }

  function update(dt, time) {
    for (const kind of kinds.values()) kind.count = 0;
    bars.geometry.instanceCount = 0;
    decals.geometry.instanceCount = 0;

    for (const view of views.values()) {
      advance(view, dt);
      if (view.type === 'hero') drawHero(view, time, dt);
      else draw(view, time);
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      const view = dying[i];
      view.life -= dt / DEATH_S;
      if (view.life <= 0) dying.splice(i, 1);
      else draw(view, time);
    }

    for (const kind of kinds.values()) {
      for (const mesh of kind.meshes) {
        mesh.count = Math.min(kind.count, CAPACITY);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
      }
    }
    for (const quads of [bars, decals]) {
      for (const attribute of Object.values(quads.geometry.attributes)) {
        if (attribute.isInstancedBufferAttribute) attribute.needsUpdate = true;
      }
    }
  }

  return {
    sync,
    update,
    point,

    /** The smoothed position of a side's hero, or null before the first snapshot. */
    hero(side) {
      const view = heroViews[side];
      return view ? { x: view.x, y: view.y, z: view.z, facing: view.facing, dead: Boolean(view.flags & FLAG.dead) } : null;
    },

    /**
     * Id of the enemy of `side` under a ground point, or 0. A click lands on a
     * unit's body, which the tilted camera shows stretched up-screen from its
     * feet, so the whole of that stretch counts.
     */
    pick(x, z, side) {
      let best = 0;
      let bestGap = Infinity;
      for (const view of views.values()) {
        if (view.side === side || view.flags & FLAG.dead) continue;
        const reach = (view.def.height * 0.85) / tanPitch;
        const nearest = Math.min(view.z, Math.max(view.z - reach, z));
        const gap = Math.hypot(view.x - x, nearest - z) - view.def.radius;
        if (gap < 0.5 && gap < bestGap) {
          best = view.id;
          bestGap = gap;
        }
      }
      return best;
    },

    clear() {
      views.clear();
      dying.length = 0;
      heroViews.radiant = heroViews.dire = null;
      for (const side of SIDES) heroes[side].group.visible = false;
      update(0, 0);
    },

    count: () => views.size,
  };
}
