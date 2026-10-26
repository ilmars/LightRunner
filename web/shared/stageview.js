// The stage view's numbers, for drawing the rig from above and from the audience (web/shared/stagedraw.js). No DOM, so it can be tested.
//
// A fixture here is what the layout gives the pages: x and y (fractions of the stage plan, across and down), w and h,
// shape, angle, reach, `segments`, and the two new optional ones: `leds` (from its type) and `hangs` (its own). Anything
// missing may also be null. Everything this module gives back is plain numbers:
//   - from above, in the plan's own units: x across as a fraction of the plan's width, y down as a fraction of its
//     height, and radii as fractions of the plan's width (so a pool is round whatever the plan's proportions);
//   - from the audience, in pixels of the box it is asked for, with a unit `s` that grows with the box.

import { BEAM_HALF_SPREAD, PLAN_ASPECT, barAxis, barEnds, beamCone } from './stage.js';

const rad = (deg) => (deg * Math.PI) / 180;

/** The plan shape a layout fixture is drawn with: as stored, else as before shapes were stored. */
function shapeOf(f) {
  return f.shape ?? (f.w || f.h ? 'bar' : 'dot');
}

/** The segments a fixture has (at least one). */
const segmentsOf = (f) => Math.max(1, Math.floor(Number(f.segments) || 1));

// ---- LEDs ----

/**
 * The segment each LED of a light belongs to, in order along the light. `leds` are spread evenly over the segments,
 * the remainder going to the first ones. Without a LED count (or with fewer LEDs than segments, which can't be
 * right) it is one LED per segment: never a made-up number.
 */
export function ledLayout(segments, leds) {
  const n = Math.max(1, Math.floor(Number(segments) || 1));
  const total = Number.isFinite(leds) ? Math.floor(leds) : 0;
  if (total < n) return Array.from({ length: n }, (_, k) => k);
  const base = Math.floor(total / n), extra = total % n;
  const out = [];
  for (let k = 0; k < n; k++) for (let i = 0; i < base + (k < extra ? 1 : 0); i++) out.push(k);
  return out;
}

/** A light with one segment, no bar shape and 16 or more LEDs is a panel: drawn as a face with a fine LED texture. */
export function isPanel(f) {
  const shape = shapeOf(f);
  return segmentsOf(f) === 1 && Number.isFinite(f.leds) && f.leds >= 16 && shape === 'dot';
}

/**
 * A bar with no thickness on the plan and no LED count is a strip (an LED tape): drawn as a glowing line in its
 * segments' colours, not as a row of lamps.
 */
export function isStrip(f) {
  if (shapeOf(f) !== 'bar' || (Number.isFinite(f.leds) && f.leds >= 1)) return false;
  return barAxis(f).thickness < 0.01;
}

/** The grid of a panel's LED texture: `cols` across and `rows` down, about 3 to 2, holding at least `leds`. */
export function panelGrid(leds) {
  const n = Math.max(1, Math.floor(Number(leds) || 1));
  const rows = Math.max(1, Math.round(Math.sqrt(n / 1.5)));
  return { cols: Math.ceil(n / rows), rows };
}

/**
 * A bar's LEDs from above, along its middle line (first segment at the first end), as plan fractions with the
 * segment each belongs to. Anything that is not a bar has no row of LEDs: it is a lamp, a panel or a line.
 */
export function ledPoints(f) {
  if (shapeOf(f) !== 'bar') return [];
  const [a, b] = barEnds(f);
  const layout = ledLayout(segmentsOf(f), f.leds);
  const m = layout.length;
  return layout.map((segment, k) => {
    const t = (k + 0.5) / m;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, segment };
  });
}

// ---- Where a light hangs ----

export const HANGS = ['truss', 'wall', 'riser', 'stand', 'side'];

/**
 * Where a light hangs: what Patch says, else a guess from the plan (so a show from before this setting still draws).
 * An outline is a riser strip; a beam hangs from the truss; smoke is at the back wall; an upright bar is at the
 * side; otherwise near the back (y < 0.3) or a bar between 0.3 and 0.6 is on the floor at the wall, near the
 * front (y > 0.75) is on a stand, and the rest hangs from the truss.
 */
export function hangsOf(f) {
  if (f.hangs) return f.hangs;
  const shape = shapeOf(f);
  if (shape === 'outline') return 'riser';
  if (shape === 'beam') return 'truss';
  if (shape === 'smoke') return 'wall';
  if (shape === 'bar') {
    const turn = ((barAxis(f).angle % 180) + 180) % 180;
    if (turn > 45 && turn < 135) return 'side';
  }
  if (f.y < 0.3) return 'wall';
  if (shape === 'bar' && f.y <= 0.6) return 'wall';
  if (f.y > 0.75) return 'stand';
  return 'truss';
}

// ---- From above: the pools of light on the floor ----

