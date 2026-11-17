/*
 * RuneDeck painted artwork.
 *
 * Procedural "digital painting" illustrations for the HUD: card art, hero
 * portraits and ability/item icons. Everything is drawn at runtime with the
 * Canvas 2D API (no images, fonts or libraries), lazily on first request, and
 * cached as a data URL. A seeded PRNG keeps every asset identical on each load.
 *
 *   cardArt(cardId)     -> 300x400 illustration
 *   portraitArt(heroId) -> 256x256 bust portrait (composed for a circular crop)
 *   iconArt(iconId)     -> 128x128 icon
 */

const TAU = Math.PI * 2;

/* ───────────────────────── seeded randomness ───────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ───────────────────────────── colour ──────────────────────────────── */

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function rgba(hex, a) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function mix(a, b, t) {
  const A = rgb(a);
  const B = rgb(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function addStops(g, stops) {
  for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]);
  return g;
}

const lin = (ctx, x0, y0, x1, y1, ...stops) => addStops(ctx.createLinearGradient(x0, y0, x1, y1), stops);
const rad = (ctx, x, y, r, ...stops) => addStops(ctx.createRadialGradient(x, y, 0, x, y, r), stops);

/* ───────────────────────────── shapes ──────────────────────────────── */

// A Path2D that also tracks a conservative bounding box, so edge-light passes
// only have to blur a region the size of the shape.
class Shape {
  constructor() {
    this.path = new Path2D();
    this.x0 = this.y0 = Infinity;
    this.x1 = this.y1 = -Infinity;
  }
  grow(x, y) {
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
    return this;
  }
  M(x, y) { this.path.moveTo(x, y); return this.grow(x, y); }
  L(x, y) { this.path.lineTo(x, y); return this.grow(x, y); }
  Q(cx, cy, x, y) { this.path.quadraticCurveTo(cx, cy, x, y); this.grow(cx, cy); return this.grow(x, y); }
  C(ax, ay, bx, by, x, y) { this.path.bezierCurveTo(ax, ay, bx, by, x, y); this.grow(ax, ay); this.grow(bx, by); return this.grow(x, y); }
  Z() { this.path.closePath(); return this; }
}

function poly(pts) {
  const s = new Shape();
  pts.forEach(([x, y], i) => (i ? s.L(x, y) : s.M(x, y)));
  return s.Z();
}

// Smooth closed shape through the midpoints of the control polygon.
function blob(pts) {
  const s = new Shape();
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let m = mid(pts[n - 1], pts[0]);
  s.M(m[0], m[1]);
  for (let i = 0; i < n; i++) {
    m = mid(pts[i], pts[(i + 1) % n]);
    s.Q(pts[i][0], pts[i][1], m[0], m[1]);
  }
  return s.Z();
}

function oval(cx, cy, rx, ry = rx, rot = 0) {
  const s = new Shape();
  s.path.ellipse(cx, cy, rx, ry, rot, 0, TAU);
  const r = Math.max(rx, ry);
  s.grow(cx - r, cy - r);
  return s.grow(cx + r, cy + r);
}

// Leaf / feather / flame-tongue: two arcs between a root and a tip.
function leaf(x0, y0, x1, y1, wid, bias = 0.4) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * wid;
  const ny = (dx / len) * wid;
  const mx = x0 + dx * bias;
  const my = y0 + dy * bias;
  return new Shape().M(x0, y0).Q(mx + nx, my + ny, x1, y1).Q(mx - nx, my - ny, x0, y0).Z();
}

// Jagged polyline between two points (cracks, lightning, veins).
function jag(rng, x0, y0, x1, y1, n, amp) {
  const pts = [[x0, y0]];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const o = (rng() - 0.5) * 2 * amp;
    pts.push([x0 + dx * t - (dy / len) * o, y0 + dy * t + (dx / len) * o]);
  }
  pts.push([x1, y1]);
  return pts;
}

const trace = (pts) => (c) => pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));

/* ─────────────────────────── painter helpers ───────────────────────── */

// Light hugging the inside edges of a shape that face `to` (device space).
// Drawn from the shape's inverse while clipped to the shape itself; `blur`
// above 4 switches from crisp offset fills to a soft blurred shadow.
function edgeLight(ctx, s, color, to, blur, add) {
  const t = ctx.getTransform();
  const scale = Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1;
  const m = (blur * 2 + Math.abs(to[0]) + Math.abs(to[1]) + 3) / scale;
  const inv = new Path2D();
  inv.rect(s.x0 - m, s.y0 - m, s.x1 - s.x0 + 2 * m, s.y1 - s.y0 + 2 * m);
  inv.addPath(s.path);
  ctx.save();
  ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
  if (blur <= 4) {
    // Tight rims skip the blurred shadow layer (the costly part): two
    // device-space offset fills of the inverse give a crisp, feathered band.
    ctx.fillStyle = color;
    ctx.globalAlpha *= 0.42;
    for (const k of [1, 0.5]) {
      ctx.setTransform(t.a, t.b, t.c, t.d, t.e - to[0] * k, t.f - to[1] * k);
      ctx.fill(inv, 'evenodd');
    }
  } else {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = -to[0];
    ctx.shadowOffsetY = -to[1];
    ctx.fillStyle = '#000';
    ctx.fill(inv, 'evenodd');
  }
  ctx.restore();
}

// Core shadow: a soft ramp of darkness over the side of a shape facing `to`
// (a device-space direction, like the rims). `blur` sets how far it reaches.
function coreShade(ctx, s, color, to, blur) {
  const t = ctx.getTransform();
  const det = t.a * t.d - t.b * t.c || 1;
  let ux = (t.d * to[0] - t.c * to[1]) / det;
  let uy = (t.a * to[1] - t.b * to[0]) / det;
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul;
  uy /= ul;
  // start the ramp inside the shape and end it at the far side of its bounds
  const far = Math.max(s.x0 * ux, s.x1 * ux) + Math.max(s.y0 * uy, s.y1 * uy);
  const len = ((blur + Math.hypot(to[0], to[1])) * 2.2) / Math.sqrt(Math.abs(det));
  const clear = color[0] === '#' ? rgba(color, 0) : color.replace(/[\d.]+\)$/, '0)');
  ctx.fillStyle = lin(ctx, ux * (far - len), uy * (far - len), ux * far, uy * far, 0, clear, 1, color);
  ctx.fill(s.path);
}

/*
 * Fill a shape as a lit form: base fill, a core shadow on the side facing
 * `shadeTo`, and additive rim light on the edges facing `rimTo` / `rim2To`.
 */
function form(ctx, s, o) {
  ctx.fillStyle = o.fill;
  ctx.fill(s.path);
  if (o.shade) coreShade(ctx, s, o.shade, o.shadeTo || [-4, 5], o.shadeBlur ?? 9);
  if (o.rim || o.rim2) {
    ctx.save();
    ctx.clip(s.path);
    if (o.rim) edgeLight(ctx, s, o.rim, o.rimTo || [3, -3], o.rimBlur ?? 3, true);
    if (o.rim2) edgeLight(ctx, s, o.rim2, o.rim2To || [-3, -3], o.rim2Blur ?? o.rimBlur ?? 3, true);
    ctx.restore();
  }
  if (o.line) {
    ctx.strokeStyle = o.line;
    ctx.lineWidth = o.lw ?? 1;
    ctx.lineJoin = 'round';
    ctx.stroke(s.path);
  }
}

/*
 * Soft radial sprites, one per falloff kind and colour. Glows, cloud dabs and
 * motes are stamped from these: scaling a cached sprite is several times
 * cheaper than shading a fresh radial gradient per stamp. Sprites sit in small
 * strip canvases so adding one never forces a large copy-on-write.
 */
const SPRITE = 48;
const spritePages = [];
const spriteSlots = new Map();
function softSprite(kind, color) {
  const key = kind + color;
  let slot = spriteSlots.get(key);
  if (slot === undefined) {
    slot = spriteSlots.size;
    if (slot % 8 === 0) spritePages.push(makeCanvas(SPRITE * 8, SPRITE));
    const c = spritePages[slot >> 3].getContext('2d');
    const h = SPRITE / 2;
    const cx = (slot & 7) * SPRITE + h;
    if (kind === 'mote') c.fillStyle = rad(c, cx, h, h, 0, '#ffffff', 0.22, rgba(color, 0.9), 1, rgba(color, 0));
    else if (kind === 'glow') c.fillStyle = rad(c, cx, h, h, 0, rgba(color, 1), 0.3, rgba(color, 0.5), 0.65, rgba(color, 0.14), 1, rgba(color, 0));
    else c.fillStyle = rad(c, cx, h, h, 0, rgba(color, 1), 0.55, rgba(color, 0.55), 1, rgba(color, 0));
    c.fillRect(cx - h, 0, SPRITE, SPRITE);
    spriteSlots.set(key, slot);
  }
  return slot;
}

// Draw a sprite centred on the origin with radius r in the current transform.
function stamp(ctx, slot, r) {
  ctx.drawImage(spritePages[slot >> 3], (slot & 7) * SPRITE, 0, SPRITE, SPRITE, -r, -r, r * 2, r * 2);
}

function glow(ctx, x, y, r, color, alpha = 1, sx = 1, sy = 1) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(sx, sy);
  stamp(ctx, softSprite('glow', color), r);
  ctx.restore();
}

// Additive glowing stroke; `draw` issues moveTo/lineTo/curve calls.
function glowPath(ctx, draw, color, width, blur, alpha = 1, core = null) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.beginPath();
  draw(ctx);
  // A stepped halo of widening strokes stands in for a blurred shadow layer:
  // much cheaper, and the bloom pass smooths the steps.
  for (const [grow, a] of [[1.5, 0.09], [0.9, 0.15], [0.4, 0.26]]) {
    ctx.globalAlpha = alpha * a;
    ctx.lineWidth = width + blur * grow;
    ctx.stroke();
  }
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.stroke();
  if (core) {
    ctx.strokeStyle = core;
    ctx.lineWidth = Math.max(0.7, width * 0.42);
    ctx.stroke();
  }
  ctx.restore();
}

function strokePath(ctx, draw, color, width, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  draw(ctx);
  ctx.stroke();
  ctx.restore();
}

// Additive streak that fades in from (x0,y0) to a bright head at (x1,y1).
function streak(ctx, x0, y0, x1, y1, width, color, alpha = 1) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = lin(ctx, x0, y0, x1, y1, 0, rgba(color, 0), 0.75, rgba(color, 0.8), 1, '#ffffff');
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

// Soft, squashed colour patches: clouds, fog, smoke and broken-colour skies.
function dabs(ctx, rng, n, [x, y, w, h], colors, r0, r1, alpha, squash = 0.5, op = 'source-over') {
  const slots = colors.map((c) => softSprite('dab', c));
  ctx.save();
  ctx.globalCompositeOperation = op;
  for (let i = 0; i < n; i++) {
    const r = r0 + (r1 - r0) * rng();
    const slot = slots[(rng() * slots.length) | 0];
    ctx.globalAlpha = alpha * (0.4 + 0.6 * rng());
    ctx.save();
    ctx.translate(x + rng() * w, y + rng() * h);
    ctx.rotate((rng() - 0.5) * 0.7);
    ctx.scale(1, squash);
    stamp(ctx, slot, r);
    ctx.restore();
  }
  ctx.restore();
}

// Additive wedges of light fanning out from a source.
function shafts(ctx, rng, x, y, len, count, color, alpha, a0, a1, spread) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    const a = a0 + (a1 - a0) * rng();
    const wd = spread * (0.35 + rng());
    ctx.globalAlpha = alpha * (0.4 + 0.6 * rng());
    ctx.fillStyle = lin(ctx, x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, 0, rgba(color, 1), 1, rgba(color, 0));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a - wd) * len, y + Math.sin(a - wd) * len);
    ctx.lineTo(x + Math.cos(a + wd) * len, y + Math.sin(a + wd) * len);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// Glowing particles: embers, snow, sparks. `drift` = [angle, jitter, stretch].
function motes(ctx, rng, n, [x, y, w, h], colors, r0, r1, alpha = 1, drift = null) {
  const slots = colors.map((c) => softSprite('mote', c));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const r = (r0 + (r1 - r0) * rng() * rng()) * 2.4;
    const slot = slots[(rng() * slots.length) | 0];
    ctx.globalAlpha = alpha * (0.35 + 0.65 * rng());
    ctx.save();
    ctx.translate(x + rng() * w, y + rng() * h);
    if (drift) {
      ctx.rotate(drift[0] + (rng() - 0.5) * drift[1]);
      ctx.scale(drift[2], 1);
    }
    stamp(ctx, slot, r);
    ctx.restore();
  }
  ctx.restore();
}

// Four-point star glint.
function sparkle(ctx, x, y, r, color, alpha = 1, rot = 0) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  const slot = softSprite('mote', color);
  for (const a of [0, Math.PI / 2]) {
    ctx.save();
    ctx.rotate(a);
    ctx.scale(1, 0.13);
    stamp(ctx, slot, r);
    ctx.restore();
  }
  stamp(ctx, slot, r * 0.42);
  ctx.restore();
}

// Soft pool of darkness: contact shadows and ambient occlusion.
function murk(ctx, x, y, r, alpha, sx = 1, sy = 1, color = '#000000') {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(sx, sy);
  stamp(ctx, softSprite('dab', color), r);
  ctx.restore();
}

