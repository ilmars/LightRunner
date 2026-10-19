// Effect layers: moving patterns along a group's line of segments. Pure
// functions of the effect's phase (in cycles), the segment's place in the line
// and the effect's settings, so the same moment always looks the same.
//
// Light safety lives here too: no segment's brightness may rise and fall by
// 20 % or more more than 3 times in any second. safeRate() halves an effect's
// rate (again, if needed) until it doesn't, with a margin for frame timing.

import { resolveColour, type EffectKind, type EffectLayer, type EffectSpeed, type Palette } from '../../shared/src/index.ts';
import { copy, dark, fromHex, type Light } from './light.ts';
import type { LayerContext } from './layers.ts';

/** A change of brightness of at least this much (after one the other way) counts. */
const SWING_DEPTH = 0.2;
/**
 * At most this many such changes in any one second for any one segment: three
 * rises and three falls, so never more than 3 rise-and-falls a second.
 */
const MAX_CHANGES = 6;
/** Sparkle picks new sparks this many times a cycle. */
const SPARKLE_SLOTS = 8;
/** Sparkle's base: the first colour at this brightness. */
const SPARKLE_BASE = 0.4;
/** Samples per cycle when the safe rate is measured from the effect itself. */
const SAMPLES = 1024;
/**
 * The share of the exact bound an effect may run at. Frames come up to a few
 * milliseconds early or late, which can squeeze a 4th rise into a second run
 * right at the bound; 5 % below it leaves room for that.
 */
const MARGIN = 0.95;

/** An effect layer with its colours looked up once, so rendering does no lookups. */
export interface CompiledEffect {
  kind: 'effect';
  effect: EffectKind;
  colours: Light[];
  speed: EffectSpeed;
  direction: EffectLayer['direction'];
  waves: number;
  size: number;
  edge: EffectLayer['edge'];
  intensity: number;
  /**
   * The fastest rate (cycles per second) it may run at: 95 % of the rate at which no
   * segment changes brightness by 20 % or more, one way and then the other, more than
   * 6 times in any one second. Infinity when its brightness never moves that much.
   */
  maxRate: number;
}

/** How many times an effect's safe rate has been worked out (not found in a SafeRates), for tests. */
export const rateChecks = { count: 0 };

/**
 * Safe rates already worked out, by what the rate depends on: the effect's settings
 * and looked-up colours (not its speed). Measuring an effect takes up to a few tenths of a
 * millisecond, and the DMX worker compiles every preset on each show edit, so an
 * edit only measures new or changed effects. prune() keeps only the rates asked
 * for since the last prune, so the store never holds more than one show's (and
 * the live effects made since).
 */
export class SafeRates {
  private kept = new Map<string, number>();
  private used = new Map<string, number>();

  rate(fx: CompiledEffect): number {
    const key = JSON.stringify([
      fx.effect, fx.colours.map((c) => [c.r, c.g, c.b, c.w, c.a, c.u, c.i]), fx.direction, fx.waves, fx.size, fx.edge, fx.intensity,
    ]);
    let rate = this.used.get(key) ?? this.kept.get(key);
    if (rate === undefined) rate = fastestRate(fx);
    this.used.set(key, rate);
    return rate;
  }

  /** Forget the rates nothing asked for since the last prune. */
  prune(): void {
    this.kept = this.used;
    this.used = new Map();
  }
}

function fastestRate(fx: CompiledEffect): number {
  rateChecks.count++;
  return MARGIN * fastestSafeRate(fx);
}

export function compileEffect(layer: EffectLayer, palettes: ReadonlyMap<string, Palette>, rates?: SafeRates): CompiledEffect {
  const colours = layer.colours.map((spec) => {
    const c = resolveColour(spec, palettes);
    return fromHex(c.hex, c);
  });
  if (!colours.length) colours.push(fromHex('#ffffff'));
  const fx: CompiledEffect = {
    kind: 'effect',
    effect: layer.effect,
    colours,
    speed: layer.speed,
    direction: layer.direction,
    waves: layer.waves,
    size: layer.size,
    edge: layer.edge,
    intensity: layer.intensity,
    maxRate: Infinity,
  };
  fx.maxRate = rates ? rates.rate(fx) : fastestRate(fx);
  return fx;
}

/** The rate the effect's settings ask for, in cycles per second: beats at the stage tempo (with the speed dial), or seconds (with the speed dial). */
export function cyclesPerSecond(fx: CompiledEffect, beatsPerSecond: number, speed: number): number {
  return 'beats' in fx.speed ? beatsPerSecond / fx.speed.beats : speed / fx.speed.seconds;
}

