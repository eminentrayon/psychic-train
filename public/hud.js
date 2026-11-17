/**
 * RuneDeck — in-game HUD (DOM overlay over the battlefield canvas).
 *
 * Top bar (team health, clock, rune timer), hero panel (portrait, bars,
 * abilities, items), card dock (hand, next card, Elixir), combat feed, minimap
 * and the health bars that float above structures and heroes.
 *
 * `render(view, now)` runs every frame, so it only touches the DOM when a
 * displayed value actually changes.
 */

import { ABILITY_ICONS, CARD_ICONS, HERO_PORTRAIT, ITEM_ICONS, SIGILS, svgUrl } from './art.js';
import { DECK, FLAG, HERO, MAP, MATCH, SIDES, STRUCTURES, UNIT_TYPES, riverCenter } from './shared.js';

const CARDS = new Map(DECK.map((card) => [card.id, card]));
const HERO_TYPE = UNIT_TYPES.indexOf('hero');
const GOLEM_TYPE = UNIT_TYPES.indexOf('golem');
const FROST_TYPE = UNIT_TYPES.indexOf('frost_tower');
const FEED_LIMIT = 5;
const FEED_LIFETIME_MS = 7_000;
/** World area shown by the minimap. */
const MINIMAP_W = (MAP.halfWidth + 1) * 2;
const MINIMAP_D = (MAP.halfDepth + 0.8) * 2;
const TEAM_CSS = { radiant: '#4fc3ff', dire: '#ff5a36' };
const TAU = Math.PI * 2;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function image(markup, alt = '') {
  const node = el('img');
  node.src = svgUrl(markup);
  node.alt = alt;
  node.draggable = false;
  return node;
}

