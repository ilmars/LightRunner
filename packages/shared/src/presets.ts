// Pure edits to a show's colour presets (the swatches in the colour picker).
// Like runningorder.ts: the input is never changed, bad input throws an Error
// with a plain message the page can show as it is.

import { HEX_COLOUR, displayColour } from './protocol.ts';
import { cleanName, uniqueId } from './runningorder.ts';
import { findProfile } from './schema.ts';
import type { Preset, Show, StaticLayer } from './schema.ts';

/** True when no fixture in the group has a red, green or blue channel: the picker offers it warm-to-cool white only. */
export function groupIsWhiteOnly(show: Show, groupId: string): boolean {
  const group = show.groups.find((g) => g.id === groupId);
  const makesColour = (fixtureId: string): boolean => {
    const fixture = show.fixtures.find((f) => f.id === fixtureId);
    const profile = fixture ? findProfile(show, fixture.profile) : undefined;
    return !!profile?.channels.some((c) => c.role === 'red' || c.role === 'green' || c.role === 'blue');
  };
  return !group?.fixtures.some(makesColour);
}

export interface AddColour {
  group: string;
  colour: string;
  /** Empty = "Colour N", numbered after the group's own presets. */
  name: string;
  /** Also add it to every other group of the same kind (colour groups, or white-only groups). */
  allGroups: boolean;
}

/** The light (hex, white, amber, UV, intensity) a preset's only layer makes, palette colours looked up; null for anything else (an effect, say). */
function plainLight(show: Show, preset: Preset): string | null {
  if (preset.layers.length !== 1) return null;
  const layer = preset.layers[0]!;
  if (layer.kind !== 'static') return null;
  const spec = layer.colour;
  const c = 'palette' in spec ? show.palettes.find((p) => p.id === spec.palette)?.colours[spec.index] : spec;
  return c ? JSON.stringify([c.hex.toLowerCase(), c.white ?? 0, c.amber ?? 0, c.uv ?? 0, layer.intensity]) : null;
}

