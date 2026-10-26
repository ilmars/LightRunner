// What a timeline puts on the stage at any moment, worked out from its blocks alone, so playing,
// seeking and replaying give the same result. Pure: no clock, no I/O. The server's runner (server/src)
// turns the changes between two moments into commands.
//
// The audio maths (loudness, waveform, base64 bytes) are in web/shared/loudness.js, because the Timeline
// page, which has no build step, needs the same code. This file only reads what that stored.

import type { EffectSpeed, Recording, Show, Timeline, TimelineBlock, TimelineLayer } from './schema.ts';

/** What one group should be showing: the block in force, and what it asks for. Missing parts keep what the group has. */
export interface GroupTarget {
  /** The block's id: two moments with the same block are the same target. */
  block: string;
  /** A colour of the group to go to (missing: keep the colour it has). */
  preset?: string;
  /** Group level, 0..1. */
  level?: number;
  effect?: { preset: string; speed?: EffectSpeed };
  /** The level rides the recording's loudness between low and high. */
  follow?: { low: number; high: number };
  /** Seconds to fade in. */
  rise: number;
  /** When the block started (seconds into the timeline). */
  started: number;
}

/** The layer that holds Whole stage blocks. */
export const STAGE = 'stage';

/** What a block asks of one group, or undefined when it can't be done (something it points to is gone, or it isn't for this layer). */
function targetFor(block: TimelineBlock, group: string, onStage: boolean, show: Show): Omit<GroupTarget, 'block' | 'rise' | 'started'> | undefined {
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
      return { preset: entry.preset, level: entry.level ?? 1 };
    }
    case 'colour': return onStage || !preset(what.preset) ? undefined : { preset: what.preset, level: what.level };
    case 'level': return onStage ? undefined : { level: what.level };
    case 'effect': {
      if (onStage || !preset(what.preset)) return undefined;
      return { effect: { preset: what.preset, ...(what.speed ? { speed: what.speed } : {}) } };
    }
    case 'follow': {
      if (onStage || (what.preset !== undefined && !preset(what.preset))) return undefined;
      return { ...(what.preset !== undefined ? { preset: what.preset } : {}), follow: { low: what.low, high: what.high } };
    }
  }
}

/**
 * The block in force on one layer at t, for one group: the latest block that has started and whose end
 * hasn't passed (a block that has ended hands the layer back to the one before it), skipping blocks that
 * can't be done. Later blocks win over earlier ones that start at the same moment.
 */
function inForce(layer: TimelineLayer, group: string, t: number, show: Show): { block: TimelineBlock; target: NonNullable<ReturnType<typeof targetFor>> } | undefined {
  let best: { block: TimelineBlock; target: NonNullable<ReturnType<typeof targetFor>> } | undefined;
  for (const block of layer.blocks) {
    if (block.start > t) continue;
    if (block.end !== undefined && block.end <= t) continue;
    if (best && block.start < best.block.start) continue;
    const target = targetFor(block, group, layer.group === STAGE, show);
    if (target) best = { block, target };
  }
  return best;
}

/** For every light group, the block in force at time t (seconds). Groups with nothing in force are left out. */
export function stateAt(timeline: Timeline, show: Show, t: number): Map<string, GroupTarget> {
  const out = new Map<string, GroupTarget>();
  const stage = timeline.layers.filter((l) => l.group === STAGE);
  for (const group of show.groups) {
    if (group.kind === 'smoke') continue;
    const own = timeline.layers.filter((l) => l.group === group.id && l.group !== STAGE);
    // The most recently started block wins; at the same start the group's own layer beats the stage.
    let winner: ReturnType<typeof inForce>;
    for (const layers of [stage, own]) {
      for (const layer of layers) {
        const found = inForce(layer, group.id, t, show);
        if (found && (!winner || found.block.start >= winner.block.start)) winner = found;
      }
    }
    if (!winner) continue;
    out.set(group.id, { block: winner.block.id, ...winner.target, rise: winner.block.rise, started: winner.block.start });
  }
  return out;
}

/** What to do going from one moment's state to the next: every group whose block changed (target) or that no longer has one (null). */
export function changesBetween(prev: Map<string, GroupTarget>, next: Map<string, GroupTarget>): { group: string; target: GroupTarget | null }[] {
  const out: { group: string; target: GroupTarget | null }[] = [];
  for (const [group, target] of next) if (prev.get(group)?.block !== target.block) out.push({ group, target });
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
