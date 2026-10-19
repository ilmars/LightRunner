// Pure edits to a show's running order and quick looks. Each function takes a
// show and returns a new one; the input is never changed. Bad input throws an
// Error with a plain message the page can show as it is.

import { BLACKOUT_PRESET, SAFE_LIGHT, SAFE_PRESET, displayColour, liveEffectId, livePresetId, parseLiveEffect, parseLivePreset } from './protocol.ts';
import { effectKey, isEffectPreset, resolveColour } from './schema.ts';
import type { EffectLayer, Layer, Look, LookEntry, Preset, QuickTab, Show } from './schema.ts';

/** Where the stage is going: preset ids (possibly live ones) and level targets, as in RuntimeState. */
export interface Stage {
  groups: Record<string, string | null>;
  levels: Record<string, number>;
  /** The live effects (`fx:` ids) the groups name. */
  effects?: Record<string, EffectLayer>;
  /** The stage tempo in beats per minute. */
  tempo?: number;
}

const MIN_TEMPO = 40;
const MAX_TEMPO = 240;

const MAX_NAME = 40;
const BASIC = 'Basic lights';
/** Basic lights is always still, so it never takes an effect. */
const STILL = 'Basic lights is always still.';

/** Trims and cuts a name to 40 characters. Empty names are refused. */
export function cleanName(name: string): string {
  const clean = name.trim().slice(0, MAX_NAME).trim();
  if (!clean) throw new Error('a name is needed');
  return clean;
}

