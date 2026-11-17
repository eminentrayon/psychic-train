/* ==========================================================================
   RuneDeck — lobby client
   Animated backdrop, loadout bar (nickname / hero / deck) and matchmaking.
   ========================================================================== */

import { cardArt, portraitArt } from './paint.js';

const NICK_STORAGE_KEY = 'runedeck.nickname';
const NICK_MAX_LENGTH = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * 88;
/** How long the queue modal shows its result before the versus screen takes over. */
const RESOLVE_BEAT_MS = 900;

const QUEUE_MESSAGES = [
  'Scanning the realm for a worthy rival…',
  'Channeling the River Rune…',
  'Rallying footmen at the barracks…',
  "Sharpening the Aether Knight's blade…",
  'Listening for war horns across the river…',
];

/** Queue ring colour by progress: Radiant cyan, then gold, then Dire crimson. */
const RING_STOPS = [
  [0, [47, 211, 245]],
  [0.6, [246, 226, 160]],
  [1, [240, 65, 58]],
];

function ringColor(progress) {
  const next = RING_STOPS.findIndex(([at]) => at >= progress);
  if (next <= 0) return `rgb(${RING_STOPS[0][1].join(', ')})`;
  const [fromAt, from] = RING_STOPS[next - 1];
  const [toAt, to] = RING_STOPS[next];
  const mix = (progress - fromAt) / (toAt - fromAt);
  return `rgb(${from.map((channel, i) => Math.round(channel + (to[i] - channel) * mix)).join(', ')})`;
}

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* -------------------------------------------------------------------------- */
/* Animated backdrop                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Full-screen canvas: faction-tinted void, the glowing River seam, drifting
 * arcane motes and runes, and the split Radiant/Dire emblem centred on `anchor`.
 */