function vignette(ctx, w, h, strength, color = '#000000') {
  const g = ctx.createRadialGradient(w / 2, h * 0.47, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  g.addColorStop(0, rgba(color, 0));
  g.addColorStop(0.6, rgba(color, strength * 0.35));
  g.addColorStop(1, rgba(color, strength));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Cheap bloom: a tiny copy with only its highlights kept, added back blurred.
function bloom(ctx, w, h, amount) {
  const s = makeCanvas(Math.ceil(w / 8), Math.ceil(h / 8));
  const sc = s.getContext('2d');
  sc.imageSmoothingQuality = 'medium';
  sc.drawImage(ctx.canvas, 0, 0, s.width, s.height);
  sc.globalCompositeOperation = 'multiply';
  sc.drawImage(s, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, amount * 1.7);
  ctx.drawImage(s, 0, 0, w, h);
  ctx.restore();
}

// Shared painterly textures, rendered once: brush streaks and fine grain.
let tiles = null;
function getTiles() {
  if (tiles) return tiles;
  const rng = mulberry32(0x51a7e);
  const grain = makeCanvas(128, 128);
  const g = grain.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (128 + (rng() - 0.5) * 130) | 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  const brush = makeCanvas(256, 256);
  const b = brush.getContext('2d');
  b.fillStyle = '#808080';
  b.fillRect(0, 0, 256, 256);
  b.lineCap = 'round';
  for (let i = 0; i < 300; i++) {
    const x = rng() * 256;
    const y = rng() * 256;
    const len = 12 + rng() * 44;
    const a = -0.65 + (rng() - 0.5) * 1.1;
    const tone = rng() < 0.5 ? '255,255,255' : '0,0,0';
    b.strokeStyle = `rgba(${tone},${0.05 + rng() * 0.1})`;
    b.lineWidth = 1.5 + rng() * 7;
    // repeat strokes that cross a tile edge so the pattern wraps seamlessly
    const reach = len + b.lineWidth;
    for (const ox of [-256, 0, 256]) {
      for (const oy of [-256, 0, 256]) {
        if (x + ox < -reach || x + ox > 256 + reach || y + oy < -reach || y + oy > 256 + reach) continue;
        b.beginPath();
        b.moveTo(x + ox, y + oy);
        b.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
        b.stroke();
      }
    }
  }
  tiles = { grain, brush };
  return tiles;
}

// Final pass shared by every painting: bloom, brush texture, grain, vignette.
function finish(ctx, w, h, o = {}) {
  if (o.bloom !== 0) bloom(ctx, w, h, o.bloom ?? 0.3);
  const { grain, brush } = getTiles();
  const k = o.texScale ?? 1;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.scale(k, k);
  ctx.globalAlpha = o.brush ?? 0.5;
  ctx.fillStyle = ctx.createPattern(brush, 'repeat');
  ctx.fillRect(0, 0, w / k, h / k);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = o.grain ?? 0.13;
  ctx.fillStyle = ctx.createPattern(grain, 'repeat');
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  vignette(ctx, w, h, o.vignette ?? 0.55, o.vignetteColor);
}

/* ══════════════════════════════ CARDS ══════════════════════════════ */

function footman(ctx, x, y, s, pal, swordAng, rimTo) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  const steel = lin(ctx, -20, -205, 20, 0, 0, pal.hi, 0.42, pal.mid, 1, pal.lo);
  const plate = (shape, extra = {}) =>
    form(ctx, shape, { fill: steel, shade: pal.dark, shadeTo: [-rimTo[0], 4], shadeBlur: 8, rim: pal.rim, rimTo, rimBlur: 2.5, ...extra });

  // cape
  form(ctx, poly([[-30, -152], [30, -152], [40, -70], [30, -48], [10, -58], [-12, -46], [-38, -62]]), {
    fill: lin(ctx, 0, -150, 0, -50, 0, pal.blue, 1, pal.blueLo),
    shade: pal.dark, shadeTo: [0, -6], shadeBlur: 12, rim: pal.rim, rimTo, rimBlur: 3,
  });
  // legs
  plate(poly([[-22, -84], [-3, -84], [-7, -42], [-9, -8], [-1, 0], [-28, 0], [-24, -12], [-25, -42]]));
  plate(poly([[3, -84], [22, -84], [27, -42], [26, -12], [32, 0], [5, 0], [9, -8], [8, -42]]));
  plate(oval(-15, -46, 9, 8));
  plate(oval(17, -46, 9, 8));
  // tabard
  form(ctx, poly([[-27, -106], [27, -106], [32, -66], [15, -56], [0, -68], [-15, -56], [-32, -66]]), {
    fill: lin(ctx, 0, -106, 0, -56, 0, pal.blueHi, 1, pal.blueLo),
    shade: pal.dark, shadeTo: [0, 5], shadeBlur: 8, rim: pal.rim, rimTo, rimBlur: 2.5,
  });
  ctx.fillStyle = pal.gold;
  ctx.fill(poly([[-32, -66], [-15, -56], [0, -68], [15, -56], [32, -66], [31, -71], [15, -61], [0, -73], [-15, -61], [-31, -71]]).path);

  // sword arm, raised
  plate(poly([[27, -157], [34, -139], [63, -152], [57, -169]]));
  plate(poly([[50, -163], [65, -158], [57, -202], [42, -199]]));
  // sword
  ctx.save();
  ctx.translate(49, -203);
  ctx.rotate(swordAng);
  const blade = poly([[-4.6, -4], [4.6, -4], [3.6, -76], [0, -88], [-3.6, -76]]);
  ctx.save();
  ctx.shadowColor = '#6fc8ff';
  ctx.shadowBlur = 10 * s;
  ctx.fillStyle = lin(ctx, -5, 0, 5, 0, 0, '#7fd0ff', 0.3, '#f2fbff', 0.5, '#ffffff', 0.7, '#d6f0ff', 1, '#5fb4f0');
  ctx.fill(blade.path);
  ctx.restore();
  ctx.fillStyle = 'rgba(70,140,220,0.6)';
  ctx.fillRect(-0.8, -72, 1.6, 66);
  form(ctx, poly([[-13, -5], [13, -5], [14, 0], [-14, 0]]), { fill: lin(ctx, 0, -5, 0, 0, 0, pal.goldHi, 1, pal.goldLo) });
  ctx.fillStyle = pal.goldLo;
  ctx.fillRect(-2.5, 0, 5, 12);
  ctx.restore();
  plate(oval(49, -200, 8.5, 8));

  // torso
  plate(poly([[-29, -152], [29, -152], [33, -128], [27, -100], [-27, -100], [-33, -128]]));
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fill(poly([[-20, -148], [-4, -148], [-6, -108], [-22, -112]]).path);
  ctx.fillStyle = pal.gold;
  ctx.fillRect(-1.4, -150, 2.8, 48);
  form(ctx, poly([[-28, -106], [28, -106], [27, -98], [-27, -98]]), { fill: lin(ctx, 0, -106, 0, -98, 0, pal.goldHi, 1, pal.goldLo) });
  // gorget + helm
  plate(poly([[-15, -162], [15, -162], [20, -150], [-20, -150]]), { fill: pal.lo });
  plate(blob([[-18, -170], [-19, -186], [-11, -199], [0, -203], [11, -199], [19, -186], [18, -170], [13, -159], [0, -155], [-13, -159]]));
  ctx.fillStyle = '#04070f';
  ctx.fill(poly([[-14, -182], [14, -182], [12, -176], [-12, -176]]).path);
  ctx.fillStyle = pal.hi;
  ctx.fillRect(-1.8, -185, 3.6, 24);
  ctx.fillStyle = pal.gold;
  ctx.fillRect(-2.2, -205, 4.4, 20);
  form(ctx, blob([[0, -203], [-6, -214], [2, -226], [13, -222], [22, -207], [24, -190], [15, -198], [7, -204]]), {
    fill: lin(ctx, 0, -226, 20, -190, 0, pal.blueHi, 1, pal.blueLo), rim: pal.rim, rimTo, rimBlur: 2,
  });
  // pauldrons
  plate(oval(-37, -147, 16, 13, -0.25));
  plate(oval(37, -149, 16, 13, 0.25));
  ctx.strokeStyle = pal.gold;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.ellipse(-37, -147, 16, 13, -0.25, 0.4, 2.6);
  ctx.ellipse(37, -149, 16, 13, 0.25, 0.5, 2.7);
  ctx.stroke();

  // tower shield
  const shield = new Shape().M(-61, -140).Q(-61, -154, -49, -154).L(-14, -157).Q(-3, -157, -3, -145)
    .L(-5, -78).Q(-8, -50, -32, -30).Q(-57, -50, -60, -82).Z();
  form(ctx, shield, {
    fill: lin(ctx, -60, -157, -4, -30, 0, pal.blueHi, 0.5, pal.blue, 1, pal.blueLo),
    shade: pal.dark, shadeTo: [3, 6], shadeBlur: 14, rim: pal.rim, rimTo: [rimTo[0], -3], rimBlur: 3,
  });
  ctx.save();
  ctx.clip(shield.path);
  ctx.strokeStyle = lin(ctx, -60, -157, -4, -30, 0, pal.goldHi, 0.5, pal.gold, 1, pal.goldLo);
  ctx.lineWidth = 9;
  ctx.stroke(shield.path);
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.moveTo(-32, -158);
  ctx.lineTo(-32, -30);
  ctx.moveTo(-62, -112);
  ctx.lineTo(-2, -114);
  ctx.stroke();
  ctx.restore();
  form(ctx, oval(-32, -113, 9), {
    fill: rad(ctx, -34, -116, 11, 0, '#ffffff', 0.35, pal.goldHi, 1, pal.goldLo), shade: pal.dark, shadeTo: [3, 3], shadeBlur: 5,
  });
  ctx.restore();

  // world-space sword tip, for the caller's glow pass
  const bx = x + (49 + Math.sin(swordAng) * 50) * s;
  const by = y + (-203 - Math.cos(swordAng) * 50) * s;
  return [bx, by];
}

function paintFootmen(ctx, rng) {
  const W = 300;
  const H = 400;
  ctx.fillStyle = lin(ctx, 0, 0, 0, H, 0, '#071023', 0.26, '#193a6c', 0.48, '#5b8ac0', 0.61, '#f6e3b3', 0.665, '#cdb48c', 0.67, '#9d927e', 1, '#080c1a');
  ctx.fillRect(0, 0, W, H);
  dabs(ctx, rng, 34, [-30, -10, 360, 200], ['#244d86', '#102550', '#7da6d6', '#3a68a4', '#0b1a3c'], 24, 70, 0.22, 0.42);
  dabs(ctx, rng, 16, [-20, 188, 340, 56], ['#ffe6ad', '#ffc98f', '#fff6dc', '#ffb4a0'], 22, 58, 0.28, 0.3);
  glow(ctx, 150, 252, 200, '#ffe0a0', 0.6);
  glow(ctx, 150, 258, 60, '#ffffff', 0.6);
  shafts(ctx, rng, 150, 260, 340, 11, '#ffe7ac', 0.13, -Math.PI * 0.95, -Math.PI * 0.05, 0.06);

  // distant host on the horizon
  ctx.fillStyle = '#4c5f86';
  for (let i = 0; i < 25; i++) {
    const x = i * 12.5 + rng() * 8 - 4;
    const y = 264 + rng() * 4;
    ctx.beginPath();
    ctx.arc(x, y - 6, 3.4, 0, TAU);
    ctx.fill();
    ctx.fillRect(x - 3.6, y - 5, 7.2, 12);
    ctx.fillRect(x + 4, y - 28 - rng() * 14, 1.1, 36);
  }
  // ground
  ctx.fillStyle = lin(ctx, 0, 266, 0, H, 0, '#a89674', 0.08, '#555a6c', 0.32, '#1c2540', 1, '#060914');
  ctx.fillRect(0, 266, W, H - 266);
  glow(ctx, 150, 270, 120, '#ffe6b0', 0.4, 1.7, 0.2);
  dabs(ctx, rng, 12, [-20, 270, 340, 80], ['#1a2440', '#3d4762', '#0d1428'], 20, 50, 0.3, 0.25);

  // banner
  ctx.fillStyle = '#18223e';
  ctx.fillRect(16, 84, 3, 230);
  const cloth = new Shape().M(19, 92).Q(40, 82, 66, 96).L(64, 172).Q(52, 160, 42, 174).Q(30, 162, 19, 170).Z();
  form(ctx, cloth, {
    fill: lin(ctx, 19, 88, 62, 172, 0, '#5a96f0', 0.45, '#2152b4', 1, '#0b1f56'),
    shade: 'rgba(4,8,30,0.8)', shadeTo: [-3, 5], shadeBlur: 12, rim: '#fff0c4', rimTo: [3, -1], rimBlur: 3,
  });
  strokePath(ctx, (c) => { c.moveTo(20, 103); c.quadraticCurveTo(40, 93, 65, 107); }, '#e3b755', 2.4);
  form(ctx, poly([[42, 118], [50, 132], [42, 146], [34, 132]]), { fill: '#f1d68a' });

  const front = {
    hi: '#c2d2ea', mid: '#566d94', lo: '#121d36', dark: 'rgba(3,6,18,0.9)', rim: '#fff0c4',
    blueHi: '#5a98f5', blue: '#2356b8', blueLo: '#0a1d52', gold: '#e3b755', goldHi: '#fff1b8', goldLo: '#7d5a1a',
  };
  const back = {};
  for (const k of Object.keys(front)) back[k] = front[k][0] === '#' ? mix(front[k], '#7f93b8', 0.26) : front[k];
  back.dark = 'rgba(20,32,62,0.75)';

  // long shadows thrown toward the viewer
  const cast = (x, y, s) => {
    const dx = (x - 150) * 0.9;
    ctx.fillStyle = lin(ctx, x, y, x + dx, y + 100, 0, 'rgba(3,6,18,0.7)', 1, 'rgba(3,6,18,0)');
    ctx.beginPath();
    ctx.moveTo(x - 30 * s, y - 2);
    ctx.lineTo(x + 32 * s, y - 2);
    ctx.lineTo(x + dx + 70 * s, y + 100);
    ctx.lineTo(x + dx - 66 * s, y + 100);
    ctx.closePath();
    ctx.fill();
  };
  cast(74, 300, 0.8);
  cast(230, 300, 0.8);
  const tips = [];
  tips.push(footman(ctx, 74, 300, 0.8, back, 0.05, [3, -1]));
  tips.push(footman(ctx, 228, 300, 0.8, back, 0.3, [-3, -1]));
  // haze between the ranks
  dabs(ctx, rng, 10, [-10, 250, 320, 60], ['#ffe9bf', '#c9d6ea'], 30, 60, 0.13, 0.35);
  cast(152, 322, 1.06);
  tips.push(footman(ctx, 152, 322, 1.06, front, 0.2, [-3, -2]));

  for (const [bx, by] of tips) {
    glow(ctx, bx, by, 30, '#6fc8ff', 0.4, 0.5, 1.5);
    sparkle(ctx, bx, by - 30, 11, '#cfeeff', 0.9);
  }
  // dust kicked up at the feet
  dabs(ctx, rng, 14, [-20, 300, 340, 70], ['#b9a886', '#4a5268', '#141a30'], 18, 46, 0.16, 0.4);
  motes(ctx, rng, 46, [0, 60, 300, 280], ['#ffe6b0', '#ffffff', '#bfe0ff'], 0.5, 1.8, 0.7);
  finish(ctx, W, H, { bloom: 0.2 });
}

// Hooded archer at full draw, facing +x. Chest sits at the local origin.
function archerFigure(ctx, pal, detail) {
  const cloth = (shape, hi, lo, extra = {}) =>
    form(ctx, shape, {
      fill: lin(ctx, 30, -80, -40, 120, 0, hi, 1, lo),
      shade: pal.shadow, shadeTo: [-5, 5], shadeBlur: 11, rim: pal.rim, rimTo: [3, -3], rimBlur: 2.5, ...extra,
    });

  // cloak streaming behind: bright lining flashing at the hem, then the cloak
  cloth(poly([[-40, 70], [8, 96], [30, 150], [22, 186], [-4, 168], [-30, 190], [-58, 172], [-90, 184], [-104, 156], [-130, 150], [-112, 110]]),
    pal.liningHi, pal.liningLo, { rim: null, shadeBlur: 14 });
  const cloak = poly([[-18, -46], [8, -56], [26, -30], [18, 24], [12, 84], [24, 140], [10, 164], [-14, 150], [-36, 172], [-62, 152],
    [-88, 166], [-100, 138], [-120, 132], [-92, 86], [-110, 40], [-74, -4], [-42, -36]]);
  cloth(cloak, pal.cloakHi, pal.cloakLo, { shadeBlur: 20, rimBlur: 5, rimTo: [5, -3] });
  // broad fold planes, light then dark, clipped to the cloak
  ctx.save();
  ctx.clip(cloak.path);
  for (const [x0, y0, x1, y1, wd, light] of [[-14, -34, -52, 158, 15, 1], [-56, -8, -112, 130, 12, 1], [6, 6, 2, 150, 9, 1],
    [-34, -24, -82, 160, 10, 0], [-4, -16, -22, 160, 8, 0], [-78, 10, -122, 110, 7, 0]]) {
    ctx.fillStyle = light ? lin(ctx, x0, y0, x1, y1, 0, rgba(pal.fold, 0.55), 1, rgba(pal.fold, 0.03)) : pal.shadowSoft;
    ctx.fill(leaf(x0, y0, x1, y1, wd, 0.5).path);
  }
  ctx.restore();
  // quiver
  ctx.save();
  ctx.translate(-30, -24);
  ctx.rotate(-0.55);
  cloth(poly([[-8, -30], [8, -30], [7, 34], [-7, 34]]), pal.leatherHi, pal.leatherLo);
  for (const fx of [-5, 0, 5]) {
    form(ctx, leaf(fx, -30, fx * 1.6, -52, 3.4), { fill: pal.glowSoft });
  }
  ctx.restore();

  // torso
  cloth(poly([[-25, -30], [20, -34], [28, 2], [22, 50], [26, 116], [-32, 116], [-27, 50], [-33, 2]]), pal.leatherHi, pal.leatherLo);
  form(ctx, poly([[-24, -28], [-12, -33], [27, 38], [22, 50]]), { fill: pal.strap, rim: pal.rim, rimTo: [2, -2], rimBlur: 2 });
  form(ctx, poly([[-29, 42], [24, 38], [24, 50], [-29, 55]]), { fill: pal.strap, rim: pal.rim, rimTo: [0, -2], rimBlur: 2 });
  if (detail) {
    ctx.fillStyle = pal.glowSoft;
    ctx.fillRect(-5, 41, 9, 9);
  }
  // draw arm: elbow pulled back
  cloth(poly([[-13, -34], [-17, -12], [-62, -27], [-58, -46]]), pal.sleeveHi, pal.sleeveLo);
  cloth(poly([[-60, -47], [-63, -29], [2, -32], [5, -46]]), pal.sleeveHi, pal.sleeveLo);
  // bow arm
  cloth(poly([[10, -37], [36, -44], [84, -41], [86, -27], [38, -21], [14, -13]]), pal.sleeveHi, pal.sleeveLo);
  form(ctx, poly([[56, -44], [84, -41], [86, -27], [58, -23]]), { fill: pal.strap, rim: pal.rim, rimTo: [1, -3], rimBlur: 2 });
  // mantle + hood
  cloth(blob([[-32, -40], [-6, -50], [24, -42], [32, -24], [0, -15], [-36, -21]]), pal.hoodHi, pal.hoodLo);
  cloth(blob([[-14, -40], [-22, -58], [-44, -78], [-14, -88], [10, -88], [27, -75], [31, -53], [25, -36], [8, -29]]), pal.hoodHi, pal.hoodLo, { rimBlur: 3 });
  ctx.fillStyle = pal.face;
  ctx.fill(blob([[13, -74], [26, -65], [28, -49], [21, -38], [10, -44], [7, -60]]).path);
  // jaw catching the arrow's light under the hood's shadow
  ctx.fillStyle = lin(ctx, 12, -52, 28, -40, 0, pal.face, 1, pal.skin);
  ctx.fill(blob([[15, -54], [27, -55], [27.5, -46], [22, -39], [14, -44]]).path);
  glow(ctx, 21, -60, 8, pal.glowAlt, 0.9);
  ctx.fillStyle = '#ffffff';
  ctx.fill(oval(21.5, -60, 3.4, 1.3, -0.2).path);
  form(ctx, oval(90, -34, 7.5, 8), { fill: pal.leatherLo, rim: pal.rim, rimTo: [2, -2], rimBlur: 2 });
  form(ctx, oval(2, -39, 7, 6.5), { fill: pal.leatherLo, rim: pal.rim, rimTo: [2, -2], rimBlur: 2 });

  // bow
  const limbs = (c) => {
    c.moveTo(46, -136);
    c.bezierCurveTo(54, -126, 96, -84, 92, -34);
    c.bezierCurveTo(96, 16, 54, 58, 46, 68);
  };
  strokePath(ctx, limbs, pal.bow, 7.5);
  strokePath(ctx, limbs, pal.bowHi, 2.4, 0.75);
  glowPath(ctx, limbs, pal.glow, 2.2, 10, detail ? 0.95 : 0.5, '#f4f0ff');
  glow(ctx, 46, -136, 12, pal.glow, 0.8);
  glow(ctx, 46, 68, 12, pal.glow, 0.8);
  // string and arrow
  strokePath(ctx, (c) => { c.moveTo(46, -136); c.lineTo(3, -39); c.lineTo(46, 68); }, '#e9f4ff', 1.1, 0.9);
  if (detail) {
    for (const fy of [-7, 7]) form(ctx, leaf(3, -39, -16, -39 + fy, 3), { fill: pal.glowSoft });
    // arcane fire streaming back off the arrowhead: the arrow's light trail
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [x1, dy, wd, col, a] of [[20, 10, 13, pal.glow, 0.5], [44, -12, 10, pal.glow, 0.45], [70, 4, 7, pal.glowAlt, 0.6], [96, -2, 4, '#ffffff', 0.8]]) {
      ctx.fillStyle = lin(ctx, 144, -33, x1, -36 + dy, 0, rgba(col, a), 1, rgba(col, 0));
      ctx.fill(leaf(146, -33, x1, -36 + dy, wd, 0.3).path);
    }
    ctx.restore();
  }
  glowPath(ctx, (c) => { c.moveTo(3, -39); c.lineTo(124, -34); }, pal.glow, 3.6, 12, 1, '#ffffff');
  form(ctx, poly([[112, -45], [150, -33], [112, -22], [120, -33.5]]), { fill: '#ffffff' });
  glow(ctx, 132, -33, detail ? 40 : 18, pal.glow, 0.9);
  glow(ctx, 134, -33, detail ? 18 : 9, pal.glowAlt, 1);
}

