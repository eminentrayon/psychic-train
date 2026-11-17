/**
 * RuneDeck — data and rules shared by the server simulation and the browser.
 * Plain ES module: no DOM and no Node APIs, so both sides can import it.
 */

export const SIDES = ['radiant', 'dire'];

export const opposite = (side) => (side === 'radiant' ? 'dire' : 'radiant');

/**
 * Battlefield layout in world units. Radiant holds -X (screen left) and Dire +X.
 * The top lane runs along -Z, the bottom lane along +Z, and the River follows X ≈ 0.
 */
export const MAP = {
  halfWidth: 22,
  halfDepth: 12,
  laneZ: 6.5,
  towerX: 10,
  throneX: 18.5,
  heroX: 12.6,
  bridgeHalfLength: 3.3,
  /** River shape. The renderer injects these same numbers into its shaders. */
  river: {
    amp1: 0.45,
    freq1: 0.42,
    amp2: 0.12,
    freq2: 1.1,
    phase2: 1.7,
    halfWidth: 2,
    wobble: 0.25,
    wobbleFreq: 0.8,
    wobblePhase: 0.5,
    poolRadius: 3.4,
    blend: 1.2,
  },
};

export const MATCH = {
  durationMs: 210_000,
  tickMs: 50,
  snapshotMs: 100,
  handSize: 4,
  elixirMax: 10,
  elixirStart: 5,
  elixirIntervalMs: 2_500,
  runeFirstSpawnMs: 30_000,
  runeIntervalMs: 45_000,
  waveFirstMs: 1_500,
  waveIntervalMs: 20_000,
  heroRespawnMs: 8_000,
  /** Each side stops receiving lane waves above this many living units. */
  unitCap: 44,
};

export const HERO = {
  id: 'aether_knight',
  name: 'Aether Knight',
  role: 'Melee Vanguard',
  description:
    'A rift-forged champion who leads every charge. Move and attack with the mouse, then turn the fight with four abilities.',
  maxHp: 1200,
  maxMana: 400,
  hpRegen: 3,
  manaRegen: 5,
  /** Regeneration per second while standing beside the hero's own Throne. */
  fountainRadius: 6,
  fountainHp: 70,
  fountainMana: 30,
  startGold: 600,
  goldPerSecond: 2,
  abilities: [
    {
      key: 'Q',
      id: 'slash_dash',
      name: 'Slash Dash',
      manaCost: 45,
      cooldownMs: 6_000,
      range: 6,
      width: 1.6,
      damage: 130,
      description: 'Dash towards the cursor and slash every enemy in the path.',
    },
    {
      key: 'W',
      id: 'aegis_shield',
      name: 'Aegis Shield',
      manaCost: 60,
      cooldownMs: 14_000,
      shield: 350,
      durationMs: 5_000,
      description: 'Raise a barrier that absorbs 350 damage for 5 seconds.',
    },
    {
      key: 'E',
      id: 'thunder_strike',
      name: 'Thunder Strike',
      manaCost: 80,
      cooldownMs: 10_000,
      range: 8,
      radius: 2.6,
      damage: 170,
      stunMs: 1_300,
      description: 'Call down lightning at the cursor that damages and stuns in an area.',
    },
    {
      key: 'R',
      id: 'divine_judgment',
      name: 'Divine Judgment',
      manaCost: 150,
      cooldownMs: 60_000,
      range: 10,
      radius: 4.2,
      damage: 420,
      delayMs: 700,
      ultimate: true,
      description: 'Ultimate. A pillar of holy light devastates a large area at the cursor.',
    },
  ],
  items: [
    {
      key: 'Z',
      id: 'blink_boots',
      name: 'Blink Boots',
      cooldownMs: 12_000,
      range: 7,
      description: 'Teleport a short distance towards the cursor.',
    },
    {
      key: 'X',
      id: 'lifesteal_blade',
      name: 'Lifesteal Blade',
      passive: true,
      lifesteal: 0.18,
      description: 'Passive. Hero attacks restore 18% of the damage dealt as health.',
    },
    {
      key: 'C',
      id: 'power_rune',
      name: 'Power Rune Slot',
      holdsRune: true,
      durationMs: 12_000,
      damageMultiplier: 2,
      description: 'Walk onto the River pad to take a Power Rune, then press C for double damage for 12 seconds.',
    },
  ],
};

/** Share of ability damage that structures take. */
export const ABILITY_STRUCTURE_FACTOR = 0.4;

/**
 * Everything that walks or is built during a match. `range` is measured from
 * the unit's centre to the target's edge; `aggro` is how far it looks for a fight.
 * `shot` units fire a projectile, `beam` units hit instantly, the rest swing in melee.
 * `siege` is the share of their damage that Towers and Thrones take.
 * `height` and `scale` only matter to the renderer: how tall the unit stands and how large its model is drawn.
 */
