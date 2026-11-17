/**
 * RuneDeck — AI opponent. On the Dire side it commands Morgath.
 *
 * The bot sees the same battlefield both players see and acts only through the
 * intents a human has: play a card, order the hero, cast an ability, use an
 * item. Its hero is never parked at base. It patrols the two lanes with its
 * creeps, walks to the River pad ahead of every rune, fights with all four
 * abilities, falls back to its tower when badly hurt, buys relics with its
 * gold, and answers the cards the enemy plays with the cards that beat them.
 */

import { DECK, HERO, MAP, canDeploy } from './public/shared.js';

const CARDS = new Map(DECK.map((card) => [card.id, card]));
const ABILITY = Object.fromEntries(HERO.abilities.map((ability) => [ability.key, ability]));
const ITEM = Object.fromEntries(HERO.items.map((item) => [item.key, item]));
const THINK_MS = 250;
/** The hero falls back below this share of its health and returns to the fight above the other. */
const RETREAT_BELOW = 0.3;
const RETURN_ABOVE = 0.7;
/** How long before a rune appears the hero sets off for the River pad. */
const RUNE_LEAD_MS = 8_000;
/** How long one answer to an enemy card is given to work before another is spent on it. */
const ANSWER_MS = 9_000;

const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const laneOf = (unit) => (unit.z < 0 ? 'top' : 'bottom');
const laneZ = (lane) => (lane === 'top' ? -MAP.laneZ : MAP.laneZ);
const between = (min, max) => min + Math.random() * (max - min);
const PAD = { x: 0, z: 0 };

/** The member of `list` with the most others within `radius`, as { x, z, count, hasHero }. */
function densest(list, radius) {
  let best = { x: 0, z: 0, count: 0, hasHero: false };
  for (const centre of list) {
    const near = list.filter((other) => gap(centre, other) <= radius);
    if (near.length > best.count) best = { x: centre.x, z: centre.z, count: near.length, hasHero: near.some((unit) => unit.isHero) };
  }
  return best;
}

