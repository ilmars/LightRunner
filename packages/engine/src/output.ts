// Turning a fixture's abstract light into DMX channel values.

import type { Fixture, Profile, ChannelRole } from '../../shared/src/index.ts';
import { copy, dark, withoutUv, type Light } from './light.ts';

const scratch = dark();

/** The roles that repeat once per segment in a fixture type with several segments. */
const COLOUR_ROLES: readonly ChannelRole[] = ['red', 'green', 'blue', 'white', 'amber', 'uv'];

interface PlannedChannel {
  role: ChannelRole;
  /**
   * The segment this channel belongs to, 0-based. −1 for a fixture-wide channel:
   * dimmer, strobe, cct and the others, and a colour that appears only once in a
   * fixture type with several segments.
   */
  cell: number;
  /** Offset of this channel inside the universe (0-based). */
  at: number;
  /** Offset of the fine byte, or -1 for 8-bit. */
  fineAt: number;
  fixed: number;
  kelvin: { min: number; max: number } | null;
}

export interface ChannelPlan {
  universe: number;
  channels: PlannedChannel[];
  hasDimmer: boolean;
  hasWhite: boolean;
  hasAmber: boolean;
  hasUv: boolean;
  /** Has a channel that makes visible colour (red, green, blue, white or amber). */
  hasColour: boolean;
  /** Number of segments: the most times any colour role repeats, at least 1. */
  cells: number;
  gamma: number;
}

export function planChannels(fixture: Fixture, profile: Profile, defaultGamma: number): ChannelPlan {
  const channels: PlannedChannel[] = [];
  const base = fixture.address - 1;
  profile.channels.forEach((ch, n) => {
    if (ch.fine) {
      // Attach to the closest earlier coarse channel of the same role.
      for (let k = channels.length - 1; k >= 0; k--) {
        if (channels[k].role === ch.role && channels[k].fineAt < 0) {
          channels[k].fineAt = base + n;
          return;
        }
      }
      return;
    }
    channels.push({ role: ch.role, at: base + n, fineAt: -1, cell: -1, fixed: ch.default ?? 0, kelvin: ch.kelvin ?? null });
  });
  // The n-th red (green, blue ...) belongs to segment n.
  const seen = new Map<ChannelRole, number>();
  for (const c of channels) {
    if (!COLOUR_ROLES.includes(c.role)) continue;
    const k = seen.get(c.role) ?? 0;
    c.cell = k;
    seen.set(c.role, k + 1);
  }
  const cells = Math.max(1, ...seen.values());
  // In a fixture type with several segments, a colour that appears once is fixture-wide.
  if (cells > 1) for (const c of channels) if (seen.get(c.role) === 1) c.cell = -1;
  const has = (role: ChannelRole) => channels.some((c) => c.role === role);
  return {
    universe: fixture.universe,
    channels: channels.filter((c) => c.at < 512),
    hasDimmer: has('dimmer'),
    hasWhite: has('white'),
    hasAmber: has('amber'),
    hasUv: has('uv'),
    hasColour: (['red', 'green', 'blue', 'white', 'amber'] as const).some(has),
    cells,
    gamma: fixture.gamma ?? profile.gamma ?? defaultGamma,
  };
}

/** Amber is about #FFBF00: full red and three quarters green. */
const AMBER_GREEN = 0xbf / 255;
/** How the visualiser shows UV: a faint violet. */
const UV_RED = 0.25;
const UV_BLUE = 0.4;

function put(buf: Uint8Array, ch: PlannedChannel, v: number): void {
  const x = Math.min(1, Math.max(0, v));
  if (ch.fineAt >= 0) {
    const v16 = Math.round(x * 65535);
    buf[ch.at] = v16 >> 8;
    if (ch.fineAt < 512) buf[ch.fineAt] = v16 & 255;
  } else {
    buf[ch.at] = Math.round(x * 255);
  }
}

/** Reused by writeFixture and writeCells so writing a frame allocates nothing. */
const sameLights: Light[] = [];
const uvFree: Light[] = [];
const usable: Light[] = [];

/**
 * Write one fixture into its universe buffer, every segment the same light.
 * See writeCells.
 */
export function writeFixture(buf: Uint8Array, plan: ChannelPlan, light: Light): void {
  sameLights.length = 0;
  for (let k = 0; k < plan.cells; k++) sameLights.push(light);
  writeCells(buf, plan, sameLights);
}

/**
 * Write one fixture into its universe buffer, one light per segment. Gamma is
 * applied per channel so slow fades look even at the dark end. Fixtures with a
 * dimmer channel get the brightest segment's intensity on the dimmer, and each
 * segment's colour scaled by its share of that; others get colour and
 * intensity multiplied together on each segment's colour channels. A
 * fixture-wide colour channel (and colour temperature) follows the brightest segment.
 */
