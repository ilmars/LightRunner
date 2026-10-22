// Controller keys: which key on a MIDI controller does what, kept in the show (operator.controller).
// One key does one thing and one thing has one key. Keys name songs, quick looks and groups by id, so
// they follow the thing: a song that moves keeps its key, one that is deleted frees it (pruneKeys).

import type { ControlKey, ControllerSettings, KeyBinding, KeyTarget, Show } from './schema.ts';

/** The fade times the fade knob sweeps, from fully left: Auto (each look's own), Instant, then seconds. */
export const FADE_STEPS: readonly (number | null)[] = [null, 0, 1, 2, 3, 5, 10];

/** The fade time at a knob position 0 to 1. */
export function fadeStepAt(position: number): number | null {
  const k = Math.round(Math.min(1, Math.max(0, position)) * (FADE_STEPS.length - 1));
  return FADE_STEPS[k]!;
}

/** Where a fade time sits on the knob: its step, or the nearest one for a time the knob doesn't have. */
export function fadeStepIndex(value: number | null): number {
  if (value === null) return 0;
  let best = 1;
  for (let k = 1; k < FADE_STEPS.length; k++) {
    if (Math.abs(FADE_STEPS[k]! - value) < Math.abs(FADE_STEPS[best]! - value)) best = k;
  }
  return best;
}

/** "APC mini" or "APC MINI", alone or with "mk2", but not the APC40 or the APC Key 25. */
const APC_MINI = /\bapc\s*mini\b/i;

/** True for an Akai APC mini (either model), by its port or device name. */
export function isApcMini(name: string): boolean {
  return APC_MINI.test(name);
}

/**
 * The name a device is known by, from its MIDI port's name, so it is the same after a re-plug: without
 * the number Windows puts in front of a second one ("2- nanoKONTROL2") or the client and port numbers
 * Linux puts after it ("… 20:0").
 */
export function deviceName(port: string): string {
  return port.trim().replace(/^\d+-\s*/, '').replace(/\s+\d+:\d+$/, '').replace(/\s+/g, ' ').trim() || port;
}

/** Faders and knobs only: these follow a position, not a press. */
export function isLevelTarget(does: KeyTarget): boolean {
  return does.kind === 'master' || does.kind === 'groupLevel' || does.kind === 'fadeKnob';
}

/**
 * Keys an operator may give or take (songs and quick looks, where they are edited on the operator page); every
 * other key, and Reset, is the programmer's (Settings). These are Undo steps; the programmer's are not.
 */
export function isOperatorKeyTarget(does: KeyTarget): boolean {
  return does.kind === 'song' || does.kind === 'quickLook';
}

/**
 * The show an Undo goes back to, with the controller settings that aren't Undo steps as they are now: the
 * programmer's keys and the switches. Its own song and quick-look keys stay, unless a key of the programmer's uses the same key.
 * A song or quick-look key the programmer has moved onto a fixed job's key since (no Undo step either) stays as it is now.
 */
export function keepControllerKeys(restored: Show, current: Show): Show {
  const cur = current.operator.controller;
  const had = restored.operator.controller;
  if (!cur && !had) return restored;
  const fixed = (cur?.keys ?? []).filter((b) => !isOperatorKeyTarget(b.does));
  const wasFixed = (had?.keys ?? []).filter((b) => !isOperatorKeyTarget(b.does));
  const moved = (cur?.keys ?? []).filter((b) => isOperatorKeyTarget(b.does) && wasFixed.some((f) => sameKey(f.key, b.key)) && !keyTargetProblem(restored, b.does));
  const own = (had?.keys ?? []).filter((b) => isOperatorKeyTarget(b.does) && ![...fixed, ...moved].some((f) => sameKey(f.key, b.key) || sameTarget(f.does, b.does)));
  const out = structuredClone(restored);
  const controller: ControllerSettings = { keys: structuredClone([...fixed, ...moved, ...own]) };
  if (cur?.apcLayout !== undefined) controller.apcLayout = cur.apcLayout;
  if (cur?.ignored) controller.ignored = [...cur.ignored];
  out.operator.controller = controller;
  return out;
}

/** The same key: device, note or control change, channel and number. */
export function sameKey(a: ControlKey, b: ControlKey): boolean {
  return a.device === b.device && a.type === b.type && a.channel === b.channel && a.number === b.number;
}

