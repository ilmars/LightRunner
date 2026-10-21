// What a button, fader or OSC message can ask for, worked out against the show's layout and the live stage.
// The APC mini, OSC and Companion all use this, so every device means the same thing by "Next" or "group 2".

import type { Command } from './protocol.ts';

/** The part of the operator layout the device actions need. */
export interface DeviceLayout {
  runningOrder: { id: string }[];
  basicLights: string | null;
  /** The quick looks, for a key that starts one by id. */
  quickLooks?: { id: string }[];
  groups?: { id: string; kind?: string; presets: { id: string; effect?: unknown }[] }[];
}

/** The part of the live state the device actions need. */
export interface DeviceState {
  look: string | null;
  lastLook: string | null;
  /** Master, 0 to 1 (only Master up and down read it; 1 when missing). */
  master?: number;
  /** The stage tempo (only the tempo steps read it; 120 when missing). */
  tempo?: number;
}

/**
 * Positions count from 1 (what a person reads on a pad or a button): `n` is the item in the running order,
 * `group` the group among the light groups (smoke is left out), `colour` the colour in that group's list
 * (effects are not in it). A group can also be named by its id (a controller key does: it follows the group),
 * and songs and quick looks by their look id.
 */
export type DeviceAction =
  | { kind: 'item'; n: number }
  | { kind: 'next' }
  | { kind: 'backToLook' }
  | { kind: 'undo' }
  | { kind: 'basic' }
  | { kind: 'blackout' }
  | { kind: 'groupLevel'; group: number | string; value: number }
  | { kind: 'groupColour'; group: number; colour: number }
  | { kind: 'flash'; group: number | string | 'all'; on: boolean }
  | { kind: 'master'; value: number }
  | { kind: 'masterStep'; by: number }
  /** A running-order item (Basic lights too) by its look id. */
  | { kind: 'song'; id: string }
  | { kind: 'quickLook'; id: string }
  /** null is Auto: each look's own fade. */
  | { kind: 'fadeTime'; value: number | null }
  | { kind: 'tempo'; bpm: number }
  /** Tempo ×2 or ÷2. */
  | { kind: 'tempoStep'; times: number }
  /** Tap tempo: the server counts the taps of each device (App.device). */
  | { kind: 'tap' };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** The tempo limits of the `tempo` command; the page rounds to whole beats a minute too. */
const clampBpm = (v: number) => Math.min(240, Math.max(40, Math.round(v)));

/** The groups a device can reach: the light groups, in the operator page's order. */
export function lightGroups<G extends { kind?: string }>(layout: { groups?: G[] }): G[] {
  return (layout.groups ?? []).filter((g) => g.kind !== 'smoke');
}

/** A group's colours as a device counts them: its presets, effects left out. */
export function colourList<P extends { effect?: unknown }>(group: { presets: P[] }): P[] {
  return group.presets.filter((p) => !p.effect);
}

/** Index in the running order of what is on stage, or -1 (Blackout, nothing yet, or a look that isn't in the order). */
export function stageIndexOf(layout: Pick<DeviceLayout, 'runningOrder' | 'basicLights'>, state: Pick<DeviceState, 'look'>): number {
  if (state.look === null) return -1;
  if (state.look === 'safe') return layout.runningOrder.findIndex((i) => i.id === layout.basicLights);
  return layout.runningOrder.findIndex((i) => i.id === state.look);
}

/**
 * The item after the one on stage; after the item before Blackout (or a look outside the order) when nothing
 * in the order is on stage; the first song when there is neither. Null at the end of the list.
 */
export function nextItemId(layout: Pick<DeviceLayout, 'runningOrder' | 'basicLights'>, state: Pick<DeviceState, 'look' | 'lastLook'>): string | null {
  const order = layout.runningOrder;
  if (!order.length) return null;
  let k = stageIndexOf(layout, state);
  if (k < 0 && state.lastLook) k = order.findIndex((i) => i.id === state.lastLook);
  if (k < 0) return order.find((i) => i.id !== layout.basicLights)?.id ?? null;
  return order[k + 1]?.id ?? null;
}

/** The command that starts a running-order item: Basic lights is the engine's own Safe, the rest are looks. */
export function startCommand(layout: Pick<DeviceLayout, 'basicLights'>, id: string): Command {
  return id === layout.basicLights ? { type: 'safe' } : { type: 'look', id };
}

/** The command for a device action, or a plain-words reason it can't be done. */
export function commandFor(action: DeviceAction, layout: DeviceLayout, state: DeviceState): Command | { error: string } {
  const group = (n: number | string) => {
    if (typeof n === 'string') return lightGroups(layout).find((g) => g.id === n) ?? { error: 'That group is no longer in the show.' };
    const g = Number.isInteger(n) && n >= 1 ? lightGroups(layout)[n - 1] : undefined;
    return g ?? { error: `There is no group ${n}.` };
  };
  switch (action.kind) {
    case 'item': {
      const item = Number.isInteger(action.n) && action.n >= 1 ? layout.runningOrder[action.n - 1] : undefined;
      return item ? startCommand(layout, item.id) : { error: `There is no song ${action.n}.` };
    }
    case 'next': {
      const id = nextItemId(layout, state);
      return id ? startCommand(layout, id) : { error: 'End of the list.' };
    }
    case 'backToLook': return { type: 'backToLook' };
    case 'undo': return { type: 'undo' };
    case 'basic': return { type: 'safe' };
    // The same command the iPad's Blackout sends (after its 1 s hold). It does not toggle: the lights come back
    // with any look, Basic lights or Next.
    case 'blackout': return { type: 'blackout' };
    case 'groupLevel': {
      const g = group(action.group);
      return 'error' in g ? g : { type: 'groupLevel', group: g.id, value: clamp01(action.value) };
    }
    case 'groupColour': {
      const g = group(action.group);
      if ('error' in g) return g;
      const colour = Number.isInteger(action.colour) && action.colour >= 1 ? colourList(g)[action.colour - 1] : undefined;
      return colour ? { type: 'groupPreset', group: g.id, preset: colour.id } : { error: `Group ${action.group} has no colour ${action.colour}.` };
    }
    case 'flash': {
      if (action.group === 'all') return { type: 'flash', groups: lightGroups(layout).map((g) => g.id), on: action.on };
      const g = group(action.group);
      return 'error' in g ? g : { type: 'flash', groups: [g.id], on: action.on };
    }
    case 'master': return { type: 'master', value: clamp01(action.value) };
    case 'masterStep': return { type: 'master', value: clamp01(Math.round(((state.master ?? 1) + action.by) * 1000) / 1000) };
    case 'song':
      return layout.runningOrder.some((i) => i.id === action.id) ? startCommand(layout, action.id) : { error: 'That song is no longer in the running order.' };
    case 'quickLook':
      return layout.quickLooks?.some((q) => q.id === action.id) ? { type: 'quickLook', id: action.id } : { error: 'That quick look is no longer there.' };
    case 'fadeTime': return { type: 'fadeTime', value: action.value };
    case 'tempo': return { type: 'tempo', bpm: clampBpm(action.bpm) };
    case 'tempoStep': return { type: 'tempo', bpm: clampBpm((state.tempo ?? 120) * action.times) };
    case 'tap': return { error: 'Tap is counted by the server.' };
  }
}