function createBackdrop(canvas, anchor) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const TAU = Math.PI * 2;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Rune strokes as [x1, y1, x2, y2] segments inside a unit box.
  const RUNES = [
    [[0, -0.5, 0, 0.5], [0, -0.32, 0.34, -0.5], [0, -0.02, 0.34, -0.2]],
    [[0, -0.5, 0.36, 0], [0.36, 0, 0, 0.5], [0, 0.5, -0.36, 0], [-0.36, 0, 0, -0.5]],
    [[0, -0.5, 0, 0.5], [0, -0.5, -0.34, -0.14], [0, -0.5, 0.34, -0.14]],
    [[-0.34, -0.5, 0.34, 0.5], [0.34, -0.5, -0.34, 0.5]],
    [[0.26, -0.5, -0.26, -0.12], [-0.26, -0.12, 0.26, 0.12], [0.26, 0.12, -0.26, 0.5]],
    [[0, -0.5, 0, 0.5], [0, 0, -0.34, -0.42], [0, 0, 0.34, -0.42]],
    [[-0.22, -0.5, -0.22, 0.5], [-0.22, -0.5, 0.26, -0.25], [0.26, -0.25, -0.22, 0], [-0.22, 0, 0.3, 0.5]],
  ];
  const DIAMOND_RUNE = 1;

  const sprites = {
    radiant: glowSprite('110, 215, 255'),
    dire: glowSprite('255, 122, 48'),
    river: glowSprite('150, 255, 232'),
  };
  const cracks = buildCracks();
  const emblem = { x: 0, y: 0, r: 100 };
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  let width = 0;
  let height = 0;
  let dpr = 1;
  let base = null;
  let motes = [];
  let glyphs = [];
  let energy = 0;
  let energyTarget = 0;
  let flash = 0;
  let ringAngle = 0;
  let time = 0;
  let last = 0;

  function glowSprite(rgb) {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const g = sprite.getContext('2d');
    const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.14, `rgba(${rgb}, 0.9)`);
    gradient.addColorStop(0.42, `rgba(${rgb}, 0.22)`);
    gradient.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = gradient;
    g.fillRect(0, 0, 64, 64);
    return sprite;
  }

  // Seeded so the molten cracks keep the same shape on every load.
  function buildCracks() {
    let seed = 0x52756e65;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const list = [];
    for (let i = 0; i < 6; i++) {
      let x = 0.04;
      let y = -0.74 + i * 0.3 + (rand() - 0.5) * 0.1;
      let heading = (rand() - 0.5) * 1.1;
      const points = [[x, y]];
      while (x * x + y * y < 1 && points.length < 12) {
        heading = clamp(heading + (rand() - 0.5) * 1.0, -1.15, 1.15);
        const step = 0.1 + rand() * 0.1;
        x += Math.cos(heading) * step;
        y += Math.sin(heading) * step;
        points.push([x, y]);
      }
      list.push(points);
    }
    return list;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintBase();
    const moteCount = Math.round(clamp((width * height) / 9000, 70, 200));
    motes = Array.from({ length: moteCount }, () => spawnMote(true));
    glyphs = Array.from({ length: 14 }, () => spawnGlyph(true));
    if (reducedMotion.matches) render(0);
  }

  // The static void is painted once per resize and blitted every frame.
  function paintBase() {
    base = document.createElement('canvas');
    base.width = canvas.width;
    base.height = canvas.height;
    const b = base.getContext('2d');
    b.scale(dpr, dpr);

    const sweep = b.createLinearGradient(0, 0, width, 0);
    sweep.addColorStop(0, '#07142e');
    sweep.addColorStop(0.46, '#060914');
    sweep.addColorStop(0.54, '#0a0711');
    sweep.addColorStop(1, '#240a0d');
    b.fillStyle = sweep;
    b.fillRect(0, 0, width, height);

    const reach = Math.max(width, height) * 0.62;
    for (const [x, color] of [[0.14, '34, 120, 220'], [0.86, '214, 54, 28']]) {
      const glow = b.createRadialGradient(width * x, height * 0.62, 0, width * x, height * 0.62, reach);
      glow.addColorStop(0, `rgba(${color}, 0.34)`);
      glow.addColorStop(1, `rgba(${color}, 0)`);
      b.fillStyle = glow;
      b.fillRect(0, 0, width, height);
    }

    const vignette = b.createRadialGradient(
      width / 2, height * 0.5, Math.min(width, height) * 0.3,
      width / 2, height * 0.5, Math.max(width, height) * 0.78,
    );
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.74)');
    b.fillStyle = vignette;
    b.fillRect(0, 0, width, height);
  }

  function spawnMote(anywhere) {
    const x = Math.random() * width;
    const offset = (x - width / 2) / width;
    const kind = Math.abs(offset) < 0.03 ? 'river' : offset < 0 ? 'radiant' : 'dire';
    const depth = 0.35 + Math.random() * 0.65;
    const speed = kind === 'radiant' ? 8 + Math.random() * 16 : kind === 'dire' ? 16 + Math.random() * 34 : 30 + Math.random() * 42;
    return {
      kind,
      depth,
      x,
      y: anywhere ? Math.random() * height : height + 20,
      vy: -speed * depth,
      sway: kind === 'river' ? 3 + Math.random() * 6 : 6 + Math.random() * 22,
      swaySpeed: 0.3 + Math.random() * 0.9,
      phase: Math.random() * TAU,
      size: (0.6 + Math.random() * 1.7) * depth * (kind === 'dire' ? 1.1 : 1.4),
      twinkle: 1 + Math.random() * 3,
    };
  }

  function spawnGlyph(anywhere) {
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : height + 40,
      vy: -(4 + Math.random() * 9),
      size: 14 + Math.random() * 30,
      rot: (Math.random() - 0.5) * 0.8,
      spin: (Math.random() - 0.5) * 0.15,
      rune: Math.floor(Math.random() * RUNES.length),
      alpha: 0.05 + Math.random() * 0.11,
      phase: Math.random() * TAU,
    };
  }

  function strokeRune(index, x, y, size, rotation) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of RUNES[index]) {
      ctx.moveTo(x1 * size, y1 * size);
      ctx.lineTo(x2 * size, y2 * size);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawRiver() {
    const x = emblem.x;
    const band = Math.max(120, width * 0.11);
    const glow = ctx.createLinearGradient(x - band, 0, x + band, 0);
    glow.addColorStop(0, 'rgba(60, 220, 230, 0)');
    glow.addColorStop(0.5, `rgba(70, 225, 235, ${0.1 + 0.035 * Math.sin(time * 0.8) + 0.07 * energy})`);
    glow.addColorStop(1, 'rgba(60, 220, 230, 0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = glow;
    ctx.fillRect(x - band, 0, band * 2, height);

    ctx.beginPath();
    for (let y = 0; y <= height + 24; y += 24) {
      const wobble = Math.sin(y * 0.012 + time * 1.1) * 5 + Math.sin(y * 0.031 - time * 0.7) * 2.5;
      if (y === 0) ctx.moveTo(x + wobble, y);
      else ctx.lineTo(x + wobble, y);
    }
    ctx.strokeStyle = 'rgba(150, 250, 245, 0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawGlyphs(dt) {
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (const glyph of glyphs) {
      glyph.y += glyph.vy * dt;
      glyph.rot += glyph.spin * dt;
      if (glyph.y < -50) Object.assign(glyph, spawnGlyph(false));
      const fade = clamp(glyph.y / (height * 0.25), 0, 1) * clamp((height - glyph.y) / (height * 0.2), 0, 1);
      ctx.globalAlpha = glyph.alpha * fade * (0.6 + 0.4 * Math.sin(time * 0.7 + glyph.phase));
      ctx.strokeStyle = glyph.x < emblem.x ? 'rgb(120, 215, 255)' : 'rgb(255, 130, 80)';
      strokeRune(glyph.rune, glyph.x + pointer.x * 6, glyph.y, glyph.size, glyph.rot);
    }
    ctx.globalAlpha = 1;
  }

  function drawMotes(dt) {
    ctx.globalCompositeOperation = 'lighter';
    const rush = 1 + energy * 0.9;
    for (const mote of motes) {
      mote.y += mote.vy * dt * rush;
      if (mote.y < -20) Object.assign(mote, spawnMote(false));
      const x = mote.x + Math.sin(time * mote.swaySpeed + mote.phase) * mote.sway + pointer.x * mote.depth * 14;
      const fade = clamp(mote.y / (height * 0.18), 0, 1) * clamp((height - mote.y) / (height * 0.1), 0, 1);
      const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * mote.twinkle + mote.phase));
      const size = mote.size * 7;
      ctx.globalAlpha = twinkle * fade * mote.depth;
      ctx.drawImage(sprites[mote.kind], x - size, mote.y - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function facets(r, mirror, focusX, focusY, alphas, edge) {
    ctx.lineWidth = Math.max(0.6, r * 0.007);
    ctx.strokeStyle = edge;
    for (let k = 0; k < 6; k++) {
      const a0 = 1.5 * Math.PI - (k * Math.PI) / 6;
      const a1 = a0 - Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(focusX * r, focusY * r);
      ctx.lineTo(mirror * Math.cos(a0) * r, Math.sin(a0) * r);
      ctx.lineTo(mirror * Math.cos(a1) * r, Math.sin(a1) * r);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 255, 255, ${alphas[k]})`;
      ctx.fill();
      ctx.stroke();
    }
  }

  function crystal(baseX, baseY, w, h, lean) {
    ctx.save();
    ctx.translate(baseX, baseY);
    ctx.rotate(lean);
    const body = ctx.createLinearGradient(0, -h, 0, 0);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.45, '#b4f0ff');
    body.addColorStop(1, '#3d9be0');
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w / 2, -h * 0.18);
    ctx.lineTo(w / 2, -h * 0.78);
    ctx.lineTo(0, -h);
    ctx.lineTo(-w / 2, -h * 0.78);
    ctx.lineTo(-w / 2, -h * 0.18);
    ctx.closePath();
    ctx.fillStyle = body;
    ctx.fill();
    ctx.shadowBlur = 0;
    // Shaded right face gives the shard its cut.
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w / 2, -h * 0.18);
    ctx.lineTo(w / 2, -h * 0.78);
    ctx.lineTo(0, -h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(12, 70, 150, 0.32)';
    ctx.fill();
    ctx.restore();
  }

  function flamePath(scale) {
    ctx.beginPath();
    ctx.moveTo(0, -1 * scale);
    ctx.bezierCurveTo(0.15 * scale, -0.55 * scale, 0.7 * scale, -0.25 * scale, 0.62 * scale, 0.35 * scale);
    ctx.bezierCurveTo(0.58 * scale, 0.75 * scale, 0.3 * scale, scale, 0, scale);
    ctx.bezierCurveTo(-0.3 * scale, scale, -0.6 * scale, 0.78 * scale, -0.62 * scale, 0.38 * scale);
    ctx.bezierCurveTo(-0.64 * scale, 0.1 * scale, -0.45 * scale, -0.05 * scale, -0.4 * scale, -0.3 * scale);
    ctx.bezierCurveTo(-0.3 * scale, -0.12 * scale, -0.2 * scale, -0.1 * scale, -0.15 * scale, -0.2 * scale);
    ctx.bezierCurveTo(-0.2 * scale, -0.55 * scale, -0.1 * scale, -0.8 * scale, 0, -1 * scale);
    ctx.closePath();
  }

  function drawEmblem() {
    const r = emblem.r;
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.7);
    const cx = emblem.x + pointer.x * r * 0.06;
    const cy = emblem.y + Math.sin(time * 0.9) * r * 0.03 + pointer.y * r * 0.06;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Faction halos.
    ctx.globalCompositeOperation = 'lighter';
    for (const [sign, rgb] of [[-1, '60, 190, 255'], [1, '255, 84, 40']]) {
      const extent = r * 2.7;
      const halo = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, extent);
      halo.addColorStop(0, `rgba(${rgb}, ${0.3 + 0.1 * pulse + 0.14 * energy})`);
      halo.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(sign < 0 ? -extent : 0, -extent, extent, extent * 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Cyan -> gold -> crimson metal, fixed in screen space while the rings turn.
    const metal = ctx.createLinearGradient(-r * 1.5, 0, r * 1.5, 0);
    metal.addColorStop(0, 'rgba(110, 225, 255, 0.95)');
    metal.addColorStop(0.5, 'rgba(246, 222, 146, 0.95)');
    metal.addColorStop(1, 'rgba(255, 104, 84, 0.95)');

    ctx.strokeStyle = metal;
    ctx.globalAlpha = 0.55 + 0.25 * energy;
    ctx.lineWidth = Math.max(1, r * 0.012);
    ctx.setLineDash([r * 0.05, r * 0.045]);
    ctx.lineDashOffset = -ringAngle * r * 1.46;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.46, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // Orbiting runes take the colour of the half they pass through.
    ctx.lineWidth = Math.max(1, r * 0.014);
    for (let i = 0; i < 16; i++) {
      const angle = -ringAngle * 0.6 + (i / 16) * TAU;
      const x = Math.cos(angle) * r * 1.28;
      const y = Math.sin(angle) * r * 1.28;
      ctx.globalAlpha = 0.4 + 0.45 * (0.5 + 0.5 * Math.sin(time * 2 + i * 1.7));
      ctx.strokeStyle = x < 0 ? 'rgb(140, 232, 255)' : 'rgb(255, 150, 96)';
      strokeRune(i % RUNES.length, x, y, r * 0.085, angle + Math.PI / 2);
    }

    ctx.strokeStyle = metal;
    for (let i = 0; i < 60; i++) {
      const angle = ringAngle * 0.35 + (i / 60) * TAU;
      const major = i % 5 === 0;
      const inner = r * (major ? 1.085 : 1.105);
      ctx.globalAlpha = major ? 0.8 : 0.45;
      ctx.lineWidth = Math.max(0.7, r * (major ? 0.012 : 0.006));
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      ctx.lineTo(Math.cos(angle) * r * 1.135, Math.sin(angle) * r * 1.135);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // ---- Radiant half: cut crystal.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
    ctx.clip();
    const ice = ctx.createRadialGradient(-r * 0.5, -r * 0.4, r * 0.05, -r * 0.2, 0, r * 1.15);
    ice.addColorStop(0, '#d9fbff');
    ice.addColorStop(0.22, '#58c6f7');
    ice.addColorStop(0.6, '#1a5cb0');
    ice.addColorStop(1, '#0a1f4d');
    ctx.fillStyle = ice;
    ctx.fillRect(-r, -r, r, r * 2);
    facets(r, 1, -0.36, -0.08, [0.26, 0.05, 0.17, 0.02, 0.12, 0.06], 'rgba(215, 248, 255, 0.3)');

    ctx.shadowColor = 'rgba(150, 235, 255, 0.9)';
    ctx.shadowBlur = r * 0.12;
    crystal(-r * 0.7, r * 0.42, r * 0.15, r * 0.5, -0.38);
    ctx.shadowBlur = r * 0.12;
    crystal(-r * 0.32, r * 0.44, r * 0.14, r * 0.46, 0.34);
    ctx.shadowBlur = r * 0.16;
    crystal(-r * 0.51, r * 0.5, r * 0.2, r * 0.86, 0);

    const sheenAt = (-1.5 + ((time * 0.26) % 1) * 2.4) * r;
    const sheen = ctx.createLinearGradient(sheenAt - r * 0.2, -r * 0.1, sheenAt + r * 0.2, r * 0.1);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0)');
    sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0.34)');
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(-r, -r, r, r * 2);
    ctx.restore();

    // ---- Dire half: molten obsidian.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.clip();
    const obsidian = ctx.createRadialGradient(r * 0.4, r * 0.3, r * 0.05, r * 0.3, 0, r * 1.1);
    obsidian.addColorStop(0, '#54190f');
    obsidian.addColorStop(0.45, '#1f0b0d');
    obsidian.addColorStop(1, '#080405');
    ctx.fillStyle = obsidian;
    ctx.fillRect(0, -r, r, r * 2);
    facets(r, -1, 0.34, 0.1, [0.075, 0.015, 0.05, 0.0, 0.035, 0.02], 'rgba(255, 170, 130, 0.13)');

    cracks.forEach((points, i) => {
      const heat = 0.5 + 0.5 * Math.sin(time * 1.3 + i * 2.1);
      ctx.beginPath();
      points.forEach(([px, py], n) => (n === 0 ? ctx.moveTo(px * r, py * r) : ctx.lineTo(px * r, py * r)));
      ctx.shadowColor = 'rgba(255, 90, 20, 0.95)';
      ctx.shadowBlur = r * 0.12;
      ctx.strokeStyle = `rgba(255, ${Math.round(105 + heat * 60)}, 40, ${0.5 + 0.4 * heat})`;
      ctx.lineWidth = r * 0.03;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(255, 238, 176, ${0.45 + 0.5 * heat})`;
      ctx.lineWidth = Math.max(0.8, r * 0.01);
      ctx.stroke();
    });

    ctx.save();
    ctx.translate(r * 0.52, r * 0.06);
    ctx.transform(1, 0, Math.sin(time * 4.3) * 0.05, 1 + Math.sin(time * 6.1) * 0.035, 0, 0);
    const outerFlame = ctx.createLinearGradient(0, -r * 0.42, 0, r * 0.42);
    outerFlame.addColorStop(0, '#ffb445');
    outerFlame.addColorStop(0.55, '#f2551c');
    outerFlame.addColorStop(1, '#a8140f');
    ctx.shadowColor = 'rgba(255, 110, 30, 0.95)';
    ctx.shadowBlur = r * 0.2;
    ctx.fillStyle = outerFlame;
    flamePath(r * 0.42);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.translate(0, r * 0.15);
    ctx.fillStyle = '#ffe9a8';
    flamePath(r * 0.24);
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // ---- Gold bezel.
    let bezel = '#d9b24c';
    if (ctx.createConicGradient) {
      bezel = ctx.createConicGradient(time * 0.25, 0, 0);
      const stops = ['#7a5415', '#fbe9ae', '#b98a2c', '#fff5cf', '#7a5415', '#e7c263', '#8d6219', '#fbe9ae', '#7a5415'];
      stops.forEach((color, i) => bezel.addColorStop(i / (stops.length - 1), color));
    }
    ctx.strokeStyle = bezel;
    ctx.lineWidth = r * 0.075;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = Math.max(0.8, r * 0.012);
    for (const radius of [r * 0.96, r * 1.04]) {
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TAU);
      ctx.stroke();
    }

    // ---- The River: a blade of light dividing the two realms.
    const blade = ctx.createLinearGradient(0, -r * 1.62, 0, r * 1.62);
    blade.addColorStop(0, 'rgba(140, 255, 240, 0)');
    blade.addColorStop(0.2, 'rgba(140, 255, 240, 0.9)');
    blade.addColorStop(0.5, '#ffffff');
    blade.addColorStop(0.8, 'rgba(140, 255, 240, 0.9)');
    blade.addColorStop(1, 'rgba(140, 255, 240, 0)');
    ctx.shadowColor = 'rgba(90, 240, 255, 0.95)';
    ctx.shadowBlur = r * (0.16 + 0.08 * pulse + 0.12 * energy);
    ctx.fillStyle = blade;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.62);
    ctx.lineTo(r * 0.032, 0);
    ctx.lineTo(0, r * 1.62);
    ctx.lineTo(-r * 0.032, 0);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 4; k++) {
      const progress = (time * (0.3 + energy * 0.5) + k / 4) % 1;
      const size = r * 0.11;
      ctx.globalAlpha = Math.sin(progress * Math.PI);
      ctx.drawImage(sprites.river, -size, r * 1.5 - progress * r * 3 - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // ---- Central rune seal.
    const half = r * 0.19;
    ctx.save();
    ctx.rotate(Math.PI / 4);
    ctx.shadowColor = 'rgba(255, 220, 130, 0.9)';
    ctx.shadowBlur = r * (0.12 + 0.1 * pulse);
    ctx.fillStyle = '#0a0e1c';
    ctx.fillRect(-half, -half, half * 2, half * 2);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = bezel;
    ctx.lineWidth = r * 0.03;
    ctx.strokeRect(-half, -half, half * 2, half * 2);
    ctx.restore();

    ctx.save();
    ctx.rotate(Math.PI / 4 - ringAngle * 1.4);
    ctx.strokeStyle = 'rgba(246, 220, 140, 0.5)';
    ctx.lineWidth = Math.max(0.8, r * 0.009);
    ctx.strokeRect(-half * 1.42, -half * 1.42, half * 2.84, half * 2.84);
    ctx.restore();

    ctx.shadowColor = 'rgba(120, 245, 255, 0.95)';
    ctx.shadowBlur = r * 0.08;
    ctx.strokeStyle = `rgba(214, 255, 250, ${0.75 + 0.25 * pulse})`;
    ctx.lineWidth = Math.max(1, r * 0.022);
    strokeRune(DIAMOND_RUNE, 0, 0, r * 0.17, 0);
    ctx.shadowBlur = 0;

    if (flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const burst = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 4.5);
      burst.addColorStop(0, `rgba(255, 244, 210, ${flash})`);
      burst.addColorStop(1, 'rgba(255, 244, 210, 0)');
      ctx.fillStyle = burst;
      ctx.fillRect(-r * 4.5, -r * 4.5, r * 9, r * 9);
    }
    ctx.restore();
  }

  function render(dt) {
    time += dt;
    energy += (energyTarget - energy) * Math.min(1, dt * 3);
    flash = Math.max(0, flash - dt * 1.5);
    ringAngle += dt * (0.12 + energy * 0.55);
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 4);
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 4);

    // Re-read every frame so the emblem tracks layout shifts and scrolling.
    const rect = anchor.getBoundingClientRect();
    emblem.x = rect.left + rect.width / 2;
    emblem.y = rect.top + rect.height / 2;
    emblem.r = Math.min(rect.width, rect.height) * 0.3;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(base, 0, 0, width, height);
    drawRiver();
    drawGlyphs(dt);
    drawEmblem();
    drawMotes(dt);
  }

  let paused = false;

  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!paused && !reducedMotion.matches) render(dt);
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (event) => {
    pointer.tx = (event.clientX / width) * 2 - 1;
    pointer.ty = (event.clientY / height) * 2 - 1;
  });

  time = 2.4;
  resize();
  last = performance.now();
  requestAnimationFrame(loop);

  return {
    /** 0 = idle lobby, 1 = searching: rings spin up and motes rush. */
    setEnergy(value) {
      energyTarget = value;
      if (reducedMotion.matches) {
        energy = value;
        render(0);
      }
    },
    flash() {
      if (!reducedMotion.matches) flash = 0.85;
    },
    /** Stops drawing while the battlefield owns the screen. */
    setPaused(value) {
      paused = value;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* State and DOM                                                              */
/* -------------------------------------------------------------------------- */

const dom = {
  app: $('app'),
  nickname: $('nickname'),
  heroChip: $('hero-chip'),
  heroPortrait: $('hero-portrait'),
  heroName: $('hero-name'),
  heroRole: $('hero-role'),
  heroKeys: $('hero-keys'),
  deck: $('deck'),
  deckCount: $('deck-count'),
  deckAvg: $('deck-avg'),
  findBtn: $('btn-find'),
  modeLine: $('mode-line'),
  conn: $('conn'),
  connText: $('conn-text'),
  lobbyStats: $('lobby-stats'),
  queueModal: $('queue-modal'),
  queuePanel: $('queue-panel'),
  queueTitle: $('queue-title'),
  queueProgress: $('queue-progress'),
  queueTimer: $('queue-timer'),
  queueLimit: $('queue-limit'),
  queueStatus: $('queue-status'),
  queueHint: $('queue-hint'),
  cancelBtn: $('btn-cancel'),
  spawnBotBtn: $('btn-spawn-bot'),
  matchOverlay: $('match-overlay'),
  matchMode: $('match-mode'),
  matchStatusLabel: $('match-status-label'),
  matchCount: $('match-count'),
  matchNote: $('match-note'),
  leaveBtn: $('btn-leave'),
  toasts: $('toasts'),
  tooltip: $('tooltip'),
};

const state = {
  /** @type {'lobby' | 'queue' | 'match'} */
  phase: 'lobby',
  connected: false,
  config: null,
  queue: { startedAt: 0, timeoutMs: 60_000, running: false },
  match: null,
  resolveTimer: 0,
  countdownTimer: 0,
};

const backdrop = createBackdrop($('backdrop'), $('emblem-slot'));
const socket = typeof window.io === 'function' ? window.io() : null;

function setPhase(phase) {
  state.phase = phase;
  document.body.dataset.phase = phase;
  // Keep keyboard focus inside whichever overlay is open.
  dom.app.inert = phase !== 'lobby';
  hideTooltip();
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function formatClock(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Toasts and tooltips                                                        */
/* -------------------------------------------------------------------------- */

function toast(message, tone = 'info', duration = 4200) {
  const node = el('div', `toast toast-${tone}`, message);
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  dom.toasts.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 320);
  }, duration);
}

let tooltipOwner = null;

function showTooltip(owner, content) {
  const tip = dom.tooltip;
  tooltipOwner = owner;
  tip.replaceChildren(content);

  const rect = owner.getBoundingClientRect();
  const tipWidth = tip.offsetWidth;
  const tipHeight = tip.offsetHeight;
  const left = clamp(rect.left + rect.width / 2 - tipWidth / 2, 8, window.innerWidth - tipWidth - 8);
  const fitsBelow = rect.bottom + 14 + tipHeight <= window.innerHeight - 8;
  const above = !fitsBelow && rect.top - 14 - tipHeight >= 8;
  const top = above ? rect.top - 14 - tipHeight : rect.bottom + 14;

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.style.setProperty('--arrow-x', `${Math.round(clamp(rect.left + rect.width / 2 - left, 16, tipWidth - 16))}px`);
  tip.classList.toggle('above', above);
  tip.classList.add('visible');
}

function hideTooltip(owner) {
  if (owner && owner !== tooltipOwner) return;
  tooltipOwner = null;
  dom.tooltip.classList.remove('visible');
}

function bindTooltip(owner, build) {
  const show = () => showTooltip(owner, build());
  const hide = () => hideTooltip(owner);
  owner.addEventListener('pointerenter', show);
  owner.addEventListener('pointerleave', hide);
  owner.addEventListener('focus', show);
  owner.addEventListener('blur', hide);
}

function buildTooltip({ name, cost, typeClass, typeLine, description, traits }) {
  const fragment = document.createDocumentFragment();
  const head = el('div', 'tip-head');
  head.append(el('span', 'tip-name', name));
  if (cost != null) {
    const costNode = el('span', 'tip-cost');
    costNode.append(el('i', 'elixir-drop'), el('span', '', `${cost} Elixir`));
    head.append(costNode);
  }
  const traitList = el('ul', 'tip-traits');
  traitList.append(...traits.map((trait) => el('li', '', trait)));
  fragment.append(head, el('div', `tip-type ${typeClass}`, typeLine), el('p', 'tip-desc', description), traitList);
  return fragment;
}

/* -------------------------------------------------------------------------- */
/* Loadout bar                                                                */
/* -------------------------------------------------------------------------- */

function cleanNickname(value) {
  const cleaned = value.replace(/[^\p{L}\p{N} _\-.']/gu, '').replace(/\s+/g, ' ');
  return [...cleaned].slice(0, NICK_MAX_LENGTH).join('');
}

/** Returns the nickname to queue with, generating one if the field is empty. */
function commitNickname() {
  let nickname = cleanNickname(dom.nickname.value).trim();
  if (!nickname) nickname = `Knight-${1000 + Math.floor(Math.random() * 9000)}`;
  dom.nickname.value = nickname;
  storeNickname(nickname);
  return nickname;
}

function storeNickname(nickname) {
  try {
    localStorage.setItem(NICK_STORAGE_KEY, nickname);
  } catch {
    // Storage can be unavailable (private mode); the nickname just won't persist.
  }
}

function initNickname() {
  try {
    dom.nickname.value = cleanNickname(localStorage.getItem(NICK_STORAGE_KEY) ?? '');
  } catch {
    dom.nickname.value = '';
  }
  dom.nickname.addEventListener('input', () => {
    const cleaned = cleanNickname(dom.nickname.value);
    if (cleaned !== dom.nickname.value) dom.nickname.value = cleaned;
  });
  dom.nickname.addEventListener('change', () => storeNickname(dom.nickname.value.trim()));
  dom.nickname.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') findMatch();
  });
}

/** A painted illustration as an <img>. */
function painting(src) {
  const node = el('img');
  node.src = src;
  node.alt = '';
  node.draggable = false;
  return node;
}

/** `heroes` names each side's champion: the selected hero leads the Radiant, his rival the Dire. */
function renderHero(hero, heroes) {
  dom.heroPortrait.replaceChildren(painting(portraitArt(hero.id)));
  dom.heroName.textContent = hero.name;
  dom.heroRole.textContent = hero.role;
  const abilityKeys = hero.abilities.map((ability) => ability.key);
  dom.heroKeys.replaceChildren(...abilityKeys.map((key) => el('kbd', '', key)));
  dom.heroChip.setAttribute('aria-label', `Selected hero: ${hero.name}, ${hero.role}. ${hero.description}`);
  bindTooltip(dom.heroChip, () =>
    buildTooltip({
      name: hero.name,
      typeClass: 'type-hero',
      typeLine: `Hero · ${hero.role}`,
      description: hero.description,
      traits: ['Mouse Move & Attack', `Abilities ${abilityKeys.join(' ')}`, `Relics ${hero.items.map((item) => item.key).join(' ')}`],
    }),
  );
  for (const side of ['radiant', 'dire']) $(`hero-${side}`).textContent = `${heroes[side].name} · ${heroes[side].title}`;
}

function renderDeck(deck) {
  dom.deck.replaceChildren(
    ...deck.map((card, index) => {
      const item = el('li', `deck-card type-${card.type.toLowerCase()}`);
      item.tabIndex = 0;
      item.style.setProperty('--i', index);
      item.setAttribute('aria-label', `${card.name}: ${card.cost} Elixir, ${card.type}. ${card.tagline}. ${card.description}`);

      const cost = el('span', 'card-cost');
      cost.append(el('span', '', String(card.cost)));
      const art = el('span', 'card-art');
      art.append(painting(cardArt(card.id)));
      item.append(cost, art, el('span', 'card-name', card.name));

      bindTooltip(item, () =>
        buildTooltip({
          name: card.name,
          cost: card.cost,
          typeClass: `type-${card.type.toLowerCase()}`,
          typeLine: `${card.type} · ${card.tagline}`,
          description: card.description,
          traits: card.traits,
        }),
      );
      return item;
    }),
  );

  const average = deck.reduce((sum, card) => sum + card.cost, 0) / deck.length;
  dom.deckCount.textContent = `${deck.length} Cards`;
  dom.deckAvg.textContent = average.toFixed(1);
}

async function loadConfig(attempt = 0) {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.config = await response.json();
  } catch {
    if (attempt < 5) setTimeout(() => loadConfig(attempt + 1), 1000 * (attempt + 1));
    else toast('Could not load game data. Refresh the page to try again.', 'error', 12_000);
    return;
  }

  const { hero, heroes, deck, queueTimeoutMs } = state.config;
  state.queue.timeoutMs = queueTimeoutMs;
  renderHero(hero, heroes);
  renderDeck(deck);

  const limit = formatClock(queueTimeoutMs);
  const seconds = Math.round(queueTimeoutMs / 1000);
  dom.modeLine.textContent = `1v1 real-time PvP · An AI challenger takes the field if no rival appears within ${seconds} seconds`;
  dom.queueLimit.textContent = `/ ${limit}`;
  dom.queueHint.replaceChildren('If no challenger answers by ', el('strong', '', limit), ', an AI opponent takes the field.');
  refreshFindButton();
}

