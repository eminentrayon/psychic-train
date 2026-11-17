/**
 * RuneDeck — AI opponent.
 *
 * The bot sees the same battlefield both players see and acts only through the
 * intents a human has: play a card, order the hero, cast an ability, use an
 * item. It defends the lane under the most pressure, pushes the other with
 * troops, saves spells for groups, and pulls its hero out of a losing fight.
 */

import { DECK, HERO, MAP, canDeploy } from './public/shared.js';

const CARDS = new Map(DECK.map((card) => [card.id, card]));
const MANA = Object.fromEntries(HERO.abilities.map((ability) => [ability.key, ability.manaCost]));
const THINK_MS = 350;

const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const laneOf = (unit) => (unit.z < 0 ? 'top' : 'bottom');
const laneZ = (lane) => (lane === 'top' ? -MAP.laneZ : MAP.laneZ);

/** The member of `list` with the most others within `radius`, as { x, z, count, hasHero }. */
function densest(list, radius) {
  let best = { x: 0, z: 0, count: 0, hasHero: false };
  for (const centre of list) {
    const near = list.filter((other) => gap(centre, other) <= radius);
    if (near.length > best.count) best = { x: centre.x, z: centre.z, count: near.length, hasHero: near.some((unit) => unit.isHero) };
  }
  return best;
}