/** "Colour 4" after "Colour 3": one more than the highest number in use among these presets. */
function nextColourName(presets: Preset[]): string {
  let highest = 0;
  for (const p of presets) {
    const m = /^Colour (\d+)$/.exec(p.name);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `Colour ${highest + 1}`;
}

/**
 * Adds a colour to the colour list of a group (or of every group of its kind) as a
 * normal preset. A group that already lists this colour is left alone. Returns the ids of
 * the presets made, in the order of the show's groups; none made is an error.
 */
export function addColour(show: Show, input: AddColour): { show: Show; ids: string[] } {
  if (!HEX_COLOUR.test(input.colour)) throw new Error('that is not a colour');
  const colour = input.colour.toLowerCase();
  const out = structuredClone(show);
  if (!out.groups.some((g) => g.id === input.group)) throw new Error(`the show has no group "${input.group}"`);

  const whiteOnly = groupIsWhiteOnly(out, input.group);
  const shown = shownGroups(out);
  const targets = input.allGroups
    ? out.groups.filter((g) => g.id === input.group || (shown.includes(g.id) && groupIsWhiteOnly(out, g.id) === whiteOnly)).map((g) => g.id)
    : [input.group];

  const layer: StaticLayer = { kind: 'static', colour: { hex: colour }, intensity: 1 };
  const wanted = JSON.stringify([colour, 0, 0, 0, 1]);
  // One name for the whole set, numbered after the highest "Colour N" in any of the groups.
  const name = input.name.trim() ? cleanName(input.name) : nextColourName(out.presets.filter((p) => targets.includes(p.group)));
  const ids: string[] = [];
  for (const group of targets) {
    const own = out.presets.filter((p) => p.group === group);
    if (own.some((p) => !p.custom && plainLight(out, p) === wanted)) continue;
    const id = uniqueId(`${group} ${name}`, out.presets.map((p) => p.id));
    out.presets.push({ id, name, group, layers: [structuredClone(layer)], fade: 3, swatch: colour });
    ids.push(id);
  }
  if (!ids.length) throw new Error(input.allGroups ? 'every group already has that colour' : 'that colour is already in the list');
  return { show: out, ids };
}

/** Names of the looks that use a preset: running-order items first, then quick looks, then any other look. */
export function presetUsers(show: Show, presetId: string): string[] {
  const using = new Set(show.looks.filter((l) => l.groups.some((e) => e.preset === presetId)).map((l) => l.id));
  const order = [
    ...show.operator.runningOrder,
    ...show.operator.quickLooks.map((q) => q.look),
    ...show.looks.map((l) => l.id),
  ];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of order) {
    if (!using.has(id) || seen.has(id)) continue;
    seen.add(id);
    const name = show.looks.find((l) => l.id === id)!.name;
    // A running-order item and the quick look it was copied from share a name; list it once.
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** "Song 2, Sermon", or "Song 2, Sermon, Prayer, Walk-in and 3 more" when there are many. */
export function listNames(names: string[], shown = 4): string {
  if (names.length <= shown) return names.join(', ');
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

export interface EditColour {
  preset: string;
  /** New name; undefined leaves it. */
  name?: string;
  /** New #rrggbb colour; undefined leaves it. */
  colour?: string;
  /** Also change the presets of other groups that have the same name as this one has now. */
  sameName: boolean;
}

/**
 * Changes the name and/or the colour of a colour in a group's list. A new colour replaces the
 * preset's layer with one plain colour (keeping its brightness) and updates the swatch.
 * Returns the ids changed. Hidden (custom) presets can't be edited from here.
 */
export function editColour(show: Show, input: EditColour): { show: Show; ids: string[] } {
  const out = structuredClone(show);
  const target = out.presets.find((p) => p.id === input.preset);
  if (!target) throw new Error('that colour is not in the list');
  if (target.custom) throw new Error("that colour can't be edited");
  if (input.name === undefined && input.colour === undefined) throw new Error('nothing to change');
  const name = input.name === undefined ? undefined : cleanName(input.name);
  if (input.colour !== undefined && !HEX_COLOUR.test(input.colour)) throw new Error('that is not a colour');
  const colour = input.colour?.toLowerCase();

  if (colour !== undefined && !canRecolour(target)) {
    throw new Error(isOff(target) ? "Off can't be given a colour; add a new colour instead." : "that colour can't be changed here");
  }

  const ids: string[] = [];
  for (const p of sameNamePresets(out, target, input.sameName)) {
    const before = JSON.stringify(p);
    if (name !== undefined) p.name = name;
    // An Off (or other kind of) colour of the same name only takes the new name.
    if (colour !== undefined && canRecolour(p)) {
      const layer = recoloured(out, p.layers[0] as StaticLayer, colour);
      p.layers = [layer];
      // The swatch shows what the stage does, white, amber and UV included (as a saved Any colour pick does).
      p.swatch = 'hex' in layer.colour ? displayColour(colour, layer.colour) : colour;
    }
    if (JSON.stringify(p) !== before) ids.push(p.id);
  }
  if (!ids.length) throw new Error('nothing changed');
  return { show: out, ids };
}

/** One plain, lit layer: the only kind of colour the editor can recolour (never an effect). */
export const isOff = (p: Preset) => p.layers.length === 1 && p.layers[0]!.kind === 'static' && p.layers[0]!.intensity === 0;
export const canRecolour = (p: Preset) => p.layers.length === 1 && p.layers[0]!.kind === 'static' && !isOff(p);

/**
 * The layer with a new hex. Everything else of its colour stays (white, and any other channel a
 * colour carries); a palette reference becomes a hex colour that keeps the palette entry's fields.
 */
function recoloured(show: Show, layer: StaticLayer, hex: string): StaticLayer {
  const spec = layer.colour;
  const base = 'palette' in spec ? show.palettes.find((p) => p.id === spec.palette)?.colours[spec.index] ?? {} : spec;
  return { ...layer, colour: { ...base, hex } };
}

/** The group ids the operator page shows (all of them when it lists none). */
function shownGroups(show: Show): string[] {
  return show.operator.groups.length ? show.operator.groups : show.groups.map((g) => g.id);
}

/** The preset, and with `sameName` the non-hidden presets of the same name in the other groups the operator page shows. */
export function sameNamePresets(show: Show, target: Preset, sameName: boolean): Preset[] {
  const shown = shownGroups(show);
  return show.presets.filter((p) => p.id === target.id
    || (sameName && !p.custom && p.group !== target.group && shown.includes(p.group) && p.name === target.name));
}

/** Removes a colour from a group's list, unless a look uses it. */
export function deleteColour(show: Show, presetId: string): Show {
  const found = show.presets.find((p) => p.id === presetId);
  if (!found) throw new Error('that colour is not in the list');
  if (found.custom) throw new Error("that colour can't be deleted");
  const users = presetUsers(show, presetId);
  if (users.length) throw new Error(`Used in ${listNames(users)}. Change those first.`);
  const out = structuredClone(show);
  out.presets = out.presets.filter((p) => p.id !== presetId);
  return out;
}
