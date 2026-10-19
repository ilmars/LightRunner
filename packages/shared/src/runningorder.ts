// Pure edits to a show's running order and quick looks. Each function takes a
// show and returns a new one; the input is never changed. Bad input throws an
// Error with a plain message the page can show as it is.

import { BLACKOUT_PRESET, SAFE_LIGHT, SAFE_PRESET, parseLivePreset } from './protocol.ts';
import type { Layer, Look, LookEntry, Preset, QuickTab, Show } from './schema.ts';

/** Where the stage is going: preset ids (possibly live ones) and level targets, as in RuntimeState. */
export interface Stage {
  groups: Record<string, string | null>;
  levels: Record<string, number>;
}

const MAX_NAME = 40;
const BASIC = 'Basic lights';

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
function uniqueId(name: string, taken: Iterable<string>): string {
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

const layerKey = (l: Layer) => JSON.stringify(['palette' in l.colour ? l.colour : [l.colour.hex.toLowerCase(), l.colour.white ?? 0], l.intensity]);

/** The group's custom preset for a built-in light, made the first time and reused after. */
function builtInPreset(show: Show, group: string, made: { name: string; swatch: string; layer: Layer }): string {
  const key = layerKey(made.layer);
  const same = show.presets.find((p) => p.custom && p.group === group && p.layers.length === 1 && layerKey(p.layers[0]!) === key);
  if (same) return same.id;
  const id = uniqueId(made.name, show.presets.map((p) => p.id));
  show.presets.push({ id, name: made.name, group, custom: true, layers: [structuredClone(made.layer)], fade: 3, swatch: made.swatch });
  return id;
}

/**
 * The look entries for these groups: one per group with a preset. A live preset
 * (an "Any colour" pick) becomes a new custom preset in `show`; an existing one
 * is only referenced. The engine's Safe light and Blackout become the group's
 * "Basic light" and "Off" custom presets, shared by every save.
 */
function entriesFor(show: Show, stage: Stage, only?: string[]): LookEntry[] {
  const entries: LookEntry[] = [];
  for (const [group, preset] of Object.entries(stage.groups)) {
    if (!preset || (only && !only.includes(group))) continue;
    if (!show.groups.some((g) => g.id === group)) throw new Error(`the show has no group "${group}"`);
    const level = stage.levels[group] ?? 1;
    const live = parseLivePreset(preset);
    const builtIn = BUILT_IN.get(preset);
    if (builtIn) {
      entries.push({ group, preset: builtInPreset(show, group, builtIn), level });
    } else if (live) {
      const made: Preset = {
        id: uniqueId('Custom', show.presets.map((p) => p.id)),
        name: 'Custom',
        group,
        custom: true,
        layers: [{ kind: 'static', colour: { hex: live.colour }, intensity: 1 }],
        fade: 3,
        swatch: live.colour,
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

/** Replaces what a look holds with the stage as it is going; the look keeps its id, name and place. */
export function saveItem(show: Show, lookId: string, stage: Stage): Show {
  const out = structuredClone(show);
  const target = lookIn(out, lookId);
  target.groups = entriesFor(out, stage);
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
  if (!input.groups.length) throw new Error('pick at least one group');
  const out = structuredClone(show);
  const id = addLook(out, name, []);
  lookIn(out, id).groups = entriesFor(out, stage, input.groups);
  out.operator.quickLooks.push({ look: id, tab: input.tab });
  return { show: out, id };
}
