/**
 * RuneDeck — match controller.
 *
 * Joins the battlefield renderer and the HUD to the server: it keeps the latest
 * snapshot, extrapolates timers between snapshots for smooth bars, turns input
 * into intents and turns server events into effects and feed lines.
 * The server stays authoritative; local checks only give instant feedback.
 *
 * Controls
 *   Right-click (or left-click with no card armed)   move the hero, or attack the enemy unit, hero or Tower under the cursor
 *   Q W E R                                          abilities, aimed at the cursor
 *   Z X                                              buy the relic (first press), then Z blinks to the cursor
 *   C                                                drink the rune bottled on the River pad
 *   1 2 3 4 or click a card                          arm a card, then left-click the battlefield to play it
 *   Drag a card onto the battlefield or minimap      play it where it is dropped
 *   Esc or right-click                               put an armed card back
 */

import { createBattlefield } from './battlefield.js';
import { createHud } from './hud.js';
import { DECK, HERO, HEROES, MATCH, RUNES, STRUCTURES, UNIT_TYPES, canDeploy } from './shared.js';

const CARDS = new Map(DECK.map((card) => [card.id, card]));
const ABILITIES = new Map(HERO.abilities.map((ability) => [ability.key, ability]));
const ITEMS = new Map(HERO.items.map((item) => [item.key, item]));
const HERO_TYPE = UNIT_TYPES.indexOf('hero');

/** Physical key positions, so the bindings survive non-Latin keyboard layouts. */
const CARD_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
const ACTION_KEYS = { KeyQ: 'Q', KeyW: 'W', KeyE: 'E', KeyR: 'R', KeyZ: 'Z', KeyX: 'X', KeyC: 'C' };
const DRAG_THRESHOLD_PX = 8;
/** Minimum gap between "under attack" notices for one structure: the player's own, and the enemy's. */
const OWN_NOTICE_MS = 12_000;
const ENEMY_NOTICE_MS = 25_000;
/** A single hit this large makes the structure flash as well as shudder. */
const HEAVY_HIT = 100;