// Where each kind of light's pool falls from the light, and how big and strong it is. Distances are fractions of the
// plan's width (a step down the plan is turned into a fraction of its height by PLAN_ASPECT); `r` is a pool's
// radius when the light's segments are far apart (closer segments make it wider so the pools join).
const POOL = {
  truss: { dx: 0, dy: 0.066, r: 0.053, alpha: 0.42 }, // a little downstage of it, down through the haze
  wall: { dx: 0, dy: 0.019, r: 0.028, alpha: 0.3 }, // hugs the wall it washes
  riser: { dx: 0, dy: 0.009, r: 0.072, alpha: 0.28 }, // glows round itself
  stand: { dx: 0, dy: -0.103, r: 0.094, alpha: 0.38 }, // thrown upstage, towards the back
  side: { dx: -0.016, dy: 0, r: 0.034, alpha: 0.3 }, // beside it, towards the middle of the stage
};
/** A pool is an ellipse a little flatter than it is wide, as the floor is seen at an angle. */
const POOL_SQUASH = 0.75;

/**
 * The light a fixture throws on the floor, seen from above: where each pool is (`spots`, plan fractions, with the
 * segment whose colour it takes; a bar has one per segment, or more along a long bar with few segments), its radius `r` (a fraction of the plan's width), `squash` (its height over its
 * width), and `alpha` (how strongly it is drawn, 0..1; before the colour's own brightness). A beam keeps its own
 * angle and reach: its pool is at the end of its cone. `view` is only 'above' for now.
 */