export const UNITS = {
  hero: { name: HERO.name, hp: HERO.maxHp, damage: 62, siege: 0.3, range: 1.5, attackMs: 850, speed: 5.4, radius: 0.6, aggro: 4.5, bounty: 150, height: 2.3 },
  melee: { name: 'Melee Creep', hp: 300, damage: 21, siege: 0.3, range: 1.1, attackMs: 1_000, speed: 3.3, radius: 0.42, aggro: 5.5, bounty: 14, height: 1.7, scale: 1.4 },
  ranged: { name: 'Ranged Creep', hp: 190, damage: 30, siege: 0.3, range: 5.2, attackMs: 1_300, speed: 3.3, radius: 0.4, aggro: 6.5, bounty: 16, height: 1.8, scale: 1.4, shot: 'bolt', shotSpeed: 15 },
  footman: { name: 'Footman', hp: 460, damage: 40, siege: 0.3, range: 1.2, attackMs: 1_000, speed: 3.5, radius: 0.46, aggro: 5.5, bounty: 12, height: 2.3, scale: 1.45 },
  archer: { name: 'Arcane Archer', hp: 250, damage: 58, siege: 0.3, range: 6.2, attackMs: 1_150, speed: 3.3, radius: 0.42, aggro: 7, bounty: 14, height: 2.3, scale: 1.45, shot: 'arcane', shotSpeed: 17 },
  golem: { name: 'Siege Golem', hp: 2200, damage: 110, siege: 1, range: 1.5, attackMs: 1_800, speed: 1.9, radius: 1.05, aggro: 9, bounty: 60, height: 3.6, scale: 2.5, buildingsOnly: true, slam: true },
  frost_tower: { name: 'Frost Tower', hp: 900, damage: 32, siege: 1, range: 6.5, attackMs: 900, speed: 0, radius: 0.9, aggro: 6.5, bounty: 30, height: 3.6, scale: 1.25, building: true, beam: true, slow: 0.45, slowMs: 1_600, lifetimeMs: 30_000 },
};

/** Fixed order: snapshots send a unit's type as an index into this list. */
export const UNIT_TYPES = Object.keys(UNITS);

/** Bit flags in a unit's snapshot entry. */
export const FLAG = { slowed: 1, stunned: 2, shielded: 4, dead: 8, empowered: 16 };

/**
 * `zone` is where a card may be played: 'own' is the player's bank of the River,
 * 'any' is the whole field. `radius` is the footprint or area of effect.
 */
export const DECK = [
  {
    id: 'footmen_squad',
    name: 'Footmen Squad',
    cost: 3,
    type: 'Troop',
    tagline: 'Melee trio',
    description: 'Deploys three armored footmen who march down the lane and hold the front line.',
    traits: ['3 Units', 'Melee', 'Frontline'],
    zone: 'own',
    radius: 1.3,
    spawns: 'footman',
    count: 3,
  },
  {
    id: 'arcane_archer',
    name: 'Arcane Archer',
    cost: 3,
    type: 'Troop',
    tagline: 'Ranged DPS',
    description: 'Two hooded marksmen who loose arcane bolts from safely behind the front line.',
    traits: ['2 Units', 'Ranged', 'High Damage'],
    zone: 'own',
    radius: 1,
    spawns: 'archer',
    count: 2,
  },
  {
    id: 'siege_golem',
    name: 'Siege Golem',
    cost: 5,
    type: 'Troop',
    tagline: 'High-HP tower tank',
    description: 'A lumbering stone colossus that ignores troops, marches on enemy buildings and smashes them with ground slams.',
    traits: ['1 Unit', 'Very High HP', 'Targets Buildings'],
    zone: 'own',
    radius: 1.5,
    spawns: 'golem',
    count: 1,
  },
  {
    id: 'fireball',
    name: 'Fireball',
    cost: 4,
    type: 'Spell',
    tagline: 'AoE spell',
    description: 'Hurls a blazing meteor from your Throne that explodes on impact, scorching every enemy in its radius.',
    traits: ['Area Damage', 'Hits Buildings'],
    zone: 'any',
    radius: 2.6,
    travelMs: 900,
    damage: 260,
    structureDamage: 160,
  },
  {
    id: 'frost_tower',
    name: 'Frost Tower',
    cost: 4,
    type: 'Building',
    tagline: 'Defensive slowing building',
    description: 'A crystalline turret that fires icy beams, damaging and slowing enemies in range. Lasts 30 seconds.',
    traits: ['Structure', 'Slows Enemies', '30 Seconds'],
    zone: 'own',
    radius: 1.6,
    spawns: 'frost_tower',
    count: 1,
  },
  {
    id: 'healing_wave',
    name: 'Healing Wave',
    cost: 2,
    type: 'Spell',
    tagline: 'Ally & Hero heal spell',
    description: 'A surge of restorative light that mends your Hero and every allied unit in the target area.',
    traits: ['Instant', 'Area Heal', 'Heals Hero'],
    zone: 'any',
    radius: 3.2,
    heal: 300,
  },
];

