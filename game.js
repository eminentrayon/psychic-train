/**
 * RuneDeck — authoritative match simulation.
 *
 * The server owns every unit: lane creeps, card troops, Frost Towers, both
 * heroes, and the projectiles that towers and ranged units fire. All damage
 * comes from one of those attacks or from a spell landing; nothing is scripted.
 *
 * Sent to each player
 *   game:state    snapshot ten times a second: structures, units, and the player's private state
 *   game:events   [{ type: 'card' | 'cast' | 'item' | 'rune' | 'runeTaken' | 'heroDown' | 'reject', ... }]
 *   game:over     { winner, reason, totals }
 *
 * Attacks are not events. Every unit and structure carries an attack counter and
 * its target's id in the snapshot; the client plays a swing or fires a
 * projectile whenever the counter changes.
 */

import {
  ABILITY_STRUCTURE_FACTOR,
  DECK,
  FLAG,
  HERO,
  LANES,
  MAP,
  MATCH,
  SIDES,
  STRUCTURES,
  UNITS,
  UNIT_TYPES,
  canDeploy,
  heroSpawn,
  opposite,
  walkable,
} from './public/shared.js';
import { createBot } from './bot.js';

const CARDS = new Map(DECK.map((card) => [card.id, card]));
const ABILITIES = new Map(HERO.abilities.map((ability) => [ability.key, ability]));
const ITEMS = new Map(HERO.items.map((item) => [item.key, item]));
const TYPE_INDEX = new Map(UNIT_TYPES.map((type, index) => [type, index]));
const LIFESTEAL = HERO.items.find((item) => item.lifesteal).lifesteal;
const RUNE = HERO.items.find((item) => item.holdsRune);
const RUNE_PICKUP_RADIUS = 1.8;
/** Where a hero steps on and off a bridge, and onto the rune pad's stepping stones. */
const BRIDGE_END_X = 3.7;
const STONES_END_X = 4.1;
/** Spawn offsets by squad size: [forward, sideways]. */
const FORMATIONS = { 1: [[0, 0]], 2: [[0, 0.55], [0, -0.55]], 3: [[0.6, 0], [-0.3, 0.6], [-0.3, -0.6]] };

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const round = (value) => Math.round(value * 100) / 100;
const alive = (target) => Boolean(target) && target.hp > 0 && !target.dead;

/** Distance from point `p` to the segment a-b. */
function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t = length2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/** -1 on Radiant's bank, 1 on Dire's, 0 over the River (a bridge or the rune pad). */
const bankOf = (x) => (x < -3.05 ? -1 : x > 3.05 ? 1 : 0);

/**
 * Waypoints for a hero walking from `from` to `to`. The River can only be
 * crossed on a bridge, so a trip to the far bank goes by the nearer one.
 */
