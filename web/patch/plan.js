// Stage plan geometry for the Patch page: no DOM, so it can be tested.
// A fixture's x and y are its middle; w and h are its size as fractions of the plan's width and height
// (no size draws a dot). `aspect` is the plan's width over its height, to keep lengths the same on screen.

/** A new bar: a fifth of the plan wide, and thin. */
export const BAR_LENGTH = 0.2;
export const BAR_THICKNESS = 0.03;
/** A bar can't be made shorter or thinner than this. */
export const MIN_LENGTH = 0.02;
export const MIN_THICKNESS = 0.01;

const round = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 'dot', 'across' or 'upright' (a bar is upright when it is longer from top to bottom on screen). */
export function shapeOf(f, aspect) {
  if (!f.w && !f.h) return 'dot';
  return (f.w ?? 0) * aspect >= (f.h ?? 0) ? 'across' : 'upright';
}

/** Make a fixture a dot or a bar; turning a bar keeps its length and thickness on screen. */
export function setShape(f, shape, aspect) {
  const was = shapeOf(f, aspect);
  if (shape === was) return;
  if (shape === 'dot') {
    delete f.w;
    delete f.h;
    return;
  }
  // Length and thickness as fractions of the plan's width.
  let length = BAR_LENGTH, thickness = BAR_THICKNESS / aspect;
  if (was === 'across') [length, thickness] = [f.w ?? BAR_LENGTH, (f.h || BAR_THICKNESS) / aspect];
  if (was === 'upright') [length, thickness] = [(f.h ?? 0) / aspect, f.w || BAR_THICKNESS / aspect];
  if (shape === 'across') {
    f.w = round(clamp(length, MIN_LENGTH, 1));
    f.h = round(clamp(thickness * aspect, MIN_THICKNESS, 1));
  } else {
    f.w = round(clamp(thickness, MIN_THICKNESS, 1));
    f.h = round(clamp(length * aspect, MIN_LENGTH, 1));
  }
}

/** Drag one end of a bar ('start' is the left or top end) to `p`; the other end stays put. */
export function resizeEnd(f, end, p, aspect) {
  const across = shapeOf(f, aspect) === 'across';
  const [pos, size] = across ? ['x', 'w'] : ['y', 'h'];
  const at = across ? p.x : p.y;
  // At least twice as long as it is thick, so it never turns into the other shape.
  const shortest = Math.max(MIN_LENGTH, 2 * (across ? (f.h ?? 0) / aspect : (f.w ?? 0) * aspect));
  const half = (f[size] ?? 0) / 2;
  let a = f[pos] - half, b = f[pos] + half;
  if (end === 'start') a = clamp(at, 0, Math.max(0, b - shortest));
  else b = clamp(at, Math.min(1, a + shortest), 1);
  f[pos] = round((a + b) / 2);
  f[size] = round(b - a);
}

/** Drag the side handle to `p`: the bar gets thicker or thinner, evenly about its middle, up to half its length. */
export function resizeThickness(f, p, aspect) {
  if (shapeOf(f, aspect) === 'across') f.h = round(clamp(2 * Math.abs(p.y - f.y), MIN_THICKNESS, Math.max(MIN_THICKNESS, ((f.w ?? 0) * aspect) / 2)));
  else f.w = round(clamp(2 * Math.abs(p.x - f.x), MIN_THICKNESS, Math.max(MIN_THICKNESS, (f.h ?? 0) / aspect / 2)));
}

/** Where `count` new fixtures go: a row from `spot` to the right, moved or squeezed to stay on the plan. */
export function placeRow(spot, count, shape) {
  const bar = shape === 'across';
  const margin = bar ? BAR_LENGTH / 2 : 0.03;
  const lo = margin, hi = 1 - margin;
  let step = bar ? BAR_LENGTH + 0.02 : 0.08;
  if (count > 1 && (count - 1) * step > hi - lo) step = (hi - lo) / (count - 1);
  const first = clamp(Math.min(spot.x, hi - (count - 1) * step), lo, hi);
  const y = round(clamp(spot.y, 0, 1));
  return Array.from({ length: count }, (_, k) => ({ x: round(clamp(first + k * step, 0, 1)), y }));
}
