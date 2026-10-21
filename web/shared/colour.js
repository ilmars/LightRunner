// Colour maths for the operator page's colour strips: the colour at a place on a strip, a colour's place,
// saturation and strength on it, and exact values (hex, R, G, B). No DOM, so it can be tested.
//
// A colour on a strip is three numbers: `p`, its place (0 at the left, 1 at the right); `s`, its saturation
// (0 = white light, 1 = the strip's own colour; the warm-to-cool strip has none, it is always 1); and `v`, its
// strength (1 = as strong as the strip is there). The hex is what is kept and sent: the three numbers are worked
// out from it, so a typed colour that isn't on the strip is never changed, its place is just the nearest one.

/** The colour strip: hues, red to red. Every colour along it has one channel at 0. */
export const HUE_STOPS = ['#ff0000', '#ffc800', '#00ff00', '#00ffc8', '#0000ff', '#8c00ff', '#ff008c', '#ff0000'];
/** The strip for white-only groups: warm to cool white. */
export const WHITE_STOPS = ['#ffb46b', '#f4f8ff'];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const stopsOf = (whiteOnly) => (whiteOnly ? WHITE_STOPS : HUE_STOPS);

/** "#rrggbb" to [r, g, b], 0..255. */
export function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r, g, b] (rounded, kept to 0..255) to "#rrggbb". */
export function rgbHex(rgb) {
  return `#${rgb.map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** The colour a strip shows at place p (0..1), blended between its stops as the CSS gradient does. */
export function stripColour(stops, p) {
  return rgbHex(stripRgb(stops, p));
}

function stripRgb(stops, p) {
  const x = clamp01(p) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const t = x - i;
  const a = hexRgb(stops[i]), b = hexRgb(stops[i + 1]);
  return a.map((v, k) => v + (b[k] - v) * t);
}

/** A typed hex colour ("#FF8800", "ff8800", spaces around it are fine) as "#rrggbb"; null when it isn't one. */
export function parseHex(text) {
  const m = /^\s*#?([0-9a-f]{6})\s*$/i.exec(String(text));
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** A typed R, G or B value: a whole number 0..255 ("0", "128", "255"); null for anything else. */
export function parseChannel(text) {
  const m = /^\s*(\d{1,3})\s*$/.exec(String(text));
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 255 ? n : null;
}

/**
 * The colour at place p with saturation s and strength v. Each channel is mixed from the strip's colour there
 * towards white light of the same strength (the strip's brightest channel), then scaled by v. At s = 1 and v = 1
 * it is exactly the strip's colour. The warm-to-cool strip has no saturation (s is taken as 1).
 */
export function stripMix(whiteOnly, p, s, v) {
  const f = stripRgb(stopsOf(whiteOnly), p);
  const top = Math.max(...f);
  const sat = whiteOnly ? 1 : clamp01(s);
  return rgbHex(f.map((c) => Math.max(0, v) * (top - sat * (top - c))));
}

/** How many places along a strip `stripPick` compares a colour with. */
const SAMPLES = 2000;
const samples = new Map();

/** Each sampled place on a strip, with its colour scaled to full (for the hue strip: from 0 to 255) and its brightest channel. */
function sampled(whiteOnly) {
  let list = samples.get(whiteOnly);
  if (list) return list;
  list = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const p = i / SAMPLES;
    const f = stripRgb(stopsOf(whiteOnly), p);
    const top = Math.max(...f);
    list.push({ p, top, full: f.map((c) => (c * 255) / top) });
  }
  samples.set(whiteOnly, list);
  return list;
}

/**
 * The place whose full colour is nearest to `full`. On the warm-to-cool strip "nearest" is by how much bluer than
 * red a colour is (that only grows from warm to cool), so a colour far from any white (a blue typed for a white-only
 * group) still goes to the white it leans to.
 */
function nearest(whiteOnly, full) {
  const lean = (c) => (c[2] - c[0]) / Math.max(...c);
  let best = null, bestD = Infinity;
  for (const x of sampled(whiteOnly)) {
    const d = whiteOnly
      ? Math.abs(lean(x.full) - lean(full))
      : (x.full[0] - full[0]) ** 2 + (x.full[1] - full[1]) ** 2 + (x.full[2] - full[2]) ** 2;
    if (d < bestD) [best, bestD] = [x, d];
  }
  return best;
}

/**
 * A colour's place, saturation and strength on a strip: `{ p, s, v }`. `p` is the nearest place to its hue (on the
 * warm-to-cool strip, to the colour itself), so stripMix(p, s, v) gives the colour back when it is on the strip.
 * A colour with no hue (black, a grey or white light) keeps `prev`'s place (null when there is none); black keeps
 * its saturation too. The strength is relative to the strip at that place, so it can be a little over 1 for a typed
 * colour brighter than the strip is there.
 */
export function stripPick(whiteOnly, hex, prev = { p: null, s: 1 }) {
  const rgb = hexRgb(hex);
  const max = Math.max(...rgb), min = Math.min(...rgb);
  const prevP = prev.p ?? null;
  const topAt = (p) => (p === null ? 255 : Math.max(...stripRgb(stopsOf(whiteOnly), p)));
  if (max === 0) return { p: prevP, s: whiteOnly ? 1 : prev.s ?? 1, v: 0 };
  if (whiteOnly) {
    const at = nearest(true, rgb.map((c) => (c * 255) / max));
    return { p: at.p, s: 1, v: max / at.top };
  }
  const s = (max - min) / max;
  if (max === min) return { p: prevP, s: 0, v: max / topAt(prevP) };
  const at = nearest(false, rgb.map((c) => ((c - min) * 255) / (max - min)));
  return { p: at.p, s, v: max / at.top };
}
