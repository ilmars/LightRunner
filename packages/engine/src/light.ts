// The abstract state of one fixture: a colour whose brightest channel is 1,
// plus a separate intensity. Keeping them apart is what stops red-to-blue
// fades dipping through a dim muddy purple.

export interface Light {
  r: number;
  g: number;
  b: number;
  /** White, amber and UV, relative like r, g and b. */
  w: number;
  a: number;
  u: number;
  /** 0..1 */
  i: number;
}

/** White, amber and UV levels (0..1) next to a #rrggbb colour. */
export interface Extras {
  white?: number;
  amber?: number;
  uv?: number;
}

export function dark(): Light {
  return { r: 1, g: 1, b: 1, w: 0, a: 0, u: 0, i: 0 };
}

export function copy(to: Light, from: Light): Light {
  to.r = from.r;
  to.g = from.g;
  to.b = from.b;
  to.w = from.w;
  to.a = from.a;
  to.u = from.u;
  to.i = from.i;
  return to;
}

/**
 * Light for a #rrggbb colour with optional white, amber and UV levels (a plain
 * number is the white level). A dark colour becomes a full-brightness colour
 * at lower intensity, so every colour in the engine has its brightest channel at 1.
 */
export function fromHex(hex: string, extras: number | Extras = 0, intensity = 1): Light {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const x: Extras = typeof extras === 'number' ? { white: extras } : extras;
  const white = x.white ?? 0, amber = x.amber ?? 0, uv = x.uv ?? 0;
  const m = Math.max(r, g, b, white, amber, uv);
  if (m <= 0) return dark();
  return { r: r / m, g: g / m, b: b / m, w: white / m, a: amber / m, u: uv / m, i: intensity * m };
}

export function toHex(l: Light): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(l.r)}${c(l.g)}${c(l.b)}`;
}

/**
 * Mix lights by weight into `out`. Intensity mixes linearly. Colour mixes as
 * the light the fixtures would actually emit (weighted by intensity), then is
 * scaled back so its brightest channel is 1. Fading up from dark therefore
 * keeps the target colour the whole way instead of passing through white.
 * White, amber and UV mix the same way as red, green and blue.
 */
export function mix(out: Light, parts: readonly Light[], weights: readonly number[]): Light {
  let i = 0, r = 0, g = 0, b = 0, w = 0, a = 0, u = 0;
  let pr = 0, pg = 0, pb = 0, pw = 0, pa = 0, pu = 0;
  for (let k = 0; k < parts.length; k++) {
    const l = parts[k], wt = weights[k];
    if (wt <= 0) continue;
    const e = wt * l.i;
    i += e;
    r += e * l.r; g += e * l.g; b += e * l.b; w += e * l.w; a += e * l.a; u += e * l.u;
    pr += wt * l.r; pg += wt * l.g; pb += wt * l.b; pw += wt * l.w; pa += wt * l.a; pu += wt * l.u;
  }
  // When everything is dark, fall back to the plain weighted colour so the
  // colour is still defined (and continuous) as intensity comes back.
  if (i <= 1e-9) {
    r = pr; g = pg; b = pb; w = pw; a = pa; u = pu;
  }
  const m = Math.max(r, g, b, w, a, u);
  if (m > 0) {
    out.r = r / m; out.g = g / m; out.b = b / m; out.w = w / m; out.a = a / m; out.u = u / m;
  } else {
    out.r = 1; out.g = 1; out.b = 1; out.w = 0; out.a = 0; out.u = 0;
  }
  out.i = Math.min(1, i);
  return out;
}

/** Mix two lights: `a` at weight 1 − t, `b` at weight t. */
export function mix2(out: Light, a: Light, b: Light, t: number): Light {
  if (t <= 0) return copy(out, a);
  if (t >= 1) return copy(out, b);
  return mix(out, [a, b], [1 - t, t]);
}
