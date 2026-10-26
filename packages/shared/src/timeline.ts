// What a timeline puts on the stage at any moment, worked out from its blocks alone, so playing,
// seeking and replaying give the same result. Pure: no clock, no I/O. The server's runner (server/src)
// turns the changes between two moments into commands.
//
// The audio maths (loudness, waveform, base64 bytes) are in web/shared/loudness.js, because the Timeline
// page, which has no build step, needs the same code. This file only reads what that stored.

import { STAGE_LAYER, isEffectPreset, type EffectSpeed, type Recording, type Show, type Timeline, type TimelineBlock } from './schema.ts';

/**
 * What one group should be showing at a moment, with everything the blocks so far have laid on it worked out
 * (so a seek, Start in the middle and playing through give the same). Missing parts keep what the group has.
 */
export interface GroupTarget {
  /** The id of the latest block in force: what tells one target from the next. */
  block: string;
  /** A colour of the group (a plain colour preset); missing = the group keeps its own. */
  preset?: string;
  /** An effect of the group (and its own speed); it replaces the colour. */
  effect?: { preset: string; speed?: EffectSpeed };
  /** Group level, 0..1. */
  level: number;
  /** The level rides the recording's loudness between low and high (low is never above high). */
  follow?: { low: number; high: number };
  /** Seconds to fade in, from the latest block. */
  rise: number;
  /** When the latest block started (seconds into the timeline). */
  started: number;
  /**
   * Set when the group has fallen back because a block with an end has passed: the rise of that block,
   * which is how long the way back should take.
   */
  handedBack?: { rise: number };
}

/** What a block changes in a group's state. Missing parts are left as they are. */
interface Step {
  /** A colour preset (or, if it runs an effect, an effect) of the group. */
  colour?: string;
  effect?: { preset: string; speed?: EffectSpeed };
  level?: number;
  follow?: { low: number; high: number };
}

/** What a block does to one group, or undefined when it can't (something it points to is gone, or it isn't for this layer). */
function stepFor(block: TimelineBlock, group: string, onStage: boolean, show: Show): Step | undefined {
  const what = block.what;
  const preset = (id: string) => {
    const p = show.presets.find((x) => x.id === id);
    return p && p.group === group ? p : undefined;
  };
  switch (what.kind) {
    case 'dark': return { level: 0 };
    case 'full': return { level: 1 };
    case 'look': {
      const entry = show.looks.find((l) => l.id === what.look)?.groups.find((e) => e.group === group);
      if (!entry || !preset(entry.preset)) return undefined;
      return { colour: entry.preset, level: entry.level ?? 1 };
    }
    case 'colour': return onStage || !preset(what.preset) ? undefined : { colour: what.preset, level: what.level };
    case 'level': return onStage ? undefined : { level: what.level };
    case 'effect': return onStage || !preset(what.preset) ? undefined : { effect: { preset: what.preset, ...(what.speed ? { speed: what.speed } : {}) } };
    case 'follow': {
      if (onStage || (what.preset !== undefined && !preset(what.preset))) return undefined;
      return { ...(what.preset !== undefined ? { colour: what.preset } : {}), follow: { low: Math.min(what.low, what.high), high: Math.max(what.low, what.high) } };
    }
  }
}

interface Laid { block: TimelineBlock; step: Step }

/**
 * For every light group, the state at time t (seconds): the blocks on the group's own layer and on the Whole
 * stage layer that have started and not ended, laid on top of each other in the order they started (the group's
 * own layer after the stage's at the same moment):
 * - a colour sets the colour and level (and drops an effect), an effect sets the effect (and drops the colour);
 * - a level, Dark (0) and Everything full (1) set the level and keep the colour;
 * - a look sets what it holds for the group (its colour or effect, and level);
 * - Follow the voice rides the level, and ends when its block ends or another block sets the level.
 * A block with an end that has passed is no longer laid down, so the group falls back to what the blocks before it
 * gave (`handedBack` says how long the way back takes). Blocks that point at something gone are skipped.
 * Groups with no block in force have no target. Smoke groups never do.
 */
