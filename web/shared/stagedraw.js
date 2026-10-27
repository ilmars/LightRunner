// The stage view's picture (the operator page's, and the Timeline page's): each fixture drawn where the stage plan puts
// it, in the colour the stage (or a Prepare draft) gives it now. Only the drawing; what is sent to the lights doesn't change.
//
// Two views of the same moment: from above (the stage plan, with each light's housing, its real LEDs and the pools it
// throws on the floor) and from the audience (the truss across the top, the back wall, the floor; beams, washes and
// glows). The numbers come from stageview.js; this file only paints them.
//
// Speed: a picture is drawn 20 times a second on an iPad. Everything that doesn't change with the colours (the floor,
// the wall, the truss, the housings, and where every LED, pool and beam goes) is worked out once per canvas size, view
// and layout and kept in two offscreen canvases; a picture then copies those and paints only the light. Soft light is
// drawn by stretching small pre-made gradients (one per colour channel, added together), never by shadows or new
// gradients per frame, into a small canvas that is then stretched over the picture.

import { barAxis, barEnds, beamCone, beamHalfWidth, outlineCells } from './stage.js';
import {
  frontPlacement, frontScene, hangsOf, isStrip, ledLayout, ledPoints, panelGrid, poolOf, sharedStrengths, softLightOverlaps,
} from './stageview.js';

/**
 * How a light's colour is drawn on screen. Whites (light colours with little
 * colour in them: warm white #ffb46b, cool white #dcebff, the safe light) are
 * drawn as soft whites instead of their raw values, which look orange or blue
 * on a screen. Saturated colours are left as they are. Only the drawing
 * changes; what is sent to the lights doesn't.
 */