function paintArcher(ctx, rng) {
  const W = 300;
  const H = 400;
  ctx.fillStyle = lin(ctx, 0, 0, 0, H, 0, '#0b0624', 0.3, '#2a1460', 0.55, '#6a2fa8', 0.7, '#c05ab4', 0.76, '#3a1c5e', 1, '#090516');
  ctx.fillRect(0, 0, W, H);
  dabs(ctx, rng, 30, [-30, -10, 360, 230], ['#3b1d86', '#170a3e', '#7a45c8', '#241064', '#9a4fc0'], 26, 74, 0.22, 0.45);
  // moon
  glow(ctx, 226, 84, 150, '#b79cff', 0.5);
  ctx.fillStyle = rad(ctx, 216, 74, 62, 0, '#ffffff', 0.5, '#efe6ff', 1, '#b9a2f2');
  ctx.fill(oval(226, 84, 47).path);
  dabs(ctx, rng, 7, [196, 56, 60, 56], ['#a48fe0', '#cdbdf6'], 6, 14, 0.4, 0.8);
  glow(ctx, 226, 84, 70, '#ffffff', 0.4);
  motes(ctx, rng, 40, [0, 0, 300, 200], ['#ffffff', '#cdbdff'], 0.3, 1, 0.8);
  // ridges and pines
  const ridge = (y, amp, col, seedStep) => {
    const pts = [[-10, H]];
    for (let x = -10; x <= 310; x += seedStep) pts.push([x, y + (rng() - 0.5) * amp]);
    pts.push([310, H]);
    ctx.fillStyle = col;
    ctx.fill(poly(pts).path);
  };
  ridge(272, 22, '#3f1f72', 26);
  for (let i = 0; i < 16; i++) {
    const x = rng() * 300;
    const hgt = 22 + rng() * 34;
    ctx.fillStyle = '#231046';
    ctx.fill(poly([[x - hgt * 0.26, 296], [x, 296 - hgt], [x + hgt * 0.26, 296]]).path);
  }
  ridge(300, 14, '#1a0c38', 30);
  dabs(ctx, rng, 12, [-20, 250, 340, 60], ['#c86ac8', '#7a45c8'], 26, 60, 0.16, 0.3);

  const back = {
    cloakHi: '#3d2580', cloakLo: '#140a34', liningHi: '#5a2a7a', liningLo: '#1c0a34', fold: '#6a48b8', hoodHi: '#4a2e92', hoodLo: '#1a0d42',
    sleeveHi: '#2c2a78', sleeveLo: '#12103a', leatherHi: '#2f2060', leatherLo: '#120a2c', strap: '#100826', face: '#080414', skin: '#3a2a5a',
    bow: '#120828', bowHi: '#5a3f9a', shadow: 'rgba(8,3,24,0.8)', shadowSoft: 'rgba(8,3,24,0.3)', rim: '#d9a8ff',
    glow: '#b58cff', glowAlt: '#8fe9ff', glowSoft: '#8f7fd8',
  };
  const main = {
    cloakHi: '#6a36c0', cloakLo: '#170a3c', liningHi: '#d0428e', liningLo: '#4a0f4a', fold: '#a478f0', hoodHi: '#8a5ae0', hoodLo: '#2a1462',
    sleeveHi: '#3f5ac8', sleeveLo: '#131c58', leatherHi: '#5a3a70', leatherLo: '#150a26', strap: '#0e0620', face: '#05020c', skin: '#c9a0c8',
    bow: '#0c0520', bowHi: '#7a5ac8', shadow: 'rgba(4,1,16,0.85)', shadowSoft: 'rgba(6,2,22,0.32)', rim: '#f0e2ff',
    glow: '#b58cff', glowAlt: '#8fe9ff', glowSoft: '#bfe9ff',
  };
  // second marksman on the ridge behind, cut out against the mist
  glow(ctx, 62, 236, 86, '#d07ad8', 0.5);
  ctx.save();
  ctx.translate(50, 252);
  ctx.rotate(-0.36);
  ctx.scale(0.48, 0.48);
  archerFigure(ctx, back, false);
  ctx.restore();
  dabs(ctx, rng, 8, [-20, 262, 180, 70], ['#7a45c8', '#c86ac8'], 26, 56, 0.2, 0.5);

  ctx.save();
  ctx.translate(134, 196);
  ctx.rotate(-0.2);
  ctx.scale(1.1, 1.1);
  archerFigure(ctx, main, true);
  ctx.restore();

  // glint and drifting sparks at the arrowhead
  const tip = [134 + (140 * Math.cos(-0.2) + 33 * Math.sin(-0.2)) * 1.1, 196 + (140 * Math.sin(-0.2) - 33 * Math.cos(-0.2)) * 1.1];
  sparkle(ctx, tip[0], tip[1], 24, '#d9c4ff', 1, 0.2);
  motes(ctx, rng, 30, [tip[0] - 150, tip[1] - 40, 160, 90], ['#b58cff', '#8fe9ff', '#ffffff'], 0.5, 2, 0.9, [-0.2, 0.3, 2.4]);
  // rocky ledge in the foreground
  form(ctx, blob([[-20, 420], [-20, 352], [40, 340], [110, 352], [170, 346], [230, 358], [320, 350], [320, 420]]), {
    fill: lin(ctx, 0, 340, 0, 400, 0, '#2a1458', 1, '#070314'), rim: '#b58cff', rimTo: [1, -3], rimBlur: 3,
  });
  dabs(ctx, rng, 12, [-20, 300, 340, 80], ['#2a1460', '#0b0624', '#6a2fa8'], 26, 60, 0.3, 0.35);
  finish(ctx, W, H, { bloom: 0.34, vignetteColor: '#06021a' });
}

function paintGolem(ctx, rng) {
  const W = 300;
  const H = 400;
  ctx.fillStyle = lin(ctx, 0, 0, 0, H, 0, '#1a0f07', 0.28, '#5c3512', 0.52, '#b8702a', 0.7, '#f2b862', 0.78, '#7b5330', 1, '#170e08');
  ctx.fillRect(0, 0, W, H);
  dabs(ctx, rng, 30, [-30, -10, 360, 300], ['#7a4a1c', '#2c1a0c', '#d08a3a', '#4a2c12', '#f0c070'], 26, 76, 0.22, 0.5);
  glow(ctx, 236, 92, 170, '#ffd58a', 0.7);
  glow(ctx, 236, 92, 60, '#fff3d0', 0.7);
  shafts(ctx, rng, 236, 92, 330, 9, '#ffd9a0', 0.13, Math.PI * 0.45, Math.PI * 1.05, 0.06);

  // tiny tower, far below, for scale
  ctx.fillStyle = '#8c5c30';
  ctx.fill(poly([[267, 304], [269, 250], [265, 250], [265, 236], [270, 236], [270, 242], [275, 242], [275, 236], [281, 236], [281, 242], [286, 242], [286, 236], [291, 236], [291, 250], [287, 250], [289, 304]]).path);
  ctx.fillStyle = '#5e3a1c';
  ctx.fill(poly([[278, 304], [278, 250], [291, 250], [287, 250], [289, 304]]).path);
  ctx.fillStyle = '#ffe2a0';
  ctx.fillRect(273, 262, 3, 6);
  strokePath(ctx, (c) => { c.moveTo(278, 236); c.lineTo(278, 222); }, '#5e3a1c', 1);
  ctx.fillStyle = '#c0452a';
  ctx.fill(poly([[278, 222], [288, 225], [278, 229]]).path);
  ctx.fillStyle = lin(ctx, 0, 296, 0, H, 0, '#6e4a2a', 0.3, '#3a2616', 1, '#120a06');
  ctx.fillRect(0, 300, W, 100);

  const pal = { hi: '#cdb089', mid: '#75604c', lo: '#231b20', dark: 'rgba(8,5,8,0.9)', rim: '#ffd08a' };
  const rock = (pts, tone = 0, extra = {}) => {
    const s = poly(pts);
    const hi = tone > 0 ? mix(pal.hi, '#ffe9c4', tone) : mix(pal.hi, '#1a120c', -tone);
    const lo = tone > 0 ? pal.lo : mix(pal.lo, '#050302', -tone);
    form(ctx, s, {
      fill: lin(ctx, s.x1, s.y0, s.x0, s.y1, 0, hi, 0.5, mix(pal.mid, '#1a120c', Math.max(0, -tone)), 1, lo),
      shade: pal.dark, shadeTo: [-5, 6], shadeBlur: 14, rim: pal.rim, rimTo: [4, -3], rimBlur: 3.5, ...extra,
    });
    return s;
  };
  const crack = (x0, y0, x1, y1, w = 1.6) => strokePath(ctx, trace(jag(rng, x0, y0, x1, y1, 5, 5)), 'rgba(10,6,3,0.8)', w);
  const vein = (x0, y0, x1, y1, w = 2) => glowPath(ctx, trace(jag(rng, x0, y0, x1, y1, 5, 4)), '#ff9a2a', w, 9, 0.95, '#fff0b0');

  // far arm
  rock([[206, 132], [250, 138], [262, 204], [222, 212]], -0.35);
  rock([[212, 204], [264, 200], [274, 256], [254, 294], [214, 290], [204, 250]], -0.25);
  rock([[200, 264], [238, 250], [270, 264], [276, 302], [248, 324], [210, 316], [194, 292]], -0.1);
  crack(214, 268, 262, 300);
  // legs
  rock([[90, 236], [144, 236], [148, 300], [152, 336], [82, 336], [86, 300]], -0.3);
  rock([[158, 236], [208, 236], [214, 300], [218, 336], [154, 336], [156, 300]], -0.35);
  rock([[100, 212], [202, 212], [210, 250], [150, 264], [92, 250]], -0.2);
  // torso
  rock([[76, 118], [118, 94], [186, 94], [228, 118], [216, 192], [196, 228], [106, 228], [86, 192]], -0.15);
  rock([[84, 122], [145, 110], [143, 172], [126, 196], [96, 186]], 0.05);
  rock([[156, 110], [220, 122], [208, 186], [176, 196], [158, 172]], 0.2);
  rock([[110, 200], [146, 204], [144, 226], [108, 226]], -0.1);
  rock([[156, 204], [192, 200], [194, 226], [158, 226]], 0);
  crack(92, 132, 130, 180);
  crack(210, 130, 180, 176);
  // molten core
  glow(ctx, 150, 172, 70, '#ff8a1a', 0.75);
  const core = poly([[150, 142], [172, 164], [163, 196], [137, 196], [128, 164]]);
  form(ctx, core, { fill: rad(ctx, 150, 170, 30, 0, '#ffffff', 0.3, '#ffe08a', 0.7, '#ff8a1a', 1, '#8a2a05'), shade: 'rgba(60,14,0,0.8)', shadeTo: [0, -5], shadeBlur: 8 });
  for (const [x, y] of [[104, 138], [200, 136], [112, 208], [190, 210], [150, 236]]) {
    vein(150 + (x - 150) * 0.22, 170 + (y - 170) * 0.3, x, y, 2.2);
  }
  glow(ctx, 150, 170, 26, '#fff3c0', 0.9);

  // head, sunk between the shoulders
  murk(ctx, 150, 126, 46, 0.55, 1.2, 0.6);
  rock([[128, 84], [150, 72], [174, 84], [178, 108], [166, 124], [136, 124], [124, 108]], 0.05);
  rock([[126, 86], [150, 76], [176, 86], [172, 96], [150, 102], [130, 96]], -0.3, { rim: null });
  rock([[136, 114], [166, 114], [162, 130], [140, 130]], -0.4);
  for (const sx of [-1, 1]) {
    const eye = poly([[150 + sx * 15, 98], [150 + sx * 4, 102], [150 + sx * 5, 107], [150 + sx * 14, 104]]);
    ctx.fillStyle = '#fff0b0';
    ctx.fill(eye.path);
    glow(ctx, 150 + sx * 10, 102, 13, '#ff9a2a', 1);
  }
  // shoulders
  rock([[36, 130], [50, 96], [86, 78], [120, 92], [128, 124], [112, 156], [70, 164], [42, 152]], 0);
  rock([[50, 96], [86, 78], [120, 92], [98, 112], [62, 116]], 0.25, { shade: null });
  rock([[66, 86], [76, 58], [90, 80]], 0.1);
  rock([[90, 82], [100, 66], [110, 88]], -0.1);
  rock([[178, 92], [214, 76], [250, 92], [264, 124], [254, 154], [226, 162], [192, 152], [174, 122]], 0.2);
  rock([[178, 92], [214, 76], [250, 92], [236, 110], [198, 112]], 0.45, { shade: null });
  rock([[222, 80], [234, 54], [244, 84]], 0.3);
  rock([[196, 84], [204, 68], [214, 82]], 0.15);
  crack(46, 128, 96, 150);
  crack(190, 118, 250, 140);
  // glowing rune carved into the near shoulder
  glowPath(ctx, trace([[70, 150], [70, 122], [86, 132], [70, 140], [88, 152]]), '#ff9a2a', 2.2, 8, 0.9, '#fff0b0');

  // near arm, forearm and fist
  murk(ctx, 70, 176, 44, 0.5, 1.1, 0.7);
  murk(ctx, 226, 176, 40, 0.45, 1.1, 0.7);
  rock([[38, 146], [84, 152], [86, 216], [42, 224], [28, 186]], -0.1);
  rock([[24, 214], [90, 208], [100, 262], [82, 302], [32, 306], [12, 262]], 0.05);
  rock([[8, 270], [40, 252], [88, 256], [106, 282], [100, 320], [60, 338], [20, 328], [2, 300]], 0.12);
  rock([[14, 276], [40, 260], [60, 262], [56, 290], [22, 298]], 0.3, { shade: null });
  rock([[62, 262], [86, 262], [100, 284], [84, 296], [60, 290]], 0.2, { shade: null });
  crack(30, 220, 84, 250);
  crack(20, 300, 96, 310, 2);
  vein(44, 232, 78, 292, 1.6);
  vein(224, 222, 250, 280, 1.4);

  // cool shadow pooling low on the unlit side
  dabs(ctx, rng, 14, [-20, 190, 230, 150], ['#5a5a8c', '#3a3a62'], 30, 60, 0.4, 0.8, 'multiply');
  // flying debris, dust and embers
  for (let i = 0; i < 11; i++) {
    const x = 10 + rng() * 280;
    const y = 240 + rng() * 80;
    const r = 3 + rng() * 7;
    const pts = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + rng();
      pts.push([x + Math.cos(a) * r * (0.6 + rng() * 0.6), y + Math.sin(a) * r * (0.6 + rng() * 0.6)]);
    }
    rock(pts, rng() * 0.4 - 0.2, { shadeBlur: 4, rimBlur: 1.5 });
  }
  dabs(ctx, rng, 22, [-30, 292, 360, 90], ['#d9b07a', '#8a6038', '#f2d09a', '#4a3018'], 22, 56, 0.3, 0.45);
  dabs(ctx, rng, 8, [-20, 60, 340, 220], ['#f2c070'], 30, 70, 0.07, 0.5, 'lighter');
  motes(ctx, rng, 34, [0, 40, 300, 300], ['#ffb040', '#ffe2a0'], 0.5, 1.9, 0.8);
  finish(ctx, W, H, { bloom: 0.32, vignetteColor: '#0c0603' });
}