/** Restarts a CSS animation class. Forces a reflow, so keep it to one-off events. */
function replay(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export function createHud() {
  const els = {
    top: $('hud-top'),
    timer: $('hud-timer'),
    rune: $('hud-rune'),
    runeText: $('hud-rune-text'),
    leave: $('btn-leave-match'),
    respawn: $('hud-respawn'),
    feed: $('feed'),
    hint: $('hint'),
    heroPanel: $('hero-panel'),
    level: $('hud-level'),
    gold: $('hud-gold'),
    playerName: $('hud-player-name'),
    minimap: $('minimap'),
    dock: $('dock'),
    hand: $('hand'),
    nextCard: $('next-card'),
    elixirCount: $('elixir-count'),
    elixirTrack: $('elixir-track'),
    ghost: $('card-ghost'),
    world: $('world-layer'),
    result: $('result'),
    resultTitle: $('result-title'),
    resultDetail: $('result-detail'),
    resultButton: $('btn-result'),
  };

  let me = 'radiant';
  let last = {};

  /* ---------------------------------------------------------------- Top bar */

  const teams = {};
  for (const side of SIDES) {
    const root = $(`team-${side}`);
    root.querySelector('.team-crest').replaceChildren(image(SIGILS[side]));
    teams[side] = {
      root,
      name: root.querySelector('.team-player'),
      fill: root.querySelector('.bar-fill'),
      ghost: root.querySelector('.bar-ghost'),
      text: root.querySelector('.bar-text'),
      indexes: STRUCTURES.flatMap((s, i) => (s.side === side ? [i] : [])),
      maxHp: STRUCTURES.reduce((sum, s) => sum + (s.side === side ? s.maxHp : 0), 0),
    };
  }

  /* ---------------------------------------------------------------- Hero panel */

  $('hud-portrait').src = svgUrl(HERO_PORTRAIT);
  $('hud-hero-name').textContent = HERO.name;
  const hpBar = { fill: $('stat-hp').querySelector('.stat-fill'), ghost: $('stat-hp').querySelector('.stat-ghost'), text: $('stat-hp').querySelector('b') };
  const manaBar = { fill: $('stat-mana').querySelector('.stat-fill'), text: $('stat-mana').querySelector('b') };

  function buildSlot(def, icon, className) {
    const button = el('button', `skill ${className}`);
    button.type = 'button';
    button.dataset.key = def.key;
    button.title = `${def.name} [${def.key}]${def.manaCost ? ` · ${def.manaCost} mana` : ''}\n${def.description}`;
    const cd = el('i', 'skill-cd');
    const cdText = el('b', 'skill-cd-text');
    button.append(image(icon, def.name), cd, cdText, el('kbd', '', def.key));
    if (def.manaCost) button.append(el('span', 'skill-cost', String(def.manaCost)));
    return { def, button, cd, cdText, cooling: false, lowMana: false, shown: '' };
  }

  const slots = new Map();
  for (const ability of HERO.abilities) {
    const slot = buildSlot(ability, ABILITY_ICONS[ability.id], ability.ultimate ? 'ability ultimate' : 'ability');
    slots.set(ability.key, slot);
    $('abilities').append(slot.button);
  }
  for (const item of HERO.items) {
    const slot = buildSlot(item, ITEM_ICONS[item.id], item.holdsRune ? 'item empty' : 'item');
    slots.set(item.key, slot);
    $('items').append(slot.button);
  }
  const runeSlot = slots.get(HERO.items.find((item) => item.holdsRune).key);

  /* ---------------------------------------------------------------- Card dock */

  function buildCard(className, key) {
    const root = el(key ? 'button' : 'div', className);
    if (key) root.type = 'button';
    const cost = el('span', 'hc-cost');
    const costText = el('b');
    cost.append(costText);
    const art = el('img', 'hc-art');
    art.alt = '';
    art.draggable = false;
    const name = el('span', 'hc-name');
    root.append(art, name, cost);
    if (key) root.append(el('kbd', '', key), el('i', 'hc-charge'));
    return { root, art, name, costText, lack: -1 };
  }

  function fillCard(view, card) {
    view.root.className = view.root.className.replace(/\btype-\w+/g, '').trim();
    view.root.classList.add(`type-${card.type.toLowerCase()}`);
    view.art.src = svgUrl(CARD_ICONS[card.id] ?? CARD_ICONS.unknown);
    view.name.textContent = card.name;
    view.costText.textContent = String(card.cost);
    view.root.title = `${card.name} · ${card.cost} Elixir · ${card.type}\n${card.description}`;
  }

  const hand = Array.from({ length: MATCH.handSize }, (_, slot) => {
    const view = buildCard('hand-card', String(slot + 1));
    view.root.dataset.slot = String(slot);
    els.hand.append(view.root);
    return view;
  });
  const next = buildCard('hand-card mini');
  els.nextCard.append(next.root);
  const ghost = buildCard('hand-card');
  els.ghost.append(ghost.root);

  // Ten segments: each whole point of Elixir lights one, and the next fills as it charges.
  const elixirSegments = Array.from({ length: MATCH.elixirMax }, () => {
    const segment = el('span', 'elixir-seg');
    const fill = el('i');
    segment.append(fill);
    els.elixirTrack.append(segment);
    return { segment, fill, shown: -1 };
  });

  /* ---------------------------------------------------------------- World health bars */

  function worldBar(className, x, y, z, units, named) {
    const root = el('div', `wbar ${className}`);
    const barGhost = el('i', 'wb-ghost');
    const fill = el('i', 'wb-fill');
    const name = named ? el('span', 'wb-name') : null;
    root.append(barGhost, fill);
    if (name) root.append(name);
    els.world.append(root);
    return { root, ghost: barGhost, fill, name, x, y, z, units, flashedAt: 0 };
  }

  const structureBars = STRUCTURES.map((s) =>
    worldBar(`${s.side} ${s.kind}`, s.x, s.height + 0.75, s.z, s.kind === 'throne' ? 4.6 : 3, false),
  );
  // Hero bars follow their heroes; the match controller places them every frame.
  const heroBars = {};
  for (const side of SIDES) heroBars[side] = worldBar(`${side} hero`, 0, 0, 0, 2.3, true);
  const worldBars = [...structureBars, ...Object.values(heroBars)];

  function setBar(bar, fraction) {
    const scale = `scaleX(${Math.max(0, Math.min(1, fraction)).toFixed(4)})`;
    bar.fill.style.transform = scale;
    if (bar.ghost) bar.ghost.style.transform = scale;
  }

  /* ---------------------------------------------------------------- Minimap */

  const mapContext = els.minimap.getContext('2d');
  const mapBase = document.createElement('canvas');
  const pings = [];
  const struckAt = STRUCTURES.map(() => 0);

  function paintMinimapBase() {
    const { width: w, height: h } = mapBase;
    const g = mapBase.getContext('2d');
    const sx = w / MINIMAP_W;
    const sz = h / MINIMAP_D;
    const X = (x) => (x + MINIMAP_W / 2) * sx;
    const Z = (z) => (z + MINIMAP_D / 2) * sz;

    const ground = g.createLinearGradient(0, 0, w, 0);
    ground.addColorStop(0, '#0d4126');
    ground.addColorStop(0.46, '#17663a');
    ground.addColorStop(0.54, '#2c1318');
    ground.addColorStop(1, '#170a0e');
    g.fillStyle = ground;
    g.fillRect(0, 0, w, h);

    // Lanes: throne to lane, along it, and down to the far throne.
    g.strokeStyle = 'rgba(232, 238, 250, 0.3)';
    g.lineWidth = 1.5 * sx;
    g.lineJoin = 'round';
    for (const lane of [-MAP.laneZ, MAP.laneZ]) {
      g.beginPath();
      g.moveTo(X(-MAP.throneX), Z(0));
      g.lineTo(X(-14), Z(lane));
      g.lineTo(X(14), Z(lane));
      g.lineTo(X(MAP.throneX), Z(0));
      g.stroke();
    }

    g.strokeStyle = '#2fd3f5';
    g.lineWidth = MAP.river.halfWidth * 2 * sx;
    g.beginPath();
    for (let z = -MINIMAP_D / 2; z <= MINIMAP_D / 2; z += 0.5) g.lineTo(X(riverCenter(z)), Z(z));
    g.stroke();
    g.fillStyle = '#2fd3f5';
    g.beginPath();
    g.arc(X(0), Z(0), MAP.river.poolRadius * sx, 0, TAU);
    g.fill();

    const half = MAP.bridgeHalfLength;
    g.fillStyle = '#b88a55';
    g.fillRect(X(-half), Z(-MAP.laneZ - 1.1), half * 2 * sx, 2.2 * sz);
    g.fillStyle = '#b4bdcb';
    g.fillRect(X(-half), Z(MAP.laneZ - 1.1), half * 2 * sx, 2.2 * sz);
  }

  function drawMinimap(view, now) {
    const { width: w, height: h } = els.minimap;
    if (!mapBase.width) return;
    const g = mapContext;
    const sx = w / MINIMAP_W;
    const sz = h / MINIMAP_D;
    const X = (x) => (x + MINIMAP_W / 2) * sx;
    const Z = (z) => (z + MINIMAP_D / 2) * sz;
    const diamond = (x, z, r) => {
      g.beginPath();
      g.moveTo(X(x), Z(z) - r);
      g.lineTo(X(x) + r, Z(z));
      g.lineTo(X(x), Z(z) + r);
      g.lineTo(X(x) - r, Z(z));
      g.closePath();
    };

    g.drawImage(mapBase, 0, 0);

    // Rune pad: gold and pulsing while a rune waits on it.
    diamond(0, 0, (view.runeActive ? 1.9 + 0.35 * Math.sin(now / 180) : 1.6) * sx);
    g.fillStyle = view.runeActive ? '#ffc94a' : '#0b3a52';
    g.fill();
    g.lineWidth = 0.3 * sx;
    g.strokeStyle = view.runeActive ? '#fff6c8' : '#9ff7ff';
    g.stroke();

    STRUCTURES.forEach((s, i) => {
      const alive = view.hp[i] > 0;
      const struck = now - struckAt[i] < 900 && Math.floor(now / 120) % 2 === 0;
      g.fillStyle = !alive ? 'rgba(120, 124, 140, 0.55)' : struck ? '#ffffff' : TEAM_CSS[s.side];
      g.strokeStyle = 'rgba(4, 6, 12, 0.9)';
      g.lineWidth = 0.35 * sx;
      if (s.kind === 'throne') {
        diamond(s.x, s.z, 2.3 * sx);
      } else {
        g.beginPath();
        g.rect(X(s.x) - 1.1 * sx, Z(s.z) - 1.1 * sx, 2.2 * sx, 2.2 * sx);
      }
      g.fill();
      g.stroke();
    });

    // Troops are dots and Frost Towers squares; heroes are drawn last, the player's own ringed in white.
    for (const [, type, sideIndex, x, z, , , , flags] of view.units) {
      if (type === HERO_TYPE || flags & FLAG.dead) continue;
      const r = (type === GOLEM_TYPE ? 0.8 : type === FROST_TYPE ? 0.6 : 0.42) * sx;
      g.fillStyle = TEAM_CSS[SIDES[sideIndex]];
      if (type === FROST_TYPE) {
        g.fillRect(X(x) - r, Z(z) - r, r * 2, r * 2);
      } else {
        g.beginPath();
        g.arc(X(x), Z(z), r, 0, TAU);
        g.fill();
      }
    }
    for (const [, type, sideIndex, x, z, , , , flags] of view.units) {
      if (type !== HERO_TYPE || flags & FLAG.dead) continue;
      const side = SIDES[sideIndex];
      g.beginPath();
      g.arc(X(x), Z(z), 1.05 * sx, 0, TAU);
      g.fillStyle = TEAM_CSS[side];
      g.fill();
      g.lineWidth = (side === me ? 0.5 : 0.3) * sx;
      g.strokeStyle = side === me ? '#ffffff' : 'rgba(4, 6, 12, 0.9)';
      g.stroke();
    }

    for (let i = pings.length - 1; i >= 0; i--) {
      const k = (now - pings[i].at) / 1400;
      if (k >= 1) {
        pings.splice(i, 1);
        continue;
      }
      g.lineWidth = 0.4 * sx;
      for (const lag of [0, 0.25]) {
        const ring = (k + lag) % 1;
        g.strokeStyle = `rgba(255, 224, 138, ${1 - ring})`;
        g.beginPath();
        g.arc(X(pings[i].x), Z(pings[i].z), (0.5 + ring * 3) * sx, 0, TAU);
        g.stroke();
      }
    }
  }

  /* ---------------------------------------------------------------- Frame render */

  function render(view, now) {
    const seconds = Math.ceil(view.timeLeftMs / 1000);
    if (seconds !== last.seconds) {
      last.seconds = seconds;
      els.timer.textContent = clock(seconds);
      els.timer.classList.toggle('urgent', seconds <= 30);
    }
    const runeSeconds = Math.ceil(view.runeInMs / 1000);
    if (runeSeconds !== last.runeSeconds || view.runeActive !== last.runeActive) {
      last.runeSeconds = runeSeconds;
      last.runeActive = view.runeActive;
      els.runeText.textContent = `Rune ${Math.floor(runeSeconds / 60)}:${String(runeSeconds % 60).padStart(2, '0')}`;
      els.rune.classList.toggle('up', view.runeActive);
    }

    // Structure bars and the team totals they add up to.
    view.hp.forEach((hp, i) => {
      if (hp === last.hp[i]) return;
      // Under steady fire the bar flashes at most twice a second.
      if (last.hp[i] !== undefined && hp < last.hp[i] && now - structureBars[i].flashedAt > 500) {
        structureBars[i].flashedAt = now;
        replay(structureBars[i].root, 'hit');
      }
      last.hp[i] = hp;
      setBar(structureBars[i], hp / STRUCTURES[i].maxHp);
      structureBars[i].root.classList.toggle('dead', hp <= 0);
    });
    for (const side of SIDES) {
      const team = teams[side];
      const total = team.indexes.reduce((sum, i) => sum + view.hp[i], 0);
      if (total === last.totals[side]) continue;
      last.totals[side] = total;
      setBar(team, total / team.maxHp);
      team.text.textContent = `${Math.ceil(total)} / ${team.maxHp}`;
    }

    // Hero.
    const hp = Math.ceil(view.hero.hp);
    if (hp !== last.heroHp) {
      last.heroHp = hp;
      setBar(hpBar, hp / HERO.maxHp);
      setBar(heroBars[me], hp / HERO.maxHp);
      hpBar.text.textContent = `${hp} / ${HERO.maxHp}`;
    }
    const foeHp = Math.ceil(view.foeHp);
    if (foeHp !== last.foeHp) {
      last.foeHp = foeHp;
      setBar(heroBars[me === 'radiant' ? 'dire' : 'radiant'], foeHp / HERO.maxHp);
    }
    // The rune slot lights up while a Power Rune is stored.
    if (view.hero.rune !== last.rune) {
      last.rune = view.hero.rune;
      runeSlot.button.classList.toggle('empty', !view.hero.rune);
      runeSlot.button.classList.toggle('charged', view.hero.rune);
    }
    const respawn = Math.ceil(view.hero.respawnMs / 1000);
    if (respawn !== last.respawn) {
      last.respawn = respawn;
      els.heroPanel.classList.toggle('dead', respawn > 0);
      els.respawn.textContent = respawn > 0 ? String(respawn) : '';
    }
    const mana = Math.floor(view.hero.mana);
    if (mana !== last.mana) {
      last.mana = mana;
      setBar(manaBar, mana / HERO.maxMana);
      manaBar.text.textContent = `${mana} / ${HERO.maxMana}`;
    }
    if (view.hero.gold !== last.gold) {
      last.gold = view.hero.gold;
      els.gold.textContent = String(view.hero.gold);
    }
    if (view.hero.level !== last.level) {
      last.level = view.hero.level;
      els.level.textContent = String(view.hero.level);
    }

    // Cooldown sweeps.
    for (const slot of slots.values()) {
      const remaining = view.cooldowns[slot.def.key] ?? 0;
      const cooling = remaining > 0;
      if (cooling) {
        slot.cd.style.setProperty('--p', (remaining / slot.def.cooldownMs).toFixed(3));
        const text = remaining >= 1000 ? String(Math.ceil(remaining / 1000)) : (remaining / 1000).toFixed(1);
        if (text !== slot.shown) {
          slot.shown = text;
          slot.cdText.textContent = text;
        }
      }
      if (cooling !== slot.cooling) {
        slot.cooling = cooling;
        slot.button.classList.toggle('cooling', cooling);
        if (!cooling) {
          slot.shown = '';
          slot.cdText.textContent = '';
          replay(slot.button, 'ready');
        }
      }
      const lowMana = Boolean(slot.def.manaCost) && view.hero.mana < slot.def.manaCost;
      if (lowMana !== slot.lowMana) {
        slot.lowMana = lowMana;
        slot.button.classList.toggle('low-mana', lowMana);
      }
    }

    // Elixir: a full segment glows; the one being charged fills smoothly from the left.
    elixirSegments.forEach((item, index) => {
      const amount = Math.round(Math.min(1, Math.max(0, view.elixir - index + 1e-6)) * 200) / 200;
      if (amount === item.shown) return;
      item.shown = amount;
      item.fill.style.transform = `scaleX(${amount})`;
      item.segment.classList.toggle('full', amount === 1);
    });
    const whole = Math.floor(view.elixir + 1e-6);
    if (whole !== last.whole) {
      last.whole = whole;
      els.elixirCount.textContent = String(whole);
      els.elixirTrack.classList.toggle('maxed', whole >= MATCH.elixirMax);
    }

    // Hand.
    view.hand.forEach((id, slot) => {
      const card = CARDS.get(id);
      const cardView = hand[slot];
      if (id !== last.hand[slot]) {
        const drawn = last.hand[slot] !== undefined;
        last.hand[slot] = id;
        fillCard(cardView, card);
        if (drawn) replay(cardView.root, 'drawn');
      }
      const lack = Math.round(Math.max(0, 1 - view.elixir / card.cost) * 100);
      if (lack !== cardView.lack) {
        cardView.lack = lack;
        cardView.root.style.setProperty('--lack', String(lack / 100));
        cardView.root.classList.toggle('unaffordable', lack > 0);
      }
      const armed = view.armed === slot;
      if (armed !== last.armed[slot]) {
        last.armed[slot] = armed;
        cardView.root.classList.toggle('armed', armed);
      }
    });
    if (view.next !== last.next) {
      last.next = view.next;
      fillCard(next, CARDS.get(view.next));
    }

    drawMinimap(view, now);
  }

  /* ---------------------------------------------------------------- Public API */

  let hintTimer = 0;

  return {
    els,
    render,

    /** Resets the HUD for a new match. `players` maps each side to { nickname, isBot }. */
    setup({ side, players }) {
      me = side;
      last = { hp: [], totals: {}, hand: [], armed: [] };
      for (const item of elixirSegments) item.shown = -1;
      for (const name of SIDES) {
        teams[name].name.textContent = players[name].nickname;
        teams[name].root.classList.toggle('you', name === side);
        heroBars[name].name.textContent = players[name].nickname;
        heroBars[name].root.classList.toggle('you', name === side);
      }
      els.playerName.textContent = players[side].nickname;
      els.feed.replaceChildren();
      els.hint.classList.remove('show');
      els.result.hidden = true;
      els.ghost.hidden = true;
      for (const bar of worldBars) bar.root.classList.remove('dead', 'hit');
      for (const slot of slots.values()) {
        slot.cooling = slot.lowMana = false;
        slot.shown = '';
        slot.cdText.textContent = '';
        slot.button.classList.remove('cooling', 'low-mana', 'ready', 'deny');
      }
      for (const cardView of hand) cardView.lack = -1;
      pings.length = 0;
      struckAt.fill(0);
    },

    /** Positions the floating bars and resizes the minimap. `project` maps world to CSS pixels. */
    layout(project, pixelsPerUnit) {
      for (const bar of worldBars) bar.root.style.width = `${(bar.units * pixelsPerUnit).toFixed(1)}px`;
      for (const bar of structureBars) {
        const point = project(bar.x, bar.y, bar.z);
        bar.root.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px) translateX(-50%)`;
      }
      const rect = els.minimap.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * ratio));
      const h = Math.max(1, Math.round(rect.height * ratio));
      if (w !== els.minimap.width || h !== els.minimap.height) {
        els.minimap.width = mapBase.width = w;
        els.minimap.height = mapBase.height = h;
        paintMinimapBase();
      }
    },

    /** Moves a hero's floating bar to a screen point, or hides it while the hero is dead. */
    placeHero(side, x, y, visible) {
      const bar = heroBars[side];
      if (visible !== bar.shown) {
        bar.shown = visible;
        bar.root.style.display = visible ? '' : 'none';
      }
      if (visible) bar.root.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translateX(-50%)`;
    },

    feed(text, tone = 'info') {
      const item = el('li', `feed-item ${tone}`, text);
      els.feed.append(item);
      while (els.feed.children.length > FEED_LIMIT) els.feed.firstElementChild.remove();
      setTimeout(() => {
        item.classList.add('leaving');
        setTimeout(() => item.remove(), 400);
      }, FEED_LIFETIME_MS);
    },

    /** Brief message near the bottom centre, for rejected actions. */
    hint(text) {
      els.hint.textContent = text;
      els.hint.classList.add('show');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => els.hint.classList.remove('show'), 1_700);
    },

    pressSlot: (key) => replay(slots.get(key).button, 'pressed'),
    denySlot: (key) => replay(slots.get(key).button, 'deny'),
    denyCard: (slot) => replay(hand[slot].root, 'deny'),

    showGhost(cardId, x, y) {
      fillCard(ghost, CARDS.get(cardId));
      els.ghost.hidden = false;
      els.ghost.style.transform = `translate(${x}px, ${y}px)`;
    },
    moveGhost(x, y) {
      els.ghost.style.transform = `translate(${x}px, ${y}px)`;
    },
    hideGhost() {
      els.ghost.hidden = true;
    },

    /** World point under a client position on the minimap, or null if outside it. */
    minimapToWorld(clientX, clientY) {
      const rect = els.minimap.getBoundingClientRect();
      const u = (clientX - rect.left) / rect.width;
      const v = (clientY - rect.top) / rect.height;
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      return { x: (u - 0.5) * MINIMAP_W, z: (v - 0.5) * MINIMAP_D };
    },
    ping(x, z) {
      pings.push({ x, z, at: performance.now() });
    },
    markStruck(index) {
      struckAt[index] = performance.now();
    },

    showResult({ outcome, title, detail }) {
      els.result.dataset.outcome = outcome;
      els.resultTitle.textContent = title;
      els.resultDetail.textContent = detail;
      els.result.hidden = false;
      els.resultButton.focus();
    },
  };
}
