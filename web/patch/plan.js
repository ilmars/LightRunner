// Stage plan editing for the Patch page: shapes, turning and resizing. No DOM, so it can be tested.
// A fixture's x and y are its middle, as fractions of the plan. What each shape keeps (see web/shared/stage.js):
// a bar its length (w), thickness (h) and angle; a beam its angle and reach; an outline its width (w) and height (h).
// Lengths along an angle are measured in the plan's proportions, as a fraction of its width.

import { BEAM_REACH, PLAN_ASPECT, barAxis } from '../shared/stage.js';
import { HANGS, hangsOf } from '../shared/stageview.js';

/** A new bar: a fifth of the plan wide, and thin. */
export const BAR_LENGTH = 0.2;
export const BAR_THICKNESS = 0.03;
/** A new outline: a box about the size of a drum riser. */
export const OUTLINE_W = 0.12;
export const OUTLINE_H = 0.25;
/** Nothing can be made shorter or thinner than this. */
export const MIN_LENGTH = 0.02;
export const MIN_THICKNESS = 0.01;
const MIN_REACH = 0.03;
/** The turning and aiming handles snap to this many degrees unless turned freely (Shift). */
const STEP = 15;

const round = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const deg = (r) => (r * 180) / Math.PI;
/** An angle kept between -180 and 180. */
const wrap = (a) => {
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 && a > 0 ? 180 : w;
};
const snap = (a, free) => wrap(free ? Math.round(a) : Math.round(a / STEP) * STEP);
/** The direction from the fixture's middle to `p`, in the plan's proportions: [angle, distance]. */
const towards = (f, p) => {
  const dx = p.x - f.x, dy = (p.y - f.y) / PLAN_ASPECT;
  return [deg(Math.atan2(dy, dx)), Math.hypot(dx, dy)];
};

/** How the fixture is drawn: a stored shape, else a cloud in a smoke group, a bar when it has a size, or a dot. */
export function shapeOf(f, inSmoke = false) {
  if (f.shape) return f.shape;
  if (inSmoke) return 'smoke';
  return f.w || f.h ? 'bar' : 'dot';
}

const drop = (f, ...keys) => { for (const k of keys) delete f[k]; };

/** Give a fixture another shape, stored, with a starting size; a bar that stays a bar keeps its size. */
export function setShape(f, shape, inSmoke = false) {
  const was = shapeOf(f, inSmoke);
  f.shape = shape;
  if (shape === was) return;
  if (shape === 'bar') {
    Object.assign(f, { w: BAR_LENGTH, h: BAR_THICKNESS, angle: 0 });
    drop(f, 'reach');
  } else if (shape === 'beam') {
    Object.assign(f, { angle: -90, reach: BEAM_REACH });
    drop(f, 'w', 'h');
  } else if (shape === 'outline') {
    Object.assign(f, { w: OUTLINE_W, h: OUTLINE_H });
    drop(f, 'angle', 'reach');
    // Near an edge it moves just enough to fit on the plan.
    f.x = round(clamp(f.x, OUTLINE_W / 2, 1 - OUTLINE_W / 2));
    f.y = round(clamp(f.y, OUTLINE_H / 2, 1 - OUTLINE_H / 2));
  } else {
    drop(f, 'w', 'h', 'angle', 'reach');
  }
}

/** Store a bar the way angles need it (an upright bar from before angles gets angle 90); returns its axis. */
function asTurned(f) {
  const axis = barAxis(f);
  f.w = round(clamp(axis.length, MIN_LENGTH, 1));
  f.h = round(clamp(axis.thickness, MIN_THICKNESS, 1));
  f.angle = axis.angle;
  return { length: f.w, thickness: f.h, angle: f.angle };
}

/** Turn a bar to `angle` degrees about its middle (Across is 0, Upright 90). */
export function setBarAngle(f, angle) {
  asTurned(f);
  f.angle = wrap(angle);
}

/** The turning handle, past the bar's end, dragged to `p`: the end points at it. */
export function turnBar(f, p, free) {
  setBarAngle(f, snap(towards(f, p)[0], free));
}

/** How far from `from` along `dir` (plan proportions) before leaving the plan. */
function roomAlong(from, dir) {
  let room = Infinity;
  const limits = [[from.x, dir.x, 1], [from.y, dir.y, 1 / PLAN_ASPECT]];
  for (const [at, d, size] of limits) {
    if (d > 1e-9) room = Math.min(room, (size - at) / d);
    else if (d < -1e-9) room = Math.min(room, -at / d);
  }
  return Math.max(0, room);
}