// Tapered, ragged flame body pointing along +x from a rounded head.
function flameBody(rng, len, r, wobble, n = 9) {
  const top = [];
  const bot = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const rr = r * Math.pow(1 - t, 0.8) + 0.8;
    const wob = wobble * t * (rng() - 0.5) * 2;
    top.push([t * len, -rr * (0.85 + rng() * 0.3) + wob]);
    bot.unshift([t * len, rr * (0.85 + rng() * 0.3) + wob]);
  }
  return blob([[-r * 1.02, 0], [-r * 0.72, -r * 0.78], ...top, ...bot, [-r * 0.72, r * 0.78]]);
}

function paintFireball(ctx, rng) {
  const W = 300;
  const H = 400;
  ctx.fillStyle = lin(ctx, 0, 0, 0, H, 0, '#0d0407', 0.35, '#2c0a0b', 0.62, '#7a1c0c', 0.74, '#d0501a', 0.78, '#3a0e08', 1, '#070304');
  ctx.fillRect(0, 0, W, H);
  dabs(ctx, rng, 34, [-30, -10, 360, 290], ['#3a0d0c', '#12060a', '#7a2410', '#1c080a', '#a8401a'], 26, 76, 0.26, 0.5);

  const hx = 116;
  const hy = 226;
  const ang = Math.atan2(30 - hy, 300 - hx);
  glow(ctx, hx + 20, hy - 20, 210, '#ff5a1a', 0.5);

  // scorched land, lit from above
  const ridge = (y, amp, step, fill, rim) => {
    const pts = [[-10, H]];
    for (let x = -10; x <= 312; x += step) pts.push([x, y + (rng() - 0.5) * amp]);
    pts.push([312, H]);
    form(ctx, poly(pts), { fill, rim, rimTo: [0, -3], rimBlur: 4 });
  };
  ridge(292, 26, 22, lin(ctx, 0, 276, 0, 350, 0, '#6a1c0c', 0.35, '#2a0a08', 1, '#0c0304'), '#ff8a3a');
  for (const [x, hgt] of [[236, 46], [262, 34], [208, 26]]) {
    strokePath(ctx, (c) => {
      c.moveTo(x, 300); c.lineTo(x + 2, 300 - hgt);
      c.moveTo(x + 1, 300 - hgt * 0.55); c.lineTo(x + 10, 300 - hgt * 0.85);
      c.moveTo(x + 1, 300 - hgt * 0.4); c.lineTo(x - 9, 300 - hgt * 0.7);
    }, '#140506', 2.2);
  }
  ridge(326, 20, 26, lin(ctx, 0, 316, 0, 400, 0, '#2a0a08', 1, '#060203'), '#ff6a2a');
  glow(ctx, 70, 322, 110, '#ff6a1a', 0.5, 1.5, 0.3);
  for (let i = 0; i < 5; i++) {
    const x = 20 + rng() * 150;
    glowPath(ctx, trace(jag(rng, x, 332 + rng() * 10, x + 30 + rng() * 40, 350 + rng() * 30, 4, 5)), '#ff7a1a', 1.5, 7, 0.8, '#ffe08a');
  }

  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(ang);
  // smoke trail behind the flames
  dabs(ctx, rng, 30, [30, -74, 270, 112], ['#1a0a0a', '#4a1c14', '#0a0405', '#6a2c1a', '#2a1210'], 18, 46, 0.6, 0.8);
  // layered tail: crimson -> orange -> yellow -> white
  const layers = [
    [272, 54, 20, '#c2180c', '#5a0a08', 0.95],
    [226, 43, 15, '#ff5a14', '#c2260c', 1],
    [170, 31, 10, '#ffb52e', '#ff6a14', 1],
    [108, 20, 6, '#fff4c0', '#ffc840', 1],
  ];
  for (const [len, r, wob, c0, c1, a] of layers) {
    ctx.fillStyle = lin(ctx, -r, 0, len, 0, 0, rgba(c0, a), 0.45, rgba(c1, a * 0.9), 1, rgba(c1, 0));
    ctx.fill(flameBody(rng, len, r, wob).path);
  }
  // tongues of flame peeling off the tail
  for (let i = 0; i < 12; i++) {
    const t = 0.1 + rng() * 0.7;
    const side = rng() < 0.5 ? -1 : 1;
    const x = t * 230;
    const y = side * (46 * Math.pow(1 - t, 0.8) + 2);
    const x1 = x + 26 + rng() * 30;
    const y1 = y + side * (8 + rng() * 14);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = lin(ctx, x, y, x1, y1, 0, rgba('#ffb040', 0.9), 0.6, rgba('#ff5a14', 0.7), 1, rgba('#c2180c', 0));
    ctx.fill(leaf(x, y * 0.8, x1, y1, 5 + rng() * 6).path);
    ctx.restore();
  }
  // the meteor itself: rock glowing through its cracks
  const rockPts = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU;
    const r = 30 * (0.82 + rng() * 0.3);
    rockPts.push([Math.cos(a) * r - 4, Math.sin(a) * r]);
  }
  form(ctx, poly(rockPts), {
    fill: lin(ctx, -34, 0, 30, 0, 0, '#3a1408', 0.45, '#b03c0c', 1, '#ffc040'),
    shade: 'rgba(20,4,2,0.85)', shadeTo: [-6, 0], shadeBlur: 10, rim: '#ffe08a', rimTo: [4, 0], rimBlur: 5,
  });
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * 0.55 + rng() * Math.PI * 0.9;
    glowPath(ctx, trace(jag(rng, 2, 0, Math.cos(a) * 28 - 4, Math.sin(a) * 28, 4, 4)), '#ff8a1a', 1.8, 7, 0.95, '#fff0b0');
  }
  ctx.fillStyle = lin(ctx, 0, 0, 96, 0, 0, 'rgba(255,255,255,0.95)', 1, 'rgba(255,240,180,0)');
  ctx.fill(flameBody(rng, 96, 15, 4).path);
  // sparks torn off along the path
  for (let i = 0; i < 26; i++) {
    const x = rng() * 250;
    const y = (rng() - 0.5) * (40 + x * 0.5);
    const l = 8 + rng() * 20;
    streak(ctx, x + l, y + (rng() - 0.5) * 6, x, y, 0.8 + rng() * 1.4, '#ffb040', 0.5 + rng() * 0.5);
  }
  ctx.restore();

  glow(ctx, hx, hy, 80, '#ffb040', 0.7);
  glow(ctx, hx + 6, hy - 6, 34, '#ffffff', 0.85);
  motes(ctx, rng, 44, [0, 40, 300, 300], ['#ff8a1a', '#ffd070', '#ff4a1a'], 0.5, 2, 0.85, [ang, 0.5, 2.2]);
  dabs(ctx, rng, 10, [-20, 330, 340, 70], ['#060203', '#1a0606'], 26, 60, 0.4, 0.4);
  finish(ctx, W, H, { bloom: 0.36, vignetteColor: '#080102' });
}

// Faceted crystal growing from (x,y) along `ang` (0 = straight up).
function crystal(ctx, x, y, len, wid, ang, pal) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const sh = len * 0.74;
  const body = poly([[-wid, 0], [-wid * 1.14, -sh], [0, -len], [wid * 1.14, -sh], [wid, 0]]);
  form(ctx, body, { fill: lin(ctx, 0, -len, 0, 0, 0, pal.tip, 0.4, pal.mid, 1, pal.base), rim: '#eafcff', rimTo: [-2, -2], rimBlur: 2 });
  ctx.fillStyle = lin(ctx, 0, -len, 0, 0, 0, rgba(pal.dark, 0.3), 1, rgba(pal.dark, 0.85));
  ctx.fill(poly([[wid * 0.25, 0], [wid * 0.2, -sh * 0.98], [0, -len], [wid * 1.14, -sh], [wid, 0]]).path);
  ctx.fillStyle = lin(ctx, 0, -len, 0, 0, 0, 'rgba(255,255,255,0.85)', 0.5, 'rgba(200,244,255,0.3)', 1, 'rgba(120,200,255,0.05)');
  ctx.fill(poly([[-wid, 0], [-wid * 1.14, -sh], [0, -len], [-wid * 0.38, -sh * 0.96], [-wid * 0.46, 0]]).path);
  strokePath(ctx, (c) => {
    c.moveTo(-wid * 0.46, 0); c.lineTo(-wid * 0.38, -sh * 0.96); c.lineTo(0, -len);
    c.lineTo(wid * 0.2, -sh * 0.98); c.lineTo(wid * 0.25, 0);
  }, 'rgba(255,255,255,0.65)', 1);
  ctx.restore();
}

function paintFrostTower(ctx, rng) {
  const W = 300;
  const H = 400;
  ctx.fillStyle = lin(ctx, 0, 0, 0, H, 0, '#030b1a', 0.35, '#0a2646', 0.66, '#17607c', 0.74, '#0d3550', 1, '#040a14');
  ctx.fillRect(0, 0, W, H);
  dabs(ctx, rng, 22, [-30, -10, 360, 260], ['#0e3a5e', '#041226', '#135a78'], 26, 70, 0.22, 0.5);
  motes(ctx, rng, 40, [0, 0, 300, 180], ['#ffffff', '#bfeaff'], 0.3, 0.9, 0.8);
  // aurora curtains
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [y0, amp, col, ph, a] of [[54, 26, '#3dffc8', 0.4, 0.34], [96, 20, '#4fc3ff', 2.1, 0.22], [34, 16, '#a48dff', 4.0, 0.26]]) {
    for (let x = -4; x < W; x += 5) {
      const top = y0 + Math.sin(x * 0.021 + ph) * amp + Math.sin(x * 0.057 + ph * 2) * amp * 0.4;
      const hgt = 70 + Math.sin(x * 0.11 + ph) * 26 + rng() * 22;
      ctx.globalAlpha = a * (0.45 + 0.55 * Math.abs(Math.sin(x * 0.045 + ph * 1.7))) * (0.7 + rng() * 0.5);
      ctx.fillStyle = lin(ctx, 0, top, 0, top + hgt, 0, rgba(col, 0), 0.16, rgba(col, 1), 1, rgba(col, 0));
      ctx.fillRect(x, top, 6, hgt);
    }
  }
  ctx.restore();
  // mountains
  const range = (y, amp, step, top, bottom, rim) => {
    const pts = [[-10, 330]];
    for (let x = -10; x <= 312; x += step) pts.push([x, y + (rng() - 0.5) * amp]);
    pts.push([312, 330]);
    form(ctx, poly(pts), { fill: lin(ctx, 0, y - amp, 0, 320, 0, top, 1, bottom), rim, rimTo: [-2, -3], rimBlur: 3 });
  };
  range(250, 60, 30, '#2c6c8c', '#0c3048', '#bff4ff');
  range(278, 30, 24, '#17486a', '#082438', '#8fe0ff');
  ctx.fillStyle = lin(ctx, 0, 296, 0, H, 0, '#2a6a88', 0.25, '#0f3550', 1, '#040a14');
  ctx.fillRect(0, 300, W, 100);
  glow(ctx, 150, 300, 150, '#6fe0ff', 0.4, 1.4, 0.3);

  const ice = { tip: '#f2fdff', mid: '#6fd8f4', base: '#1a6c9c', dark: '#06304e' };
  const iceDim = { tip: '#c4f0ff', mid: '#49b0d6', base: '#135680', dark: '#04253e' };
  // shards behind the spire
  crystal(ctx, 112, 268, 96, 12, -0.62, iceDim);
  crystal(ctx, 190, 268, 90, 12, 0.66, iceDim);
  // stone plinth
  const stone = (pts) => form(ctx, poly(pts), {
    fill: lin(ctx, 90, 0, 210, 0, 0, '#5d7890', 0.5, '#33475c', 1, '#121c2a'),
    shade: 'rgba(2,8,16,0.8)', shadeTo: [4, 5], shadeBlur: 10, rim: '#bfefff', rimTo: [-3, -2], rimBlur: 3,
  });
  stone([[84, 326], [216, 326], [206, 296], [94, 296]]);
  stone([[100, 296], [200, 296], [190, 262], [110, 262]]);
  strokePath(ctx, (c) => {
    for (const x of [126, 152, 178]) { c.moveTo(x, 296); c.lineTo(x + 2, 326); }
    for (const x of [136, 166]) { c.moveTo(x, 262); c.lineTo(x - 1, 296); }
  }, 'rgba(2,8,16,0.6)', 1.4);
  glowPath(ctx, trace([[150, 268], [141, 279], [150, 290], [159, 279], [150, 268], [150, 290]]), '#6fe0ff', 1.6, 7, 0.95, '#eafcff');
  // snow caps and icicles
  for (const [y, x0, x1] of [[262, 108, 192], [296, 92, 208]]) {
    const pts = [[x0, y + 3]];
    for (let x = x0; x <= x1; x += 12) pts.push([x, y - 5 - rng() * 4]);
    pts.push([x1, y + 3]);
    for (let x = x1 - 6; x > x0; x -= 14) pts.push([x, y + 5 + rng() * 5]);
    form(ctx, blob(pts), { fill: lin(ctx, 0, y - 8, 0, y + 8, 0, '#ffffff', 1, '#9fd6f0'), shade: 'rgba(20,70,110,0.6)', shadeTo: [3, 4], shadeBlur: 5 });
  }
  for (let i = 0; i < 9; i++) {
    const x = 96 + i * 13.5 + rng() * 5;
    form(ctx, leaf(x, 300, x + 1, 310 + rng() * 12, 2.4, 0.2), { fill: 'rgba(210,244,255,0.9)' });
  }

  // the spire
  glow(ctx, 150, 170, 120, '#4fc3ff', 0.5, 0.8, 1.3);
  crystal(ctx, 128, 266, 150, 13, -0.3, ice);
  crystal(ctx, 172, 266, 140, 13, 0.32, ice);
  crystal(ctx, 150, 268, 206, 23, 0, ice);
  crystal(ctx, 134, 268, 58, 8, -0.75, ice);
  crystal(ctx, 166, 268, 54, 8, 0.8, ice);
  glow(ctx, 150, 190, 46, '#bff4ff', 0.5, 0.5, 2);
  strokePath(ctx, (c) => { c.moveTo(150, 250); c.lineTo(150, 100); }, 'rgba(255,255,255,0.5)', 2.4);

  // icy beam lancing out of the tip
  const bx = 150;
  const by = 66;
  const ex = 330;
  const ey = 176;
  for (const [wd, col, a, blur] of [[26, '#3fa8e8', 0.3, 18], [12, '#7fe0ff', 0.6, 12], [5, '#eafcff', 1, 6]]) {
    glowPath(ctx, (c) => { c.moveTo(bx, by); c.lineTo(ex, ey); }, col, wd, blur, a);
  }
  strokePath(ctx, (c) => { c.moveTo(bx, by); c.lineTo(ex, ey); }, '#ffffff', 2.2);
  for (let i = 0; i < 14; i++) {
    const t = 0.1 + rng() * 0.8;
    const px = bx + (ex - bx) * t;
    const py = by + (ey - by) * t;
    form(ctx, leaf(px, py, px + (rng() - 0.3) * 26, py + 6 + rng() * 22, 2.2), { fill: 'rgba(220,248,255,0.8)' });
  }
  glow(ctx, bx, by, 60, '#7fe0ff', 0.9);
  sparkle(ctx, bx, by, 46, '#bff4ff', 1, 0.3);
  glow(ctx, bx, by, 16, '#ffffff', 1);

  // snowfall and drifts
  motes(ctx, rng, 70, [0, 20, 300, 330], ['#ffffff', '#cfefff'], 0.5, 2.1, 0.85, [2.0, 0.4, 1.5]);
  dabs(ctx, rng, 14, [-20, 310, 340, 70], ['#cfeeff', '#2a6a88', '#0a2030'], 24, 56, 0.24, 0.35);
  for (let i = 0; i < 9; i++) sparkle(ctx, 30 + rng() * 240, 130 + rng() * 190, 4 + rng() * 6, '#cff4ff', 0.9);
  finish(ctx, W, H, { bloom: 0.36, vignetteColor: '#01060f' });
}