/** The same job. */
export function sameTarget(a: KeyTarget, b: KeyTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The show's controller settings with the defaults filled in. */
export function controllerOf(show: Show): { keys: KeyBinding[]; apcLayout: boolean; ignored: string[] } {
  const c = show.operator.controller;
  return { keys: c?.keys ?? [], apcLayout: c?.apcLayout ?? true, ignored: c?.ignored ?? [] };
}

/** The key that does this, or null. */
export function keyOf(show: Show, does: KeyTarget): ControlKey | null {
  return show.operator.controller?.keys.find((b) => sameTarget(b.does, does))?.key ?? null;
}

/** What this key does now, or null. */
export function bindingOf(show: Show, key: ControlKey): KeyBinding | null {
  return show.operator.controller?.keys.find((b) => sameKey(b.key, key)) ?? null;
}

const lookName = (show: Show, id: string) => show.looks.find((l) => l.id === id)?.name;
const groupName = (show: Show, id: string) => show.groups.find((g) => g.id === id)?.name ?? id;

/** What a key does, in a few plain words ("Next", "Flash Key lights", "Fade 2 s"). */
export function targetName(show: Show, does: KeyTarget): string {
  switch (does.kind) {
    case 'song': return lookName(show, does.id) ?? 'a song that is gone';
    case 'quickLook': return lookName(show, does.id) ?? 'a quick look that is gone';
    case 'next': return 'Next';
    case 'backToLook': return 'Back to saved';
    case 'undo': return 'Undo';
    case 'basic': return 'Basic lights';
    case 'blackout': return 'Blackout';
    case 'flashAll': return 'Flash all';
    case 'flash': return `Flash ${groupName(show, does.group)}`;
    case 'master': return 'Master';
    case 'groupLevel': return `${groupName(show, does.group)} level`;
    case 'fadeKnob': return 'Fade time knob';
    case 'fadeTime': return `Fade ${does.value === null ? 'Auto' : does.value === 0 ? 'Instant' : `${does.value} s`}`;
    case 'tap': return 'Tap';
    case 'tempoStep': return `Tempo ${does.times === 2 ? '×2' : '÷2'}`;
  }
}

/** Why a key can't do this in this show (the song, quick look or group is gone), or null when it can. */
export function keyTargetProblem(show: Show, does: KeyTarget): string | null {
  switch (does.kind) {
    case 'song':
      return show.operator.runningOrder.includes(does.id) || show.operator.safeLook === does.id ? null : 'That song is no longer in the running order.';
    case 'quickLook':
      return show.operator.quickLooks.some((q) => q.look === does.id) ? null : 'That quick look is no longer there.';
    case 'flash':
    case 'groupLevel':
      return show.groups.some((g) => g.id === does.group && g.kind !== 'smoke') ? null : 'That group is no longer in the show.';
  }
  return null;
}

function withKeys(show: Show, keys: KeyBinding[], extra: Partial<ControllerSettings> = {}): Show {
  const out = structuredClone(show);
  out.operator.controller = { ...out.operator.controller, ...extra, keys };
  return out;
}

/**
 * Give `does` this key. A key that did something else moves (`moved` says what it did), and the thing
 * loses the key it had: one key, one job. Throws in plain words when it can't be done.
 */
export function assignKey(show: Show, key: ControlKey, does: KeyTarget): { show: Show; moved: KeyTarget | null } {
  const problem = keyTargetProblem(show, does);
  if (problem) throw new Error(problem);
  if (isLevelTarget(does) && key.type !== 'cc') throw new Error(`${targetName(show, does)} needs a fader or a knob.`);
  const keys = controllerOf(show).keys;
  const was = keys.find((b) => sameKey(b.key, key));
  const moved = was && !sameTarget(was.does, does) ? was.does : null;
  const rest = keys.filter((b) => !sameKey(b.key, key) && !sameTarget(b.does, does));
  return { show: withKeys(show, [...rest, { key: { ...key }, does: structuredClone(does) }]), moved };
}

/** Take the key off `does`. */
export function clearKey(show: Show, does: KeyTarget): Show {
  const keys = controllerOf(show).keys;
  if (!keys.some((b) => sameTarget(b.does, does))) throw new Error(`${targetName(show, does)} has no key.`);
  return withKeys(show, keys.filter((b) => !sameTarget(b.does, does)));
}

/** Every key on an APC mini goes, and the standard layout is on again. Keys on other controllers stay. */
export function resetApcKeys(show: Show): Show {
  const out = withKeys(show, controllerOf(show).keys.filter((b) => !isApcMini(b.key.device)));
  delete out.operator.controller!.apcLayout;
  return out;
}

/** The show without keys for songs, quick looks and groups that are gone; the same show when there are none. */
export function pruneKeys(show: Show): Show {
  const keys = show.operator.controller?.keys;
  if (!keys?.length) return show;
  const kept = keys.filter((b) => !keyTargetProblem(show, b.does));
  return kept.length === keys.length ? show : withKeys(show, kept);
}

/**
 * Tap tempo, as the operator page's Tap: the average of the last 4 gaps; a gap over 2 s starts over.
 * The tempo from the second tap on, else null. Times in milliseconds.
 */
export class TapTempo {
  private times: number[] = [];

  tap(ms: number): number | null {
    if (this.times.length && ms - this.times[this.times.length - 1]! > 2000) this.times = [];
    this.times.push(ms);
    if (this.times.length > 5) this.times.shift();
    if (this.times.length < 2) return null;
    return (60000 * (this.times.length - 1)) / (ms - this.times[0]!);
  }
}

/** A quick look moved to another look id (it took its own copy): its key goes with it. */
export function followQuickLook(show: Show, from: string, to: string): void {
  for (const b of show.operator.controller?.keys ?? []) {
    if (b.does.kind === 'quickLook' && b.does.id === from) b.does.id = to;
  }
}