/** Drag one end of a bar ('start' is the left or top end at 0° or 90°) to `p`; the other end stays put. */
export function resizeEnd(f, end, p) {
  const { length, thickness, angle } = asTurned(f);
  const r = (angle * Math.PI) / 180;
  const dir = { x: Math.cos(r), y: Math.sin(r) };
  // The end that stays, and the way to the end that moves, in plan proportions.
  const sign = end === 'end' ? 1 : -1;
  const middle = { x: f.x, y: f.y / PLAN_ASPECT };
  const fixed = { x: middle.x - (sign * dir.x * length) / 2, y: middle.y - (sign * dir.y * length) / 2 };
  const way = { x: sign * dir.x, y: sign * dir.y };
  const at = (p.x - fixed.x) * way.x + (p.y / PLAN_ASPECT - fixed.y) * way.y;
  // At least twice as long as it is thick, so it stays a bar.
  const shortest = Math.max(MIN_LENGTH, (2 * thickness) / PLAN_ASPECT);
  const next = clamp(at, shortest, Math.max(shortest, roomAlong(fixed, way)));
  f.x = round(fixed.x + (way.x * next) / 2);
  f.y = round((fixed.y + (way.y * next) / 2) * PLAN_ASPECT);
  f.w = round(next);
}

/** Drag the side handle to `p`: the bar gets thicker or thinner, evenly about its middle, up to half its length. */
export function resizeThickness(f, p) {
  const { length, angle } = asTurned(f);
  const r = (angle * Math.PI) / 180;
  const dx = p.x - f.x, dy = (p.y - f.y) / PLAN_ASPECT;
  const across = Math.abs(dx * Math.sin(r) - dy * Math.cos(r));
  f.h = round(clamp(2 * across * PLAN_ASPECT, MIN_THICKNESS, Math.max(MIN_THICKNESS, (length * PLAN_ASPECT) / 2)));
}

/** The beam's tip dragged to `p`: it points there and reaches that far. */
export function aimBeam(f, p, free) {
  const [angle, distance] = towards(f, p);
  f.angle = snap(angle, free);
  f.reach = round(clamp(distance, MIN_REACH, 1));
}

/** The outline's corner dragged to `p`: its width and height, evenly about its middle. */
export function resizeOutline(f, p) {
  f.w = round(clamp(2 * Math.abs(p.x - f.x), MIN_LENGTH, 1));
  f.h = round(clamp(2 * Math.abs(p.y - f.y), MIN_LENGTH, 1));
}

/** Where `count` new fixtures go: a row from `spot` to the right, moved or squeezed to stay on the plan. */
export function placeRow(spot, count, shape) {
  const bar = shape === 'bar';
  const margin = bar ? BAR_LENGTH / 2 : 0.03;
  const lo = margin, hi = 1 - margin;
  let step = bar ? BAR_LENGTH + 0.02 : 0.08;
  if (count > 1 && (count - 1) * step > hi - lo) step = (hi - lo) / (count - 1);
  const first = clamp(Math.min(spot.x, hi - (count - 1) * step), lo, hi);
  const y = round(clamp(spot.y, 0, 1));
  return Array.from({ length: count }, (_, k) => ({ x: round(clamp(first + k * step, 0, 1)), y }));
}

// ---- Several fixtures at once ----

/**
 * The space a fixture takes up on the plan, as fractions: a point for a dot, a beam (its lamp) or smoke;
 * a bar's or outline's edges as they are on screen.
 */
export function boundsOf(f, inSmoke = false) {
  const shape = shapeOf(f, inSmoke);
  let ex = 0, ey = 0;
  if (shape === 'bar') {
    const { length, thickness, angle } = barAxis(f);
    const r = (angle * Math.PI) / 180, cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
    ex = (length / 2) * cos + (thickness / (2 * PLAN_ASPECT)) * sin;
    ey = (length / 2) * sin * PLAN_ASPECT + (thickness / 2) * cos;
  } else if (shape === 'outline') {
    ex = (f.w ?? 0) / 2;
    ey = (f.h ?? 0) / 2;
  }
  return { left: f.x - ex, right: f.x + ex, top: f.y - ey, bottom: f.y + ey };
}

/**
 * Line fixtures up: 'left', 'right', 'top' or 'bottom' edges with the outermost one,
 * or their middles with the group's middle ('centre' across, 'middle' up and down).
 */
export function alignFixtures(list, how, inSmoke = () => false) {
  const boxes = list.map((f) => boundsOf(f, inSmoke(f)));
  const across = ['left', 'centre', 'right'].includes(how);
  const lo = Math.min(...boxes.map((b) => (across ? b.left : b.top)));
  const hi = Math.max(...boxes.map((b) => (across ? b.right : b.bottom)));
  list.forEach((f, k) => {
    const b = boxes[k];
    const [start, end] = across ? [b.left, b.right] : [b.top, b.bottom];
    const shift = how === 'left' || how === 'top' ? lo - start : how === 'right' || how === 'bottom' ? hi - end : (lo + hi) / 2 - (start + end) / 2;
    if (across) f.x = round(clamp(f.x + shift, 0, 1));
    else f.y = round(clamp(f.y + shift, 0, 1));
  });
}