function paintHealingWave(ctx, rng) {
  const W = 300;
  const H = 400;
  ctx.fillStyle = lin(ctx, 0, 0, 0, H, 0, '#03130d', 0.4, '#0b3a28', 0.66, '#1c7a48', 0.76, '#0c3a26', 1, '#030d08');
  ctx.fillRect(0, 0, W, H);
  dabs(ctx, rng, 30, [-30, -10, 360, 300], ['#0c4a30', '#03130d', '#1c7a48', '#062a1c', '#3a9a52'], 26, 72, 0.24, 0.6);
  // grove trunks framing the light
  for (const [x, wd, lean] of [[18, 26, 6], [58, 12, -3], [282, 28, -8], [246, 11, 4]]) {
    form(ctx, poly([[x - wd / 2, 330], [x - wd / 2 + lean, -10], [x + wd / 2 + lean, -10], [x + wd / 2 + 4, 330]]), {
      fill: lin(ctx, 0, 0, 0, 330, 0, '#03100b', 1, '#082418'),
      rim: '#b8ff9a', rimTo: [x < 150 ? 3 : -3, 0], rimBlur: 4,
    });
  }
  dabs(ctx, rng, 18, [-30, -30, 360, 90], ['#020b07', '#06261a', '#0a3a24'], 30, 70, 0.6, 0.5);

  const cx = 150;
  const cy = 264;
  glow(ctx, cx, 170, 190, '#7dff9a', 0.4);
  glow(ctx, cx, 180, 110, '#fff1b8', 0.5);
  shafts(ctx, rng, cx, -30, 420, 9, '#d8ffb0', 0.1, Math.PI * 0.36, Math.PI * 0.64, 0.05);
  shafts(ctx, rng, cx, 250, 300, 12, '#fff1b8', 0.1, -Math.PI * 0.86, -Math.PI * 0.14, 0.05);

  // ground and the expanding rings of the wave
  ctx.fillStyle = lin(ctx, 0, 250, 0, H, 0, 'rgba(20,90,50,0.0)', 0.2, '#0c3a26', 1, '#020a06');
  ctx.fillRect(0, 250, W, 150);
  glow(ctx, cx, cy, 150, '#9dffb0', 0.5, 1, 0.26);
  const ring = (rx, ry, wd, col, a, blur) => glowPath(ctx, (c) => c.ellipse(cx, cy, rx, ry, 0, 0, TAU), col, wd, blur, a, '#ffffff');
  ring(196, 52, 3, '#5dffb0', 0.35, 10);
  // rising curtain of light along the main ring
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * TAU + rng() * 0.05;
    const x = cx + Math.cos(a) * 132;
    const y = cy + Math.sin(a) * 36;
    const hgt = 26 + rng() * 76;
    const col = rng() < 0.4 ? '#fff1b8' : '#7dffa6';
    ctx.globalAlpha = (Math.sin(a) > 0 ? 0.3 : 0.17) * (0.5 + rng() * 0.5);
    ctx.fillStyle = lin(ctx, 0, y, 0, y - hgt, 0, rgba(col, 1), 1, rgba(col, 0));
    ctx.fillRect(x - 3, y - hgt, 6, hgt);
  }
  ctx.restore();
  ring(132, 36, 5, '#b8ff9a', 0.9, 14);
  ring(84, 22, 2.5, '#fff1b8', 0.7, 9);
  ring(40, 10, 2, '#ffffff', 0.6, 7);

  // laurel leaves cradling the sigil
  const leafPair = (x0, y0, dx, dy, wid, hi, lo) => {
    for (const s of [-1, 1]) {
      const lf = leaf(cx + s * x0, y0, cx + s * (x0 + dx), y0 + dy, wid, 0.45);
      form(ctx, lf, {
        fill: lin(ctx, cx, y0, cx + s * (x0 + dx), y0 + dy, 0, hi, 1, lo),
        shade: 'rgba(2,24,12,0.7)', shadeTo: [0, 5], shadeBlur: 7, rim: '#eaffc0', rimTo: [0, -3], rimBlur: 2.5,
      });
      strokePath(ctx, (c) => { c.moveTo(cx + s * x0, y0); c.lineTo(cx + s * (x0 + dx * 0.9), y0 + dy * 0.9); }, 'rgba(234,255,192,0.6)', 1.1);
    }
  };
  leafPair(6, 244, 84, -40, 17, '#b8ff9a', '#1c8a48');
  leafPair(10, 232, 70, -74, 16, '#9dffb0', '#17703c');
  leafPair(12, 218, 44, -96, 13, '#d8ffb0', '#249a52');

  // ankh sigil of restoration
  const ankh = (c) => {
    c.moveTo(cx, 160);
    c.bezierCurveTo(cx - 40, 146, cx - 34, 92, cx, 92);
    c.bezierCurveTo(cx + 34, 92, cx + 40, 146, cx, 160);
  };
  const arms = poly([[cx - 44, 158], [cx - 6, 163], [cx, 160], [cx + 6, 163], [cx + 44, 158], [cx + 46, 176], [cx + 7, 174], [cx + 11, 236], [cx, 246], [cx - 11, 236], [cx - 7, 174], [cx - 46, 176]]);
  ctx.save();
  ctx.shadowColor = '#7dff9a';
  ctx.shadowBlur = 22;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#8a6a1a';
  ctx.lineWidth = 17;
  ctx.beginPath();
  ankh(ctx);
  ctx.stroke();
  ctx.fillStyle = '#8a6a1a';
  ctx.lineWidth = 5;
  ctx.fill(arms.path);
  ctx.stroke(arms.path);
  ctx.restore();
  const gold = lin(ctx, cx - 30, 90, cx + 30, 246, 0, '#ffffff', 0.3, '#fff1b8', 0.7, '#f2cc66', 1, '#c9952e');
  ctx.strokeStyle = gold;
  ctx.lineWidth = 12;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ankh(ctx);
  ctx.stroke();
  form(ctx, arms, { fill: gold, rim: '#ffffff', rimTo: [-2, -3], rimBlur: 2.5, shade: 'rgba(120,80,10,0.6)', shadeTo: [3, 4], shadeBlur: 5 });
  strokePath(ctx, (c) => { c.moveTo(cx - 3, 154); c.bezierCurveTo(cx - 33, 142, cx - 28, 97, cx - 2, 96); }, 'rgba(255,255,255,0.85)', 2.2);
  form(ctx, poly([[cx, 196], [cx + 5, 204], [cx, 212], [cx - 5, 204]]), { fill: '#3dd68c' });
  glow(ctx, cx, 126, 30, '#eaffc0', 0.8);
  glow(ctx, cx, 168, 90, '#b8ff9a', 0.35);
  sparkle(ctx, cx, 126, 26, '#fff1b8', 0.9);

  // rising motes and little crosses of light
  motes(ctx, rng, 60, [20, 40, 260, 280], ['#b8ff9a', '#fff1b8', '#5dffb0'], 0.5, 2.2, 0.9, [Math.PI / 2, 0.2, 1.8]);
  for (let i = 0; i < 9; i++) {
    const x = 34 + rng() * 232;
    const y = 70 + rng() * 210;
    if (Math.abs(x - cx) < 46 && y > 84 && y < 250) continue;
    const r = 4 + rng() * 5;
    glowPath(ctx, (c) => { c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r); }, '#b8ff9a', 2.2, 7, 0.85, '#ffffff');
  }
  dabs(ctx, rng, 12, [-20, 320, 340, 70], ['#020a06', '#0c3a26'], 26, 60, 0.4, 0.35);
  finish(ctx, W, H, { bloom: 0.36, vignetteColor: '#010a05' });
}

function runeGlyph(kind, cx, cy, s) {
  const strokes = {
    generic: [[[-0.3, 0.6], [-0.3, -0.6], [0.32, -0.26], [-0.3, 0.06], [0.36, 0.6]]],
    damage: [[[0, 0.62], [0, -0.6]], [[-0.4, -0.16], [0, -0.6], [0.4, -0.16]], [[-0.4, 0.26], [0, -0.18], [0.4, 0.26]]],
    haste: [[[-0.46, -0.5], [0, 0], [-0.46, 0.5]], [[0.04, -0.5], [0.5, 0], [0.04, 0.5]]],
    regen: [[[-0.4, 0.6], [0.4, -0.16], [0, -0.6], [-0.4, -0.16], [0.4, 0.6]]],
  }[kind];
  return (c) => {
    for (const line of strokes) line.forEach(([x, y], i) => (i ? c.lineTo(cx + x * s, cy + y * s) : c.moveTo(cx + x * s, cy + y * s)));
  };
}

// Fallback for unknown cards: an ornate rune card back.
function paintCardBack(ctx, rng) {
  const W = 300;
  const H = 400;
  ctx.fillStyle = rad(ctx, 150, 200, 280, 0, '#24408a', 0.45, '#131c44', 1, '#060915');
  ctx.fillRect(0, 0, W, H);
  dabs(ctx, rng, 26, [-20, -20, 340, 440], ['#1c2f70', '#0a0f22', '#3558b0'], 26, 70, 0.22, 0.7);
  shafts(ctx, rng, 150, 200, 260, 22, '#4fc3ff', 0.08, 0, TAU, 0.05);
  // lattice
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.strokeStyle = '#e3b755';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -400; i < 700; i += 34) {
    ctx.moveTo(i, 0); ctx.lineTo(i + 400, 400);
    ctx.moveTo(i, 0); ctx.lineTo(i - 400, 400);
  }
  ctx.stroke();
  ctx.restore();
  const gold = lin(ctx, 0, 0, 300, 400, 0, '#fff1b8', 0.35, '#e3b755', 0.7, '#8a6420', 1, '#e3b755');
  const frame = (inset, lw, r) => {
    ctx.strokeStyle = gold;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(inset + r, inset);
    ctx.arcTo(W - inset, inset, W - inset, H - inset, r);
    ctx.arcTo(W - inset, H - inset, inset, H - inset, r);
    ctx.arcTo(inset, H - inset, inset, inset, r);
    ctx.arcTo(inset, inset, W - inset, inset, r);
    ctx.closePath();
    ctx.stroke();
  };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 6;
  frame(13, 5, 16);
  frame(23, 1.4, 10);
  ctx.restore();
  for (const [x, y] of [[23, 23], [277, 23], [23, 377], [277, 377], [150, 23], [150, 377], [23, 200], [277, 200]]) {
    form(ctx, poly([[x, y - 9], [x + 9, y], [x, y + 9], [x - 9, y]]), { fill: gold, rim: '#ffffff', rimTo: [-2, -2], rimBlur: 2, shade: 'rgba(60,40,0,0.7)', shadeTo: [2, 2], shadeBlur: 3 });
  }
  // medallion
  glow(ctx, 150, 200, 150, '#4fc3ff', 0.4);
  for (const [r, lw] of [[92, 2], [84, 5], [66, 1.2]]) {
    ctx.strokeStyle = gold;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(150, 200, r, 0, TAU);
    ctx.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    form(ctx, leaf(150 + Math.cos(a) * 70, 200 + Math.sin(a) * 70, 150 + Math.cos(a) * 82, 200 + Math.sin(a) * 82, 3.2, 0.5), { fill: gold });
  }
  form(ctx, poly([[150, 142], [196, 200], [150, 258], [104, 200]]), {
    fill: lin(ctx, 110, 142, 190, 258, 0, '#2a6ad0', 0.5, '#123070', 1, '#070f30'),
    shade: 'rgba(2,6,24,0.8)', shadeTo: [4, 5], shadeBlur: 12, rim: '#9fe2ff', rimTo: [-3, -3], rimBlur: 3, line: '#e3b755', lw: 2.4,
  });
  glowPath(ctx, runeGlyph('generic', 150, 200, 40), '#4fc3ff', 5, 14, 1, '#f0fbff');
  motes(ctx, rng, 40, [20, 20, 260, 360], ['#4fc3ff', '#fff1b8'], 0.4, 1.6, 0.8);
  finish(ctx, W, H, { bloom: 0.3 });
}

/* ════════════════════════════ PORTRAITS ════════════════════════════ */