export function createMatchView({ socket, onExit }) {
  const root = document.getElementById('game');
  const canvas = document.getElementById('battlefield');
  const field = createBattlefield(canvas);
  const hud = createHud();

  let active = false;
  let finished = false;
  let side = 'radiant';
  let snapshot = null;
  let snapshotAt = 0;
  /** Hand slot waiting for a target, or null. */
  let armed = null;
  let drag = null;
  /** Last known cursor position in client coordinates. */
  let pointer = null;
  let foeHp = HERO.maxHp;
  let leaveTimer = 0;
  /** Where the hero was last told to walk, marked on the ground until it gets there. */
  let waypoint = null;
  const noticedAt = new Map();

  /* ---------------------------------------------------------------- Live values */

  const age = () => Math.max(0, performance.now() - snapshotAt);
  const elixirNow = () => Math.min(MATCH.elixirMax, snapshot.you.elixir + age() / MATCH.elixirIntervalMs);
  const cooldownNow = (key) => Math.max(0, (snapshot.you.cooldowns[key] ?? 0) - age());
  const armedCard = () => (armed === null ? null : CARDS.get(snapshot.you.hand[armed]));
  const ownerOf = (def) => (def.side === side ? 'Your' : 'Enemy');
  const heroName = (name) => HEROES[name].name;
  /** "a Haste rune", "an Arcane Regen rune". */
  const aRune = (kind) => `${/^[aeiou]/i.test(RUNES[kind].name) ? 'an' : 'a'} ${RUNES[kind].name} rune`;

  function setWaypoint(point) {
    waypoint = point;
    field.setWaypoint(point);
  }

  const view = { hp: [], hand: [], hero: {}, cooldowns: {}, units: [] };

  field.onFrame = (_dt, now) => {
    if (!snapshot) return;
    // A frame timestamp can predate the snapshot that arrived during it.
    const elapsed = finished ? 0 : Math.max(0, now - snapshotAt);
    const { hero } = snapshot.you;
    view.timeLeftMs = Math.max(0, snapshot.timeLeftMs - elapsed);
    view.rune = snapshot.rune.kind;
    view.runeInMs = Math.max(0, snapshot.rune.nextInMs - elapsed);
    view.units = snapshot.units;
    view.elixir = Math.min(MATCH.elixirMax, snapshot.you.elixir + elapsed / MATCH.elixirIntervalMs);
    view.hand = snapshot.you.hand;
    view.next = snapshot.you.next;
    view.armed = armed;
    view.hero.hp = hero.hp;
    view.hero.mana = hero.mana;
    view.hero.level = hero.level;
    view.hero.gold = hero.gold;
    view.hero.rune = hero.rune;
    view.hero.owned = hero.owned;
    view.hero.buffs = hero.buffs;
    view.hero.buffAge = elapsed;
    view.hero.respawnMs = Math.max(0, hero.respawnMs - elapsed);
    view.foeHp = foeHp;
    for (const key in snapshot.you.cooldowns) view.cooldowns[key] = Math.max(0, snapshot.you.cooldowns[key] - elapsed);
    hud.render(view, now);

    // The heroes' name plates follow them across the field.
    for (const name of ['radiant', 'dire']) {
      const at = field.heroView(name);
      if (!at) continue;
      const screen = field.project(at.x, at.y + 3.7, at.z);
      hud.placeHero(name, screen.x, screen.y, !at.dead);
      // The walk marker goes once the hero arrives, or falls on the way.
      if (name === side && waypoint && (at.dead || Math.hypot(at.x - waypoint.x, at.z - waypoint.z) < 0.5)) setWaypoint(null);
    }
  };

  function applySnapshot(next) {
    const previous = snapshot;
    snapshot = next;
    snapshotAt = performance.now();
    field.setRune(next.rune.kind);
    field.sync(next);
    for (const unit of next.units) {
      if (unit[1] === HERO_TYPE && unit[0] !== next.you.hero.id) foeHp = unit[5];
    }

    // Structure damage is read off the snapshot: no event says a Tower was hit.
    next.structures.forEach(([hp], index) => {
      view.hp[index] = hp;
      const before = previous ? previous.structures[index][0] : hp;
      if (hp >= before) return;
      const def = STRUCTURES[index];
      const own = def.side === side;
      if (hp <= 0) {
        field.fx.destroyed(def.id);
        hud.feed(`${ownerOf(def)} ${def.label} has been destroyed!`, own ? 'danger' : 'good');
        return;
      }
      field.fx.hit(def.id, before - hp >= HEAVY_HIT);
      hud.markStruck(index);
      const now = performance.now();
      if (now - (noticedAt.get(def.id) ?? -Infinity) > (own ? OWN_NOTICE_MS : ENEMY_NOTICE_MS)) {
        noticedAt.set(def.id, now);
        hud.feed(`${ownerOf(def)} ${def.label} is under attack!`, own ? 'danger' : 'good');
      }
    });
  }

  /* ---------------------------------------------------------------- Layout */

  function layout() {
    if (!active) return;
    const top = hud.els.top.getBoundingClientRect().bottom + 4;
    const panels = Math.min(hud.els.heroPanel.getBoundingClientRect().top, hud.els.dock.getBoundingClientRect().top);
    field.resize(window.innerWidth, window.innerHeight, { top, bottom: window.innerHeight - panels + 4 });
    hud.layout(field.project, field.pixelsPerUnit);
  }

  /* ---------------------------------------------------------------- Cursor */

  /** The ground point under a client position, whether over the battlefield or the minimap. */
  function worldAt(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    if (target === canvas) return field.pick(clientX, clientY);
    if (target === hud.els.minimap) return hud.minimapToWorld(clientX, clientY);
    return null;
  }

  const aim = () => (pointer ? worldAt(pointer.x, pointer.y) : null);

  /* ---------------------------------------------------------------- Cards */

  function setArmed(slot) {
    armed = slot;
    root.classList.toggle('arming', slot !== null);
    refreshPreview(slot === null ? null : aim());
  }

  /** Draws the placement circle at `point`: green where the armed card may land, red where it may not. */
  function refreshPreview(point) {
    const card = armedCard();
    if (!card || !point) {
      field.setPreview(null);
      return;
    }
    field.setPreview({
      x: point.x,
      z: point.z,
      radius: card.radius,
      side,
      restricted: card.zone === 'own',
      valid: canDeploy(card, side, point.x, point.z).ok && elixirNow() >= card.cost,
    });
  }

  function deploy(point) {
    const card = armedCard();
    if (!card || !point || finished) return;
    if (elixirNow() < card.cost) {
      hud.hint('Not enough Elixir');
      hud.denyCard(armed);
      return;
    }
    const placement = canDeploy(card, side, point.x, point.z);
    if (!placement.ok) {
      hud.hint(placement.reason);
      return;
    }
    socket.emit('game:playCard', { slot: armed, x: point.x, z: point.z });
    setArmed(null);
  }

  /* ---------------------------------------------------------------- Hero */

  /** Sends the hero to a ground point, or at the enemy standing on it. */
  function orderHero(point) {
    if (!point || finished) return;
    if (snapshot.you.hero.respawnMs > 0) {
      hud.hint('Your hero is respawning');
      return;
    }
    const target = field.pickTarget(point.x, point.z, side);
    if (target) socket.emit('game:attack', { id: target });
    else socket.emit('game:move', { x: point.x, z: point.z });
    field.fx.marker(point.x, point.z, Boolean(target));
    setWaypoint(target ? null : { x: point.x, z: point.z });
  }

  function cast(key) {
    if (finished) return;
    const ability = ABILITIES.get(key);
    if (snapshot.you.hero.respawnMs > 0) {
      hud.hint('Your hero is respawning');
      hud.denySlot(key);
    } else if (cooldownNow(key) > 0) {
      hud.hint(`${ability.name} is on cooldown`);
      hud.denySlot(key);
    } else if (snapshot.you.hero.mana < ability.manaCost) {
      hud.hint('Not enough mana');
      hud.denySlot(key);
    } else {
      hud.pressSlot(key);
      socket.emit('game:cast', { key, ...aim() });
    }
  }

  function useItem(key) {
    if (finished) return;
    const item = ITEMS.get(key);
    const { hero } = snapshot.you;
    if (item.cost && !hero.owned[key]) {
      // The first press buys the relic.
      if (hero.gold < item.cost) {
        hud.hint(`${item.name} costs ${item.cost} gold`);
        hud.denySlot(key);
      } else {
        hud.pressSlot(key);
        socket.emit('game:useItem', { key });
      }
    } else if (item.passive) {
      hud.hint(`${item.name} is always active`);
    } else if (hero.respawnMs > 0) {
      hud.hint('Your hero is respawning');
      hud.denySlot(key);
    } else if (item.holdsRune && !hero.rune) {
      hud.hint('The Rune Bottle is empty. Walk onto the River pad when a rune appears');
      hud.denySlot(key);
    } else if (cooldownNow(key) > 0) {
      hud.hint(`${item.name} is on cooldown`);
      hud.denySlot(key);
    } else {
      hud.pressSlot(key);
      socket.emit('game:useItem', { key, ...aim() });
    }
  }

  /* ---------------------------------------------------------------- Input */

  function onKeyDown(event) {
    if (!active || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'Escape') {
      setArmed(null);
    } else if (finished) {
      return;
    } else if (event.code in CARD_KEYS) {
      const slot = CARD_KEYS[event.code];
      setArmed(armed === slot ? null : slot);
    } else if (event.code in ACTION_KEYS) {
      const key = ACTION_KEYS[event.code];
      if (ABILITIES.has(key)) cast(key);
      else useItem(key);
    } else {
      return;
    }
    event.preventDefault();
  }

  // The placement circle follows the cursor wherever it goes; off the map it hides.
  function onPointerMove(event) {
    pointer = { x: event.clientX, y: event.clientY };
    if (armed !== null && !drag) refreshPreview(aim());
  }

  canvas.addEventListener('pointerdown', (event) => {
    const point = field.pick(event.clientX, event.clientY);
    if (event.button === 0 && armed !== null) deploy(point);
    else if (event.button === 2 && armed !== null) setArmed(null);
    else if (event.button === 0 || event.button === 2) orderHero(point);
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  // Cards: click to arm, or drag onto the battlefield or minimap to deploy.
  hud.els.hand.addEventListener('pointerdown', (event) => {
    const card = event.target.closest('.hand-card');
    if (!card || event.button !== 0 || finished) return;
    drag = { slot: Number(card.dataset.slot), x: event.clientX, y: event.clientY, moved: false };
    card.setPointerCapture(event.pointerId);
  });
  hud.els.hand.addEventListener('pointermove', (event) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      setArmed(drag.slot);
      hud.showGhost(snapshot.you.hand[drag.slot], event.clientX, event.clientY);
    }
    hud.moveGhost(event.clientX, event.clientY);
    refreshPreview(worldAt(event.clientX, event.clientY));
  });
  hud.els.hand.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const { slot, moved } = drag;
    drag = null;
    hud.hideGhost();
    if (!moved) {
      setArmed(armed === slot ? null : slot);
      return;
    }
    const point = worldAt(event.clientX, event.clientY);
    if (point) deploy(point);
    // A drag that ends anywhere else, or on an invalid spot, puts the card back.
    setArmed(null);
  });
  hud.els.hand.addEventListener('pointercancel', () => {
    drag = null;
    hud.hideGhost();
    setArmed(null);
  });

  // Minimap: left-click deploys the armed card there or drops a ping; right-click sends the hero.
  hud.els.minimap.addEventListener('pointerdown', (event) => {
    const point = hud.minimapToWorld(event.clientX, event.clientY);
    if (!point) return;
    if (event.button === 2) {
      if (armed !== null) setArmed(null);
      else orderHero(point);
    } else if (event.button === 0 && armed !== null) {
      deploy(point);
    } else if (event.button === 0) {
      hud.ping(point.x, point.z);
      field.fx.ping(point.x, point.z);
    }
  });
  hud.els.minimap.addEventListener('contextmenu', (event) => event.preventDefault());

  for (const container of [document.getElementById('abilities'), document.getElementById('items')]) {
    container.addEventListener('click', (event) => {
      const key = event.target.closest('.skill')?.dataset.key;
      if (!key) return;
      if (ABILITIES.has(key)) cast(key);
      else useItem(key);
    });
  }

  // Leaving takes two clicks so a stray one cannot forfeit the match.
  hud.els.leave.addEventListener('click', () => {
    if (hud.els.leave.classList.contains('confirm')) {
      onExit();
      return;
    }
    hud.els.leave.classList.add('confirm');
    hud.els.leave.textContent = 'Confirm Leave';
    leaveTimer = setTimeout(resetLeaveButton, 3_000);
  });
  hud.els.resultButton.addEventListener('click', () => onExit());

  function resetLeaveButton() {
    clearTimeout(leaveTimer);
    hud.els.leave.classList.remove('confirm');
    hud.els.leave.textContent = 'Leave Match';
  }

  /* ---------------------------------------------------------------- Server events */

  socket.on('game:state', (next) => {
    if (active) applySnapshot(next);
  });

  function onEvent(event) {
    const mine = event.side === side;
    switch (event.type) {
      case 'card': {
        const card = CARDS.get(event.card);
        if (!card) break;
        field.fx.card(card, event.side, event.x, event.z);
        if (!mine) hud.feed(`Enemy ${card.type === 'Spell' ? 'cast' : 'deployed'} ${card.name}`, 'info');
        break;
      }
      case 'cast': {
        const ability = ABILITIES.get(event.key);
        if (!ability) break;
        field.fx.cast(event, ability);
        if (!mine && ability.ultimate) hud.feed(`${heroName(event.side)} unleashed ${ability.name}!`, 'danger');
        break;
      }
      case 'item': {
        const item = ITEMS.get(event.key);
        if (!item) break;
        // A relic bought while respawning has no hero to light up.
        if (!event.bought || !field.heroView(event.side)?.dead) field.fx.item(event);
        if (event.bought) {
          hud.feed(mine ? `${item.name} unlocked!` : `${heroName(event.side)} bought ${item.name}`, mine ? 'gold' : 'danger');
        } else if (event.rune) {
          const rune = RUNES[event.rune];
          hud.feed(mine ? `${rune.name}! ${rune.description}` : `${heroName(event.side)} drank ${aRune(event.rune)}!`, mine ? 'gold' : 'danger');
        }
        break;
      }
      case 'rune':
        if (!RUNES[event.kind]) break;
        field.fx.rune(event.kind);
        field.setRune(event.kind);
        hud.feed(`${aRune(event.kind).replace(/^a/, 'A')} has appeared on the River!`, 'gold');
        break;
      case 'runeTaken':
        if (!RUNES[event.kind]) break;
        field.fx.runeTaken(event.kind);
        field.setRune(null);
        hud.feed(
          mine ? `${RUNES[event.kind].name} bottled! Press C to drink it.` : `${heroName(event.side)} bottled the ${RUNES[event.kind].name} rune!`,
          mine ? 'gold' : 'danger',
        );
        break;
      case 'bounty': {
        // Gold for a kill: coins burst where it fell and the amount floats up from it.
        const height = event.id < 0 ? STRUCTURES[-event.id - 1].height * 0.7 : 1.9;
        field.fx.gold(event.x, height, event.z);
        hud.floatText(`+${event.gold}g`, event.x, height + 0.5, event.z);
        break;
      }
      case 'heroDown': {
        const seconds = Math.round(event.respawnMs / 1000);
        hud.feed(
          mine ? `${heroName(side)} has fallen! Respawning in ${seconds}s.` : `${heroName(event.side)} has been slain!`,
          mine ? 'danger' : 'good',
        );
        break;
      }
      case 'reject':
        hud.hint(event.reason);
        break;
      default:
        break;
    }
  }

  socket.on('game:events', (events) => {
    if (active) events.forEach(onEvent);
  });

  socket.on('game:over', ({ winner, reason, totals }) => {
    if (!active) return;
    finished = true;
    setArmed(null);
    const percent = (name) => Math.round((totals[name].hp / totals[name].maxHp) * 100);
    const detail =
      reason === 'throne'
        ? `The ${winner === 'radiant' ? 'Dire' : 'Radiant'} Ancient Throne has fallen.`
        : `Time expired. Structures standing: Radiant ${percent('radiant')}%, Dire ${percent('dire')}%.`;
    const outcome = winner === null ? 'draw' : winner === side ? 'victory' : 'defeat';
    hud.showResult({ outcome, title: { draw: 'Draw', victory: 'Victory', defeat: 'Defeat' }[outcome], detail });
  });

  /* ---------------------------------------------------------------- Lifecycle */

  return {
    /** `start` is the server's match:start payload: { side, players, state }. */
    start(start) {
      active = true;
      finished = false;
      side = start.side;
      snapshot = null;
      armed = null;
      drag = null;
      waypoint = null;
      foeHp = HERO.maxHp;
      noticedAt.clear();
      resetLeaveButton();
      root.hidden = false;
      root.classList.remove('arming');

      field.reset();
      hud.setup(start);
      applySnapshot(start.state);
      layout();
      field.start();
      window.addEventListener('resize', layout);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('pointermove', onPointerMove);
      // Web fonts can change the HUD's size after the first layout.
      document.fonts?.ready.then(layout);
      hud.feed(`The battle begins! You command ${heroName(side)}.`, 'gold');
      hud.feed('Right-click to move and attack. Q W E R cast, Z X buy relics, 1-4 arm a card.', 'info');
    },

    stop() {
      if (!active) return;
      active = false;
      field.stop();
      window.removeEventListener('resize', layout);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointermove', onPointerMove);
      root.hidden = true;
    },

    /** Renderer counters, for diagnostics from the browser console. */
    stats: () => field.stats(),
    /** More console diagnostics: world-to-screen projection, a switch that pins render quality, and the effect table. */
    project: (x, y, z) => field.project(x, y, z),
    lockQuality: (locked) => field.lockQuality(locked),
    fx: field.fx,
    heroView: (name) => field.heroView(name),
  };
}