function refreshFindButton() {
  dom.findBtn.disabled = !(state.connected && state.config && state.phase === 'lobby');
}

/* -------------------------------------------------------------------------- */
/* Matchmaking queue                                                          */
/* -------------------------------------------------------------------------- */

function findMatch() {
  if (state.phase !== 'lobby' || !state.connected || !state.config) return;
  const nickname = commitNickname();

  setPhase('queue');
  refreshFindButton();
  backdrop.setEnergy(1);

  state.queue.running = false;
  dom.queuePanel.classList.remove('resolved');
  dom.queueTitle.textContent = 'Searching for Opponent';
  dom.queueTimer.textContent = formatClock(0);
  dom.queueProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  dom.queueProgress.style.color = ringColor(0);
  dom.queueStatus.textContent = 'Entering the matchmaking queue…';
  dom.cancelBtn.disabled = false;
  dom.spawnBotBtn.disabled = false;
  dom.queueModal.hidden = false;
  dom.cancelBtn.focus();

  socket.emit('queue:join', { nickname });
}

function onQueueJoined({ nickname, timeoutMs, elapsedMs }) {
  if (state.phase !== 'queue') return;
  dom.nickname.value = nickname;
  state.queue.timeoutMs = timeoutMs;
  state.queue.startedAt = performance.now() - elapsedMs;
  if (!state.queue.running) {
    state.queue.running = true;
    requestAnimationFrame(tickQueue);
  }
}