export function createBot({ side, team, units, structures, runeActive, intents }) {
  const { hero } = team;
  /** Own half of the map is where sign * x is positive. */
  const sign = side === 'radiant' ? -1 : 1;
  const fountain = { x: sign * 14.8, z: 0 };

  let now = 0;
  let thinkAt = 2_000;
  let lane = Math.random() < 0.5 ? 'top' : 'bottom';
  let laneUntil = 0;
  let retreating = false;
  /** Elixir to save up before the next push, re-rolled after every card. */
  let spendAt = 5 + Math.random() * 3;

  const ready = (key) => (hero.readyAt[key] ?? 0) <= now && (MANA[key] ?? 0) <= hero.mana;

  function think(elapsedMs) {
    if (elapsedMs < thinkAt) return;
    now = elapsedMs;
    thinkAt = now + THINK_MS + Math.random() * 150;

    const foes = units.filter((unit) => unit.side !== side && unit.hp > 0 && !unit.dead);
    const allies = units.filter((unit) => unit.side === side && unit.hp > 0 && !unit.isHero && !unit.building);
    // Enemy troops on our half of each lane; a Golem counts for several.
    const pressure = { top: 0, bottom: 0 };
    for (const foe of foes) {
      if (!foe.isHero && foe.x * sign > 0) pressure[laneOf(foe)] += foe.type === 'golem' ? 4 : 1;
    }
    const other = lane === 'top' ? 'bottom' : 'top';
    if (pressure[other] > pressure[lane] + 2 || (now >= laneUntil && pressure[other] >= pressure[lane])) {
      lane = pressure[other] === pressure[lane] && Math.random() < 0.5 ? lane : other;
      laneUntil = now + 12_000;
    }

    if (!hero.dead && hero.stunUntil <= now) commandHero(foes, allies);
    spend(foes, allies, pressure);
  }

  function commandHero(foes, allies) {
    const health = hero.hp / hero.maxHp;
    const close = foes.filter((foe) => gap(foe, hero) < 6.5);

    // Fall back to the fountain when badly hurt, and stay until mostly healed.
    retreating = retreating ? health < 0.85 : health < 0.3;
    if (retreating) {
      if (gap(hero, fountain) > 1.5) intents.heroMove(side, fountain.x, fountain.z);
      if (close.length && ready('W')) intents.cast(side, 'W');
      if (close.length && ready('Z')) intents.useItem(side, 'Z', fountain.x, fountain.z);
      return;
    }

    if (close.length) {
      const pack = densest(close, 2.6);
      if (hero.rune) intents.useItem(side, 'C');
      if (ready('R') && (pack.count >= 4 || (pack.hasHero && pack.count >= 2))) intents.cast(side, 'R', pack.x, pack.z);
      else if (ready('E') && pack.count >= 2) intents.cast(side, 'E', pack.x, pack.z);
      else if (ready('Q') && hero.mana > 200 && pack.count >= 2 && gap(hero, pack) > 2) intents.cast(side, 'Q', pack.x, pack.z);
      if (health < 0.6 && ready('W')) intents.cast(side, 'W');

      // Finish a weakened hero first, otherwise hit the nearest enemy.
      const enemyHero = close.find((foe) => foe.isHero && foe.hp < foe.maxHp * 0.5);
      const prey = enemyHero ?? close.reduce((best, foe) => (gap(foe, hero) < gap(best, hero) ? foe : best));
      intents.heroAttack(side, prey.id);
      return;
    }

    if (runeActive() && health > 0.5 && Math.hypot(hero.x, hero.z) < 16) {
      intents.heroMove(side, 0, 0);
      return;
    }

    // Walk with the front of the chosen lane; with no troops there, hold the tower.
    const column = allies.filter((unit) => laneOf(unit) === lane && unit.type !== 'golem');
    const front = column.reduce((best, unit) => (!best || unit.x * sign < best.x * sign ? unit : best), null);
    const goal = front ? { x: front.x + sign * 1.4, z: front.z } : { x: sign * 7.5, z: laneZ(lane) * 0.7 };
    // An enemy building in reach is fair game once the lane is clear.
    const siege = structures.find((s) => s.side !== side && s.hp > 0 && gap(s, hero) < s.radius + 5);
    if (siege && front) intents.heroAttack(side, siege.id);
    else if (gap(hero, goal) > 2.2) intents.heroMove(side, goal.x, goal.z);
  }

  function spend(foes, allies, pressure) {
    const hand = team.hand.map((id, slot) => ({ slot, card: CARDS.get(id) })).filter(({ card }) => card.cost <= team.elixir);
    if (!hand.length) return;

    const play = (id, x, z) => {
      const entry = hand.find(({ card }) => card.id === id);
      if (!entry || !canDeploy(entry.card, side, x, z).ok) return false;
      intents.playCard(side, entry.slot, x, z);
      spendAt = 4 + Math.random() * 4.5;
      return true;
    };

    // Spells answer what is on the field, whatever the Elixir plan. Troops still
    // leaving their own Throne are left alone: no camping the enemy's gate.
    const pack = densest(foes.filter((foe) => !foe.building && foe.x * sign > -13), 2.6);
    if (pack.count >= 3 && play('fireball', pack.x, pack.z)) return;
    const heroHurt = !hero.dead && hero.hp < hero.maxHp * 0.5;
    const wounded = densest([...allies, hero].filter((unit) => !unit.dead && unit.hp < unit.maxHp * 0.6), 3.2);
    if (heroHurt && play('healing_wave', hero.x, hero.z)) return;
    if (wounded.count >= 3 && play('healing_wave', wounded.x, wounded.z)) return;

    // Defend the lane the enemy is pushing.
    const hot = pressure.top === pressure.bottom ? lane : pressure.top > pressure.bottom ? 'top' : 'bottom';
    if (pressure[hot] >= 3) {
      const z = laneZ(hot);
      if (play('frost_tower', sign * 7.2, z * 0.45)) return;
      if (play('footmen_squad', sign * 6.4, z * 0.85)) return;
      if (play('arcane_archer', sign * 8.4, z * 0.7)) return;
    }

    if (team.elixir < spendAt) return;
    // Push: troops go in behind the River bank of the lane the hero is on.
    const z = laneZ(lane) + (Math.random() - 0.5) * 1.2;
    const escort = allies.filter((unit) => laneOf(unit) === lane).length;
    if (escort >= 3 && play('siege_golem', sign * 4.8, z)) return;
    if (play('footmen_squad', sign * 5.4, z)) return;
    if (play('arcane_archer', sign * 6.6, z)) return;

    // Nearly full with nothing better to do: do not let Elixir go to waste.
    if (team.elixir < 9.5) return;
    if (play('siege_golem', sign * 4.8, z)) return;
    if (play('frost_tower', sign * 6.8, laneZ(lane) * 0.45)) return;
    const weakest = structures.filter((s) => s.side !== side && s.hp > 0).reduce((best, s) => (!best || s.hp < best.hp ? s : best), null);
    if (weakest && play('fireball', weakest.x, weakest.z)) return;
    if (!hero.dead) play('healing_wave', hero.x, hero.z);
  }

  return { think };
}