export function writeCells(buf: Uint8Array, plan: ChannelPlan, lights: readonly Light[]): void {
  // The engine has already taken UV out for fixtures that can't make it; this keeps a direct call right too.
  const cells = plan.hasUv ? lights : withoutUvAll(lights);
  let top = 0, brightest = 0;
  for (let k = 0; k < cells.length; k++) {
    if (cells[k].i > top) {
      top = cells[k].i;
      brightest = k;
    }
  }
  // Fully dark writes zeros everywhere, so Blackout looks like Blackout on any desk monitor.
  if (top <= 0) {
    for (const ch of plan.channels) {
      const fixed = ch.role === 'strobe' || ch.role === 'other';
      buf[ch.at] = fixed ? ch.fixed : 0;
      if (ch.fineAt >= 0 && ch.fineAt < 512) buf[ch.fineAt] = 0;
    }
    return;
  }
  const g = plan.gamma;
  for (const ch of plan.channels) {
    const light = ch.cell >= 0 && ch.cell < cells.length ? cells[ch.cell] : cells[brightest];
    // A fixture without a white channel makes white from red, green and blue;
    // one without an amber channel makes amber from red and green.
    const fold = plan.hasWhite ? 0 : light.w;
    const amber = plan.hasAmber ? 0 : light.a;
    // With a dimmer at the brightest segment's intensity, the colour carries the rest.
    const level = plan.hasDimmer ? light.i / top : light.i;
    switch (ch.role) {
      case 'dimmer': put(buf, ch, Math.pow(top, g)); break;
      case 'red': put(buf, ch, Math.pow(Math.min(1, light.r + fold + amber) * level, g)); break;
      case 'green': put(buf, ch, Math.pow(Math.min(1, light.g + fold + amber * AMBER_GREEN) * level, g)); break;
      case 'blue': put(buf, ch, Math.pow(Math.min(1, light.b + fold) * level, g)); break;
      case 'white': put(buf, ch, Math.pow(light.w * level, g)); break;
      case 'amber': put(buf, ch, Math.pow(light.a * level, g)); break;
      case 'uv': put(buf, ch, Math.pow(light.u * level, g)); break;
      case 'cct': {
        const k = ch.kelvin ?? { min: 2700, max: 6500 };
        put(buf, ch, (kelvinOf(light) - k.min) / (k.max - k.min));
        break;
      }
      default: buf[ch.at] = ch.fixed;
    }
  }
}

/** The lights as a fixture without UV shows them, copying only the ones that have UV. */
function withoutUvAll(lights: readonly Light[]): readonly Light[] {
  let any = false;
  for (const l of lights) if (l.u > 0) any = true;
  if (!any) return lights;
  usable.length = 0;
  for (let k = 0; k < lights.length; k++) {
    const l = lights[k];
    if (l.u <= 0) {
      usable.push(l);
      continue;
    }
    if (!uvFree[k]) uvFree[k] = dark();
    usable.push(withoutUv(copy(uvFree[k], l)));
  }
  return usable;
}

/**
 * How bright a fixture looks, 0..1: its brightest colour channel as written
 * (before gamma, with white and amber folded in where there is no channel for
 * them) times its intensity. A fixture with only a dimmer (or dimmer and
 * colour temperature) looks as bright as its dimmer. The jump check judges this.
 */
export function visibleLevel(plan: ChannelPlan, light: Light): number {
  if (!plan.hasUv && light.u > 0) light = withoutUv(copy(scratch, light));
  if (light.i <= 0) return 0;
  if (!plan.hasColour && !plan.hasUv) return light.i;
  const fold = plan.hasWhite ? 0 : light.w;
  const amber = plan.hasAmber ? 0 : light.a;
  let top = 0;
  for (const ch of plan.channels) {
    switch (ch.role) {
      case 'red': top = Math.max(top, light.r + fold + amber); break;
      case 'green': top = Math.max(top, light.g + fold + amber * AMBER_GREEN); break;
      case 'blue': top = Math.max(top, light.b + fold); break;
      case 'white': top = Math.max(top, light.w); break;
      case 'amber': top = Math.max(top, light.a); break;
      case 'uv': top = Math.max(top, light.u); break;
    }
  }
  return Math.min(1, top) * light.i;
}

/** True when a fixture type with several segments has a colour channel shared by all of them (it follows the brightest segment). */
export function hasWideColour(plan: ChannelPlan): boolean {
  return plan.cells > 1 && plan.channels.some((c) => c.cell < 0 && COLOUR_ROLES.includes(c.role));
}