function tickQueue() {
  if (!state.queue.running) return;
  const { startedAt, timeoutMs } = state.queue;
  const elapsed = Math.min(performance.now() - startedAt, timeoutMs);

  setText(dom.queueTimer, formatClock(elapsed));
  dom.queueProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - elapsed / timeoutMs));
  dom.queueProgress.style.color = ringColor(elapsed / timeoutMs);

  let status = QUEUE_MESSAGES[Math.floor(elapsed / 5000) % QUEUE_MESSAGES.length];
  if (elapsed >= timeoutMs) status = 'No opponent found — summoning an AI challenger…';
  else if (timeoutMs - elapsed <= 10_000) status = 'No rival yet — an AI challenger is arming up…';
  setText(dom.queueStatus, status);

  requestAnimationFrame(tickQueue);
}

function cancelQueue() {
  if (state.phase !== 'queue' || state.match) return;
  socket.emit('queue:cancel');
  returnToLobby();
}

function onMatchFound(found) {
  // The player cancelled just as the server paired them: release the opponent.
  if (state.phase !== 'queue') {
    socket.emit('match:leave');
    return;
  }

  const receivedAt = performance.now();
  state.queue.running = false;
  state.match = { ...found, live: false };

  if (found.reason === 'timeout') {
    dom.queueTimer.textContent = formatClock(state.queue.timeoutMs);
    dom.queueProgress.style.strokeDashoffset = '0';
  }
  dom.queueTitle.textContent = found.vsBot ? 'AI Challenger Summoned' : 'Opponent Found';
  // Hand the ring colour back to the stylesheet, which turns it gold.
  dom.queueProgress.style.color = '';
  dom.queueStatus.textContent =
    found.reason === 'timeout'
      ? 'No opponent found — an AI challenger takes the field.'
      : found.reason === 'dev'
        ? 'AI bot spawned on request.'
        : `${found.players[found.side === 'radiant' ? 'dire' : 'radiant'].nickname} accepts your challenge!`;
  dom.queuePanel.classList.add('resolved');
  dom.cancelBtn.disabled = true;
  dom.spawnBotBtn.disabled = true;

  const beat = Math.min(RESOLVE_BEAT_MS, found.countdownMs / 2);
  state.resolveTimer = setTimeout(() => showMatch(receivedAt), found.reason === 'dev' ? beat / 2 : beat);
}