function paintKnight(ctx, rng) {
  const W = 256;
  ctx.fillStyle = rad(ctx, 128, 112, 196, 0, '#5fc4ff', 0.3, '#1f5fb5', 0.65, '#0c1f4d', 1, '#040816');
  ctx.fillRect(0, 0, W, W);
  dabs(ctx, rng, 26, [-10, -10, 276, 276], ['#2a7bd6', '#0d2a66', '#7fd8ff', '#143a86'], 22, 60, 0.24, 0.6);
  shafts(ctx, rng, 128, 116, 230, 16, '#9fe2ff', 0.13, 0, TAU, 0.07);
  glow(ctx, 128, 110, 118, '#8fdcff', 0.55);

  const steel = (x0, y0, x1, y1) => lin(ctx, x0, y0, x1, y1, 0, '#f6fbff', 0.35, '#a9bfdc', 0.75, '#4c648e', 1, '#1e2c4e');
  const gold = (x0, y0, x1, y1) => lin(ctx, x0, y0, x1, y1, 0, '#fff6cc', 0.4, '#e3b755', 1, '#7d5a1a');
  const dark = 'rgba(4,10,30,0.85)';
  const rim = '#bfeeff';

  // cape
  form(ctx, blob([[14, 266], [28, 196], [70, 160], [128, 150], [186, 160], [228, 196], [242, 266]]), {
    fill: lin(ctx, 0, 150, 0, 256, 0, '#3a74e6', 1, '#0a1a4c'), shade: dark, shadeTo: [0, -6], shadeBlur: 18, rim, rimTo: [0, -3], rimBlur: 3,
  });
  // plume: tall crest sweeping back over the helm
  form(ctx, blob([[122, 66], [112, 40], [118, 16], [138, 8], [164, 14], [186, 30], [196, 52], [178, 44], [160, 42], [148, 50], [140, 66]]), {
    fill: lin(ctx, 118, 10, 180, 60, 0, '#7fc0ff', 0.45, '#2f6fe0', 1, '#0d2a7a'), shade: dark, shadeTo: [3, 6], shadeBlur: 10, rim: '#e6f6ff', rimTo: [-2, -3], rimBlur: 3,
  });
  for (const [a, b, c] of [[[124, 60], [120, 30], [150, 16]], [[134, 62], [138, 36], [172, 28]], [[142, 64], [152, 46], [186, 42]]]) {
    strokePath(ctx, (k) => { k.moveTo(a[0], a[1]); k.quadraticCurveTo(b[0], b[1], c[0], c[1]); }, 'rgba(8,24,90,0.55)', 2.4);
  }

  // wings swept up from the temples
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(128, 0);
    ctx.scale(side, 1);
    const feathers = [[-1.24, 66], [-1.0, 64], [-0.76, 58], [-0.52, 50], [-0.28, 40]];
    feathers.forEach(([a, len], i) => {
      const x1 = 36 + Math.cos(a) * len;
      const y1 = 110 + Math.sin(a) * len;
      form(ctx, leaf(34, 112, x1, y1, 9.5 - i * 0.6, 0.55), {
        fill: lin(ctx, 34, 112, x1, y1, 0, '#e3b755', 0.25, '#f2f8ff', 0.7, '#b5c8e4', 1, '#6c84b0'),
        shade: dark, shadeTo: [0, 4], shadeBlur: 6, rim: '#ffffff', rimTo: [0, -3], rimBlur: 2,
      });
    });
    form(ctx, oval(38, 110, 11, 13), { fill: gold(28, 98, 48, 124), shade: 'rgba(70,40,0,0.7)', shadeTo: [2, 4], shadeBlur: 5, rim: '#ffffff', rimTo: [-2, -2], rimBlur: 2 });
    ctx.restore();
  }

  // raised sword: the brightest thing in the frame
  ctx.save();
  ctx.translate(204, 206);
  ctx.rotate(0.03);
  glow(ctx, 0, -90, 74, '#4fc3ff', 0.5, 0.45, 1.6);
  const blade = poly([[-10.5, 0], [-9, -144], [0, -176], [9, -144], [10.5, 0]]);
  ctx.save();
  ctx.shadowColor = '#4fc3ff';
  ctx.shadowBlur = 16;
  ctx.fillStyle = lin(ctx, -10.5, 0, 10.5, 0, 0, '#49b8f5', 0.22, '#bfeeff', 0.5, '#ffffff', 0.78, '#d6f4ff', 1, '#3a9fe6');
  ctx.fill(blade.path);
  ctx.restore();
  ctx.fillStyle = 'rgba(60,150,235,0.45)';
  ctx.fill(poly([[-1.6, -4], [1.6, -4], [1.2, -132], [0, -146], [-1.2, -132]]).path);
  strokePath(ctx, (c) => { c.moveTo(-10, -2); c.lineTo(-8.6, -144); c.lineTo(0, -175); }, '#ffffff', 1.3, 0.95);
  form(ctx, poly([[-26, -3], [26, -3], [29, 4], [0, 9], [-29, 4]]), { fill: gold(0, -4, 0, 10), shade: 'rgba(70,40,0,0.7)', shadeTo: [0, 4], shadeBlur: 4, rim: '#ffffff', rimTo: [0, -2], rimBlur: 2 });
  form(ctx, oval(0, 3, 5), { fill: '#7fe6ff' });
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(-4, 9, 8, 30);
  ctx.restore();

  // gorget and chest
  form(ctx, poly([[80, 262], [88, 198], [128, 182], [168, 198], [176, 262]]), {
    fill: steel(90, 180, 170, 262), shade: dark, shadeTo: [4, 6], shadeBlur: 14, rim, rimTo: [3, -2], rimBlur: 3,
  });
  form(ctx, poly([[92, 200], [128, 188], [164, 200], [162, 210], [128, 199], [94, 210]]), { fill: gold(92, 188, 164, 210) });
  ctx.fillStyle = '#060c1c';
  ctx.fill(poly([[100, 172], [156, 172], [162, 198], [128, 190], [94, 198]]).path);
  form(ctx, poly([[128, 214], [139, 228], [128, 244], [117, 228]]), { fill: rad(ctx, 126, 224, 16, 0, '#ffffff', 0.4, '#7fe6ff', 1, '#1c6cc0'), line: '#e3b755', lw: 2 });
  glow(ctx, 128, 228, 20, '#4fc3ff', 0.7);

  // pauldrons, layered lames with gold edging
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(128, 0);
    ctx.scale(side, 1);
    form(ctx, blob([[40, 262], [36, 214], [56, 188], [92, 184], [120, 204], [128, 262]]), {
      fill: steel(40, 186, 120, 262), shade: dark, shadeTo: [side * 3, 7], shadeBlur: 14, rim, rimTo: [side * 3, -3], rimBlur: 3,
    });
    form(ctx, blob([[44, 232], [40, 204], [60, 182], [94, 178], [118, 196], [120, 222], [84, 208]]), {
      fill: steel(40, 176, 116, 236), shade: dark, shadeTo: [side * 3, 6], shadeBlur: 9, rim: '#ffffff', rimTo: [side * 2, -3], rimBlur: 2.5,
    });
    strokePath(ctx, (c) => { c.moveTo(44, 232); c.quadraticCurveTo(84, 204, 120, 222); }, '#e3b755', 3.2);
    strokePath(ctx, (c) => { c.moveTo(42, 256); c.quadraticCurveTo(88, 230, 126, 248); }, '#c79a3a', 2.4);
    form(ctx, oval(82, 196, 4), { fill: '#fff1b8' });
    ctx.restore();
  }

  // helm
  const helm = new Shape().M(86, 114).C(86, 72, 108, 56, 128, 56).C(148, 56, 170, 72, 170, 114)
    .L(168, 150).C(164, 172, 146, 190, 128, 198).C(110, 190, 92, 172, 88, 150).Z();
  form(ctx, helm, {
    fill: lin(ctx, 96, 56, 164, 196, 0, '#ffffff', 0.3, '#b7cbe6', 0.7, '#566e98', 1, '#243458'),
    shade: dark, shadeTo: [-4, 6], shadeBlur: 16, rim, rimTo: [4, -1], rimBlur: 4, rim2: '#ffffff', rim2To: [-2, -3], rim2Blur: 3,
  });
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill(blob([[98, 96], [100, 76], [112, 66], [118, 70], [108, 82], [104, 98]]).path);
  // cheek plates
  strokePath(ctx, (c) => { c.moveTo(100, 134); c.lineTo(106, 168); c.lineTo(128, 190); c.lineTo(150, 168); c.lineTo(156, 134); }, 'rgba(10,20,50,0.55)', 1.6);
  for (const sx of [-1, 1]) for (const [dx, dy] of [[18, 150], [15, 160], [21, 160]]) {
    ctx.fillStyle = 'rgba(6,12,30,0.8)';
    ctx.fill(oval(128 + sx * dx, dy, 1.6).path);
  }
  // gold brow band and crest ridge
  form(ctx, new Shape().M(85, 106).Q(128, 92, 171, 106).L(171, 116).Q(128, 102, 85, 116).Z(), {
    fill: gold(85, 96, 171, 116), shade: 'rgba(70,40,0,0.7)', shadeTo: [0, 3], shadeBlur: 3, rim: '#ffffff', rimTo: [0, -2], rimBlur: 1.5,
  });
  form(ctx, poly([[123, 57], [133, 57], [132, 104], [128, 110], [124, 104]]), {
    fill: gold(123, 57, 133, 110), shade: 'rgba(70,40,0,0.7)', shadeTo: [-2, 0], shadeBlur: 3, rim: '#ffffff', rimTo: [2, 0], rimBlur: 1.5,
  });
  // T-visor, lit from within
  const visor = new Shape().M(96, 121).Q(128, 113, 160, 121).L(158, 133).Q(144, 129, 133, 129)
    .L(132, 176).L(128, 184).L(124, 176).L(123, 129).Q(112, 129, 98, 133).Z();
  ctx.fillStyle = '#020812';
  ctx.fill(visor.path);
  ctx.save();
  ctx.clip(visor.path);
  glow(ctx, 128, 126, 40, '#4fc3ff', 1, 1, 0.3);
  glow(ctx, 112, 126, 12, '#eaffff', 1, 1, 0.45);
  glow(ctx, 144, 126, 12, '#eaffff', 1, 1, 0.45);
  glow(ctx, 128, 150, 30, '#4fc3ff', 0.55, 0.3, 1);
  ctx.restore();
  ctx.strokeStyle = 'rgba(10,20,50,0.7)';
  ctx.lineWidth = 1.2;
  ctx.stroke(visor.path);
  glow(ctx, 128, 126, 46, '#4fc3ff', 0.5, 1, 0.5);

  sparkle(ctx, 205, 60, 30, '#bfeeff', 1, 0.1);
  sparkle(ctx, 204, 120, 14, '#bfeeff', 0.8);
  motes(ctx, rng, 36, [10, 10, 236, 236], ['#9fe2ff', '#ffffff', '#fff1b8'], 0.5, 1.8, 0.8);
  finish(ctx, W, W, { bloom: 0.3, texScale: 0.85, vignette: 0.7, vignetteColor: '#020512' });
}

function paintMorgath(ctx, rng) {
  const W = 256;
  ctx.fillStyle = rad(ctx, 128, 160, 210, 0, '#8a1c0a', 0.35, '#3d0a08', 0.7, '#150405', 1, '#050203');
  ctx.fillRect(0, 0, W, W);
  dabs(ctx, rng, 28, [-10, -10, 276, 276], ['#1a0607', '#4a0e0a', '#000000', '#6a160c'], 22, 62, 0.3, 0.6);
  glow(ctx, 128, 262, 170, '#ff5a1a', 0.5);
  shafts(ctx, rng, 128, 280, 260, 10, '#ff7a2a', 0.1, -Math.PI * 0.9, -Math.PI * 0.1, 0.06);

  const dark = 'rgba(3,1,2,0.9)';
  const ember = '#ff7a2a';
  const obsidian = (x0, y0, x1, y1) => lin(ctx, x0, y0, x1, y1, 0, '#5a4650', 0.3, '#2a1c22', 0.75, '#0e080a', 1, '#040203');
  const vein = (pts, w = 1.8) => glowPath(ctx, trace(pts), '#ff6a1a', w, 8, 0.95, '#ffe9a0');

  // tattered cape
  form(ctx, poly([[-4, 262], [6, 204], [40, 170], [92, 156], [164, 156], [216, 170], [250, 204], [260, 262]]), {
    fill: lin(ctx, 0, 156, 0, 256, 0, '#a3161c', 1, '#2a0508'), shade: dark, shadeTo: [0, -6], shadeBlur: 18, rim: '#ff5a36', rimTo: [0, -3], rimBlur: 3,
  });

  // molten great-blade resting on the shoulder; drawn later, over the pauldron
  const greatBlade = () => {
    ctx.save();
    ctx.translate(186, 254);
    ctx.rotate(0.26);
    ctx.scale(1.05, 1.05);
    glow(ctx, 0, -100, 80, '#ff5a1a', 0.55, 0.6, 1.5);
    const blade = poly([[-18, 0], [-16, -42], [-23, -52], [-15, -64], [-14, -102], [-21, -112], [-12, -124], [-9, -152], [0, -182],
      [10, -152], [14, -110], [8, -100], [15, -90], [16, -50], [9, -40], [17, -30], [18, 0]]);
    form(ctx, blade, {
      fill: lin(ctx, -20, 0, 20, 0, 0, '#4a3034', 0.5, '#1a0e12', 1, '#0a0507'),
      shade: dark, shadeTo: [4, 0], shadeBlur: 8, rim: '#ffb060', rimTo: [-3, -1], rimBlur: 2.5, rim2: '#ff5a1a', rim2To: [3, 0],
    });
    const melt = poly([[-5.5, 0], [-5, -140], [0, -164], [5, -140], [5.5, 0]]);
    ctx.save();
    ctx.shadowColor = '#ff6a1a';
    ctx.shadowBlur = 14;
    ctx.fillStyle = lin(ctx, 0, -164, 0, 0, 0, '#fff6c8', 0.4, '#ffc040', 1, '#ff6a14');
    ctx.fill(melt.path);
    ctx.restore();
    for (const [y, x] of [[-30, 15], [-56, -19], [-84, 14], [-106, -17], [-128, 11], [-146, -9]]) {
      vein(jag(rng, x < 0 ? -5 : 5, y + 6, x, y - 4, 3, 2.5), 1.6);
    }
    ctx.restore();
  };

  // horns
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(128, 0);
    ctx.scale(side, 1);
    const horn = new Shape().M(30, 102).C(66, 108, 92, 72, 68, 16).C(68, 50, 52, 64, 26, 66).Z();
    form(ctx, horn, {
      fill: lin(ctx, 30, 100, 72, 18, 0, '#3a2a2e', 0.5, '#7a6258', 1, '#e8cfa8'),
      shade: dark, shadeTo: [side * -4, -5], shadeBlur: 10, rim: ember, rimTo: [side * 3, 3], rimBlur: 3,
    });
    for (const [x0, y0, x1, y1] of [[40, 68, 46, 102], [54, 62, 66, 92], [62, 50, 78, 70], [66, 36, 78, 46]]) {
      strokePath(ctx, (c) => { c.moveTo(x0, y0); c.quadraticCurveTo((x0 + x1) / 2 + 5, (y0 + y1) / 2 - 3, x1, y1); }, 'rgba(8,3,4,0.6)', 1.8);
    }
    ctx.restore();
  }

  // spiked pauldrons with magma veins
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(128, 0);
    ctx.scale(side, 1);
    form(ctx, poly([[30, 262], [28, 200], [46, 180], [50, 150], [66, 176], [84, 140], [94, 180], [116, 150], [118, 196], [132, 216], [134, 262]]), {
      fill: obsidian(40, 140, 120, 262), shade: dark, shadeTo: [0, -6], shadeBlur: 14, rim: ember, rimTo: [side * 2, 4], rimBlur: 3, rim2: '#c8402a', rim2To: [side * 3, -3], rim2Blur: 2.5,
    });
    form(ctx, poly([[40, 232], [44, 204], [66, 192], [98, 196], [118, 212], [112, 236], [78, 226]]), {
      fill: obsidian(44, 190, 110, 240), shade: dark, shadeTo: [0, -5], shadeBlur: 8, rim: '#ff9a4a', rimTo: [0, 3], rimBlur: 2.5,
    });
    vein(jag(rng, 46, 250, 82, 214, 4, 4));
    vein(jag(rng, 82, 214, 110, 188, 3, 4), 1.5);
    vein(jag(rng, 82, 214, 122, 240, 3, 4), 1.5);
    vein(jag(rng, 62, 204, 66, 180, 2, 2), 1.3);
    ctx.restore();
  }

  greatBlade();

  // gorget and chest
  form(ctx, poly([[82, 262], [90, 204], [128, 190], [166, 204], [174, 262]]), {
    fill: obsidian(90, 190, 170, 262), shade: dark, shadeTo: [0, -6], shadeBlur: 12, rim: ember, rimTo: [0, 4], rimBlur: 3,
  });
  ctx.fillStyle = '#030102';
  ctx.fill(poly([[100, 176], [156, 176], [164, 204], [128, 196], [92, 204]]).path);
  vein([[108, 262], [118, 236], [128, 246], [138, 236], [148, 262]], 2.2);
  vein([[128, 246], [128, 222]], 2);
  glow(ctx, 128, 244, 26, '#ff6a1a', 0.6);

  // horned helm
  const helm = poly([[90, 72], [108, 52], [128, 44], [148, 52], [166, 72], [172, 114], [164, 150], [154, 176], [140, 202], [128, 210], [116, 202], [102, 176], [92, 150], [84, 114]]);
  form(ctx, helm, {
    fill: lin(ctx, 100, 44, 156, 210, 0, '#6a545c', 0.3, '#33232a', 0.7, '#120a0d', 1, '#050203'),
    shade: dark, shadeTo: [-4, -6], shadeBlur: 16, rim: ember, rimTo: [4, 2], rimBlur: 4, rim2: '#c8402a', rim2To: [-3, 1], rim2Blur: 3,
  });
  // sagittal ridge and crown spikes
  form(ctx, poly([[122, 46], [128, 22], [134, 46], [132, 104], [128, 112], [124, 104]]), {
    fill: obsidian(122, 22, 134, 112), rim: '#ff9a4a', rimTo: [2, 0], rimBlur: 2,
  });
  for (const sx of [-1, 1]) {
    form(ctx, poly([[128 + sx * 14, 50], [128 + sx * 22, 30], [128 + sx * 28, 58]]), { fill: obsidian(100, 30, 150, 60), rim: '#ff9a4a', rimTo: [sx * 2, 1], rimBlur: 2 });
  }
  // heavy brow
  form(ctx, poly([[84, 96], [128, 118], [172, 96], [170, 110], [128, 132], [86, 110]]), {
    fill: lin(ctx, 0, 96, 0, 132, 0, '#4a363e', 1, '#0a0507'), shade: dark, shadeTo: [0, 4], shadeBlur: 6, rim: '#9a7078', rimTo: [0, -2], rimBlur: 2,
  });
  // jaw grille glowing from the furnace within
  const grille = poly([[106, 152], [150, 152], [146, 180], [136, 200], [128, 204], [120, 200], [110, 180]]);
  ctx.fillStyle = lin(ctx, 0, 150, 0, 204, 0, '#2a0804', 0.5, '#d0481a', 1, '#ffb040');
  ctx.fill(grille.path);
  ctx.save();
  ctx.clip(grille.path);
  ctx.fillStyle = '#0a0507';
  for (const x of [107, 115, 123.5, 132, 140, 148]) ctx.fillRect(x - 2.6, 148, 5.2, 60);
  ctx.restore();
  ctx.strokeStyle = '#050203';
  ctx.lineWidth = 2;
  ctx.stroke(grille.path);
  glow(ctx, 128, 190, 30, '#ff5a1a', 0.5);
  // cheek blades
  for (const sx of [-1, 1]) {
    form(ctx, poly([[128 + sx * 44, 112], [128 + sx * 54, 160], [128 + sx * 30, 176], [128 + sx * 24, 150], [128 + sx * 36, 140]]), {
      fill: obsidian(128, 112, 128 + sx * 50, 176), shade: dark, shadeTo: [0, -4], shadeBlur: 6, rim: ember, rimTo: [sx * 2, 3], rimBlur: 2.5,
    });
  }
  // ember eyes
  for (const sx of [-1, 1]) {
    const eye = poly([[128 + sx * 34, 114], [128 + sx * 8, 127], [128 + sx * 10, 136], [128 + sx * 32, 126]]);
    ctx.fillStyle = '#030102';
    ctx.fill(poly([[128 + sx * 38, 110], [128 + sx * 5, 126], [128 + sx * 8, 140], [128 + sx * 36, 130]]).path);
    ctx.fillStyle = lin(ctx, 128 + sx * 34, 0, 128 + sx * 8, 0, 0, '#ff4a14', 0.5, '#ffb040', 1, '#fff6c8');
    ctx.fill(eye.path);
    glow(ctx, 128 + sx * 20, 125, 24, '#ff6a1a', 0.9);
    glow(ctx, 128 + sx * 16, 127, 9, '#fff0b0', 0.9);
    // flame licking up from the outer corner
    glowPath(ctx, (c) => { c.moveTo(128 + sx * 33, 116); c.bezierCurveTo(128 + sx * 46, 104, 128 + sx * 40, 92, 128 + sx * 50, 80); }, '#ff7a1a', 3, 8, 0.75, '#ffe08a');
  }

  dabs(ctx, rng, 12, [-10, 180, 276, 90], ['#1a0607', '#000000'], 22, 50, 0.3, 0.6);
  motes(ctx, rng, 46, [6, 6, 244, 244], ['#ff7a1a', '#ffd070', '#ff3a1a'], 0.5, 2, 0.9, [-Math.PI / 2, 0.6, 1.9]);
  finish(ctx, W, W, { bloom: 0.34, texScale: 0.85, vignette: 0.75, vignetteColor: '#040001' });
}