/** Distance from point `p` to the segment a-b. */
function segmentGap(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t = length2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/**
 * @param {object} options
 * @param options.rune  () => { kind, nextInMs }: the rune on the pad (or null) and the time until the next one
 */
export function createBot({ side, team, units, structures, rune, intents }) {
  const { hero } = team;
  /** Own half of the map is where sign * x is positive. */
  const sign = side === 'radiant' ? -1 : 1;
  const fountain = { x: sign * 14.8, z: 0 };
  const towers = structures.filter((s) => s.side === side && s.def.kind === 'tower');
  const enemyStructures = structures.filter((s) => s.side !== side);
  const enemyThrone = enemyStructures.find((s) => s.def.kind === 'throne');

  let now = 0;
  let thinkAt = 600;
  let lane = Math.random() < 0.5 ? 'top' : 'bottom';
  let laneUntil = between(14_000, 22_000);
  /** null while fighting; 'tower' while falling back to the tower, 'fountain' while going on to heal. */
  let retreat = null;
  let lastHp = hero.hp;
  let preyId = 0;
  /** Elixir to save up before the next push, re-rolled after every card. */
  let spendAt = between(5, 8);
  /** Enemy unit id -> time until which it counts as already answered with a card. */
  const answered = new Map();

  const ready = (key) =>
    (hero.readyAt[key] ?? 0) <= now && (ABILITY[key]?.manaCost ?? 0) <= hero.mana && (!ITEM[key]?.cost || Boolean(hero.owned[key]));
  const living = (s) => s.hp > 0;
  /** Whether attacking `foe` means standing inside an enemy Tower's range with no troops to draw its fire. */
  const dive = (foe, allies) =>
    enemyStructures.some((s) => living(s) && gap(s, foe) < s.def.range + 1 && !allies.some((ally) => gap(ally, s) < s.def.range));

  function think(elapsedMs) {
    if (elapsedMs < thinkAt) return;
    now = elapsedMs;
    thinkAt = now + THINK_MS + Math.random() * 120;

    const foes = units.filter((unit) => unit.side !== side && unit.hp > 0 && !unit.dead);
    const allies = units.filter((unit) => unit.side === side && unit.hp > 0 && !unit.isHero && !unit.building);
    // Enemy troops on our half of each lane; a Golem counts for several.
    const pressure = { top: 0, bottom: 0 };
    for (const foe of foes) {
      if (!foe.isHero && !foe.building && foe.x * sign > 0) pressure[laneOf(foe)] += foe.type === 'golem' ? 4 : 1;
    }

    // Patrol: a spell on each lane in turn, crossing early to meet a push on the other one.
    const other = lane === 'top' ? 'bottom' : 'top';
    if (pressure[other] > pressure[lane] + 2 || (now >= laneUntil && pressure[lane] <= pressure[other] + 1)) {
      lane = other;
      laneUntil = now + between(14_000, 22_000);
    }

    shop();
    if (!hero.dead && hero.stunUntil <= now) commandHero(foes, allies);
    spend(foes, allies, pressure);
    lastHp = hero.hp;
  }

  /** Lifesteal first for staying power, then the boots. */
  function shop() {
    const want = !hero.owned.X ? 'X' : !hero.owned.Z ? 'Z' : null;
    if (want && hero.gold >= ITEM[want].cost) intents.useItem(side, want);
  }

  /* ---------------------------------------------------------------- Hero */

  function commandHero(foes, allies) {
    const health = hero.hp / hero.maxHp;
    const near = foes.filter((foe) => gap(foe, hero) < 7.5);
    // A hero healing at its own fountain is left alone: no hunting a player who has just respawned.
    const enemyHero = foes.find((foe) => foe.isHero && gap(foe, enemyThrone) > enemyThrone.radius + HERO.fountainRadius) ?? null;
    const hit = lastHp - hero.hp > 25;

    if (!retreat && health < RETREAT_BELOW) retreat = 'tower';
    else if (retreat && health >= RETURN_ABOVE) retreat = null;

    drinkRune(health, near);
    if (retreat) {
      fallBack(near, enemyHero);
      return;
    }

    // Every rune is contested: be standing on the pad when it appears.
    const pad = rune();
    if ((pad.kind || pad.nextInMs < RUNE_LEAD_MS) && health > 0.45) {
      const contested = near.filter((foe) => gap(foe, PAD) < 6);
      if (contested.length && fight(contested, enemyHero, allies, health, hit)) return;
      if (gap(hero, PAD) > 0.6) intents.heroMove(side, PAD.x, PAD.z);
      return;
    }

    if (near.length && fight(near, enemyHero, allies, health, hit)) return;
    patrol(allies);
  }

  function drinkRune(health, near) {
    if (!hero.rune) return;
    const heroClose = near.some((foe) => foe.isHero);
    const wanted =
      hero.rune === 'regen'
        ? health < 0.7 || hero.mana < HERO.maxMana * 0.4
        : hero.rune === 'haste'
          ? Boolean(retreat) || heroClose
          : heroClose || near.length >= 2;
    if (wanted) intents.useItem(side, 'C');
  }

  /** Runs for the nearer Tower and fights under its guns; once the chase is off, walks on to the fountain to heal. */
  function fallBack(near, enemyHero) {
    const tower = towers.filter(living).reduce((best, s) => (!best || gap(s, hero) < gap(best, hero) ? s : best), null);
    const shelter = tower ? { x: tower.x + sign * 2.6, z: tower.z * 0.82 } : fountain;
    const chasers = near.filter((foe) => gap(foe, hero) < 5);
    if (retreat === 'tower' && (!tower || (gap(hero, shelter) < 2 && (!near.length || hero.hp < hero.maxHp * 0.15)))) retreat = 'fountain';
    const goal = retreat === 'fountain' ? fountain : shelter;

    if (chasers.length) {
      if (ready('W')) intents.cast(side, 'W');
      // Break contact: blink or dash towards safety, and stun a hero who follows.
      if (gap(hero, goal) > 4.5) {
        if (ready('Z')) intents.useItem(side, 'Z', goal.x, goal.z);
        else if (ready('Q')) intents.cast(side, 'Q', goal.x, goal.z);
      }
      if (enemyHero && gap(enemyHero, hero) < ABILITY.E.range && ready('E')) intents.cast(side, 'E', enemyHero.x, enemyHero.z);
    }
    if (gap(hero, goal) > 1.4) {
      intents.heroMove(side, goal.x, goal.z);
    } else if (retreat === 'tower' && chasers.length) {
      const closest = chasers.reduce((best, foe) => (gap(foe, hero) < gap(best, hero) ? foe : best));
      intents.heroAttack(side, closest.id);
    }
  }

  /** Casts what the moment calls for and picks a target. Returns false when nothing here is worth fighting. */
  function fight(near, enemyHero, allies, health, hit) {
    const { Q, W, E, R } = ABILITY;
    const rival = enemyHero && gap(enemyHero, hero) < 9 ? enemyHero : null;
    const rivalGap = rival ? gap(rival, hero) : Infinity;

    // One offensive cast per thought, so a stun lands before the pillar that follows it.
    const wide = densest(near, R.radius);
    const pack = densest(near, E.radius);
    const pinned = rival && rival.stunUntil > now + 500;
    if (ready('R') && rival && rivalGap <= R.range && (pinned || (rival.hp < rival.maxHp * 0.5 && rivalGap < 5))) {
      intents.cast(side, 'R', rival.x, rival.z);
    } else if (ready('R') && (wide.count >= 4 || (wide.hasHero && wide.count >= 3))) {
      intents.cast(side, 'R', wide.x, wide.z);
    } else if (ready('E') && rival && rivalGap <= E.range) {
      intents.cast(side, 'E', rival.x, rival.z);
    } else if (ready('E') && pack.count >= 2 && hero.mana > 230) {
      intents.cast(side, 'E', pack.x, pack.z);
    } else if (ready('Q')) {
      const aim = dashAim(near, rival, rivalGap, allies, health);
      if (aim) intents.cast(side, 'Q', aim.x, aim.z);
    }
    const crowd = near.filter((foe) => gap(foe, hero) < 3).length;
    if (ready('W') && health < 0.85 && (hit || crowd >= 3)) intents.cast(side, 'W');

    // Whom to strike: a hero he can beat, a creep about to die (for its bounty), else stay on the last target.
    const targets = near.filter((foe) => !dive(foe, allies) && (!foe.isHero || foe === rival));
    let prey = null;
    if (rival && targets.includes(rival) && rivalGap < 6.5 && (health >= rival.hp / rival.maxHp - 0.2 || rival.hp < 300)) {
      prey = rival;
    } else {
      const creeps = targets.filter((foe) => !foe.isHero);
      const dying = creeps.filter((foe) => foe.hp <= hero.def.damage * 2 && gap(foe, hero) < 3.5);
      prey =
        dying.reduce((best, foe) => (!best || foe.hp < best.hp ? foe : best), null) ??
        creeps.find((foe) => foe.id === preyId) ??
        creeps.reduce((best, foe) => (!best || gap(foe, hero) < gap(best, hero) ? foe : best), null);
    }
    if (!prey) return false;
    preyId = prey.id;
    intents.heroAttack(side, prey.id);
    return true;
  }

  /** Where to dash: onto the enemy hero to close the distance, or through a line of creeps. */
  function dashAim(near, rival, rivalGap, allies, health) {
    const { Q } = ABILITY;
    if (rival && rivalGap > 2.4 && rivalGap < Q.range + 1 && health > 0.45 && !dive(rival, allies)) return rival;
    if (hero.mana < 200) return null;
    let best = null;
    let bestCount = 1;
    for (const foe of near) {
      const reach = gap(foe, hero);
      if (foe.isHero || reach < 1 || reach > Q.range || dive(foe, allies)) continue;
      const end = { x: hero.x + ((foe.x - hero.x) / reach) * Q.range, z: hero.z + ((foe.z - hero.z) / reach) * Q.range };
      const count = near.filter((other) => segmentGap(other, hero, end) <= Q.width / 2 + other.radius).length;
      if (count > bestCount) {
        best = end;
        bestCount = count;
      }
    }
    return best;
  }

  /** Walks with the front of the current lane's wave; with no troops there, holds the bank beside the bridge. */
  function patrol(allies) {
    const column = allies.filter((unit) => laneOf(unit) === lane && unit.type !== 'golem');
    const front = column.reduce((best, unit) => (!best || unit.x * sign < best.x * sign ? unit : best), null);
    const goal = front ? { x: front.x + sign * 1.6, z: front.z } : { x: sign * 6.2, z: laneZ(lane) * 0.92 };
    // Without an escort ahead, stop at the bridge rather than walk into a Tower's fire.
    const escort = column.filter((unit) => unit.x * sign < 0).length;
    if (escort < 2) goal.x = sign * Math.max(goal.x * sign, -1.2);

    const siege = enemyStructures.find((s) => living(s) && gap(s, hero) < s.radius + 6 && !dive(s, allies));
    if (siege) intents.heroAttack(side, siege.id);
    else if (gap(hero, goal) > 1.8) intents.heroMove(side, goal.x, goal.z);
  }

  /* ---------------------------------------------------------------- Cards */

  function spend(foes, allies, pressure) {
    const hand = team.hand.map((id, slot) => ({ slot, card: CARDS.get(id) })).filter(({ card }) => card.cost <= team.elixir);
    if (!hand.length) return;

    /** Plays the card at the first of a few nearby spots where it may legally land. */
    const play = (id, x, z) => {
      const entry = hand.find(({ card }) => card.id === id);
      if (!entry) return false;
      for (const [dx, dz] of [[0, 0], [1.3, 0], [2.6, 0], [0, 1.3], [0, -1.3], [4, 0]]) {
        const px = x + dx * sign;
        const pz = z + dz;
        if (!canDeploy(entry.card, side, px, pz).ok) continue;
        intents.playCard(side, entry.slot, px, pz);
        spendAt = between(4, 8.5);
        return true;
      }
      return false;
    };
    /** Nearest x on our own bank, clear of the River and of our Throne. */
    const ownX = (x) => sign * Math.min(MAP.halfWidth - 6, Math.max(3.9, x * sign));
    const fresh = (list) => list.filter((unit) => (answered.get(unit.id) ?? 0) <= now);
    const mark = (list) => {
      for (const unit of list) answered.set(unit.id, now + ANSWER_MS);
      for (const [id, until] of answered) if (until <= now) answered.delete(id);
      return true;
    };

    // Spells answer what is on the field, whatever the Elixir plan. Troops still
    // leaving their own Throne are left alone: no camping the enemy's gate.
    const fireball = CARDS.get('fireball');
    const troops = foes.filter((foe) => !foe.isHero && !foe.building && foe.x * sign > -13);
    const pack = densest(troops, fireball.radius);
    if (pack.count >= 3 && play('fireball', pack.x, pack.z)) return;
    // A Fireball kills Arcane Archers outright: a pair of them is worth it.
    const archerPack = densest(troops.filter((foe) => foe.type === 'archer'), fireball.radius);
    if (archerPack.count >= 2 && play('fireball', archerPack.x, archerPack.z)) return;
    // A stunned hero cannot step out of the blast.
    const rival = foes.find((foe) => foe.isHero);
    if (rival && rival.stunUntil > now + fireball.travelMs - 200 && rival.hp < rival.maxHp * 0.6 && play('fireball', rival.x, rival.z)) return;

    const heroHurt = !hero.dead && hero.hp < hero.maxHp * 0.5 && gap(hero, fountain) > 7;
    const wounded = densest([...allies, hero].filter((unit) => !unit.dead && unit.hp < unit.maxHp * 0.6), CARDS.get('healing_wave').radius);
    if (heroHurt && play('healing_wave', hero.x, hero.z)) return;
    if (wounded.count >= 3 && play('healing_wave', wounded.x, wounded.z)) return;

    // Counter-cards: read what is coming down each lane and play what beats it.
    const lanes = pressure.top >= pressure.bottom ? ['top', 'bottom'] : ['bottom', 'top'];
    for (const hot of lanes) {
      const z = laneZ(hot);
      // Enemies at the River or already across it.
      const invaders = foes.filter((foe) => !foe.isHero && !foe.building && laneOf(foe) === hot && foe.x * sign > -5);
      const guards = allies.filter((unit) => laneOf(unit) === hot && unit.x * sign > 0).length;
      const leader = (list) => list.reduce((best, unit) => (unit.x * sign > best.x * sign ? unit : best));

      // A Siege Golem ignores troops: slow it with a Frost Tower in its path and swarm it with blades.
      const golems = fresh(invaders.filter((foe) => foe.type === 'golem'));
      if (golems.length) {
        const golem = leader(golems);
        if (
          play('frost_tower', ownX(golem.x + sign * 4), z * 0.62) ||
          play('footmen_squad', ownX(golem.x + sign * 1.6), golem.z) ||
          play('arcane_archer', ownX(golem.x + sign * 4.5), z * 0.75)
        ) {
          return mark(golems);
        }
      }
      // Footmen must walk into melee: archers behind the line, or a Frost Tower, cut them down first.
      const footmen = fresh(invaders.filter((foe) => foe.type === 'footman'));
      if (footmen.length >= 2) {
        const lead = leader(footmen);
        if (
          play('arcane_archer', ownX(lead.x + sign * 5.5), z * 0.75) ||
          play('frost_tower', ownX(lead.x + sign * 4.5), z * 0.6) ||
          play('footmen_squad', ownX(lead.x + sign * 2.5), z * 0.9)
        ) {
          return mark(footmen);
        }
      }
      // Archers are fragile up close: drop Footmen right on top of them.
      const archers = fresh(invaders.filter((foe) => foe.type === 'archer'));
      if (archers.length) {
        const lead = leader(archers);
        if (play('footmen_squad', ownX(lead.x + sign * 0.8), lead.z) || play('frost_tower', ownX(lead.x + sign * 4), z * 0.6)) {
          return mark(archers);
        }
      }
      // A creep wave with nobody in its way.
      if (invaders.length >= 4 && guards < 2) {
        if (play('footmen_squad', sign * 6.4, z * 0.85) || play('frost_tower', sign * 7.2, z * 0.5) || play('arcane_archer', sign * 8.4, z * 0.7)) {
          return;
        }
      }
      // Their Frost Tower shreds troops, but a Golem walks through the cold and flattens it.
      const frost = fresh(foes.filter((foe) => foe.type === 'frost_tower' && laneOf(foe) === hot));
      if (frost.length && play('siege_golem', sign * 4.8, z)) return mark(frost);
    }

    if (team.elixir < spendAt) return;
    // Push: troops go in behind the River bank of the lane the hero is on.
    const z = laneZ(lane) + (Math.random() - 0.5) * 1.2;
    const column = allies.filter((unit) => laneOf(unit) === lane);
    if (column.length >= 3 && play('siege_golem', sign * 4.8, z)) return;
    const melee = column.filter((unit) => !unit.def.shot).length;
    // Keep the line balanced: blades in front, bows behind them.
    if (melee >= 3 && play('arcane_archer', sign * 6.6, z)) return;
    if (play('footmen_squad', sign * 5.4, z)) return;
    if (play('arcane_archer', sign * 6.6, z)) return;

    // Nearly full with nothing better to do: do not let Elixir go to waste.
    if (team.elixir < 9.5) return;
    if (play('siege_golem', sign * 4.8, z)) return;
    if (play('frost_tower', sign * 6.8, laneZ(lane) * 0.45)) return;
    const weakest = enemyStructures.filter(living).reduce((best, s) => (!best || s.hp < best.hp ? s : best), null);
    if (weakest && play('fireball', weakest.x, weakest.z)) return;
    if (!hero.dead) play('healing_wave', hero.x, hero.z);
  }

  return { think };
}