/* -------------------------------------------------------------------------- */
/* Match found                                                                */
/* -------------------------------------------------------------------------- */

function showMatch(receivedAt) {
  const match = state.match;
  if (!match) return;

  for (const side of ['radiant', 'dire']) {
    const info = match.players[side];
    const isYou = side === match.side;
    $(`name-${side}`).textContent = info.nickname;
    $(`tag-${side}`).textContent = isYou ? 'You' : info.isBot ? 'AI Bot' : 'Opponent';
    $(`side-${side}`).classList.toggle('is-you', isYou);
    $(`sigil-${side}`).replaceChildren(painting(portraitArt(state.config.heroes[side].id)));
  }
  dom.matchMode.textContent = match.vsBot ? '1v1 · Versus AI Bot' : '1v1 · Player versus Player';
  dom.matchNote.textContent = `You fight for the ${match.side === 'radiant' ? 'Radiant, on the left' : 'Dire, on the right'}.`;

  dom.queueModal.hidden = true;
  dom.matchOverlay.hidden = false;
  setPhase('match');
  backdrop.setEnergy(0.4);
  backdrop.flash();
  dom.leaveBtn.focus();

  const startsAt = receivedAt + match.countdownMs;
  const tick = () => {
    if (match.live) return;
    const remaining = startsAt - performance.now();
    if (remaining > 0) {
      setText(dom.matchStatusLabel, 'Battle begins in');
      setText(dom.matchCount, String(Math.ceil(remaining / 1000)));
    } else {
      setText(dom.matchStatusLabel, 'Entering the battlefield…');
      setText(dom.matchCount, '');
    }
  };
  tick();
  state.countdownTimer = setInterval(tick, 100);
  // Build the battlefield during the countdown so the match opens without a hitch.
  setTimeout(() => loadGameView().catch(() => {}), 700);
}