function slug(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** A slug of the name that no id in `taken` uses: "song-6", then "song-6-2", "song-6-3", ... */
export function uniqueId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slug(name);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

function addLook(show: Show, name: string, groups: LookEntry[]): string {
  const id = uniqueId(name, show.looks.map((l) => l.id));
  show.looks.push({ id, name, groups });
  return id;
}

/** The engine's own Safe light and Blackout, as the presets a Save stores them as. */
const BUILT_IN = new Map<string, { name: string; swatch: string; layer: Layer }>([
  [SAFE_PRESET, {
    name: 'Basic light',
    swatch: SAFE_LIGHT.hex,
    layer: { kind: 'static', colour: { hex: SAFE_LIGHT.hex, white: SAFE_LIGHT.white }, intensity: SAFE_LIGHT.intensity },
  }],
  // Only a group Blackout left dark (Save itself is refused during Blackout).
  [BLACKOUT_PRESET, { name: 'Off', swatch: '#000000', layer: { kind: 'static', colour: { hex: '#000000' }, intensity: 0 } }],
]);

/** A plain layer's light (palette colours by reference); an effect layer is only ever the same as itself. */
const layerKey = (l: Layer) => l.kind === 'effect' ? effectKey(l) : JSON.stringify([
  'palette' in l.colour ? l.colour : [l.colour.hex.toLowerCase(), l.colour.white ?? 0, l.colour.amber ?? 0, l.colour.uv ?? 0],
  l.intensity,
]);

/** The group's custom preset for a built-in light, made the first time and reused after. */
function builtInPreset(show: Show, group: string, made: { name: string; swatch: string; layer: Layer }): string {
  const key = layerKey(made.layer);
  const same = show.presets.find((p) => p.custom && p.group === group && p.layers.length === 1 && layerKey(p.layers[0]!) === key);
  if (same) return same.id;
  const id = uniqueId(made.name, show.presets.map((p) => p.id));
  show.presets.push({ id, name: made.name, group, custom: true, layers: [structuredClone(made.layer)], fade: 3, swatch: made.swatch });
  return id;
}

/** The #rrggbb of an effect's first colour (palette colours looked up), for its swatch. */
export function effectSwatch(show: Show, effect: EffectLayer): string {
  const first = effect.colours[0];
  return first ? resolveColour(first, new Map(show.palettes.map((p) => [p.id, p]))).hex.toLowerCase() : '#ffffff';
}

/**
 * The look entries for these groups: one per group with a preset. A live preset
 * (an "Any colour" pick, or a live effect) becomes a new custom preset in `show`; an existing one
 * is only referenced. The engine's Safe light and Blackout become the group's
 * "Basic light" and "Off" custom presets, shared by every save. Smoke groups
 * are left out: starting a look never turns a smoke machine on or off.
 */
function entriesFor(show: Show, stage: Stage, only?: string[]): LookEntry[] {
  const entries: LookEntry[] = [];
  for (const [group, preset] of Object.entries(stage.groups)) {
    if (!preset || (only && !only.includes(group))) continue;
    const found = show.groups.find((g) => g.id === group);
    if (!found) throw new Error(`the show has no group "${group}"`);
    if (found.kind === 'smoke') continue;
    const level = stage.levels[group] ?? 1;
    const live = parseLivePreset(preset);
    const builtIn = BUILT_IN.get(preset);
    const fx = parseLiveEffect(preset);
    if (fx) {
      const effect = stage.effects?.[preset];
      if (!effect) throw new Error(`the show has no preset "${preset}"`);
      if (fx.group !== group) throw new Error(`preset "${preset}" belongs to another group`);
      const made: Preset = {
        id: uniqueId('Custom effect', show.presets.map((p) => p.id)),
        name: 'Custom effect',
        group,
        custom: true,
        layers: [structuredClone(effect)],
        swatch: effectSwatch(show, effect),
        fade: 3,
      };
      show.presets.push(made);
      entries.push({ group, preset: made.id, level });
    } else if (builtIn) {
      entries.push({ group, preset: builtInPreset(show, group, builtIn), level });
    } else if (live) {
      // White, amber and UV go with it (each only when the pick had it).
      const { group: _group, colour: hex, ...extras } = live;
      const made: Preset = {
        id: uniqueId('Custom', show.presets.map((p) => p.id)),
        name: 'Custom',
        group,
        custom: true,
        layers: [{ kind: 'static', colour: { hex, ...extras }, intensity: 1 }],
        fade: 3,
        swatch: displayColour(hex, extras),
      };
      show.presets.push(made);
      entries.push({ group, preset: made.id, level });
    } else {
      const existing = show.presets.find((p) => p.id === preset);
      if (!existing) throw new Error(`the show has no preset "${preset}"`);
      if (existing.group !== group) throw new Error(`preset "${preset}" belongs to another group`);
      entries.push({ group, preset, level });
    }
  }
  return entries;
}

function lookIn(show: Show, id: string): Look {
  const found = show.looks.find((l) => l.id === id);
  if (!found) throw new Error(`"${id}" isn't in the show`);
  return found;
}

function inOrder(show: Show, id: string): void {
  if (!show.operator.runningOrder.includes(id)) throw new Error(`"${id}" isn't in the running order`);
}

/**
 * Gives a show that has no running order its first one: Basic lights, five
 * songs, a sermon and a midweek look. Does nothing when there is one already.
 */
export function ensureRunningOrder(show: Show): Show {
  const out = structuredClone(show);
  if (out.operator.runningOrder.length) return out;

  const before = [...out.looks];
  const named = (name: string) => before.find((l) => l.name === name);

  let safeId = out.operator.safeLook;
  const safe = safeId ? out.looks.find((l) => l.id === safeId) : undefined;
  const worship = named('Worship');
  const sermon = named('Sermon');
  const prayer = named('Prayer');

  if (safe) safe.name = BASIC;
  else safeId = addLook(out, BASIC, []);
  out.operator.safeLook = safeId;
  const basic = lookIn(out, safeId!);

  const copy = (name: string, from?: Look) => addLook(out, name, structuredClone((from ?? basic).groups));
  const order = [safeId!];
  for (let n = 1; n <= 5; n++) order.push(copy(`Song ${n}`, worship));
  order.push(copy('Sermon', sermon));
  order.push(copy('Midweek calm', prayer));
  out.operator.runningOrder = order;

  out.operator.quickLooks = before
    .filter((l) => l.id !== safeId)
    .map((l) => ({ look: l.id, tab: l.name === 'All white' ? 'plain' : 'colours' }));
  return out;
}

/**
 * Keeps the rule the operator page relies on: a safe look (Basic lights) always
 * exists, it is first in the running order and nowhere else in it. A show that
 * lost it (Compare with a file, an old Settings choice) gets an empty "Basic
 * lights" look, or the look of that name if there is one.
 */
export function ensureBasicLights(show: Show): Show {
  const out = structuredClone(show);
  let safeId = out.operator.safeLook;
  if (!safeId || !out.looks.some((l) => l.id === safeId)) {
    safeId = out.looks.find((l) => l.name === BASIC)?.id ?? addLook(out, BASIC, []);
    out.operator.safeLook = safeId;
  }
  out.operator.runningOrder = [safeId, ...out.operator.runningOrder.filter((id) => id !== safeId)];
  return out;
}

/** True when the stage preset is an effect: a live one (`fx:`) or a preset of the show with an effect in it. */
function isEffect(show: Show, preset: string): boolean {
  if (parseLiveEffect(preset)) return true;
  const found = show.presets.find((p) => p.id === preset);
  return !!found && isEffectPreset(found);
}

/**
 * Replaces what a look holds with the stage as it is going; the look keeps its id, name and place.
 * Basic lights keeps no dimmer levels: it stores every group at full, as it always resets them.
 * Basic lights is always still too: a group running an effect keeps what Basic lights had for it.
 */
export function saveItem(show: Show, lookId: string, stage: Stage): Show {
  const out = structuredClone(show);
  const target = lookIn(out, lookId);
  if (lookId === out.operator.safeLook) {
    const moving = new Set(Object.entries(stage.groups).filter(([, p]) => p && isEffect(out, p)).map(([g]) => g));
    const fresh = entriesFor(out, stage, Object.keys(stage.groups).filter((g) => !moving.has(g)));
    const kept = target.groups.filter((e) => moving.has(e.group));
    // In the stage's group order, as a plain Save stores them.
    const order = Object.keys(stage.groups);
    target.groups = [...fresh, ...kept].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    for (const entry of target.groups) entry.level = 1;
  } else {
    target.groups = entriesFor(out, stage);
  }
  if (stage.tempo !== undefined) target.tempo = stage.tempo;
  return out;
}

/** A new "Song N" holding the stage, placed right after `afterId` (or last). */
export function addSong(show: Show, afterId: string, stage: Stage): { show: Show; id: string } {
  const out = structuredClone(show);
  // Number after the highest song, so deleting Song 1 never makes a second Song 5.
  let highest = 0;
  for (const itemId of out.operator.runningOrder) {
    const m = /^Song (\d+)$/.exec(out.looks.find((l) => l.id === itemId)?.name ?? '');
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  const id = addLook(out, `Song ${highest + 1}`, []);
  lookIn(out, id).groups = entriesFor(out, stage);
  if (stage.tempo !== undefined) lookIn(out, id).tempo = stage.tempo;
  const at = out.operator.runningOrder.indexOf(afterId);
  if (at < 0) out.operator.runningOrder.push(id);
  else out.operator.runningOrder.splice(at + 1, 0, id);
  return { show: out, id };
}

export function renameItem(show: Show, id: string, name: string): Show {
  const clean = cleanName(name);
  const out = structuredClone(show);
  inOrder(out, id);
  lookIn(out, id).name = clean;
  return out;
}

/** Removes an item from the running order, and its look too unless a quick look uses it. */
export function deleteItem(show: Show, id: string): Show {
  if (id === show.operator.safeLook) throw new Error("Basic lights can't be deleted");
  const out = structuredClone(show);
  inOrder(out, id);
  out.operator.runningOrder = out.operator.runningOrder.filter((x) => x !== id);
  if (!out.operator.quickLooks.some((q) => q.look === id)) {
    out.looks = out.looks.filter((l) => l.id !== id);
    out.operator.looks = out.operator.looks.filter((x) => x !== id);
  }
  return out;
}

/** Moves an item to position `to` (0 is Basic lights, so the first free place is 1). */
export function moveItem(show: Show, id: string, to: number): Show {
  if (id === show.operator.safeLook) throw new Error('Basic lights stays first');
  const out = structuredClone(show);
  inOrder(out, id);
  const rest = out.operator.runningOrder.filter((x) => x !== id);
  const place = Math.min(Math.max(Math.round(to), 1), rest.length);
  rest.splice(place, 0, id);
  out.operator.runningOrder = rest;
  return out;
}

/** A new look from the chosen groups of the stage, offered under Quick looks on a tab. */
export function saveQuickLook(
  show: Show,
  input: { name: string; tab: QuickTab; groups: string[] },
  stage: Stage,
): { show: Show; id: string } {
  const name = cleanName(input.name);
  // Smoke groups never go into a look, so they don't count.
  const lights = input.groups.filter((id) => show.groups.find((g) => g.id === id)?.kind !== 'smoke');
  if (!lights.length) throw new Error('pick at least one group');
  const out = structuredClone(show);
  const id = addLook(out, name, []);
  lookIn(out, id).groups = entriesFor(out, stage, input.groups);
  out.operator.quickLooks.push({ look: id, tab: input.tab });
  return { show: out, id };
}

/** One group's change in a running-order item: a preset, an Any colour (with extras) or an effect, and/or a level. */
export interface ItemGroupEdit {
  group: string;
  preset?: string;
  colour?: string;
  white?: number;
  amber?: number;
  uv?: number;
  effect?: EffectLayer;
  level?: number;
}

/** The item's look, if it is in the running order. Only those can be changed from the operator page. */
function itemLook(show: Show, itemId: string): Look {
  if (!show.operator.runningOrder.includes(itemId)) throw new Error('only running-order items can be changed here');
  return lookIn(show, itemId);
}

/** Puts the entry in the look: replaces the group's one, or adds it last. Basic lights stays at full. */
function putEntry(show: Show, target: Look, entry: LookEntry): void {
  if (target.id === show.operator.safeLook) entry.level = 1;
  const at = target.groups.findIndex((e) => e.group === entry.group);
  if (at < 0) target.groups.push(entry);
  else target.groups[at] = entry;
}

/**
 * Changes one group in a running-order item: a preset of the group, an Any colour
 * (kept as a new hidden "Custom" preset, as Save does), an effect (a new hidden
 * "Custom effect") and/or its level. The other groups and the item's name stay.
 * A level alone needs the group to be set already. Basic lights is always still: it takes no effect.
 */
export function setItemGroup(show: Show, itemId: string, edit: ItemGroupEdit): Show {
  const out = structuredClone(show);
  const target = itemLook(out, itemId);
  const group = out.groups.find((g) => g.id === edit.group);
  if (!group) throw new Error(`the show has no group "${edit.group}"`);
  if (group.kind === 'smoke') throw new Error("smoke machines aren't part of a song");
  const picks = [edit.preset, edit.colour, edit.effect].filter((x) => x !== undefined).length;
  if (picks > 1) throw new Error('pick a colour, a preset or an effect, not more than one');
  if (!picks && edit.level === undefined) throw new Error('nothing to change');

  const existing = target.groups.find((e) => e.group === edit.group);
  if (!picks) {
    // Level only: keep the preset (and its own fade).
    if (!existing) throw new Error('Give the group a colour first.');
    putEntry(out, target, { ...existing, level: edit.level! });
    return out;
  }

  let stagePreset: string;
  const effects: Record<string, EffectLayer> = {};
  const safe = target.id === out.operator.safeLook;
  if (edit.effect !== undefined) {
    if (safe) throw new Error(STILL);
    stagePreset = liveEffectId(edit.group, 0);
    effects[stagePreset] = edit.effect;
  } else if (edit.colour !== undefined) {
    stagePreset = livePresetId(edit.group, edit.colour, { white: edit.white, amber: edit.amber, uv: edit.uv });
  } else {
    const preset = out.presets.find((p) => p.id === edit.preset && p.group === edit.group);
    if (!preset) throw new Error(`unknown preset "${edit.preset}" for group "${edit.group}"`);
    if (safe && isEffectPreset(preset)) throw new Error(STILL);
    stagePreset = preset.id;
  }
  // Without a level the group keeps the one the item has (full if it has none).
  const level = edit.level ?? existing?.level ?? 1;
  const [entry] = entriesFor(out, { groups: { [edit.group]: stagePreset }, levels: { [edit.group]: level }, effects }, [edit.group]);
  putEntry(out, target, entry!);
  return out;
}

/** Sets a running-order item's tempo (beats per minute), without touching the stage. */
export function setItemTempo(show: Show, itemId: string, bpm: number): Show {
  if (!(bpm >= MIN_TEMPO && bpm <= MAX_TEMPO)) throw new Error(`the tempo is ${MIN_TEMPO} to ${MAX_TEMPO} beats per minute`);
  const out = structuredClone(show);
  itemLook(out, itemId).tempo = bpm;
  return out;
}

/**
 * Copies a quick look into a running-order item: each group the quick look lists
 * takes its preset (referenced, not copied) and level. Other groups keep their entries.
 * Smoke machines are skipped: looks never set smoke, so an older quick look that lists one
 * doesn't put it into a song. Basic lights is always still: a quick look with an effect is refused there.
 */
export function applyQuickLookToItem(show: Show, itemId: string, quickLookId: string): Show {
  const out = structuredClone(show);
  const target = itemLook(out, itemId);
  if (!out.operator.quickLooks.some((q) => q.look === quickLookId)) throw new Error('that is not a quick look');
  const entries = lookIn(out, quickLookId).groups;
  if (itemId === out.operator.safeLook && entries.some((e) => isEffect(out, e.preset))) throw new Error(STILL);
  for (const entry of entries) {
    if (out.groups.find((g) => g.id === entry.group)?.kind === 'smoke') continue;
    putEntry(out, target, { group: entry.group, preset: entry.preset, level: entry.level ?? 1 });
  }
  return out;
}