export function stateAt(timeline: Timeline, show: Show, t: number): Map<string, GroupTarget> {
  const out = new Map<string, GroupTarget>();
  for (const group of show.groups) {
    if (group.kind === 'smoke') continue;
    const laid: Laid[] = [];
    // The stage layers come first, so at the same start the group's own layer is laid on top.
    for (const onStage of [true, false]) {
      for (const layer of timeline.layers) {
        if ((layer.group === STAGE_LAYER) !== onStage || (!onStage && layer.group !== group.id)) continue;
        for (const block of layer.blocks) {
          if (block.start > t) continue;
          const step = stepFor(block, group.id, onStage, show);
          if (step) laid.push({ block, step });
        }
      }
    }
    // Array.prototype.sort is stable, so equal starts keep the order above.
    laid.sort((x, y) => x.block.start - y.block.start);
    const inForce = laid.filter((l) => l.block.end === undefined || l.block.end > t);
    const latest = inForce.at(-1);
    if (!latest) continue;

    let preset: string | undefined, effect: GroupTarget['effect'], follow: GroupTarget['follow'];
    let level = 1;
    for (const { step } of inForce) {
      if (step.colour !== undefined) {
        const p = show.presets.find((x) => x.id === step.colour)!;
        if (isEffectPreset(p)) { effect = { preset: p.id }; preset = undefined; } else { preset = p.id; effect = undefined; }
      }
      if (step.effect) { effect = step.effect; preset = undefined; }
      if (step.level !== undefined) { level = step.level; follow = undefined; }
      if (step.follow) follow = step.follow;
    }
    // Handed back: a block that started after the latest one in force has ended since, so the group has fallen back.
    let ended: Laid | undefined;
    for (const l of laid.slice(laid.indexOf(latest) + 1)) {
      if (l.block.end !== undefined && l.block.end <= t && (!ended || l.block.end >= ended.block.end!)) ended = l;
    }
    out.set(group.id, {
      block: latest.block.id,
      ...(preset !== undefined ? { preset } : {}),
      ...(effect ? { effect } : {}),
      level,
      ...(follow ? { follow } : {}),
      rise: latest.block.rise,
      started: latest.block.start,
      ...(ended ? { handedBack: { rise: ended.block.rise } } : {}),
    });
  }
  return out;
}

/** The same value, whatever order an object's keys are in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const kx = Object.keys(x).filter((k) => x[k] !== undefined), ky = Object.keys(y).filter((k) => y[k] !== undefined);
  return kx.length === ky.length && kx.every((k) => same(x[k], y[k]));
}

/**
 * What to do going from one moment's state to the next: every group whose target is not the same
 * (so an edited block, or a seek to another place, is noticed) gets its target, and a group that no longer has one gets null.
 */
export function changesBetween(prev: Map<string, GroupTarget>, next: Map<string, GroupTarget>): { group: string; target: GroupTarget | null }[] {
  const out: { group: string; target: GroupTarget | null }[] = [];
  for (const [group, target] of next) if (!same(prev.get(group), target)) out.push({ group, target });
  for (const group of prev.keys()) if (!next.has(group)) out.push({ group, target: null });
  return out;
}

// ---- The loudness track ----

let lastText = '';
let lastBytes = new Uint8Array(0);
/** The bytes of a base64 string (the same as decodeBytes in web/shared/loudness.js); the last one asked for is kept. */
function bytesOf(text: string): Uint8Array {
  if (text === lastText) return lastBytes;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  lastText = text;
  lastBytes = bytes;
  return bytes;
}

/** How loud the recording is at t seconds, 0..1, in a straight line between the 25-a-second values; the first and last value hold outside it. */
export function followAt(recording: Recording, t: number): number {
  const bytes = bytesOf(recording.loudness);
  if (!bytes.length) return 0;
  const x = Math.min(bytes.length - 1, Math.max(0, t * 25));
  const i = Math.floor(x);
  const a = bytes[i]!, b = bytes[Math.min(bytes.length - 1, i + 1)]!;
  return (a + (b - a) * (x - i)) / 255;
}

// ---- Keeping in step with the page ----

/**
 * The server's clock, eased towards the position the page reports: within 0.1 s it takes 20 % of the
 * difference, up to 0.3 s half of it, and beyond that it jumps there (`jumped`).
 */
export function mergeClock(serverPos: number, reportedPos: number): { pos: number; jumped: boolean } {
  const diff = reportedPos - serverPos;
  const size = Math.abs(diff);
  if (size > 0.3) return { pos: reportedPos, jumped: true };
  return { pos: serverPos + diff * (size <= 0.1 ? 0.2 : 0.5), jumped: false };
}