/**
 * The rate actually used: `cyclesPerSecond`, halved (again, if needed) while one
 * segment's brightness would rise and fall by 20 % or more more than 3 times in
 * any one second, with a 5 % margin (see maxRate). Colour changes at the same brightness don't
 * count, so they are never slowed.
 */
export function safeRate(fx: CompiledEffect, cyclesPerSecond: number): number {
  let rate = cyclesPerSecond;
  while (rate > fx.maxRate) rate /= 2;
  return rate;
}

/**
 * How fast an effect may run. A segment's brightness changes are counted with
 * 20 % hysteresis (a change counts once the brightness has moved 20 % against the
 * last one); a one-second window may hold at most 6. The bound is for the worst
 * one-second window, not the average, because some effects bunch their changes
 * (yo-yo near its turning points, a breathe or a wave through colours of
 * different brightness).
 *
 * - Every segment of a colour fade or a breathe does the same, and every segment of
 *   a wave through several colours does the same, only later: their changes are
 *   measured from the effect itself over one period.
 * - Wave (one colour), chase, meteor and fill change a segment at most twice a cycle,
 *   at the same moments every cycle, so 6 changes take at least 3 cycles. Yo-yo passes
 *   each segment twice a cycle (4 changes, bunched near the ends): at most 1 cycle a second.
 * - Sparkle changes a segment at most once in each of its 8 slots a cycle: on the
 *   slot's edge (hard) or during its crossfade (soft), so 7 changes take at least
 *   6 slots (hard) or 5 (soft).
 */
function fastestSafeRate(fx: CompiledEffect): number {
  const levels = fx.colours.map((c) => c.i * fx.intensity);
  const top = Math.max(...levels), bottom = Math.min(...levels);
  const first = levels[0]!, last = levels[levels.length - 1]!;
  const deep = (depth: number) => depth >= SWING_DEPTH - 1e-9;
  const same = levels.every((v) => Math.abs(v - first) < 1e-9);
  const n = levels.length;
  const soft = fx.edge === 'soft';
  /** The rate for an effect that changes a segment this many times a cycle, at the same moments every cycle. */
  const perCycle = (changes: number) => Math.floor(MAX_CHANGES / changes);
  switch (fx.effect) {
    case 'colourFade': return measuredRate(fx, n);
    case 'wave':
      if (n === 1) return deep(first) && (fx.edge === 'soft' || (fx.size > 0 && fx.size < 1)) ? perCycle(2) : Infinity;
      return measuredRate(fx, 1);
    // Chase and fill light each cycle in the next colour: with soft edges a dimmer colour
    // is counted later in its (at most half-cycle) fade, so allow half a cycle for that.
    case 'chase': return deep(top) ? perCycle(2) - (soft && !same ? 0.5 : 0) : Infinity;
    case 'sparkle':
      if (!deep(Math.abs(last - SPARKLE_BASE * first))) return Infinity;
      return (fx.edge === 'hard' ? MAX_CHANGES : MAX_CHANGES - 1) / SPARKLE_SLOTS;
    case 'breathe':
      if (same) return deep(fx.size * first) ? perCycle(2) : Infinity;
      return measuredRate(fx, n);
    case 'meteor': return deep(first) ? perCycle(2) : Infinity;
    case 'fill': return deep(top) ? perCycle(2) - (soft && !same ? 0.5 : 0) : Infinity;
    case 'yoyo': return deep(first) && fx.size < 1 ? perCycle(4) : Infinity;
  }
}

const probe = dark();

/**
 * The fastest safe rate of an effect whose every segment shows the same brightness
 * over time (perhaps later than the others), measured from one segment over a
 * period of `period` cycles: the shortest stretch that holds 7 changes, less one
 * sample for the timing of the samples.
 */