export function poolOf(f, hangs, view = 'above') {
  if (view !== 'above') throw new RangeError(`no pools for the view "${view}"`);
  const shape = shapeOf(f);
  if (shape === 'beam') {
    const cone = beamCone(f);
    const reach = f.reach ?? 0.14;
    return { spots: [{ x: cone.tip.x, y: cone.tip.y, segment: 0 }], r: reach * Math.tan(rad(BEAM_HALF_SPREAD)), squash: POOL_SQUASH, alpha: POOL.truss.alpha };
  }
  const p = POOL[hangs] ?? POOL.truss;
  const dx = hangs === 'side' && f.x < 0.5 ? -p.dx : p.dx;
  const dy = p.dy * PLAN_ASPECT;
  const move = (pt, segment) => ({ x: pt.x + dx, y: pt.y + dy, segment });
  if (shape === 'bar') {
    const [a, b] = barEnds(f);
    const n = segmentsOf(f), length = barAxis(f).length;
    // A pool per segment; a long bar with few segments gets more of them (each in its segment's colour), so its light
    // stays near it instead of one huge pool.
    const m = Math.max(n, Math.ceil(length / (p.r * 1.2)));
    const spots = Array.from({ length: m }, (_, k) => {
      const t = (k + 0.5) / m;
      return move({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, Math.min(n - 1, Math.floor((k * n) / m)));
    });
    // Neighbouring pools overlap, so a long bar washes in one piece.
    return { spots, r: Math.max(p.r, length / m), squash: POOL_SQUASH, alpha: p.alpha };
  }
  const r = shape === 'outline' ? Math.max(p.r, (f.w ?? 0) / 2) : p.r;
  return { spots: [move({ x: f.x, y: f.y }, 0)], r, squash: POOL_SQUASH, alpha: p.alpha };
}

// ---- From the audience ----

/**
 * The stage seen from the front in a box of `w` by `h` pixels: the truss across the top, the back wall under it
 * down to the floor line, and the floor in front. `s` is the unit sizes are drawn in (1 at 640 by 300): it follows
 * the smaller side, so the picture fits any box.
 */
export function frontScene(w, h) {
  return { trussY: h * 0.11, wallTop: h * 0.16, floorY: h * 0.8, s: Math.min(w / 640, h / 300) };
}

/** A light's length across the stage in pixels, as drawn from the audience; 0 when it is a lamp. */
function lengthOf(f, w) {
  const shape = shapeOf(f);
  if (shape === 'bar') return barAxis(f).length * w;
  if (shape === 'outline') return (f.w ?? 0) * w;
  return 0;
}

/**
 * Where a light is drawn from the audience in a box of `w` by `h` pixels, by where it hangs: `x` (its middle, from
 * the plan's x), the body (`left`, `top`, `width`, `height`, with `length` its long side and `vertical` when it
 * stands upright), its `leds` (x, y and segment of each, in the housing), the `segments` (the middle of each, for
 * the beam or wash under it), `beamFrom` (a truss light's beam starts there) and `pole` (a stand's pole), where
 * they apply. Nothing is clamped to the box: whoever draws clips it.
 */
export function frontPlacement(f, hangs, w, h) {
  const { trussY, wallTop, floorY, s } = frontScene(w, h);
  const x = f.x * w;
  const own = lengthOf(f, w);
  const place = { hangs, x, vertical: false, left: 0, top: 0, width: 0, height: 0, length: 0 };
  let along; // the line the segments and LEDs lie on: from one end to the other
  if (hangs === 'side') {
    const length = floorY - wallTop - 20 * s;
    Object.assign(place, { vertical: true, length, width: 8 * s, height: length, top: floorY - length });
    place.left = x - place.width / 2;
    along = { x1: x, y1: place.top, x2: x, y2: place.top + length };
  } else {
    let height, top, min = 16 * s;
    if (hangs === 'truss') { height = 7 * s; top = trussY + 6 * s; place.beamFrom = top + height; }
    else if (hangs === 'wall') { height = 7 * s; top = floorY - height; }
    else if (hangs === 'riser') { height = 12 * s; top = floorY - height; }
    else { // on a stand at the front
      height = 14 * s; top = h - 40 * s; min = 18 * s;
      place.pole = { from: h - 4 * s, to: h - 26 * s };
    }
    const length = Math.max(own, min);
    Object.assign(place, { length, width: length, height, top, left: x - length / 2 });
    const y = top + height / 2;
    along = { x1: x - length / 2, y1: y, x2: x + length / 2, y2: y };
  }
  const at = (t) => ({ x: along.x1 + (along.x2 - along.x1) * t, y: along.y1 + (along.y2 - along.y1) * t });
  const n = segmentsOf(f);
  place.segments = Array.from({ length: n }, (_, k) => ({ ...at((k + 0.5) / n), segment: k }));
  const layout = ledLayout(n, f.leds);
  place.leds = layout.map((segment, k) => ({ ...at((k + 0.5) / layout.length), segment }));
  return place;
}

// ---- Soft light that overlaps ----

/**
 * How much of a soft light's shape falls at x, y (0..1). A light is `{ sprite, x, y, w, h, a }` in pixels: 'arch' is
 * a wash up a wall from the middle of its bottom edge ((1 - d)^1.5); anything else a round spot from its middle
 * ((1 - d^2)^2), d being the distance as a fraction of the shape's half-width and half-height (height for an arch).
 */
export function softShareAt(p, x, y) {
  if (p.sprite === 'arch') {
    const X = (x - (p.x + p.w / 2)) / (p.w / 2), Y = (p.y + p.h - y) / p.h;
    if (Y < -0.05) return 0;
    const d = Math.hypot(X, Math.max(0, Y));
    return d >= 1 ? 0 : (1 - d) ** 1.5;
  }
  const d2 = ((x - (p.x + p.w / 2)) / (p.w / 2)) ** 2 + ((y - (p.y + p.h / 2)) / (p.h / 2)) ** 2;
  return d2 >= 1 ? 0 : (1 - d2) ** 2;
}

/**
 * Pools and washes that overlap would add up to a bright floor (an All white look, a long bar's pools). Each light's
 * strength `a` is made fainter (in place) by how much light falls where it is strongest, so overlapping light grows
 * only a little brighter (about the fifth root of how many overlap) and never gets near white. A light alone keeps
 * its strength. Returns `lights`.
 */
export function shareSoftLight(lights) {
  const peak = (p) => (p.sprite === 'arch' ? [p.x + p.w / 2, p.y + p.h] : [p.x + p.w / 2, p.y + p.h / 2]);
  const sums = lights.map((p) => {
    const [x, y] = peak(p);
    return lights.reduce((sum, q) => sum + q.a * softShareAt(q, x, y), 0);
  });
  lights.forEach((p, i) => {
    if (sums[i] > p.a) p.a *= (p.a / sums[i]) ** 0.8;
  });
  return lights;
}

// ---- The view each browser shows, and the size of its stage view ----

/** The stored choice of view ('above' or 'front'): from above unless it says from the audience. */
export function stageViewFrom(stored) {
  return stored === 'front' ? 'front' : 'above';
}

/**
 * The stage view's size kept for `page` in the stored text (`{"operator": {"h": 200}, "timeline": {"w": 900, "h": 300}}`):
 * `{ w, h }`, each a number or null when not kept. Anything unreadable is nothing kept.
 */
export function stageSizeFrom(stored, page) {
  let all = null;
  try {
    all = JSON.parse(stored ?? 'null');
  } catch {
    all = null;
  }
  const mine = all && typeof all === 'object' ? all[page] : null;
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  return { w: num(mine?.w), h: num(mine?.h) };
}

/** The stored text with `page`'s size set to `size` ({ w?, h? }, rounded), or taken out when `size` is null. */
export function stageSizeWith(stored, page, size) {
  let all = {};
  try {
    const was = JSON.parse(stored ?? '{}');
    if (was && typeof was === 'object' && !Array.isArray(was)) all = was;
  } catch {
    all = {};
  }
  if (!size) delete all[page];
  else {
    const kept = {};
    for (const k of ['w', 'h']) if (Number.isFinite(size[k]) && size[k] > 0) kept[k] = Math.round(size[k]);
    all[page] = kept;
  }
  return JSON.stringify(all);
}

/** `want` (a length in px) kept between `min` and `max`; the minimum wins when there is less room than it. */
export function fitStageLength(want, min, max) {
  const v = Number.isFinite(want) ? want : min;
  return Math.max(min, Math.min(Number.isFinite(max) ? max : v, v));
}