/* -------------------------------------------------------------------------- */
/* In-game                                                                    */
/* -------------------------------------------------------------------------- */

let gameView = null;
let gameViewLoading = null;

/** The renderer and HUD load on demand and are reused for every later match. */
function loadGameView() {
  gameViewLoading ??= import('./match.js')
    .then(({ createMatchView }) => {
      gameView = createMatchView({ socket, onExit: leaveMatch });
      // Console diagnostics: runedeck.stats() reports FPS, draw calls and triangles.
      window.runedeck = { stats: gameView.stats, project: gameView.project, lockQuality: gameView.lockQuality, fx: gameView.fx, heroView: gameView.heroView };
      return gameView;
    })
    .catch((error) => {
      gameViewLoading = null;
      throw error;
    });
  return gameViewLoading;
}

async function onMatchStart(start) {
  const match = state.match;
  if (!match || match.matchId !== start.matchId) return;
  match.live = true;

  let view;
  try {
    view = await loadGameView();
  } catch (error) {
    console.error(error);
    if (state.match !== match) return;
    leaveMatch();
    toast('The battlefield could not start. This browser may not support WebGL 2.', 'error', 9_000);
    return;
  }
  // The player may have left while the battlefield was loading.
  if (state.match !== match) return;

  clearTimeout(state.resolveTimer);
  clearInterval(state.countdownTimer);
  dom.queueModal.hidden = true;
  dom.matchOverlay.hidden = true;
  setPhase('game');
  backdrop.setPaused(true);
  view.start(start);
}