function measuredRate(fx: CompiledEffect, period: number): number {
  const at = { index: 0, count: 1 };
  const span = Math.round(period * SAMPLES);
  const changes: number[] = [];
  let lo = renderEffect(probe, fx, at, 0).i, hi = lo, dir = 0;
  // One period to settle, then the changes of the next.
  for (let s = 1; s < 2 * span; s++) {
    const v = renderEffect(probe, fx, at, s / SAMPLES).i;
    let changed = false;
    if (dir !== -1 && hi - v >= SWING_DEPTH) {
      dir = -1;
      changed = true;
    } else if (dir !== 1 && v - lo >= SWING_DEPTH) {
      dir = 1;
      changed = true;
    }
    if (changed) {
      lo = hi = v;
      if (s >= span) changes.push(s / SAMPLES);
    }
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const c = changes.length;
  if (c === 0) return Infinity;
  let shortest = Infinity;
  for (let k = 0; k < c; k++) {
    const j = k + MAX_CHANGES;
    shortest = Math.min(shortest, changes[j % c]! + period * Math.floor(j / c) - changes[k]!);
  }
  return Math.max(1 / SAMPLES, shortest - 1 / SAMPLES);
}

// ---- Rendering ----

/** Smoothstep, clamped to 0..1. */
function smooth(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function clamp01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

function frac(v: number): number {
  return v - Math.floor(v);
}

function colourAt(fx: CompiledEffect, k: number): Light {
  const n = fx.colours.length;
  return fx.colours[((k % n) + n) % n]!;
}

/**
 * `a` at weight 1 − t and `b` at weight t, mixed as light.ts's mix() does
 * (intensity linear, colour weighted by intensity), without allocating.
 */
function blend(out: Light, a: Light, b: Light, t: number): Light {
  if (t <= 0) return copy(out, a);
  if (t >= 1) return copy(out, b);
  const wa = 1 - t, wb = t;
  const i = wa * a.i + wb * b.i;
  // When both are dark, the plain weighted colour keeps the colour defined.
  const ea = i > 1e-9 ? wa * a.i : wa, eb = i > 1e-9 ? wb * b.i : wb;
  const r = ea * a.r + eb * b.r, g = ea * a.g + eb * b.g, bl = ea * a.b + eb * b.b;
  const w = ea * a.w + eb * b.w, am = ea * a.a + eb * b.a, u = ea * a.u + eb * b.u;
  const m = Math.max(r, g, bl, w, am, u);
  if (m > 0) {
    out.r = r / m; out.g = g / m; out.b = bl / m; out.w = w / m; out.a = am / m; out.u = u / m;
  } else {
    out.r = 1; out.g = 1; out.b = 1; out.w = 0; out.a = 0; out.u = 0;
  }
  out.i = Math.min(1, i);
  return out;
}

/** `colour` at `level` of its own brightness. */
function lit(out: Light, colour: Light, level: number): Light {
  copy(out, colour);
  out.i = colour.i * level;
  return out;
}

const stepA = dark();
const stepB = dark();

/**
 * One segment's light for an effect at `phase` (in cycles; the engine advances
 * it at safeRate()). The segment's place along the line is
 * x = index / (count − 1), mapped by the direction.
 */
export function renderEffect(out: Light, fx: CompiledEffect, ctx: Pick<LayerContext, 'index' | 'count'>, phase: number): Light {
  const count = ctx.count, index = ctx.index;
  const span = Math.max(1, count - 1);
  const centred = fx.direction === 'centreOut' || fx.direction === 'outsideIn';
  // x = index / span, mapped by the direction; worked out from whole numbers so mirrored segments match exactly.
  let xp: number;
  switch (fx.direction) {
    case 'ltr': xp = index / span; break;
    case 'rtl': xp = (span - index) / span; break;
    case 'centreOut': xp = Math.abs(2 * index - span) / span; break;
    case 'outsideIn': xp = 1 - Math.abs(2 * index - span) / span; break;
  }
  // The distance between neighbouring segments in xp: a segment owns xp ± e/2.
  const e = count > 1 ? (centred ? 2 : 1) / (count - 1) : 1;
  // Waves and chases repeat along the line: a wave is count ÷ waves segments long, so the
  // line's two ends are not always in step.
  const xw = count > 1 ? xp * (count - 1) / count : xp;
  const soft = fx.edge === 'soft';
  const n = fx.colours.length;
  const first = fx.colours[0]!;

  switch (fx.effect) {
    case 'colourFade': {
      const k = Math.floor(phase);
      if (soft) blend(out, colourAt(fx, k), colourAt(fx, k + 1), smooth(phase - k));
      else copy(out, colourAt(fx, k));
      break;
    }
    case 'wave': {
      const v = phase - fx.waves * xw;
      if (n === 1) {
        const level = soft ? 0.5 + 0.5 * Math.cos(2 * Math.PI * v) : frac(v) < fx.size ? 1 : 0;
        lit(out, first, level);
      } else {
        const u = frac(v) * n;
        const j = Math.floor(u);
        if (soft) blend(out, colourAt(fx, j), colourAt(fx, j + 1), smooth(u - j));
        else copy(out, colourAt(fx, j));
      }
      break;
    }
    case 'chase': {
      // The blocks move one segment a step: `steps` steps make one wave length.
      const steps = Math.max(2, Math.round(1 / (fx.waves * (count > 1 ? e * (count - 1) / count : e))));
      // Whole steps long (at least one), so a segment is never on a block's edge.
      const block = Math.min(steps, Math.max(1, Math.round(fx.size * steps)));
      const q = phase * steps;
      const k = Math.floor(q);
      chaseStep(stepA, fx, xw, k, steps, block);
      if (soft) {
        chaseStep(stepB, fx, xw, k + 1, steps, block);
        blend(out, stepA, stepB, smooth(q - k));
      } else copy(out, stepA);
      break;
    }
    case 'sparkle': {
      const q = phase * SPARKLE_SLOTS;
      const s = Math.floor(q);
      sparkleSlot(stepA, fx, index, s);
      if (soft) {
        sparkleSlot(stepB, fx, index, s + 1);
        blend(out, stepA, stepB, smooth(q - s));
      } else copy(out, stepA);
      break;
    }
    case 'breathe': {
      const k = Math.floor(phase);
      const t = phase - k;
      // A cycle starts at the dimmest point; the next colour comes in there.
      const level = 1 - fx.size * (0.5 + 0.5 * Math.cos(2 * Math.PI * t));
      if (soft && t > 0.5) blend(out, colourAt(fx, k), colourAt(fx, k + 1), smooth((t - 0.5) * 2));
      else copy(out, colourAt(fx, k));
      out.i *= level;
      break;
    }
    case 'meteor': {
      const tail = Math.max(fx.size, e);
      // The head's front runs from just before the line to where the tail has left it.
      const head = -e / 2 + frac(phase) * (1 + e + tail);
      const d = head - xp;
      let level: number;
      if (soft) level = smooth(d / e + 0.5) * smooth(1 - d / tail);
      else level = d >= 0 && d <= tail ? 1 - d / tail : 0;
      lit(out, first, level);
      break;
    }
    case 'fill': {
      const k = Math.floor(phase);
      const t = phase - k;
      const filled = t < 0.5 ? t * 2 : 2 - t * 2;
      // The lit part runs from before the first segment to `end`.
      const end = -e / 2 + filled * (1 + e);
      const level = soft ? smooth((end - xp) / e + 0.5) : xp < end ? 1 : 0;
      lit(out, colourAt(fx, k), level);
      break;
    }
    case 'yoyo': {
      const t = frac(phase);
      const there = t < 0.5 ? t * 2 : 2 - t * 2;
      // The block, at least one segment long, travels from one end of the line to the other and back.
      const width = Math.max(fx.size * (1 + e), e);
      const start = -e / 2 + there * Math.max(0, 1 + e - width);
      let level: number;
      if (soft) {
        // How much of the segment's own stretch the block covers.
        const covered = Math.min(xp + e / 2, start + width) - Math.max(xp - e / 2, start);
        level = smooth(covered / e);
      } else level = xp >= start && xp < start + width ? 1 : 0;
      lit(out, first, level);
      break;
    }
  }
  out.i *= fx.intensity;
  return out;
}

/** A chase at one step: lit in its block's colour inside a block, dark between them. */
function chaseStep(out: Light, fx: CompiledEffect, xw: number, step: number, steps: number, block: number): Light {
  // Counted from the start of this cycle, so every cycle steps exactly alike.
  const cycle = Math.floor(step / steps);
  // Half a step's offset keeps segments clear of the block edges.
  const v = (step - cycle * steps + 0.5) / steps - fx.waves * xw;
  const colour = colourAt(fx, cycle + Math.floor(v));
  return lit(out, colour, frac(v) * steps < block ? 1 : 0);
}

/** Sparkle in one slot: a spark (the last colour at full) or the base (the first colour at 40 %). */
function sparkleSlot(out: Light, fx: CompiledEffect, index: number, slot: number): Light {
  if (hash(index, slot) < fx.size) return lit(out, fx.colours[fx.colours.length - 1]!, 1);
  return lit(out, fx.colours[0]!, SPARKLE_BASE);
}

/** A number in 0..1 from a segment and a slot, the same every time. */
function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