/* ══════════════════════════════ ICONS ══════════════════════════════ */

function iconBack(ctx, rng, cx, cy, hi, mid, lo) {
  ctx.fillStyle = rad(ctx, cx, cy, 104, 0, hi, 0.45, mid, 1, lo);
  ctx.fillRect(0, 0, 128, 128);
  dabs(ctx, rng, 12, [-8, -8, 144, 144], [hi, lo, mid], 14, 40, 0.2, 0.7);
}

function iconFinish(ctx, o = {}) {
  finish(ctx, 128, 128, { bloom: 0.3, texScale: 0.6, brush: 0.4, grain: 0.1, vignette: 0.6, ...o });
  // painted bevel so the tile reads as an inset plate
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.strokeRect(3.5, 3.5, 121, 121);
}

function paintSlashDash(ctx, rng) {
  iconBack(ctx, rng, 80, 56, '#3d55b8', '#141c4a', '#04061a');
  for (let i = 0; i < 14; i++) {
    const y = 22 + rng() * 92;
    const x1 = 34 + rng() * 60;
    streak(ctx, x1 - 30 - rng() * 50, y, x1, y, 1 + rng() * 2.2, '#ffe9a8', 0.25 + rng() * 0.4);
  }
  // dashing knight, low and forward, with fading afterimages behind
  const dasher = (dx, alpha, lit) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(48 + dx, 80);
    ctx.rotate(-0.1);
    const look = lit ? { shade: 'rgba(2,3,12,0.85)', shadeTo: [-3, 3], shadeBlur: 5, rim: '#ffd76a', rimTo: [3, -2], rimBlur: 2 } : {};
    const tone = (hi, lo) => (lit ? lin(ctx, 14, -44, -14, 40, 0, hi, 1, lo) : '#3f6ad8');
    // cape torn back by the speed of the dash
    form(ctx, poly([[4, -28], [-30, -40], [-22, -28], [-58, -24], [-36, -12], [-62, 2], [-30, 0], [-44, 16], [-8, 6]]), { ...look, fill: tone('#3b62d0', '#0a1640') });
    // trailing leg, lunging leg
    form(ctx, poly([[-8, 6], [4, 10], [-14, 28], [-34, 34], [-36, 28], [-20, 20]]), { ...look, fill: tone('#27356e', '#080e28') });
    form(ctx, poly([[-2, 6], [12, 0], [32, 16], [30, 36], [38, 40], [20, 40], [20, 22], [4, 16]]), { ...look, fill: tone('#3d5296', '#0c1436') });
    // cuirass, sword arm, helm and plume
    form(ctx, blob([[-12, -22], [4, -34], [20, -26], [18, -2], [6, 12], [-10, 8]]), { ...look, fill: tone('#5068ac', '#0c1436') });
    form(ctx, poly([[10, -28], [36, -24], [38, -15], [10, -14]]), { ...look, fill: tone('#465c9c', '#0c1436') });
    form(ctx, blob([[8, -34], [10, -46], [20, -50], [29, -44], [28, -34], [18, -30]]), { ...look, fill: tone('#7088c4', '#131e4a') });
    form(ctx, leaf(16, -48, -10, -58, 5), { fill: lit ? '#5a98f5' : '#3f6ad8' });
    if (lit) {
      ctx.fillStyle = '#050a1e';
      ctx.fillRect(20, -42, 9, 2.4);
      form(ctx, leaf(36, -20, 66, -46, 3, 0.5), { fill: '#fff7d6' });
    }
    ctx.restore();
  };
  dasher(-30, 0.16, false);
  dasher(-15, 0.3, false);
  dasher(0, 1, true);

  // afterimage arc, then the crescent itself
  const echo = new Shape().M(40, 22).Q(112, 40, 82, 112).Q(84, 58, 40, 22).Z();
  ctx.fillStyle = 'rgba(255,200,90,0.22)';
  ctx.fill(echo.path);
  const cres = new Shape().M(54, 10).Q(140, 30, 98, 118).Q(104, 52, 54, 10).Z();
  ctx.save();
  ctx.shadowColor = '#ffa82a';
  ctx.shadowBlur = 16;
  ctx.fillStyle = rad(ctx, 40, 84, 96, 0, 'rgba(255,180,60,0)', 0.55, '#f0a020', 0.78, '#ffd76a', 0.92, '#fff7d6', 1, '#ffffff');
  ctx.fill(cres.path);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rad(ctx, 40, 84, 96, 0.6, 'rgba(255,200,90,0)', 0.9, 'rgba(255,230,160,0.7)', 1, '#ffffff');
  ctx.fill(cres.path);
  ctx.restore();
  strokePath(ctx, (c) => { c.moveTo(54, 10); c.quadraticCurveTo(140, 30, 98, 118); }, '#ffffff', 2);
  glow(ctx, 110, 54, 44, '#ffc040', 0.45);
  sparkle(ctx, 112, 50, 24, '#fff1b8', 1, 0.5);
  motes(ctx, rng, 16, [60, 10, 64, 110], ['#ffd76a', '#ffffff'], 0.5, 1.6, 0.9, [0, 0.4, 2.4]);
  iconFinish(ctx);
}

function paintAegis(ctx, rng) {
  iconBack(ctx, rng, 64, 64, '#6a4a14', '#221606', '#070402');
  const cx = 64;
  const cy = 66;
  const R = 41;
  glow(ctx, cx, cy, 64, '#ffb52e', 0.6);
  const orbit = (a0, a1) => glowPath(ctx, (c) => c.ellipse(cx, cy, 56, 15, -0.38, a0, a1), '#ffd76a', 3.2, 8, 1, '#fffbe6');
  orbit(Math.PI, TAU); // far half of the ring passes behind the sphere
  ctx.fillStyle = rad(ctx, cx, cy, R, 0, 'rgba(90,50,0,0.5)', 0.55, 'rgba(200,120,10,0.45)', 0.86, 'rgba(255,196,70,0.8)', 1, '#fff7d6');
  ctx.fill(oval(cx, cy, R).path);
  // hex lattice wrapped over the sphere
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.clip();
  ctx.beginPath();
  const cell = 0.34;
  for (let q = -4; q <= 4; q++) {
    for (let r = -5; r <= 5; r++) {
      const hx = cell * 1.5 * q;
      const hy = cell * Math.sqrt(3) * (r + q / 2);
      if (Math.hypot(hx, hy) > 1.2) continue;
      for (let k = 0; k <= 6; k++) {
        const a = (k * TAU) / 6;
        const ux = hx + cell * Math.cos(a);
        const uy = hy + cell * Math.sin(a);
        const rho = Math.hypot(ux, uy);
        const m = rho > 1e-6 ? Math.sin(Math.min(rho, 1) * Math.PI * 0.5) / rho : 1;
        k ? ctx.lineTo(cx + ux * m * R, cy + uy * m * R) : ctx.moveTo(cx + ux * m * R, cy + uy * m * R);
      }
    }
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = '#ffb52e';
  ctx.shadowBlur = 5;
  ctx.strokeStyle = rad(ctx, cx, cy, R, 0, 'rgba(255,230,150,0.35)', 0.7, 'rgba(255,236,170,0.75)', 1, '#ffffff');
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  // shield crest at the heart
  const crest = new Shape().M(64, 44).L(81, 50).Q(82, 76, 64, 90).Q(46, 76, 47, 50).Z();
  form(ctx, crest, {
    fill: lin(ctx, 48, 44, 80, 90, 0, '#fffbe6', 0.4, '#ffd76a', 1, '#b3741a'),
    shade: 'rgba(90,40,0,0.7)', shadeTo: [3, 4], shadeBlur: 6, rim: '#ffffff', rimTo: [-2, -2], rimBlur: 2, line: '#7d4a0a', lw: 1.4,
  });
  ctx.fillStyle = 'rgba(125,74,10,0.55)';
  ctx.fillRect(62.8, 48, 2.4, 38);
  ctx.fillRect(50, 60, 28, 2.4);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fill(blob([[36, 52], [40, 38], [54, 30], [58, 34], [46, 42], [42, 56]]).path);
  ctx.strokeStyle = '#fff7d6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.stroke();
  orbit(0, Math.PI);
  sparkle(ctx, 108, 44, 16, '#fff1b8', 1);
  sparkle(ctx, 18, 88, 11, '#fff1b8', 0.9);
  motes(ctx, rng, 14, [6, 6, 116, 116], ['#ffd76a', '#ffffff'], 0.5, 1.5, 0.9);
  iconFinish(ctx);
}

function paintThunder(ctx, rng) {
  iconBack(ctx, rng, 62, 60, '#2a4aa0', '#0e1840', '#03050f');
  dabs(ctx, rng, 14, [-10, -14, 148, 44], ['#1a2450', '#05081a', '#3a4c8a'], 16, 34, 0.7, 0.55);
  glow(ctx, 66, 14, 44, '#7fe0ff', 0.5);
  // ground
  form(ctx, poly([[0, 128], [0, 104], [22, 100], [48, 104], [78, 100], [104, 105], [128, 101], [128, 128]]), {
    fill: lin(ctx, 0, 100, 0, 128, 0, '#1a2a5c', 1, '#03050f'), rim: '#9feaff', rimTo: [0, -3], rimBlur: 3,
  });
  glow(ctx, 58, 104, 60, '#4fc3ff', 0.8, 1, 0.4);
  glowPath(ctx, (c) => c.ellipse(58, 106, 44, 10, 0, 0, TAU), '#7fe0ff', 2.4, 8, 0.9, '#ffffff');
  glowPath(ctx, (c) => c.ellipse(58, 106, 24, 5, 0, 0, TAU), '#bff4ff', 1.6, 6, 0.8);
  // branches, then the main bolt
  const bolt = [[78, -4], [62, 24], [76, 34], [52, 60], [66, 68], [56, 104]];
  for (const [from, to] of [[[62, 24], [36, 46]], [[76, 34], [100, 56]], [[52, 60], [30, 78]], [[66, 68], [88, 84]]]) {
    glowPath(ctx, trace(jag(rng, from[0], from[1], to[0], to[1], 4, 4)), '#4fc3ff', 1.8, 7, 0.85, '#dff8ff');
  }
  ctx.save();
  ctx.lineJoin = 'miter';
  glowPath(ctx, trace(bolt), '#2f8fe8', 13, 18, 0.55);
  ctx.restore();
  const boltShape = poly([[84, -4], [58, 26], [72, 33], [47, 62], [61, 68], [54, 106], [73, 64], [59, 58], [84, 31], [69, 23], [92, -4]]);
  ctx.save();
  ctx.shadowColor = '#4fc3ff';
  ctx.shadowBlur = 14;
  ctx.fillStyle = lin(ctx, 0, 0, 0, 106, 0, '#bff4ff', 0.5, '#ffffff', 1, '#eaffff');
  ctx.fill(boltShape.path);
  ctx.fill(boltShape.path);
  ctx.restore();
  // impact burst
  glow(ctx, 56, 104, 30, '#ffffff', 0.9, 1, 0.7);
  for (let i = 0; i < 12; i++) {
    const a = -Math.PI * (0.08 + 0.84 * rng());
    const l = 14 + rng() * 22;
    streak(ctx, 56, 104, 56 + Math.cos(a) * l * 1.5, 104 + Math.sin(a) * l, 1 + rng() * 1.4, '#7fe0ff', 0.8);
  }
  sparkle(ctx, 56, 103, 30, '#bff4ff', 1);
  motes(ctx, rng, 14, [16, 60, 96, 50], ['#7fe0ff', '#ffffff'], 0.5, 1.5, 0.9);
  iconFinish(ctx, { vignetteColor: '#01030c' });
}

function paintDivine(ctx, rng) {
  iconBack(ctx, rng, 64, 50, '#7a5214', '#2a1a0a', '#080503');
  shafts(ctx, rng, 64, -10, 190, 16, '#ffe08a', 0.16, Math.PI * 0.18, Math.PI * 0.82, 0.05);
  // parted clouds ringing the opening in the sky
  dabs(ctx, rng, 16, [-12, -14, 152, 36], ['#3a2410', '#120a04', '#8a5a1c'], 14, 30, 0.8, 0.6);
  dabs(ctx, rng, 8, [20, 2, 88, 22], ['#ffd76a', '#fff1b8'], 10, 22, 0.35, 0.5, 'lighter');
  // ground and the rings radiating from the strike
  form(ctx, poly([[0, 128], [0, 106], [128, 106], [128, 128]]), { fill: lin(ctx, 0, 104, 0, 128, 0, '#5a3a10', 1, '#080503') });
  glow(ctx, 64, 108, 74, '#ffb52e', 0.8, 1, 0.34);
  const ring = (y, rx, ry, w, a0, a1, a = 1) => glowPath(ctx, (c) => c.ellipse(64, y, rx, ry, 0, a0, a1), '#ffd76a', w, 8, a, '#fffbe6');
  ring(108, 58, 13, 2.2, 0, TAU, 0.7);
  ring(108, 42, 9, 2.6, 0, TAU, 0.9);
  ring(74, 34, 8, 2, Math.PI, TAU, 0.8);
  ring(44, 28, 6.5, 1.8, Math.PI, TAU, 0.7);
  // the pillar: wide soft body, hot white core
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [half, top, col, a] of [[34, 30, '#ff9a1a', 0.5], [24, 22, '#ffd060', 0.75], [13, 12, '#fff3c4', 0.95], [6, 5, '#ffffff', 1]]) {
    ctx.globalAlpha = a;
    ctx.fillStyle = lin(ctx, 64 - half, 0, 64 + half, 0, 0, rgba(col, 0), 0.5, rgba(col, 1), 1, rgba(col, 0));
    ctx.fill(poly([[64 - top, -4], [64 + top, -4], [64 + half, 110], [64 - half, 110]]).path);
  }
  ctx.restore();
  ring(74, 34, 8, 2.4, 0, Math.PI, 1);
  ring(44, 28, 6.5, 2.2, 0, Math.PI, 0.95);
  ring(108, 24, 5, 3, 0, TAU, 1);
  // winged sigil of judgment hanging in the light
  for (const s of [-1, 1]) {
    for (const [dx, dy, wd] of [[40, -16, 6], [38, -4, 5.5], [30, 7, 5]]) {
      form(ctx, leaf(64 + s * 6, 60, 64 + s * dx, 60 + dy, wd, 0.5), { fill: lin(ctx, 64, 60, 64 + s * dx, 60 + dy, 0, '#ffffff', 1, '#ffc040'), line: 'rgba(160,90,10,0.6)', lw: 0.8 });
    }
  }
  form(ctx, poly([[64, 36], [70, 58], [64, 92], [58, 58]]), { fill: lin(ctx, 58, 36, 70, 92, 0, '#ffffff', 1, '#ffe08a'), line: 'rgba(160,90,10,0.7)', lw: 1 });
  glow(ctx, 64, 106, 34, '#ffffff', 0.95, 1, 0.5);
  for (let i = 0; i < 14; i++) {
    const a = -Math.PI * (0.06 + 0.88 * rng());
    const l = 16 + rng() * 26;
    streak(ctx, 64, 106, 64 + Math.cos(a) * l * 1.5, 106 + Math.sin(a) * l * 0.8, 1 + rng() * 1.3, '#ffd76a', 0.75);
  }
  sparkle(ctx, 64, 58, 34, '#fff1b8', 1);
  motes(ctx, rng, 26, [10, 8, 108, 104], ['#ffd76a', '#ffffff', '#ffb52e'], 0.5, 1.7, 0.95, [Math.PI / 2, 0.2, 2]);
  iconFinish(ctx, { bloom: 0.36, vignetteColor: '#0a0502' });
  // the ultimate earns a gilded inner frame
  ctx.strokeStyle = lin(ctx, 0, 0, 128, 128, 0, '#fff1b8', 0.5, '#e3b755', 1, '#8a6420');
  ctx.lineWidth = 2;
  ctx.strokeRect(5, 5, 118, 118);
  for (const [x, y] of [[5, 5], [123, 5], [5, 123], [123, 123]]) {
    ctx.fillStyle = '#fff1b8';
    ctx.fill(poly([[x, y - 5], [x + 5, y], [x, y + 5], [x - 5, y]]).path);
  }
}