function structure(side, kind, lane = null) {
  const sign = side === 'radiant' ? -1 : 1;
  const throne = kind === 'throne';
  return {
    id: throne ? `${side}_throne` : `${side}_${lane}`,
    side,
    kind,
    lane,
    label: throne ? 'Ancient Throne' : `${lane === 'top' ? 'Top' : 'Bottom'} Tower`,
    x: sign * (throne ? MAP.throneX : MAP.towerX),
    z: throne ? 0 : lane === 'top' ? -MAP.laneZ : MAP.laneZ,
    maxHp: throne ? 4000 : 2500,
    radius: throne ? 3 : 1.6,
    height: throne ? 6.4 : 5.4,
    /** Height the structure fires from. */
    muzzle: throne ? 5 : 4.6,
    damage: throne ? 140 : 100,
    range: throne ? 8 : 7.5,
    attackMs: throne ? 900 : 1_000,
    shotSpeed: 17,
    bounty: throne ? 0 : 200,
  };
}

/** Fixed order: snapshots send structure state as an array in this order. */
export const STRUCTURES = [
  structure('radiant', 'throne'),
  structure('radiant', 'tower', 'top'),
  structure('radiant', 'tower', 'bottom'),
  structure('dire', 'throne'),
  structure('dire', 'tower', 'top'),
  structure('dire', 'tower', 'bottom'),
];

/**
 * Lane routes from the Radiant Throne gate to the Dire one. Radiant units walk
 * them forwards and Dire units backwards. Each route swings round the inner
 * side of both towers and crosses the River on its bridge.
 */
const LANE_SHAPE = [
  [-16.5, 3.5], [-14, 6.3], [-12.2, 5.3], [-10, 4.25], [-7.8, 5.3], [-5.6, 6.5], [-3.5, 6.5],
  [3.5, 6.5], [5.6, 6.5], [7.8, 5.3], [10, 4.25], [12.2, 5.3], [14, 6.3], [16.5, 3.5],
];

export const LANES = {
  top: LANE_SHAPE.map(([x, z]) => ({ x, z: -z })),
  bottom: LANE_SHAPE.map(([x, z]) => ({ x, z })),
};

export function heroSpawn(side) {
  return { x: side === 'radiant' ? -MAP.heroX : MAP.heroX, z: 0 };
}

/** X of the River's centre line at depth `z`. */
export function riverCenter(z) {
  const r = MAP.river;
  return Math.sin(z * r.freq1) * r.amp1 + Math.sin(z * r.freq2 + r.phase2) * r.amp2;
}

/** Signed distance to the water's edge: negative in the River or the rune pool. */
export function riverDistance(x, z) {
  const r = MAP.river;
  const channel = Math.abs(x - riverCenter(z)) - (r.halfWidth + r.wobble * Math.sin(z * r.wobbleFreq + r.wobblePhase));
  const pool = Math.hypot(x, z) - r.poolRadius;
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (pool - channel)) / r.blend));
  return pool + (channel - pool) * h - r.blend * h * (1 - h);
}

const onBridge = (x, z, margin) => Math.abs(x) < MAP.bridgeHalfLength + 0.4 && Math.abs(Math.abs(z) - MAP.laneZ) < margin;

/** Whether a unit may stand at a point: dry land, a bridge, or the rune pad and its stepping stones. */
export function walkable(x, z) {
  if (Math.abs(x) > MAP.halfWidth || Math.abs(z) > MAP.halfDepth) return false;
  if (riverDistance(x, z) > 0.25) return true;
  if (onBridge(x, z, 0.95)) return true;
  return Math.hypot(x, z) < 1.7 || (Math.abs(z) < 0.75 && Math.abs(x) < 4.2);
}

/** Height of the walking surface, so units climb the bridge arches and the rune pad. */
export function groundHeight(x, z) {
  const half = MAP.bridgeHalfLength;
  if (Math.abs(x) < half + 0.6 && Math.abs(Math.abs(z) - MAP.laneZ) < 1.4) {
    const ramp = Math.min(1, (half + 0.6 - Math.abs(x)) / 0.6);
    const arch = Math.cos((Math.min(Math.abs(x), half) / half) * (Math.PI / 2));
    // The top bridge is timber, the bottom one stone; their decks sit at different heights.
    return ramp * (z < 0 ? 0.24 + 0.26 * arch : 0.12 + 0.42 * arch);
  }
  const pad = Math.hypot(x, z);
  if (pad < 1.9) return 0.42 * Math.min(1, (1.9 - pad) / 0.4);
  return 0;
}

/** Whether `side` may play `card` at a point. The server enforces this; the client previews it. */
export function canDeploy(card, side, x, z) {
  if (Math.abs(x) > MAP.halfWidth - 0.5 || Math.abs(z) > MAP.halfDepth - 0.5) {
    return { ok: false, reason: 'That is outside the battlefield' };
  }
  if (card.zone === 'any') return { ok: true };

  const plural = `${card.type}s`;
  if (riverDistance(x, z) < 0.5) return { ok: false, reason: `${plural} cannot be placed in the River` };
  if (side === 'radiant' ? x > 0 : x < 0) {
    return { ok: false, reason: `${plural} must be placed on your side of the River` };
  }
  if (STRUCTURES.some((s) => Math.hypot(x - s.x, z - s.z) < s.radius + 0.5)) {
    return { ok: false, reason: 'Too close to a structure' };
  }
  return { ok: true };
}