function leaveMatch() {
  if (!state.match) return;
  socket.emit('match:leave');
  returnToLobby();
}

function onMatchEnded({ reason }) {
  if (!state.match) return;
  returnToLobby();
  toast(
    reason === 'opponent_disconnected' ? 'Your opponent disconnected. The match was closed.' : 'Your opponent left the match.',
    'warn',
  );
}

function returnToLobby() {
  clearTimeout(state.resolveTimer);
  clearInterval(state.countdownTimer);
  state.queue.running = false;
  state.match = null;
  dom.queueModal.hidden = true;
  dom.matchOverlay.hidden = true;
  gameView?.stop();
  backdrop.setPaused(false);
  setPhase('lobby');
  backdrop.setEnergy(0);
  refreshFindButton();
  if (!dom.findBtn.disabled) dom.findBtn.focus();
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

function setConnection(status, text) {
  dom.conn.dataset.state = status;
  dom.connText.textContent = text;
}

function initSocket() {
  if (!socket) {
    setConnection('offline', 'Realtime client failed to load');
    toast('Could not load the realtime client. Refresh the page to try again.', 'error', 12_000);
    return;
  }

  socket.on('connect', () => {
    state.connected = true;
    setConnection('online', 'Connected to realm server');
    refreshFindButton();
  });

  socket.on('disconnect', () => {
    state.connected = false;
    setConnection('offline', 'Connection lost — reconnecting…');
    dom.lobbyStats.textContent = '';
    // The server drops queue and match state with the socket, so mirror that here.
    if (state.phase !== 'lobby') {
      returnToLobby();
      toast('Connection lost. You were returned to the lobby.', 'error');
    }
    refreshFindButton();
  });

  socket.on('lobby:stats', ({ online, searching, matches }) => {
    dom.lobbyStats.textContent = `${online} online · ${searching} searching · ${matches} ${matches === 1 ? 'match' : 'matches'} live`;
  });
  socket.on('lobby:error', ({ message }) => toast(message, 'error'));
  socket.on('queue:joined', onQueueJoined);
  socket.on('match:found', onMatchFound);
  socket.on('match:start', onMatchStart);
  socket.on('match:ended', onMatchEnded);
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

dom.findBtn.addEventListener('click', findMatch);
dom.cancelBtn.addEventListener('click', cancelQueue);
dom.spawnBotBtn.addEventListener('click', () => {
  if (state.phase === 'queue' && !state.match) socket.emit('queue:spawnBot');
});
dom.leaveBtn.addEventListener('click', leaveMatch);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  hideTooltip();
  cancelQueue();
});
window.addEventListener('resize', () => hideTooltip());
window.addEventListener('scroll', () => hideTooltip(), { passive: true });

initNickname();
initSocket();
loadConfig();