const CREAM = [241, 236, 228];
export function shownRgb(r, g, b) {
  const max = Math.max(r, g, b);
  if (max <= 0) return [r, g, b];
  const chroma = (max - Math.min(r, g, b)) / max;
  if (chroma >= 0.65) return [r, g, b];
  // Mix the colour (at full brightness) 60 % towards cream, then put its brightness back.
  const k = max / 255;
  return [r, g, b].map((v, i) => Math.round(((v / k) * 0.4 + CREAM[i] * 0.6) * k));
}
export function shown(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = shownRgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ---- The stage's own colours (near black; the light is the only colour in the picture) ----

const FLOOR = '#05070b', BACK_BAND = '#0a0d13', BOARD = 'rgba(255,255,255,0.022)';
const WALL = '#0a0c11', ROOM = '#040508', FLOOR_NEAR = '#0d0f15', FLOOR_FAR = '#050608';
const TRUSS = '#363b45';
const HOUSING = '#191c23', HOUSING_EDGE = '#2c313b', HOUSING_INNER = '#0f1217', RISER = '#13161c';
const LED_OFF = '#262a32';
const DARK = [0, 0, 0];

// How strongly the soft light is drawn (0..1 at a full-brightness colour). Kept low: the picture must glow, never flare.
const LED_GLOW = 0.5, BEAM = 0.16, WASH = 0.3, FLOOR_POOL = 0.34, RISER_GLOW = 0.24, LINE_GLOW = 0.3, CONE = 0.2;

// ---- Soft light from pre-made gradients ----

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

/** Three small canvases (red, green, blue) holding the same soft shape: `alphaAt(u, v)` over 0..1 across and down. */
function spriteOf(w, h, alphaAt) {
  return [0, 1, 2].map((channel) => {
    const c = makeCanvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = alphaAt((x + 0.5) / w, (y + 0.5) / h);
        const i = (y * w + x) * 4;
        img.data[i + channel] = 255;
        img.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

let sprites = null;
function spritesOf() {
  if (sprites) return sprites;
  sprites = {
    // A round soft spot, strongest in the middle: pools on the floor and the glow round a LED.
    round: spriteOf(64, 64, (u, v) => {
      const d2 = (2 * u - 1) ** 2 + (2 * v - 1) ** 2;
      return d2 >= 1 ? 0 : (1 - d2) ** 2;
    }),
    // A wash up a wall from a light at the foot of it: strongest at the floor in the middle, a soft arch at the top.
    arch: spriteOf(64, 64, (u, v) => {
      const d = Math.hypot(2 * u - 1, 1 - v);
      return d >= 1 ? 0 : (1 - d) ** 1.5;
    }),
    // A beam's cone from above: from the lamp at the top middle to the far edge at the bottom, fading as it goes.
    cone: spriteOf(48, 48, (u, v) => {
      const x = Math.abs(2 * u - 1);
      return v <= 0 || x >= v ? 0 : (1 - v) * Math.min(1, (v - x) * 12);
    }),
    // A beam down through the haze: narrow at the lamp, wider and fading towards the floor, with soft sides.
    beam: spriteOf(48, 128, (u, v) => {
      const half = 0.08 + 0.92 * v;
      const x = Math.abs(2 * u - 1) / half;
      return x >= 1 ? 0 : (1 - x * x) ** 0.9 * (1 - v) ** 0.9 * Math.min(1, v * 25);
    }),
  };
  return sprites;
}

/** Adds the light of `colour` (0..255 each) through `sprite` over x, y, w, h; `a` is its strength at full colour. */
function addLight(ctx, sprite, x, y, w, h, colour, a) {
  let drawn = false;
  for (let ch = 0; ch < 3; ch++) {
    const v = (colour[ch] / 255) * a;
    if (v < 0.004) continue;
    ctx.globalAlpha = Math.min(1, v);
    ctx.drawImage(sprite[ch], x, y, w, h);
    drawn = true;
  }
  return drawn;
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const litOf = (c) => Math.max(c[0], c[1], c[2]) / 255;

// ---- The picture ----

// The static parts of each canvas's picture, kept until its size, view or layout changes.
const kept = new WeakMap();
let keptElsewhere = null;

/** While the picture is being resized, the kept parts are worked out again at most this often (ms); in between the
 *  last ones are stretched to the new size. */
const RESIZE_REBUILD_MS = 150;

/**
 * Draws the stage onto `ctx` (already scaled to CSS pixels), `w` by `h`: the layout's fixtures in the colours of
 * `visual` (r, g, b per segment, in fixture order; missing values are dark). Smoke machines are a small cloud,
 * brighter while `smokeLevel(groupId)` (0..1) is up. `options.view` is 'above' (the stage plan; the default) or
 * 'front' (from the audience). `options.resizing` is true while someone drags the picture's size: the last picture's
 * parts are stretched (worked out again at most every 150 ms); draw once more without it when the drag ends.
 */
export function drawStagePicture(ctx, w, h, layout, visual, smokeLevel = () => 0, options = {}) {
  if (!layout || !(w > 0) || !(h > 0)) return;
  const view = options.view === 'front' ? 'front' : 'above';
  const scale = ctx.getTransform ? Math.abs(ctx.getTransform().a) || 1 : 1;
  const key = `${view}|${w}|${h}|${scale}`;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let scene = ctx.canvas ? kept.get(ctx.canvas) : keptElsewhere;
  const same = scene && scene.layout === layout && scene.view === view && scene.scale === scale;
  if (same && scene.key !== key && options.resizing && now - scene.builtAt < RESIZE_REBUILD_MS) {
    ctx.save();
    ctx.scale(w / scene.w, h / scene.h);
    paint(ctx, scene, layout, visual ?? new Uint8Array(0), smokeLevel);
    ctx.restore();
    return;
  }
  if (!scene || scene.key !== key || scene.layout !== layout) {
    // The canvases of the last scene are used again (resized in place), so a drag makes no new ones.
    scene = buildScene(view, w, h, layout, scale, scene);
    Object.assign(scene, { key, layout, view, scale, builtAt: now });
    if (ctx.canvas) kept.set(ctx.canvas, scene);
    else keptElsewhere = scene;
  }
  paint(ctx, scene, layout, visual ?? new Uint8Array(0), smokeLevel);
}

/** Each fixture's segment colours as shown (whites as whites), in the order along the fixture: reversed ones flipped. */
function coloursOf(layout, visual) {
  const out = [];
  let at = 0;
  for (const f of layout.fixtures) {
    const n = Math.max(1, Math.floor(Number(f.segments) || 1));
    const cells = [];
    for (let s = 0; s < n; s++) {
      const i = (at + s) * 3;
      cells.push(shownRgb(visual[i] ?? 0, visual[i + 1] ?? 0, visual[i + 2] ?? 0));
    }
    // A fixture hung the other way round has its first segment at its far end.
    out.push(f.reversed ? cells.reverse() : cells);
    at += n;
  }
  return out;
}

function paint(ctx, scene, layout, visual, smokeLevel) {
  const { w, h, items } = scene;
  const colours = coloursOf(layout, visual);
  const sp = spritesOf();
  const colourOf = (item, seg) => colours[item.k]?.[seg] ?? DARK;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.drawImage(scene.back, 0, 0, w, h);

  // Light on the floor and the wall, added together as light is. Soft light needs no sharpness: it is painted into a
  // small canvas and stretched over the picture in one go (far less to fill than painting it at full size).
  // How strongly each pool and wash is drawn now: overlapping ones share their light only where their neighbours are lit.
  const { soft, lit, strengths } = scene;
  for (const item of items) for (const p of item.under) lit[p.i] = litOf(colourOf(item, p.seg));
  sharedStrengths(soft, scene.overlaps, lit, strengths);
  const lights = (pass, list) => {
    const light = scene.light[pass], lg = light.g;
    lg.save();
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.clearRect(0, 0, light.c.width, light.c.height);
    lg.restore();
    lg.globalCompositeOperation = 'lighter';
    let any = false;
    for (const item of list) {
      for (const p of item[pass]) {
        const a = pass === 'under' ? strengths[p.i] : p.a;
        if (!p.skew) {
          any = addLight(lg, sp[p.sprite], p.x, p.y, p.w, p.h, colourOf(item, p.seg), a) || any;
          continue;
        }
        // Leaning: each row moves across by `skew` per pixel down from its top, so it stays as wide all the way.
        lg.save();
        lg.transform(1, 0, p.skew, 1, -p.skew * p.y, 0);
        any = addLight(lg, sp[p.sprite], p.x, p.y, p.w, p.h, colourOf(item, p.seg), a) || any;
        lg.restore();
      }
    }
    lg.globalAlpha = 1;
    if (!any) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(light.c, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  };
  lights('under', items);

  // A beam's cone from above (strongest at the lamp, gone at the tip), and smoke clouds.
  ctx.globalCompositeOperation = 'lighter';
  for (const item of items) {
    if (!item.cone) continue;
    const { lamp, left, right } = item.cone;
    // The cone sprite (apex at the top middle, its far edge along the bottom) mapped onto the lamp and the far corners.
    ctx.save();
    ctx.transform(
      right[0] - left[0], right[1] - left[1],
      (left[0] + right[0]) / 2 - lamp[0], (left[1] + right[1]) / 2 - lamp[1],
      lamp[0] - (right[0] - left[0]) / 2, lamp[1] - (right[1] - left[1]) / 2,
    );
    addLight(ctx, sp.cone, 0, 0, 1, 1, colourOf(item, 0), CONE);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  for (const item of items) {
    if (item.smoke) drawSmoke(ctx, item.smoke, Math.max(0, ...item.smoke.groups.map((g) => smokeLevel(g) || 0)));
  }

  ctx.drawImage(scene.bodies, 0, 0, w, h);

  // Beams through the haze, the glow round lit LEDs, then the LEDs themselves and strips as lines (dark ones in the
  // housing's LED grey, so every LED can be counted). With a riser in the picture, the lights behind it (the wall's
  // bars) go first, then the riser hides them, then everything in front of it: their beams and glows stay whole.
  const front = (list) => {
    lights('over', list);
    ctx.globalCompositeOperation = 'lighter';
    for (const item of list) {
      for (const l of item.lines) {
        const c = colourOf(item, l.seg);
        if (litOf(c) <= 0.02) continue;
        ctx.globalAlpha = LINE_GLOW * (l.a ?? 1);
        strokeLine(ctx, l.pts, l.glow, rgb(c));
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const item of list) {
      for (const l of item.lines) {
        const c = colourOf(item, l.seg);
        const lit = litOf(c) > 0.02;
        if (!lit && l.dark === false) continue;
        ctx.globalAlpha = lit ? l.a ?? 1 : 1;
        strokeLine(ctx, l.pts, l.width, lit ? rgb(c) : LED_OFF);
      }
      ctx.globalAlpha = 1;
      // LEDs in a row of the same colour (a segment's) go in one path, filled once.
      let last = '', open = false;
      for (const d of item.leds) {
        const c = colourOf(item, d.seg);
        const style = litOf(c) > 0.02 ? rgb(c) : LED_OFF;
        if (style !== last) {
          if (open) ctx.fill();
          ctx.fillStyle = last = style;
          ctx.beginPath();
          open = true;
        }
        if (d.square) ctx.rect(d.x - d.r, d.y - d.r, d.r * 2, d.r * 2);
        else {
          ctx.moveTo(d.x + d.r, d.y);
          ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        }
      }
      if (open) ctx.fill();
    }
  };
  if (scene.covers.length) {
    // Everything but the risers: the wall's lights don't show through a riser (its box is in the bodies layer).
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    for (const c of scene.covers) ctx.rect(c.x, c.y, c.w, c.h);
    ctx.clip('evenodd');
    front(scene.behind);
    ctx.restore();
    front(scene.inFront);
  } else front(items);
  ctx.restore();
}

function strokeLine(ctx, pts, width, style) {
  ctx.beginPath();
  pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.stroke();
}

/** A small grey cloud, a little brighter while its smoke group's level is up. */
function drawSmoke(ctx, { x, y, r }, level) {
  ctx.fillStyle = `rgba(148,170,210,${0.16 + 0.24 * level})`;
  for (const [dx, dy, s] of [[-0.55, 0.15, 0.7], [0, -0.2, 0.9], [0.6, 0.1, 0.75]]) {
    ctx.beginPath();
    ctx.arc(x + dx * r * 1.6, y + dy * r * 1.6, s * r * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- Working out the static parts ----

/** A canvas for `w` by `h` CSS px at `scale`: `old` (a layer kept from before) resized in place, else a new one. */
function layer(w, h, scale, old) {
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  let c = old?.c, g = old?.g;
  if (c) {
    // Setting the size clears the canvas and its drawing state, even when it is the same.
    c.width = cw;
    c.height = ch;
  } else {
    c = makeCanvas(cw, ch);
    g = c.getContext('2d');
  }
  g.setTransform(scale, 0, 0, scale, 0, 0);
  return { c, g };
}

function buildScene(view, w, h, layout, scale, old) {
  const back = layer(w, h, scale, old?.backLayer), bodies = layer(w, h, scale, old?.bodiesLayer);
  const items = view === 'front' ? buildFront(back.g, bodies.g, w, h, layout) : buildAbove(back.g, bodies.g, w, h, layout);
  // The soft light's canvases: pools and washes (the softest) at a quarter of the picture's CSS size on a small view
  // and an eighth on a big one; beams and LED glows at twice that.
  const k = w * h > 200_000 ? 0.125 : 0.25;
  const light = { under: layer(w, h, k, old?.light.under), over: layer(w, h, 2 * k, old?.light.over) };
  // Pools and washes that overlap share their light when lit (sharedStrengths, each picture): where each one reaches.
  const soft = items.flatMap((item) => item.under);
  soft.forEach((p, i) => (p.i = i));
  const overlaps = softLightOverlaps(soft);
  return {
    w, h, back: back.c, bodies: bodies.c, backLayer: back, bodiesLayer: bodies, light, items, soft, overlaps,
    lit: new Float32Array(soft.length), strengths: new Array(soft.length),
    covers: items.filter((i) => i.cover).map((i) => i.cover),
    behind: items.filter((i) => i.behind), inFront: items.filter((i) => !i.behind),
  };
}

const shapeOf = (f) => f.shape ?? (f.w || f.h ? 'bar' : 'dot');
const segmentsOf = (f) => Math.max(1, Math.floor(Number(f.segments) || 1));
const ledCount = (f) => ledLayout(segmentsOf(f), f.leds).length;

function newItem(k, f) {
  return { k, f, under: [], over: [], lines: [], leds: [], cone: null, smoke: null, cover: null, behind: false };
}

/** The groups a smoke machine belongs to (whose level makes its cloud brighter). */
function smokeGroups(layout, f) {
  return (layout.groups ?? []).filter((g) => g.kind === 'smoke' && layout.members?.[g.id]?.includes(f.id)).map((g) => g.id);
}

function box(g, x, y, w, h, radius) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.max(0, Math.min(radius, w / 2, h / 2)));
  g.fillStyle = HOUSING;
  g.fill();
  g.lineWidth = 1;
  g.strokeStyle = HOUSING_EDGE;
  g.stroke();
}

/**
 * The soft glow round a fixture's lit LEDs: one per segment, over all its LEDs, when they lie in a line across or
 * down (far fewer to draw than one per LED); one per LED on a turned bar. `a` is the strength of one LED's glow.
 */
function ledGlows(item, glow, a) {
  const bySeg = new Map();
  for (const d of item.leds) {
    const list = bySeg.get(d.seg) ?? [];
    list.push(d);
    bySeg.set(d.seg, list);
  }
  for (const [seg, leds] of bySeg) {
    const xs = leds.map((d) => d.x), ys = leds.map((d) => d.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (leds.length === 1 || x1 - x0 < 0.5 || y1 - y0 < 0.5) {
      // Several LEDs together glow about as much as close LEDs' glows added up (LED_GLOW); one alone glows `a`.
      item.over.push({ sprite: 'round', x: x0 - glow, y: y0 - glow, w: x1 - x0 + 2 * glow, h: y1 - y0 + 2 * glow, seg, a: leds.length > 1 ? LED_GLOW : a });
    } else {
      for (const d of leds) item.over.push({ sprite: 'round', x: d.x - glow, y: d.y - glow, w: 2 * glow, h: 2 * glow, seg, a });
    }
  }
}

/** A panel's face: its LEDs in a grid (`panelGrid`), each in its segment's colour, centred on cx, cy. */
function panelFace(item, f, cx, cy, s) {
  const layout = ledLayout(segmentsOf(f), f.leds);
  const { cols, rows } = panelGrid(layout.length);
  const pitch = Math.max(1.5, Math.min(3.2 * s, (30 * s) / cols));
  const fw = cols * pitch, fh = rows * pitch;
  const left = cx - fw / 2, top = cy - fh / 2;
  const r = Math.max(0.45, pitch * 0.3);
  const sums = new Map();
  layout.forEach((seg, k) => {
    const x = left + ((k % cols) + 0.5) * pitch, y = top + (Math.floor(k / cols) + 0.5) * pitch;
    item.leds.push({ x, y, r, seg, square: true });
    const sum = sums.get(seg) ?? { x: 0, y: 0, n: 0 };
    sums.set(seg, { x: sum.x + x, y: sum.y + y, n: sum.n + 1 });
  });
  // A soft glow over the face, one per segment where its LEDs are.
  const glow = Math.max(fw, fh) * (sums.size > 1 ? 0.6 : 0.9) + 4;
  for (const [seg, sum] of sums) {
    const x = sum.x / sum.n, y = sum.y / sum.n;
    item.over.push({ sprite: 'round', x: x - glow, y: y - glow, w: 2 * glow, h: 2 * glow, seg, a: LED_GLOW * 0.6 });
  }
  return { left, top, width: fw, height: fh, pitch };
}

// ---- From above ----

function buildAbove(bg, fg, w, h, layout) {
  const pad = 12;
  const iw = Math.max(1, w - 2 * pad), ih = Math.max(1, h - 2 * pad);
  const s = Math.min(w / 640, h / 300);
  const P = (p) => [pad + p.x * iw, pad + p.y * ih];

  // The floor: a dark deck with faint boards, the back wall as a darker band at the top.
  bg.fillStyle = FLOOR;
  bg.fillRect(0, 0, w, h);
  const band = Math.max(pad, h * 0.07);
  bg.fillStyle = BACK_BAND;
  bg.fillRect(0, 0, w, band);
  bg.strokeStyle = BOARD;
  bg.lineWidth = 1;
  bg.beginPath();
  for (let y = band + 0.5; y < h; y += Math.max(7, 10 * s)) {
    bg.moveTo(0, y);
    bg.lineTo(w, y);
  }
  bg.stroke();

  const items = layout.fixtures.map((f, k) => {
    const item = newItem(k, f);
    const shape = shapeOf(f), hangs = hangsOf(f), n = segmentsOf(f);
    if (shape === 'smoke') {
      const [x, y] = P(f);
      item.smoke = { x, y, r: Math.max(5, Math.min(9 * Math.max(1, s), h / 16)), groups: smokeGroups(layout, f) };
      return item;
    }
    // The pools it throws on the floor (ry follows the plan's width, so a pool is round whatever the box).
    const pool = poolOf(f, hangs, 'above');
    const rx = pool.r * iw, ry = rx * pool.squash;
    for (const spot of pool.spots) {
      const [x, y] = P(spot);
      item.under.push({ sprite: 'round', x: x - rx, y: y - ry, w: 2 * rx, h: 2 * ry, seg: spot.segment, a: pool.alpha });
    }

    if (shape === 'bar' && isStrip(f)) {
      // A strip: a glowing line, one stretch per segment.
      const [a, b] = barEnds(f).map(P);
      for (let k2 = 0; k2 < n; k2++) {
        const p0 = [a[0] + ((b[0] - a[0]) * k2) / n, a[1] + ((b[1] - a[1]) * k2) / n];
        const p1 = [a[0] + ((b[0] - a[0]) * (k2 + 1)) / n, a[1] + ((b[1] - a[1]) * (k2 + 1)) / n];
        item.lines.push({ pts: [p0, p1], seg: k2, width: Math.max(1.6, 2.2 * s), glow: Math.max(5, 8 * s) });
      }
    } else if (shape === 'bar') {
      // The housing at the bar's plan size and angle, with its real LEDs along it.
      const [a, b] = barEnds(f).map(P);
      const len = Math.max(8, Math.hypot(b[0] - a[0], b[1] - a[1]));
      const thick = Math.max(5, Math.min(barAxis(f).thickness * ih, 8 * s));
      fg.save();
      fg.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      fg.rotate(Math.atan2(b[1] - a[1], b[0] - a[0]));
      box(fg, -len / 2, -thick / 2, len, thick, 2.5 * Math.max(0.6, s));
      fg.restore();
      const points = ledPoints(f);
      const pitch = len / points.length;
      const r = Math.max(0.7, Math.min(thick * 0.3, pitch * 0.36, 2.6 * s));
      const glow = Math.max(2.5, r * 3.2);
      // Close LEDs' glows overlap: each is fainter so a dense bar glows no more than a sparse one.
      for (const p of points) {
        const [x, y] = P(p);
        item.leds.push({ x, y, r, seg: p.segment });
      }
      ledGlows(item, glow, LED_GLOW * Math.min(1, pitch / glow));
    } else if (shape === 'outline') {
      // A strip round something: dark where it is off, its cells clockwise from the top left.
      const left = pad + (f.x - (f.w ?? 0) / 2) * iw, top = pad + (f.y - (f.h ?? 0) / 2) * ih;
      const rect = { left, top, width: (f.w ?? 0) * iw, height: (f.h ?? 0) * ih };
      outlineCells(rect, n, false).forEach((pts, seg) => {
        item.lines.push({ pts, seg, width: Math.max(1.6, 2.4 * s), glow: Math.max(5, 8 * s) });
      });
    } else {
      // A lamp (a spot light or a beam): a round housing with its lens; a panel: a face of LEDs.
      const [x, y] = P(f);
      if (shape === 'beam') {
        const cone = beamCone(f);
        item.cone = { lamp: P(cone.lamp), left: P(cone.left), right: P(cone.right), tip: P(cone.tip) };
      }
      if (shape !== 'beam' && ledCount(f) > 1) {
        const face = panelFace(item, f, x, y, s);
        const m = Math.max(1.5, face.pitch * 0.7);
        box(fg, face.left - m, face.top - m, face.width + 2 * m, face.height + 2 * m, 2 * Math.max(0.6, s));
      } else {
        const rb = Math.max(4.5, 7.5 * s);
        fg.beginPath();
        fg.arc(x, y, rb, 0, Math.PI * 2);
        fg.fillStyle = HOUSING;
        fg.fill();
        fg.lineWidth = 1;
        fg.strokeStyle = HOUSING_EDGE;
        fg.stroke();
        item.leds.push({ x, y, r: rb * 0.62, seg: 0 });
        const glow = rb * 2.6;
        item.over.push({ sprite: 'round', x: x - glow, y: y - glow, w: 2 * glow, h: 2 * glow, seg: 0, a: LED_GLOW });
      }
    }
    return item;
  });
  return items;
}

// ---- From the audience ----

// The order they are drawn in, from the back of the stage to the front: a riser stands in front of the wall's bars.
const DEPTH = { wall: 0, riser: 1, truss: 2, side: 3, stand: 4 };

function buildFront(bg, fg, w, h, layout) {
  const { trussY, wallTop, floorY, s } = frontScene(w, h);
  const u = Math.max(0.35, s);

  // The room: the back wall under the truss down to the floor line, the floor in front.
  bg.fillStyle = ROOM;
  bg.fillRect(0, 0, w, h);
  bg.fillStyle = WALL;
  bg.fillRect(0, wallTop, w, floorY - wallTop);
  const floor = bg.createLinearGradient(0, floorY, 0, h);
  floor.addColorStop(0, FLOOR_NEAR);
  floor.addColorStop(1, FLOOR_FAR);
  bg.fillStyle = floor;
  bg.fillRect(0, floorY, w, h - floorY);
  // The truss: two chords with a zigzag between them.
  const half = Math.max(2.5, 5 * s);
  bg.strokeStyle = TRUSS;
  bg.lineWidth = Math.max(1, 1.2 * s);
  bg.beginPath();
  bg.moveTo(0, trussY - half);
  bg.lineTo(w, trussY - half);
  bg.moveTo(0, trussY + half);
  bg.lineTo(w, trussY + half);
  bg.stroke();
  bg.lineWidth = Math.max(0.6, 0.8 * s);
  bg.beginPath();
  const step = Math.max(5, 12 * s);
  for (let x = 0; x < w; x += step) {
    bg.moveTo(x, trussY - half);
    bg.lineTo(x + step / 2, trussY + half);
    bg.lineTo(x + step, trussY - half);
  }
  bg.stroke();

  const order = layout.fixtures.map((f, k) => ({ f, k, hangs: hangsOf(f) }));
  order.sort((a, b) => DEPTH[a.hangs] - DEPTH[b.hangs] || a.k - b.k);
  return order.map(({ f, k, hangs }) => {
    const item = newItem(k, f);
    const shape = shapeOf(f), n = segmentsOf(f);
    const place = frontPlacement(f, hangs, w, h);
    // Behind a riser: the riser hides this light's LEDs and glow where it stands in front of them.
    item.behind = hangs === 'wall';
    if (shape === 'smoke') {
      // A haze machine at the foot of the wall: its cloud drifts over the floor line.
      item.smoke = { x: place.x, y: floorY - 6 * u, r: Math.max(5, 10 * u), groups: smokeGroups(layout, f) };
      return item;
    }
    const lamp = shape !== 'bar' && shape !== 'outline' && ledCount(f) <= 1;
    const panel = shape !== 'bar' && shape !== 'outline' && !lamp;
    const strip = shape === 'outline' || (shape === 'bar' && isStrip(f));
    const spacing = place.length / n;
    const midY = place.top + place.height / 2;

    if (hangs === 'truss') {
      // Down through the haze from under the truss, a pool where it lands.
      let from = place.beamFrom ?? place.top + place.height;
      if (lamp) {
        const bw = 11 * u, bh = 8 * u;
        box(fg, place.x - bw / 2, place.top, bw, bh, 2 * u);
        item.leds.push({ x: place.x, y: place.top + bh - 2.2 * u, r: Math.max(1, 2.6 * u), seg: 0 });
        from = place.top + bh;
      } else if (panel) {
        const face = panelFace(item, f, place.x, midY, s);
        const m = Math.max(1.5, face.pitch * 0.7);
        box(fg, face.left - m, face.top - m, face.width + 2 * m, face.height + 2 * m, 2 * u);
        from = face.top + face.height + m;
      } else {
        box(fg, place.left, place.top, place.length, place.height, 2.5 * u);
      }
      // A beam opens as wide as its cone on the plan (its reach); a bar's segments each light their own stretch.
      const bw = shape === 'beam' ? Math.max(beamHalfWidth(f) * w, 6 * u) : Math.max(spacing * 0.9, 22 * u);
      // A beam aimed sideways on the plan leans over to where its cone ends (its top stays under the light).
      const lean = (place.beamTo ?? place.x) - place.x;
      for (const seg of place.segments) {
        item.over.push({ sprite: 'beam', x: seg.x - bw, y: from, w: 2 * bw, h: floorY - from, seg: seg.segment, a: BEAM, skew: lean / (floorY - from) });
        const px = bw * (shape === 'beam' ? 1.1 : 1.5), py = px * 0.22;
        item.under.push({ sprite: 'round', x: seg.x + lean - px, y: floorY + 2 * u - py, w: 2 * px, h: 2 * py, seg: seg.segment, a: FLOOR_POOL });
      }
    } else if (hangs === 'wall') {
      // At the foot of the back wall, washing it upwards: a soft arch per segment, wide enough that they join.
      if (lamp) box(fg, place.x - 6 * u, floorY - 6 * u, 12 * u, 6 * u, 1.5 * u);
      else if (!panel) box(fg, place.left, place.top, place.length, place.height, 2 * u);
      const washH = (floorY - wallTop) * 0.8;
      const halfW = Math.max(spacing * 1.5, washH * 0.42, 14 * u);
      for (const seg of place.segments) {
        item.under.push({ sprite: 'arch', x: seg.x - halfW, y: floorY - washH, w: 2 * halfW, h: washH, seg: seg.segment, a: WASH });
      }
      if (lamp) item.leds.push({ x: place.x, y: floorY - 4.5 * u, r: Math.max(0.9, 1.8 * u), seg: 0 });
      else if (panel) {
        const face = panelFace(item, f, place.x, floorY - 8 * u, s);
        const m = Math.max(1.5, face.pitch * 0.7);
        box(fg, face.left - m, face.top - m, face.width + 2 * m, face.height + 2 * m, 2 * u);
      }
    } else if (hangs === 'riser') {
      // A low riser in front of the wall, its strip round it glowing and lighting what stands on it.
      fg.fillStyle = RISER;
      fg.fillRect(place.left, place.top, place.length, place.height);
      item.cover = { x: place.left, y: place.top, w: place.length, h: place.height };
      // One glow over the riser per segment, wide enough that they join.
      const gw = n === 1 ? place.length * 0.65 : Math.max(spacing * 1.2, 30 * u);
      for (const seg of place.segments) {
        item.under.push({ sprite: 'round', x: seg.x - gw, y: floorY - 22 * u - 36 * u, w: 2 * gw, h: 72 * u, seg: seg.segment, a: RISER_GLOW });
      }
      if (strip) {
        const rect = { left: place.left, top: place.top, width: place.length, height: place.height };
        outlineCells(rect, n, false).forEach((pts, seg) => {
          item.lines.push({ pts, seg, width: Math.max(1.4, 2 * s), glow: Math.max(4, 7 * s) });
        });
      }
    } else if (hangs === 'stand') {
      // On a stand at the front, facing the stage: we see its back, a rim of its light, and a glow on the floor.
      if (place.pole) {
        fg.strokeStyle = HOUSING_EDGE;
        fg.lineWidth = Math.max(1, 1.4 * s);
        fg.beginPath();
        fg.moveTo(place.x, place.pole.from);
        fg.lineTo(place.x, place.pole.to);
        fg.stroke();
      }
      box(fg, place.left, place.top, place.length, place.height, 2 * u);
      const inset = Math.max(1, 2 * u);
      fg.fillStyle = HOUSING_INNER;
      fg.fillRect(place.left + inset, place.top + inset, place.length - 2 * inset, place.height - 2 * inset);
      item.lines.push({ pts: [[place.left + inset, place.top + 0.5], [place.left + place.length - inset, place.top + 0.5]], seg: 0, width: 1, glow: Math.max(3, 4 * s), a: 0.55, dark: false });
      const px = Math.max(44 * u, place.length * 1.6), py = px * 0.22;
      // On the floor between the floor line and the stand (in a tall picture the stands are well in front).
      const y = floorY + (place.top - floorY) * 0.6;
      for (const seg of place.segments) {
        item.under.push({ sprite: 'round', x: seg.x - px, y: y - py, w: 2 * px, h: 2 * py, seg: seg.segment, a: FLOOR_POOL });
      }
      return item;
    } else {
      // Upright at the side, its LEDs one above the other; a little light on the floor beside it.
      box(fg, place.left, place.top, place.width, place.length, 2 * u);
      // The pool beside it, towards the middle of the stage, in the colour of its lowest segment.
      const dir = f.x < 0.5 ? 1 : -1;
      const px = 30 * u, py = px * 0.22;
      item.under.push({ sprite: 'round', x: place.x + dir * 6 * u - px, y: floorY + 2 * u - py, w: 2 * px, h: 2 * py, seg: n - 1, a: FLOOR_POOL });
    }

    // The LEDs along the housing (a lamp's and a panel's are placed above). A strip is a line, one stretch per segment.
    if (strip && hangs !== 'riser') {
      const along = place.length / n;
      for (const seg of place.segments) {
        const k2 = seg.segment;
        const pts = place.vertical
          ? [[place.x, place.top + along * k2], [place.x, place.top + along * (k2 + 1)]]
          : [[place.left + along * k2, midY], [place.left + along * (k2 + 1), midY]];
        item.lines.push({ pts, seg: k2, width: Math.max(1.4, 2 * s), glow: Math.max(4, 7 * s) });
      }
    } else if (!strip && !lamp && !panel) {
      const pitch = place.length / place.leds.length;
      const r = Math.max(0.8, Math.min(1.9 * s, pitch * 0.36));
      const glow = Math.max(2.5, r * 3.2);
      for (const l of place.leds) item.leds.push({ x: l.x, y: l.y, r, seg: l.segment });
      ledGlows(item, glow, LED_GLOW * Math.min(1, pitch / glow));
    }
    if (lamp) {
      for (const d of item.leds) {
        const glow = Math.max(3, d.r * 3.5);
        item.over.push({ sprite: 'round', x: d.x - glow, y: d.y - glow, w: 2 * glow, h: 2 * glow, seg: d.seg, a: LED_GLOW });
      }
    }
    return item;
  });
}