function route(from, to) {
  const a = bankOf(from.x);
  const b = bankOf(to.x);
  const path = [];
  if (a !== b && a !== 0 && b !== 0) {
    const cost = (z) => Math.hypot(from.x - a * BRIDGE_END_X, from.z - z) + Math.hypot(to.x - b * BRIDGE_END_X, to.z - z);
    const z = cost(-MAP.laneZ) < cost(MAP.laneZ) ? -MAP.laneZ : MAP.laneZ;
    path.push({ x: a * BRIDGE_END_X, z }, { x: b * BRIDGE_END_X, z });
  } else if (a !== b) {
    // One end is on a bridge or the rune pad: line up with it on the bank first.
    const over = a === 0 ? from : to;
    const onBridge = Math.abs(over.z) > 3;
    path.push({ x: (a || b) * (onBridge ? BRIDGE_END_X : STONES_END_X), z: onBridge ? Math.sign(over.z) * MAP.laneZ : 0 });
  }
  path.push({ x: to.x, z: to.z });
  // A waypoint the hero is already standing on would hold it there.
  while (path.length > 1 && Math.hypot(path[0].x - from.x, path[0].z - from.z) < 0.3) path.shift();
  return path;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * @param {{
 *   players: Record<'radiant' | 'dire', { nickname: string, isBot: boolean }>,
 *   emit: (side: string, event: string, payload: object) => void,
 *   onOver: () => void,
 * }} options
 */
export function createGame({ players, emit, onOver }) {
  /** Towers and Thrones carry the same target fields as units, so combat code treats them alike. */
  const structures = STRUCTURES.map((def, index) => ({
    def,
    id: -(index + 1),
    side: def.side,
    x: def.x,
    z: def.z,
    radius: def.radius,
    hp: def.maxHp,
    maxHp: def.maxHp,
    building: true,
    isStructure: true,
    target: null,
    cooldown: 0,
    atk: 0,
    atkTarget: 0,
  }));
  /** Every unit, Frost Tower and hero in play. A dead hero stays listed until it respawns. */
  const units = [];
  const projectiles = [];
  /** Delayed effects such as a Fireball in flight, ordered by due time. */
  const pending = [];
  const outbox = { radiant: [], dire: [] };

  let nextId = 1;
  let elapsedMs = 0;
  let nextWaveMs = MATCH.waveFirstMs;
  let nextRuneMs = MATCH.runeFirstSpawnMs;
  let runeActive = false;
  let over = false;
  let lastTick = performance.now();
  let sinceSnapshot = 0;

  const teams = { radiant: createTeam('radiant'), dire: createTeam('dire') };
  const bots = SIDES.filter((side) => players[side].isBot).map((side) =>
    createBot({
      side,
      team: teams[side],
      units,
      structures,
      runeActive: () => runeActive,
      intents: { playCard, cast, useItem, heroMove, heroAttack },
    }),
  );
  const timer = setInterval(tick, MATCH.tickMs);

  /* ---------------------------------------------------------------- Setup */

  function createTeam(side) {
    const deck = shuffle(DECK.map((card) => card.id));
    const spawnPoint = heroSpawn(side);
    const hero = spawn('hero', side, spawnPoint.x, spawnPoint.z);
    Object.assign(hero, {
      mana: HERO.maxMana,
      level: 1,
      gold: HERO.startGold,
      readyAt: {},
      order: null,
      dead: false,
      respawnAt: 0,
      shield: 0,
      shieldUntil: 0,
      rune: false,
      empowerUntil: 0,
    });
    return { side, elixir: MATCH.elixirStart, hand: deck.slice(0, MATCH.handSize), queue: deck.slice(MATCH.handSize), hero };
  }

  function spawn(type, side, x, z, lane = null) {
    const def = UNITS[type];
    const unit = {
      id: nextId++,
      type,
      def,
      side,
      x,
      z,
      radius: def.radius,
      hp: def.hp,
      maxHp: def.hp,
      building: Boolean(def.building),
      isHero: type === 'hero',
      lane,
      wp: 0,
      // Sideways offset from the lane's centre line, so a wave does not march in single file.
      drift: (Math.random() - 0.5) * 0.9,
      target: null,
      scanAt: 0,
      cooldown: 300 + Math.random() * 400,
      atk: 0,
      atkTarget: 0,
      slowUntil: 0,
      stunUntil: 0,
      blockedMs: 0,
      ignore: null,
      ignoreUntil: 0,
      expiresAt: def.lifetimeMs ? elapsedMs + def.lifetimeMs : Infinity,
    };
    if (lane) unit.wp = firstWaypoint(unit);
    units.push(unit);
    return unit;
  }

  /** The first point of the unit's lane that still lies ahead of it. */
  function firstWaypoint(unit) {
    const path = LANES[unit.lane];
    if (unit.side === 'radiant') {
      const index = path.findIndex((point) => point.x > unit.x + 0.3);
      return index === -1 ? path.length - 1 : index;
    }
    const index = path.findLastIndex((point) => point.x < unit.x - 0.3);
    return index === -1 ? 0 : index;
  }

  /** Three melee creeps and a ranged creep leave each Throne for each lane. */
  function spawnWave() {
    for (const side of SIDES) {
      if (units.filter((unit) => unit.side === side).length >= MATCH.unitCap) continue;
      const forward = side === 'radiant' ? 1 : -1;
      for (const lane of ['top', 'bottom']) {
        const path = LANES[lane];
        const gate = side === 'radiant' ? path[0] : path[path.length - 1];
        for (const [ahead, across] of FORMATIONS[3]) spawn('melee', side, gate.x + ahead * forward, gate.z + across, lane);
        spawn('ranged', side, gate.x - 0.8 * forward, gate.z, lane);
      }
    }
  }

  /* ---------------------------------------------------------------- Messaging */

  function broadcast(event) {
    for (const side of SIDES) outbox[side].push(event);
  }

  function reject(side, reason) {
    outbox[side].push({ type: 'reject', reason });
  }

  function flush() {
    for (const side of SIDES) {
      if (outbox[side].length) emit(side, 'game:events', outbox[side].splice(0));
    }
  }

  function schedule(delayMs, run) {
    const at = elapsedMs + delayMs;
    let index = pending.length;
    while (index > 0 && pending[index - 1].at > at) index--;
    pending.splice(index, 0, { at, run });
  }

  function flagsOf(unit) {
    return (
      (unit.slowUntil > elapsedMs ? FLAG.slowed : 0) |
      (unit.stunUntil > elapsedMs ? FLAG.stunned : 0) |
      (unit.shieldUntil > elapsedMs && unit.shield > 0 ? FLAG.shielded : 0) |
      (unit.dead ? FLAG.dead : 0) |
      (unit.empowerUntil > elapsedMs ? FLAG.empowered : 0)
    );
  }

  /** The part of a snapshot both players share. */
  function worldState() {
    return {
      timeLeftMs: Math.max(0, MATCH.durationMs - elapsedMs),
      rune: { active: runeActive, nextInMs: Math.max(0, nextRuneMs - elapsedMs) },
      structures: structures.map((s) => [Math.ceil(s.hp), s.atk, s.atkTarget]),
      units: units.map((u) => [
        u.id,
        TYPE_INDEX.get(u.type),
        u.side === 'radiant' ? 0 : 1,
        round(u.x),
        round(u.z),
        Math.ceil(u.hp),
        u.atk,
        u.atkTarget,
        flagsOf(u),
      ]),
    };
  }

  function privateState(side) {
    const team = teams[side];
    const { hero } = team;
    const cooldowns = {};
    for (const key of [...ABILITIES.keys(), ...ITEMS.keys()]) {
      cooldowns[key] = Math.max(0, (hero.readyAt[key] ?? 0) - elapsedMs);
    }
    return {
      elixir: team.elixir,
      hand: team.hand,
      next: team.queue[0],
      hero: {
        id: hero.id,
        hp: hero.hp,
        mana: hero.mana,
        level: hero.level,
        gold: Math.floor(hero.gold),
        rune: hero.rune,
        respawnMs: hero.dead ? Math.max(0, hero.respawnAt - elapsedMs) : 0,
      },
      cooldowns,
    };
  }

  const snapshot = (side) => ({ ...worldState(), you: privateState(side) });

  function sendSnapshots() {
    const world = worldState();
    for (const side of SIDES) emit(side, 'game:state', { ...world, you: privateState(side) });
  }

  /* ---------------------------------------------------------------- Movement */

  /** Moves by (dx, dz), sliding along whichever axis stays on walkable ground. */
  function tryMove(unit, dx, dz) {
    if (walkable(unit.x + dx, unit.z + dz)) {
      unit.x += dx;
      unit.z += dz;
    } else if (dx && walkable(unit.x + dx, unit.z)) {
      unit.x += dx;
    } else if (dz && walkable(unit.x, unit.z + dz)) {
      unit.z += dz;
    }
  }

  /** One tick of walking towards a point. `blockedMs` grows while no real progress is made. */
  function stepToward(unit, x, z, dt) {
    const before = Math.hypot(x - unit.x, z - unit.z);
    if (before < 0.01) return;
    const slowed = unit.slowUntil > elapsedMs ? 1 - UNITS.frost_tower.slow : 1;
    const step = Math.min(before, (unit.def.speed * slowed * dt) / 1000);
    tryMove(unit, ((x - unit.x) / before) * step, ((z - unit.z) / before) * step);
    const gained = before - Math.hypot(x - unit.x, z - unit.z);
    unit.blockedMs = gained > step * 0.3 ? 0 : unit.blockedMs + dt;
  }

  function followLane(unit, dt) {
    const path = LANES[unit.lane];
    const forward = unit.side === 'radiant' ? 1 : -1;
    const last = forward > 0 ? path.length - 1 : 0;
    const point = path[unit.wp];
    // The bridges are too narrow for the full sideways drift.
    const z = point.z + (Math.abs(point.x) < 4 ? unit.drift * 0.5 : unit.drift);
    if (Math.hypot(point.x - unit.x, z - unit.z) < 0.7 || unit.blockedMs > 1_200) {
      unit.blockedMs = 0;
      if (unit.wp === last) return;
      unit.wp += forward;
    }
    stepToward(unit, point.x, z, dt);
  }

  /** Keeps units from stacking on each other and from walking through buildings. */
  function separate() {
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (!alive(a)) continue;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j];
        if (!alive(b) || (a.building && b.building)) continue;
        const min = a.radius + b.radius;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        let d = Math.sqrt(d2);
        if (d < 0.001) {
          // Exactly stacked: pick a direction that differs per pair.
          dx = Math.cos(a.id * 7 + b.id);
          dz = Math.sin(a.id * 7 + b.id);
          d = 1;
        }
        // Heavier units give way less; buildings not at all.
        const massA = a.building ? Infinity : a.radius ** 2;
        const massB = b.building ? Infinity : b.radius ** 2;
        const overlap = (min - d) / d;
        const shareA = massB === Infinity ? 1 : massA === Infinity ? 0 : massB / (massA + massB);
        if (shareA > 0) tryMove(a, -dx * overlap * shareA, -dz * overlap * shareA);
        if (shareA < 1) tryMove(b, dx * overlap * (1 - shareA), dz * overlap * (1 - shareA));
      }
      if (a.building) continue;
      for (const s of structures) {
        if (s.hp <= 0) continue;
        const min = s.radius + a.radius;
        const dx = a.x - s.x;
        const dz = a.z - s.z;
        const d = Math.hypot(dx, dz);
        if (d < min && d > 0.001) tryMove(a, (dx / d) * (min - d), (dz / d) * (min - d));
      }
    }
  }

  /* ---------------------------------------------------------------- Combat */

  const powerOf = (unit) => (unit.empowerUntil > elapsedMs ? RUNE.damageMultiplier : 1);

  /** The closest enemy this unit is allowed to fight and can see. */
  function acquire(unit) {
    const sight = unit.def.speed ? unit.def.aggro : unit.def.range;
    let best = null;
    let bestGap = Infinity;
    const consider = (target) => {
      if (target.side === unit.side || !alive(target)) return;
      if (unit.def.buildingsOnly && !target.building) return;
      if (target === unit.ignore && unit.ignoreUntil > elapsedMs) return;
      const gap = distance(unit, target) - target.radius;
      if (gap <= sight && gap < bestGap) {
        best = target;
        bestGap = gap;
      }
    };
    for (const other of units) consider(other);
    for (const s of structures) consider(s);
    return best;
  }

  function strike(unit, target) {
    const { def } = unit;
    unit.cooldown = def.attackMs;
    unit.atk = (unit.atk + 1) % 64;
    unit.atkTarget = target.id;
    const damage = def.damage * powerOf(unit) * (target.isStructure ? def.siege : 1);
    if (def.shot) {
      projectiles.push({ x: unit.x, z: unit.z, tx: target.x, tz: target.z, target, speed: def.shotSpeed, damage, source: unit });
      return;
    }
    hurt(target, damage, unit);
    if (def.slowMs && !target.isStructure) target.slowUntil = elapsedMs + def.slowMs;
    if (unit.isHero) unit.hp = Math.min(unit.maxHp, unit.hp + damage * LIFESTEAL);
  }

  /** Attacks `target` if it is in reach, otherwise closes the distance. */
  function engage(unit, target, dt) {
    if (distance(unit, target) <= unit.def.range + target.radius) {
      unit.blockedMs = 0;
      if (unit.cooldown <= 0) strike(unit, target);
      return;
    }
    if (!unit.def.speed) return;
    if (unit.isHero) {
      const [next] = route(unit, target);
      stepToward(unit, next.x, next.z, dt);
      return;
    }
    stepToward(unit, target.x, target.z, dt);
    // A target across the water cannot be reached directly: forget it for a while and walk on.
    if (unit.blockedMs > 700) {
      unit.ignore = target;
      unit.ignoreUntil = elapsedMs + 2_500;
      unit.target = null;
      unit.blockedMs = 0;
    }
  }

  function think(unit, dt) {
    unit.cooldown -= dt;
    const { def } = unit;
    const leash = def.speed ? def.aggro + 2.5 : def.range;
    if (unit.target && (!alive(unit.target) || distance(unit, unit.target) > leash + unit.target.radius)) unit.target = null;
    if (!unit.target && unit.scanAt <= elapsedMs) {
      unit.scanAt = elapsedMs + 150 + Math.random() * 100;
      unit.target = acquire(unit);
    }
    if (unit.target) engage(unit, unit.target, dt);
    else if (unit.lane) followLane(unit, dt);
  }

  function thinkHero(hero, dt) {
    hero.cooldown -= dt;
    const { order } = hero;
    if (order?.target) {
      if (alive(order.target)) {
        hero.target = order.target;
        engage(hero, order.target, dt);
        return;
      }
      hero.order = null;
    } else if (order) {
      const point = order.path[0];
      if (distance(hero, point) < 0.2 || hero.blockedMs > 500) {
        hero.blockedMs = 0;
        order.path.shift();
        if (!order.path.length) hero.order = null;
      } else {
        stepToward(hero, point.x, point.z, dt);
      }
      hero.target = null;
      return;
    }
    // No orders: fight whatever comes close.
    if (!alive(hero.target) || distance(hero, hero.target) > hero.def.aggro + hero.target.radius + 2) hero.target = acquire(hero);
    if (hero.target) engage(hero, hero.target, dt);
  }

  /** Towers and Thrones fire at the closest enemy unit or hero inside their range. */
  function defend(s, dt) {
    s.cooldown -= dt;
    if (!alive(s.target) || distance(s, s.target) > s.def.range + s.target.radius) {
      s.target = null;
      let bestGap = s.def.range;
      for (const unit of units) {
        if (unit.side === s.side || !alive(unit)) continue;
        const gap = distance(s, unit) - unit.radius;
        if (gap <= bestGap) {
          s.target = unit;
          bestGap = gap;
        }
      }
    }
    if (!s.target || s.cooldown > 0) return;
    s.cooldown = s.def.attackMs;
    s.atk = (s.atk + 1) % 64;
    s.atkTarget = s.target.id;
    projectiles.push({ x: s.x, z: s.z, tx: s.target.x, tz: s.target.z, target: s.target, speed: s.def.shotSpeed, damage: s.def.damage, source: s });
  }

  /** Projectiles home on their target and deal their damage on arrival. */
  function moveProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const live = alive(p.target);
      if (live) {
        p.tx = p.target.x;
        p.tz = p.target.z;
      }
      const gap = Math.hypot(p.tx - p.x, p.tz - p.z);
      const step = (p.speed * dt) / 1000;
      if (gap <= step + (live ? p.target.radius * 0.5 : 0)) {
        if (live) hurt(p.target, p.damage, p.source);
        projectiles.splice(i, 1);
      } else {
        p.x += ((p.tx - p.x) / gap) * step;
        p.z += ((p.tz - p.z) / gap) * step;
      }
    }
  }

  function hurt(target, amount, source) {
    if (over || !alive(target)) return;
    if (target.shieldUntil > elapsedMs && target.shield > 0) {
      const absorbed = Math.min(target.shield, amount);
      target.shield -= absorbed;
      amount -= absorbed;
    }
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp > 0) return;

    teams[source ? source.side : opposite(target.side)].hero.gold += target.def.bounty;
    if (target.isStructure) {
      if (target.def.kind === 'throne') finish('throne', opposite(target.side));
    } else if (target.isHero) {
      target.dead = true;
      target.respawnAt = elapsedMs + MATCH.heroRespawnMs;
      target.order = null;
      target.target = null;
      broadcast({ type: 'heroDown', side: target.side, respawnMs: MATCH.heroRespawnMs });
    }
  }

  /** Damages every enemy of `side` that `hits` accepts. Structures take a reduced share and are never stunned. */
  function blast(side, source, damage, hits, stunMs = 0) {
    for (const unit of units) {
      if (unit.side === side || !alive(unit) || !hits(unit)) continue;
      hurt(unit, damage, source);
      if (stunMs && !unit.building) unit.stunUntil = elapsedMs + stunMs;
    }
    for (const s of structures) {
      if (s.side !== side && alive(s) && hits(s)) hurt(s, damage * ABILITY_STRUCTURE_FACTOR, source);
    }
  }

  /** Removes the fallen and any Frost Tower whose time is up. Heroes stay and respawn. */
  function sweep() {
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i];
      if (unit.isHero) continue;
      if (elapsedMs >= unit.expiresAt) unit.hp = 0;
      if (unit.hp <= 0) units.splice(i, 1);
    }
  }

  /* ---------------------------------------------------------------- Tick */

  function tick() {
    const now = performance.now();
    const dt = Math.min(now - lastTick, 250);
    lastTick = now;
    elapsedMs += dt;

    for (const side of SIDES) {
      const team = teams[side];
      const { hero } = team;
      team.elixir = Math.min(MATCH.elixirMax, team.elixir + dt / MATCH.elixirIntervalMs);
      hero.gold += (HERO.goldPerSecond * dt) / 1000;
      if (hero.dead) {
        if (elapsedMs >= hero.respawnAt) revive(hero);
        continue;
      }
      const home = structures[side === 'radiant' ? 0 : 3];
      const resting = distance(hero, home) < home.radius + HERO.fountainRadius;
      hero.hp = Math.min(hero.maxHp, hero.hp + ((resting ? HERO.fountainHp : HERO.hpRegen) * dt) / 1000);
      hero.mana = Math.min(HERO.maxMana, hero.mana + ((resting ? HERO.fountainMana : HERO.manaRegen) * dt) / 1000);
      if (runeActive && Math.hypot(hero.x, hero.z) < RUNE_PICKUP_RADIUS) {
        runeActive = false;
        hero.rune = true;
        broadcast({ type: 'runeTaken', side });
      }
    }

    if (elapsedMs >= nextWaveMs) {
      nextWaveMs += MATCH.waveIntervalMs;
      spawnWave();
    }
    // An unclaimed rune is simply replaced by the next one.
    if (elapsedMs >= nextRuneMs) {
      nextRuneMs += MATCH.runeIntervalMs;
      runeActive = true;
      broadcast({ type: 'rune' });
    }
    while (!over && pending.length && pending[0].at <= elapsedMs) pending.shift().run();

    for (const unit of units) {
      if (over) break;
      if (!alive(unit) || unit.stunUntil > elapsedMs) continue;
      if (unit.isHero) thinkHero(unit, dt);
      else think(unit, dt);
    }
    for (const s of structures) {
      if (!over && s.hp > 0) defend(s, dt);
    }
    if (!over) moveProjectiles(dt);
    if (!over) {
      separate();
      sweep();
      for (const bot of bots) bot.think(elapsedMs);
    }
    // finish() has already sent the final state.
    if (over) return;
    if (elapsedMs >= MATCH.durationMs) {
      finish('time');
      return;
    }

    sinceSnapshot += dt;
    if (sinceSnapshot >= MATCH.snapshotMs) {
      sinceSnapshot = 0;
      sendSnapshots();
    }
    flush();
  }

  function revive(hero) {
    const point = heroSpawn(hero.side);
    Object.assign(hero, { x: point.x, z: point.z, hp: hero.maxHp, mana: HERO.maxMana, dead: false, slowUntil: 0, stunUntil: 0, shield: 0, blockedMs: 0 });
  }

  function totals() {
    const sum = { radiant: { hp: 0, maxHp: 0 }, dire: { hp: 0, maxHp: 0 } };
    for (const s of structures) {
      sum[s.side].hp += Math.ceil(s.hp);
      sum[s.side].maxHp += s.maxHp;
    }
    return sum;
  }

  function finish(reason, winner = null) {
    if (over) return;
    over = true;
    clearInterval(timer);
    const sum = totals();
    if (reason === 'time') {
      const radiant = sum.radiant.hp / sum.radiant.maxHp;
      const dire = sum.dire.hp / sum.dire.maxHp;
      winner = radiant === dire ? null : radiant > dire ? 'radiant' : 'dire';
    }
    flush();
    sendSnapshots();
    for (const side of SIDES) emit(side, 'game:over', { winner, reason, totals: sum });
    onOver();
  }

  /* ---------------------------------------------------------------- Intents */

  function playCard(side, slot, x, z) {
    if (over || !Number.isInteger(slot) || slot < 0 || slot >= MATCH.handSize) return;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const team = teams[side];
    const card = CARDS.get(team.hand[slot]);
    if (team.elixir < card.cost) return reject(side, 'Not enough Elixir');
    const placement = canDeploy(card, side, x, z);
    if (!placement.ok) return reject(side, placement.reason);

    team.elixir -= card.cost;
    team.queue.push(card.id);
    team.hand[slot] = team.queue.shift();
    broadcast({ type: 'card', side, card: card.id, x: round(x), z: round(z) });

    const at = { x, z };
    if (card.spawns) {
      const forward = side === 'radiant' ? 1 : -1;
      const lane = UNITS[card.spawns].building ? null : z < 0 ? 'top' : 'bottom';
      for (const [ahead, across] of FORMATIONS[card.count]) {
        const px = x + ahead * forward;
        const pz = z + across;
        const fits = walkable(px, pz);
        spawn(card.spawns, side, fits ? px : x, fits ? pz : z, lane);
      }
    } else if (card.id === 'fireball') {
      // The meteor is in the air for `travelMs`; nothing is hurt until it lands.
      schedule(card.travelMs, () => {
        const hits = (target) => distance(target, at) <= card.radius + target.radius;
        for (const unit of units) {
          if (unit.side !== side && alive(unit) && hits(unit)) hurt(unit, card.damage, team.hero);
        }
        for (const s of structures) {
          if (s.side !== side && alive(s) && hits(s)) hurt(s, card.structureDamage, team.hero);
        }
      });
    } else if (card.id === 'healing_wave') {
      for (const unit of units) {
        if (unit.side !== side || !alive(unit) || unit.building) continue;
        if (distance(unit, at) <= card.radius + unit.radius) unit.hp = Math.min(unit.maxHp, unit.hp + card.heal);
      }
    }
    emit(side, 'game:state', snapshot(side));
  }

  /** The point an ability lands on: the cursor, pulled in to `range`. Without a cursor it aims straight ahead. */
  function aimPoint(hero, x, z, range) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      x = hero.x + (hero.side === 'radiant' ? range : -range);
      z = hero.z;
    }
    const gap = Math.hypot(x - hero.x, z - hero.z);
    if (gap <= range) return { x, z };
    return { x: hero.x + ((x - hero.x) / gap) * range, z: hero.z + ((z - hero.z) / gap) * range };
  }

  /**
   * Moves the hero in a straight line towards `aim`. A dash stops at the first
   * obstacle; a blink lands on the farthest free spot along the line.
   */
  function travel(hero, aim, blink) {
    const dx = aim.x - hero.x;
    const dz = aim.z - hero.z;
    const steps = Math.ceil(Math.hypot(dx, dz) / 0.3);
    const free = (x, z) => walkable(x, z) && structures.every((s) => s.hp <= 0 || Math.hypot(x - s.x, z - s.z) >= s.radius + hero.radius);
    let landing = null;
    for (let i = 1; i <= steps; i++) {
      const x = hero.x + (dx * i) / steps;
      const z = hero.z + (dz * i) / steps;
      if (free(x, z)) landing = { x, z };
      else if (!blink) break;
    }
    if (landing) Object.assign(hero, landing);
    hero.order = null;
  }

  /** The hero that may act for `side`, or null after telling the player why not. */
  function actingHero(side) {
    const { hero } = teams[side];
    if (hero.dead) reject(side, 'Your hero is respawning');
    else if (hero.stunUntil > elapsedMs) reject(side, 'Your hero is stunned');
    else return hero;
    return null;
  }

  function cast(side, key, x, z) {
    const ability = ABILITIES.get(key);
    if (over || !ability) return;
    const hero = actingHero(side);
    if (!hero) return;
    if ((hero.readyAt[key] ?? 0) > elapsedMs) return reject(side, `${ability.name} is on cooldown`);
    if (hero.mana < ability.manaCost) return reject(side, 'Not enough mana');

    hero.mana -= ability.manaCost;
    hero.readyAt[key] = elapsedMs + ability.cooldownMs;
    const damage = (ability.damage ?? 0) * powerOf(hero);
    const event = { type: 'cast', side, key, x: round(hero.x), z: round(hero.z) };

    if (key === 'Q') {
      const from = { x: hero.x, z: hero.z };
      travel(hero, aimPoint(hero, x, z, ability.range), false);
      blast(side, hero, damage, (target) => segmentDistance(target, from, hero) <= ability.width / 2 + target.radius);
      Object.assign(event, { tx: round(hero.x), tz: round(hero.z) });
    } else if (key === 'W') {
      hero.shield = ability.shield;
      hero.shieldUntil = elapsedMs + ability.durationMs;
    } else {
      const aim = aimPoint(hero, x, z, ability.range);
      const strikeArea = () => blast(side, hero, damage, (target) => distance(target, aim) <= ability.radius + target.radius, ability.stunMs);
      if (ability.delayMs) schedule(ability.delayMs, strikeArea);
      else strikeArea();
      Object.assign(event, { tx: round(aim.x), tz: round(aim.z) });
    }
    broadcast(event);
    emit(side, 'game:state', snapshot(side));
  }

  function useItem(side, key, x, z) {
    const item = ITEMS.get(key);
    if (over || !item) return;
    if (item.passive) return reject(side, `${item.name} is passive`);
    const hero = actingHero(side);
    if (!hero) return;
    const event = { type: 'item', side, key, x: round(hero.x), z: round(hero.z) };

    if (item.holdsRune) {
      if (!hero.rune) return reject(side, 'No Power Rune stored');
      hero.rune = false;
      hero.empowerUntil = elapsedMs + item.durationMs;
    } else {
      if ((hero.readyAt[key] ?? 0) > elapsedMs) return reject(side, `${item.name} is on cooldown`);
      hero.readyAt[key] = elapsedMs + item.cooldownMs;
      travel(hero, aimPoint(hero, x, z, item.range), true);
      Object.assign(event, { tx: round(hero.x), tz: round(hero.z) });
    }
    broadcast(event);
    emit(side, 'game:state', snapshot(side));
  }

  function heroMove(side, x, z) {
    if (over || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const { hero } = teams[side];
    if (hero.dead) return;
    const limit = (value, max) => Math.min(max, Math.max(-max, value));
    hero.order = { path: route(hero, { x: limit(x, MAP.halfWidth - 0.3), z: limit(z, MAP.halfDepth - 0.3) }) };
    hero.blockedMs = 0;
  }

  function heroAttack(side, id) {
    if (over || !Number.isInteger(id)) return;
    const { hero } = teams[side];
    const target = id < 0 ? structures[-id - 1] : units.find((unit) => unit.id === id);
    if (hero.dead || !alive(target) || target.side === side) return;
    hero.order = { target };
    hero.blockedMs = 0;
  }

  return {
    snapshot,
    playCard,
    cast,
    useItem,
    heroMove,
    heroAttack,
    stop() {
      over = true;
      clearInterval(timer);
    },
  };
}