/** Space fixtures evenly across ('x') or down ('y') by their middles; the outermost two stay where they are. */
export function spaceEvenly(list, axis) {
  if (list.length < 3) return;
  const order = [...list].sort((a, b) => a[axis] - b[axis]);
  const first = order[0][axis], last = order[order.length - 1][axis];
  const step = (last - first) / (order.length - 1);
  order.forEach((f, k) => { f[axis] = round(first + k * step); });
}

/** Move fixtures together from where they started by dx and dy, only as far as all of them stay on the plan. */
export function moveTogether(list, starts, dx, dy) {
  const room = (key, d) => clamp(d, Math.max(...starts.map((s) => -s[key])), Math.min(...starts.map((s) => 1 - s[key])));
  const mx = room('x', dx), my = room('y', dy);
  list.forEach((f, k) => {
    f.x = round(starts[k].x + mx);
    f.y = round(starts[k].y + my);
  });
}

/**
 * After a handle changed `lead` (from `leadStart`, a copy taken when the drag began), give each of `others` the same
 * change from where it started (`starts`, copies in the same order). `how` is the handle: 'start' or 'end' (a bar's
 * length, that end moving and the other staying put), 'thick', 'turn', 'tip' (a beam's aim and reach) or 'corner' (an
 * outline's size). Each stays within its own limits, as with its own handle.
 */
export function changeTogether(lead, how, leadStart, others, starts) {
  if (how === 'tip') {
    const turn = (lead.angle ?? -90) - (leadStart.angle ?? -90);
    const reach = (lead.reach ?? BEAM_REACH) - (leadStart.reach ?? BEAM_REACH);
    others.forEach((f, k) => {
      f.angle = wrap((starts[k].angle ?? -90) + turn);
      f.reach = round(clamp((starts[k].reach ?? BEAM_REACH) + reach, MIN_REACH, 1));
    });
    return;
  }
  if (how === 'corner') {
    others.forEach((f, k) => {
      f.w = round(clamp((starts[k].w ?? OUTLINE_W) + (lead.w - (leadStart.w ?? OUTLINE_W)), MIN_LENGTH, 1));
      f.h = round(clamp((starts[k].h ?? OUTLINE_H) + (lead.h - (leadStart.h ?? OUTLINE_H)), MIN_LENGTH, 1));
    });
    return;
  }
  const was = barAxis(leadStart), now = barAxis(lead);
  others.forEach((f, k) => {
    Object.assign(f, starts[k]);
    const axis = asTurned(f);
    if (how === 'turn') setBarAngle(f, axis.angle + (now.angle - was.angle));
    else if (how === 'thick') f.h = round(clamp(axis.thickness + (now.thickness - was.thickness), MIN_THICKNESS, Math.max(MIN_THICKNESS, (axis.length * PLAN_ASPECT) / 2)));
    else {
      // Its own end the same way out (or in) as the lead's: a point that far along its axis from the end that stays.
      const r = (axis.angle * Math.PI) / 180, sign = how === 'end' ? 1 : -1;
      const way = { x: sign * Math.cos(r), y: sign * Math.sin(r) };
      const fixed = { x: f.x - (way.x * axis.length) / 2, y: f.y / PLAN_ASPECT - (way.y * axis.length) / 2 };
      const next = axis.length + (now.length - was.length);
      resizeEnd(f, how, { x: fixed.x + way.x * next, y: (fixed.y + way.y * next) * PLAN_ASPECT });
    }
  });
}

/** Whether a fixture is touched by a box drawn on the plan (left, top, right, bottom as fractions). */
export function touches(f, box, inSmoke = false) {
  const b = boundsOf(f, inSmoke);
  return b.right >= box.left && b.left <= box.right && b.bottom >= box.top && b.top <= box.bottom;
}

// ---- Where a light hangs (the stage view from the audience) ----

/** What Patch offers for Hangs on, in the order of the select. */
export const HANGS_CHOICES = [
  { value: 'truss', label: 'Truss' },
  { value: 'wall', label: 'Back-wall floor' },
  { value: 'riser', label: 'Riser' },
  { value: 'stand', label: 'Stand' },
  { value: 'side', label: 'Side' },
];

/** What the stage view would guess for a fixture with no Hangs on, from its place and shape on the plan. */
export function guessHangs(f, inSmoke = false) {
  return hangsOf({ ...f, shape: shapeOf(f, inSmoke), hangs: null });
}

/** Say where a fixture hangs; an empty value (or one that isn't a place) takes it back to the guess. */
export function setHangs(f, value) {
  if (HANGS.includes(value)) f.hangs = value;
  else delete f.hangs;
}