/**
 * How bright each segment of a fixture looks, written to `out[at..]`: as
 * visibleLevel(), but a fixture-wide colour channel shows the brightest
 * segment's light, as writeCells writes it, and counts for every segment.
 */
export function visibleCells(plan: ChannelPlan, lights: readonly Light[], out: number[], at: number): void {
  const cells = plan.hasUv ? lights : withoutUvAll(lights);
  if (!plan.hasColour && !plan.hasUv) {
    for (let k = 0; k < cells.length; k++) out[at + k] = Math.max(0, cells[k].i);
    return;
  }
  let top = 0, brightest = 0;
  for (let k = 0; k < cells.length; k++) {
    if (cells[k].i > top) {
      top = cells[k].i;
      brightest = k;
    }
  }
  // What the fixture-wide colour channels show, for every segment.
  let wide = 0;
  for (const ch of plan.channels) {
    if (ch.cell < 0 || ch.cell >= cells.length) wide = Math.max(wide, channelLevel(plan, ch.role, cells[brightest]));
  }
  for (let k = 0; k < cells.length; k++) {
    let level = wide;
    for (const ch of plan.channels) {
      if (ch.cell === k) level = Math.max(level, channelLevel(plan, ch.role, cells[k]));
    }
    out[at + k] = level;
  }
}

/** How bright one colour channel looks for a light (0 for channels that make no colour). */
function channelLevel(plan: ChannelPlan, role: ChannelRole, light: Light): number {
  if (light.i <= 0) return 0;
  const fold = plan.hasWhite ? 0 : light.w;
  const amber = plan.hasAmber ? 0 : light.a;
  let v: number;
  switch (role) {
    case 'red': v = light.r + fold + amber; break;
    case 'green': v = light.g + fold + amber * AMBER_GREEN; break;
    case 'blue': v = light.b + fold; break;
    case 'white': v = light.w; break;
    case 'amber': v = light.a; break;
    case 'uv': v = light.u; break;
    default: return 0;
  }
  return Math.min(1, v) * light.i;
}

/**
 * The colour the visualiser shows for a light, as RGB bytes at `out[at..at+2]`:
 * white adds to all three, amber to red and green, UV a faint violet.
 */
export function visualOf(light: Light, out: Uint8Array, at: number): void {
  const byte = (c: number) => Math.round(Math.min(1, c) * light.i * 255);
  out[at] = byte(light.r + light.w + light.a + UV_RED * light.u);
  out[at + 1] = byte(light.g + light.w + AMBER_GREEN * light.a);
  out[at + 2] = byte(light.b + light.w + UV_BLUE * light.u);
}

/**
 * Write a smoke or haze machine: only its output level, linear (no gamma), on
 * its dimmer channel, or on its one channel when the profile has a single
 * channel of another role. Every other channel keeps its fixed value (fan,
 * mode, ...), and colour channels stay at 0.
 */
export function writeSmoke(buf: Uint8Array, plan: ChannelPlan, level: number): void {
  const single = plan.channels.length === 1;
  for (const ch of plan.channels) {
    if (ch.role === 'dimmer' || single) put(buf, ch, level);
    else {
      buf[ch.at] = ch.fixed;
      if (ch.fineAt >= 0 && ch.fineAt < 512) buf[ch.fineAt] = 0;
    }
  }
}

/** Blue-to-red ratio of typical white sources at a given colour temperature. */
const KELVIN_BY_RATIO: [number, number][] = [
  [0.2, 2000], [0.34, 2700], [0.45, 3200], [0.64, 4000], [0.87, 5600], [1.0, 6500], [1.27, 10000],
];

/**
 * Colour temperature for a fixture that only has a CCT channel (no RGB):
 * warm colours give warm white, blue colours give cool white, and amber makes
 * it warmer. UV is left out.
 */
export function kelvinOf(light: Light): number {
  const r = Math.min(1, light.r + light.w) + light.a;
  const b = Math.min(1, light.b + light.w);
  if (r <= 0) return KELVIN_BY_RATIO[KELVIN_BY_RATIO.length - 1][1];
  const ratio = b / r;
  if (ratio <= KELVIN_BY_RATIO[0][0]) return KELVIN_BY_RATIO[0][1];
  for (let k = 1; k < KELVIN_BY_RATIO.length; k++) {
    const [r1, k1] = KELVIN_BY_RATIO[k];
    if (ratio <= r1) {
      const [r0, k0] = KELVIN_BY_RATIO[k - 1];
      return k0 + ((ratio - r0) / (r1 - r0)) * (k1 - k0);
    }
  }
  return KELVIN_BY_RATIO[KELVIN_BY_RATIO.length - 1][1];
}