function paintBlinkBoots(ctx, rng) {
  iconBack(ctx, rng, 54, 62, '#2f7fe0', '#0e2260', '#030618');
  // teleport flash
  glow(ctx, 48, 64, 62, '#4fc3ff', 0.85);
  shafts(ctx, rng, 48, 64, 110, 16, '#9fe2ff', 0.2, 0, TAU, 0.05);
  sparkle(ctx, 34, 62, 60, '#9fe2ff', 0.8, 0.4);
  for (let i = 0; i < 12; i++) {
    const y = 18 + rng() * 96;
    const x1 = 6 + rng() * 50;
    streak(ctx, x1 + 40 + rng() * 30, y, x1, y, 1 + rng() * 1.8, '#9fe2ff', 0.3 + rng() * 0.4);
  }

  ctx.save();
  ctx.translate(2, 2);
  ctx.scale(1.06, 1.06);
  // wing behind the ankle
  for (const [tx, ty, wd] of [[4, 30, 7.5], [-2, 46, 7], [2, 62, 6.5], [10, 76, 5.5]]) {
    form(ctx, leaf(56, 70, tx, ty, wd, 0.55), {
      fill: lin(ctx, 56, 70, tx, ty, 0, '#e3b755', 0.22, '#ffffff', 0.7, '#cfe8ff', 1, '#7fc0ff'),
      shade: 'rgba(20,50,120,0.6)', shadeTo: [0, 4], shadeBlur: 4, rim: '#ffffff', rimTo: [0, -2], rimBlur: 2,
    });
  }
  // sole, then the boot
  form(ctx, new Shape().M(40, 100).L(112, 100).Q(114, 110, 104, 110).L(44, 110).Q(38, 108, 40, 100).Z(), { fill: '#0a0f24', rim: '#7fc0ff', rimTo: [0, 3], rimBlur: 2 });
  const body = new Shape().M(47, 30).L(79, 26).C(79, 44, 76, 58, 80, 66).C(94, 70, 110, 78, 112, 94).C(112, 101, 106, 104, 98, 104)
    .L(46, 104).C(40, 104, 38, 98, 41, 90).C(47, 74, 44, 52, 47, 30).Z();
  form(ctx, body, {
    fill: lin(ctx, 44, 24, 104, 106, 0, '#7fb4ff', 0.45, '#2e62c4', 1, '#10255e'),
    shade: 'rgba(2,5,22,0.85)', shadeTo: [-4, 5], shadeBlur: 10, rim: '#dff2ff', rimTo: [3, -3], rimBlur: 3,
  });
  // gold cuff, toe cap, ankle strap
  form(ctx, poly([[42, 24], [82, 19], [83, 34], [43, 40]]), {
    fill: lin(ctx, 42, 20, 83, 40, 0, '#fff6cc', 0.5, '#e3b755', 1, '#8a6420'), shade: 'rgba(70,40,0,0.7)', shadeTo: [0, 4], shadeBlur: 4, rim: '#ffffff', rimTo: [0, -2], rimBlur: 1.5,
  });
  form(ctx, new Shape().M(96, 78).C(106, 82, 112, 88, 112, 94).C(112, 101, 106, 104, 98, 104).L(90, 104).Q(98, 92, 96, 78).Z(), {
    fill: lin(ctx, 90, 78, 112, 104, 0, '#fff6cc', 0.5, '#e3b755', 1, '#8a6420'), rim: '#ffffff', rimTo: [2, -2], rimBlur: 1.5,
  });
  strokePath(ctx, (c) => { c.moveTo(43, 74); c.quadraticCurveTo(62, 64, 80, 68); }, '#e3b755', 3.4);
  form(ctx, oval(60, 70, 5), { fill: rad(ctx, 59, 69, 6, 0, '#ffffff', 0.5, '#7fe6ff', 1, '#1c6cc0'), line: '#fff1b8', lw: 1 });
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fill(blob([[66, 40], [72, 40], [73, 60], [68, 62]]).path);
  ctx.restore();

  sparkle(ctx, 26, 30, 20, '#bfeeff', 1, 0.3);
  sparkle(ctx, 100, 34, 10, '#bfeeff', 0.9);
  motes(ctx, rng, 18, [4, 10, 120, 108], ['#9fe2ff', '#ffffff'], 0.5, 1.6, 0.9, [0, 0.3, 2.2]);
  iconFinish(ctx, { vignetteColor: '#01030f' });
}

function paintLifesteal(ctx, rng) {
  iconBack(ctx, rng, 66, 60, '#8a1220', '#30060c', '#090103');
  glow(ctx, 70, 54, 62, '#ff2a3a', 0.6);
  // siphoned blood spiralling into the blade
  for (const [a, b, c2, d] of [[[100, 100], [124, 60], [100, 20], [70, 44]], [[24, 36], [10, 76], [50, 100], [78, 74]], [[96, 104], [60, 122], [20, 100], [36, 70]]]) {
    glowPath(ctx, (c) => { c.moveTo(a[0], a[1]); c.bezierCurveTo(b[0], b[1], c2[0], c2[1], d[0], d[1]); }, '#ff2a3a', 2.6, 9, 0.75, '#ffb0b0');
  }
  ctx.save();
  ctx.translate(32, 102);
  ctx.rotate(Math.atan2(18 - 102, 104 - 32) + Math.PI / 2);
  // curved, fanged blade
  const blade = new Shape().M(-7, -14).L(-9.5, -64).C(-9, -88, -3, -104, 1, -120).C(5, -104, 9, -88, 8.5, -64).L(7, -14).Z();
  ctx.save();
  ctx.shadowColor = '#ff1a2a';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#7a0a14';
  ctx.fill(blade.path);
  ctx.restore();
  form(ctx, blade, {
    fill: lin(ctx, -12, 0, 12, 0, 0, '#ffb4b4', 0.18, '#e02236', 0.55, '#8a0c1a', 1, '#2c0308'),
    shade: 'rgba(20,0,4,0.8)', shadeTo: [4, 2], shadeBlur: 6, rim: '#ffe0e0', rimTo: [-3, 0], rimBlur: 2,
  });
  strokePath(ctx, (c) => { c.moveTo(0, -20); c.quadraticCurveTo(-3, -62, 2, -98); }, 'rgba(40,0,6,0.7)', 1.6);
  glowPath(ctx, (c) => { c.moveTo(-7, -16); c.lineTo(-9.5, -64); c.bezierCurveTo(-9, -88, -3, -104, 1, -119); }, '#ff6a7a', 1.6, 6, 0.9, '#ffffff');
  // crossguard, grip, ruby pommel
  form(ctx, new Shape().M(-22, -16).Q(0, -6, 22, -16).L(24, -8).Q(0, 0, -24, -8).Z(), {
    fill: lin(ctx, -24, -16, 24, 0, 0, '#fff1b8', 0.5, '#e3b755', 1, '#7d5a1a'), shade: 'rgba(60,30,0,0.7)', shadeTo: [0, 3], shadeBlur: 3, rim: '#ffffff', rimTo: [0, -2], rimBlur: 1.5,
  });
  form(ctx, poly([[-4.5, -5], [4.5, -5], [3.6, 14], [-3.6, 14]]), { fill: lin(ctx, -5, 0, 5, 0, 0, '#5a2a1a', 1, '#1a0806') });
  form(ctx, oval(0, 17, 6), { fill: rad(ctx, -2, 15, 7, 0, '#ffffff', 0.4, '#ff3a4a', 1, '#6a0612'), line: '#e3b755', lw: 1.4 });
  ctx.restore();

  // blood drop
  const drop = new Shape().M(92, 66).C(98, 80, 108, 86, 108, 97).C(108, 107, 101, 113, 92, 113).C(83, 113, 76, 107, 76, 97).C(76, 86, 86, 80, 92, 66).Z();
  ctx.save();
  ctx.shadowColor = '#ff1a2a';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#b00a1a';
  ctx.fill(drop.path);
  ctx.restore();
  form(ctx, drop, {
    fill: rad(ctx, 88, 92, 26, 0, '#ff6a6a', 0.45, '#d81428', 1, '#5a0410'),
    shade: 'rgba(30,0,6,0.8)', shadeTo: [4, 5], shadeBlur: 7, rim: '#ffd0d0', rimTo: [-2, -2], rimBlur: 2,
  });
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fill(oval(86, 94, 3, 5.5, 0.5).path);
  sparkle(ctx, 100, 22, 16, '#ffb0b0', 1, 0.3);
  motes(ctx, rng, 18, [6, 6, 116, 116], ['#ff3a4a', '#ffb0b0'], 0.5, 1.6, 0.9);
  iconFinish(ctx, { vignetteColor: '#0a0002' });
}

// River Rune Bottle. `kind` null = empty; otherwise the stored rune.
function paintBottle(ctx, rng, kind) {
  const color = { damage: '#ffa41a', haste: '#5dffb0', regen: '#b48cff' }[kind] || null;
  if (color) {
    iconBack(ctx, rng, 64, 74, mix(color, '#0a0f22', 0.55), mix(color, '#0a0f22', 0.85), '#04060f');
    glow(ctx, 64, 78, 70, color, 0.7);
    shafts(ctx, rng, 64, 78, 100, 14, color, 0.16, 0, TAU, 0.06);
  } else {
    iconBack(ctx, rng, 64, 70, '#2a3248', '#12172a', '#05070f');
  }
  const body = new Shape().M(53, 30).L(53, 47).C(39, 53, 29, 65, 29, 80).C(29, 100, 44, 115, 64, 115)
    .C(84, 115, 99, 100, 99, 80).C(99, 65, 89, 53, 75, 47).L(75, 30).Z();
  // back wall of the glass
  ctx.fillStyle = color ? rgba(mix(color, '#0a0f22', 0.6), 0.75) : 'rgba(110,128,160,0.2)';
  ctx.fill(body.path);
  ctx.save();
  ctx.clip(body.path);
  if (color) {
    // glowing liquid with a bright meniscus
    ctx.fillStyle = lin(ctx, 0, 58, 0, 115, 0, mix(color, '#ffffff', 0.35), 0.25, color, 1, mix(color, '#0a0f22', 0.65));
    ctx.fillRect(20, 60, 90, 60);
    ctx.fillStyle = mix(color, '#ffffff', 0.75);
    ctx.fill(oval(64, 60, 30, 4.5).path);
    glow(ctx, 64, 84, 26, mix(color, '#ffffff', 0.4), 0.3);
    for (let i = 0; i < 9; i++) {
      const bx = 40 + rng() * 48;
      const by = 68 + rng() * 40;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(bx, by, 1.2 + rng() * 2.2, 0, TAU);
      ctx.stroke();
    }
  }
  edgeLight(ctx, body, color ? 'rgba(4,6,18,0.7)' : 'rgba(4,6,14,0.75)', [4, 5], 12, false);
  edgeLight(ctx, body, color ? mix(color, '#ffffff', 0.7) : '#9aa8c4', [-3, -2], 3, true);
  ctx.restore();
  // etched rune
  const glyph = runeGlyph(kind || 'generic', 64, 86, 24);
  if (color) {
    strokePath(ctx, glyph, mix(color, '#0a0f22', 0.82), 7.5, 0.75);
    glowPath(ctx, glyph, mix(color, '#ffffff', 0.55), 3.4, 5, 1, '#ffffff');
  } else {
    strokePath(ctx, glyph, 'rgba(6,8,16,0.6)', 4.5);
    strokePath(ctx, glyph, 'rgba(160,176,206,0.55)', 2.2);
  }
  // glass outline and highlights
  ctx.strokeStyle = color ? rgba(mix(color, '#ffffff', 0.6), 0.9) : 'rgba(150,166,196,0.75)';
  ctx.lineWidth = 2;
  ctx.stroke(body.path);
  strokePath(ctx, (c) => { c.moveTo(39, 74); c.quadraticCurveTo(41, 60, 52, 54); }, 'rgba(255,255,255,0.8)', 3.2);
  strokePath(ctx, (c) => { c.moveTo(38, 90); c.quadraticCurveTo(40, 98, 46, 104); }, 'rgba(255,255,255,0.45)', 2.2);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(57, 32, 3, 14);
  // lip and cork
  form(ctx, new Shape().M(49, 25).L(79, 25).Q(82, 29, 79, 33).L(49, 33).Q(46, 29, 49, 25).Z(), {
    fill: color ? rgba(mix(color, '#ffffff', 0.5), 0.9) : '#8794b0', shade: 'rgba(4,6,18,0.7)', shadeTo: [3, 3], shadeBlur: 4, rim: '#ffffff', rimTo: [-2, -2], rimBlur: 1.5,
  });
  form(ctx, poly([[54, 10], [74, 10], [76, 25], [52, 25]]), {
    fill: lin(ctx, 52, 10, 76, 25, 0, color ? '#e0b47a' : '#9a8468', 1, color ? '#6a4420' : '#3a3026'),
    shade: 'rgba(20,10,2,0.75)', shadeTo: [3, 3], shadeBlur: 5, rim: '#fff1d0', rimTo: [-2, -2], rimBlur: 1.5,
  });
  if (color) {
    glow(ctx, 64, 82, 46, color, 0.2);
    motes(ctx, rng, 20, [14, 8, 100, 110], [color, '#ffffff'], 0.5, 1.7, 0.95, [Math.PI / 2, 0.3, 1.8]);
    sparkle(ctx, 96, 54, 14, mix(color, '#ffffff', 0.5), 1);
    iconFinish(ctx, { bloom: 0.16 });
  } else {
    iconFinish(ctx, { bloom: 0.15, vignette: 0.7 });
  }
}

// Fallback for unknown icons: a gold rune cut into a stone disc.
function paintRuneIcon(ctx, rng) {
  iconBack(ctx, rng, 64, 60, '#2a4a9a', '#121a40', '#04060f');
  glow(ctx, 64, 64, 60, '#4fc3ff', 0.4);
  form(ctx, oval(64, 64, 44), {
    fill: rad(ctx, 52, 48, 70, 0, '#5a6a8c', 0.5, '#2c3550', 1, '#0e1220'),
    shade: 'rgba(2,4,14,0.85)', shadeTo: [4, 6], shadeBlur: 14, rim: '#bfe2ff', rimTo: [-3, -3], rimBlur: 3,
  });
  ctx.strokeStyle = lin(ctx, 20, 20, 108, 108, 0, '#fff1b8', 0.5, '#e3b755', 1, '#7d5a1a');
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(64, 64, 37, 0, TAU);
  ctx.stroke();
  strokePath(ctx, runeGlyph('generic', 64, 64, 40), 'rgba(2,4,14,0.8)', 9);
  glowPath(ctx, runeGlyph('generic', 64, 64, 40), '#e3b755', 5, 10, 1, '#fff7d6');
  motes(ctx, rng, 12, [8, 8, 112, 112], ['#fff1b8', '#4fc3ff'], 0.5, 1.5, 0.9);
  iconFinish(ctx);
}

/* ════════════════════════════ PUBLIC API ═══════════════════════════ */

const CARD_PAINTERS = new Map([
  ['footmen_squad', paintFootmen],
  ['arcane_archer', paintArcher],
  ['siege_golem', paintGolem],
  ['fireball', paintFireball],
  ['frost_tower', paintFrostTower],
  ['healing_wave', paintHealingWave],
]);

const PORTRAIT_PAINTERS = new Map([
  ['aether_knight', paintKnight],
  ['morgath', paintMorgath],
]);

const ICON_PAINTERS = new Map([
  ['slash_dash', paintSlashDash],
  ['aegis_shield', paintAegis],
  ['thunder_strike', paintThunder],
  ['divine_judgment', paintDivine],
  ['blink_boots', paintBlinkBoots],
  ['lifesteal_blade', paintLifesteal],
  ['rune_bottle', (ctx, rng) => paintBottle(ctx, rng, null)],
  ['rune_bottle:damage', (ctx, rng) => paintBottle(ctx, rng, 'damage')],
  ['rune_bottle:haste', (ctx, rng) => paintBottle(ctx, rng, 'haste')],
  ['rune_bottle:regen', (ctx, rng) => paintBottle(ctx, rng, 'regen')],
]);

const cache = new Map();
let webp = null;

function encode(canvas) {
  if (webp === false) return canvas.toDataURL('image/png');
  // a browser without a WebP encoder answers this with a PNG data URL
  const url = canvas.toDataURL('image/webp', 0.92);
  webp = url.startsWith('data:image/webp');
  return url;
}

function render(key, w, h, painter) {
  let url = cache.get(key);
  if (url) return url;
  const canvas = makeCanvas(w, h);
  // one-shot paint then read back: keep the canvas on the CPU
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  painter(ctx, mulberry32(seedOf(key)));
  url = encode(canvas);
  cache.set(key, url);
  return url;
}

/** Painted 300x400 card illustration; unknown ids get the rune card back. */
export function cardArt(cardId) {
  const painter = CARD_PAINTERS.get(cardId);
  return painter ? render(`card:${cardId}`, 300, 400, painter) : render('card:*', 300, 400, paintCardBack);
}

/** Painted 256x256 hero bust; unknown ids fall back to the Aether Knight. */
export function portraitArt(heroId) {
  const id = PORTRAIT_PAINTERS.has(heroId) ? heroId : 'aether_knight';
  return render(`portrait:${id}`, 256, 256, PORTRAIT_PAINTERS.get(id));
}

/** Painted 128x128 ability/item icon; unknown ids get a generic rune glyph. */
export function iconArt(iconId) {
  const painter = ICON_PAINTERS.get(iconId);
  return painter ? render(`icon:${iconId}`, 128, 128, painter) : render('icon:*', 128, 128, paintRuneIcon);
}
