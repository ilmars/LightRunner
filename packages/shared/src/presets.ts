// Pure edits to a show's colour presets (the swatches in the colour picker).
// Like runningorder.ts: the input is never changed, bad input throws an Error
// with a plain message the page can show as it is.

import { HEX_COLOUR, displayColour } from './protocol.ts';
import { cleanName, effectSwatch, uniqueId } from './runningorder.ts';
import { findProfile, isEffectPreset, layerColours, resolveColour } from './schema.ts';
import type { ChannelRole, ColourSpec, EffectLayer, Palette, Preset, Profile, Show, StaticLayer } from './schema.ts';

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
  /**
   * White, amber and UV levels 0..1 (missing is 0), kept to whole percent as an Any colour pick
   * keeps them. A group whose fixtures lack a channel shows it as the engine shows any colour
   * with it: white and amber made from red, green and blue, UV left out.
   */
  white?: number;
  amber?: number;
  uv?: number;
  /** Its brightness, 0.05 to 1, kept to whole percent (missing is full). */
  level?: number;
  /** Its own fade in seconds, 0 to 600 (missing is 3 s). */
  fade?: number;
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

/** "Colour 4" after "Colour 3" (or "Effect 4" after "Effect 3"): one more than the highest number in use among these presets. */
function nextName(presets: Preset[], word: 'Colour' | 'Effect' = 'Colour'): string {
  let highest = 0;
  for (const p of presets) {
    const m = /^(\w+) (\d+)$/.exec(p.name);
    if (m && m[1] === word) highest = Math.max(highest, Number(m[2]));
  }
  return `${word} ${highest + 1}`;
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

  const extras: { white?: number; amber?: number; uv?: number } = {};
  for (const k of ['white', 'amber', 'uv'] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (!(v >= 0 && v <= 1)) throw new Error(`the ${k === 'uv' ? 'UV' : k} level is between 0 and 100 %`);
    const level = Math.round(v * 100) / 100;
    if (level > 0) extras[k] = level;
  }
  if (input.level !== undefined && !(input.level >= 0.05 && input.level <= 1)) throw new Error('the brightness is between 5 % and 100 %');
  if (input.fade !== undefined && !(input.fade >= 0 && input.fade <= 600)) throw new Error('the fade is between 0 and 600 seconds');
  const level = input.level === undefined ? 1 : Math.round(input.level * 100) / 100;
  const fade = input.fade ?? 3;
  const layer: StaticLayer = { kind: 'static', colour: { hex: colour, ...extras }, intensity: level };
  const wanted = JSON.stringify([colour, extras.white ?? 0, extras.amber ?? 0, extras.uv ?? 0, level]);
  // The swatch shows the white, amber and UV in it, as a saved Any colour pick's does.
  const swatch = Object.keys(extras).length ? displayColour(colour, extras) : colour;
  // A black colour is a light only with White, Amber or UV in it.
  if (colour === '#000000' && !Object.keys(extras).length) throw new Error('that colour has no light: pick a colour, or add White, Amber or UV');
  // One name for the whole set, numbered after the highest "Colour N" in any of the groups.
  const name = input.name.trim() ? cleanName(input.name) : nextName(out.presets.filter((p) => targets.includes(p.group)));
  const ids: string[] = [];
  for (const group of targets) {
    const own = out.presets.filter((p) => p.group === group);
    if (own.some((p) => !p.custom && plainLight(out, p) === wanted)) continue;
    const id = uniqueId(`${group} ${name}`, out.presets.map((p) => p.id));
    out.presets.push({ id, name, group, layers: [structuredClone(layer)], fade, swatch });
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
  /** New brightness of the colour, 0.05 to 1 (the layer's intensity); undefined leaves it. */
  level?: number;
  /** New fade time in seconds, 0 to 600 (the preset's own fade); undefined leaves it. */
  fade?: number;
  /**
   * New White, Amber and UV levels 0..1, kept to whole percent (0 takes it out); undefined leaves each.
   * They go with the colour: to the palette entry with `shared`, otherwise into the colour's own.
   */
  white?: number;
  amber?: number;
  uv?: number;
  /**
   * With a new colour (or new White, Amber or UV) on a colour that points to a palette entry: change the palette entry,
   * so every colour pointing to it follows. Without a palette entry it does nothing. A same-named
   * colour of another group that points elsewhere (or nowhere) takes the new colour as its own.
   */
  shared?: boolean;
  /** Also change the presets of other groups that have the same name as this one has now. */
  sameName: boolean;
}

/** The palette entry a preset's only layer points to; null for a plain colour, an effect or Off. */
export function paletteEntryOf(p: Preset): { palette: string; index: number } | null {
  if (!canRecolour(p)) return null;
  const spec = (p.layers[0] as StaticLayer).colour;
  return 'palette' in spec ? { palette: spec.palette, index: spec.index } : null;
}

/** Every preset with a layer (or an effect colour, or an effect's base) that points to this palette entry, in the show's order. */
export function presetsUsingPaletteEntry(show: Show, palette: string, index: number): Preset[] {
  const points = (c: ColourSpec) => 'palette' in c && c.palette === palette && c.index === index;
  return show.presets.filter((p) => p.layers.some((l) => layerColours(l).some(points)));
}

/**
 * Changes the name, colour, White, Amber and UV, brightness and/or fade of a colour in a group's list. A new colour
 * replaces the preset's layer with one plain colour (keeping its brightness) and updates the swatch,
 * or, with `shared` on a palette colour, changes the palette entry itself for everything that points to it.
 * Returns the ids of every preset changed. Hidden (custom) presets can't be edited from here.
 */
export function editColour(show: Show, input: EditColour): { show: Show; ids: string[] } {
  const out = structuredClone(show);
  const target = out.presets.find((p) => p.id === input.preset);
  if (!target) throw new Error('that colour is not in the list');
  if (target.custom) throw new Error("that colour can't be edited");
  const extras: { white?: number; amber?: number; uv?: number } = {};
  for (const k of ['white', 'amber', 'uv'] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (!(v >= 0 && v <= 1)) throw new Error(`the ${k === 'uv' ? 'UV' : k} level is between 0 and 100 %`);
    extras[k] = Math.round(v * 100) / 100;
  }
  const newExtras = Object.keys(extras).length > 0;
  if (input.name === undefined && input.colour === undefined && input.level === undefined && input.fade === undefined && !newExtras) throw new Error('nothing to change');
  const name = input.name === undefined ? undefined : cleanName(input.name);
  if (input.colour !== undefined && !HEX_COLOUR.test(input.colour)) throw new Error('that is not a colour');
  const colour = input.colour?.toLowerCase();
  const { level, fade } = input;
  if (level !== undefined && !(level >= 0.05 && level <= 1)) throw new Error('the brightness is between 5 % and 100 %');
  if (fade !== undefined && !(fade >= 0 && fade <= 600)) throw new Error('the fade is between 0 and 600 seconds');

  if ((colour !== undefined || level !== undefined || newExtras) && !canRecolour(target)) {
    throw new Error(isOff(target) ? "Off can't be given a colour; add a new colour instead." : "that colour can't be changed here");
  }

  const before = new Map(out.presets.map((p) => [p.id, JSON.stringify(p)]));
  const palettesBefore = JSON.stringify(out.palettes);
  // Only colours that point to the same palette entry as this one follow it. Any other colour of
  // the same name (a plain one, or one pointing to another shared colour) takes the colour as its own.
  const sharedEntry = input.shared ? paletteEntryOf(target) : null;
  const followsTarget = (e: { palette: string; index: number } | null) =>
    !!e && !!sharedEntry && e.palette === sharedEntry.palette && e.index === sharedEntry.index;
  const moved = new Set<string>(); // palette entries that got a new hex, as "palette:index"
  const edited = new Set<string>(); // presets that got a new colour of their own
  /** The new colour and White, Amber and UV on `c` (0 takes one out); a colour with no light left is refused. */
  const recolour = (c: { hex: string; white?: number; amber?: number; uv?: number }) => {
    if (colour !== undefined) c.hex = colour;
    for (const [k, v] of Object.entries(extras) as ['white' | 'amber' | 'uv', number][]) {
      if (v > 0) c[k] = v;
      else delete c[k];
    }
    if (/^#0{6}$/i.test(c.hex) && !c.white && !c.amber && !c.uv) throw new Error('that colour has no light: pick a colour, or add White, Amber or UV');
  };

  for (const p of sameNamePresets(out, target, input.sameName)) {
    if (name !== undefined) p.name = name;
    if (fade !== undefined) p.fade = fade;
    // An Off (or other kind of) colour of the same name only takes the new name and fade.
    if (!canRecolour(p)) continue;
    const layer = p.layers[0] as StaticLayer;
    if (level !== undefined) layer.intensity = level;
    if (colour === undefined && !newExtras) continue;
    const entry = paletteEntryOf(p);
    if (entry && followsTarget(entry)) {
      const found = out.palettes.find((x) => x.id === entry.palette)?.colours[entry.index];
      if (found) {
        // Two same-named colours pointing to it change it once.
        if (!moved.has(`${entry.palette}:${entry.index}`)) recolour(found);
        moved.add(`${entry.palette}:${entry.index}`);
        edited.add(p.id);
        continue;
      }
    }
    const own = recoloured(out, layer, colour ?? resolveColour(layer.colour, new Map(out.palettes.map((x) => [x.id, x]))).hex);
    recolour(own.colour as { hex: string });
    p.layers = [own];
    edited.add(p.id);
  }

  // Swatches follow the look: the colours edited, and everything that points to a palette entry that moved.
  const follows = (c: ColourSpec) => 'palette' in c && moved.has(`${c.palette}:${c.index}`);
  for (const p of out.presets) {
    const layer = p.layers[0];
    if (p.layers.length !== 1 || !layer) continue;
    const changed = (layer.kind === 'static' && edited.has(p.id)) || layerColours(layer).some(follows);
    if (changed) p.swatch = swatchOf(out, p) ?? p.swatch;
  }

  const ids = out.presets.filter((p) => JSON.stringify(p) !== before.get(p.id)).map((p) => p.id);
  if (!ids.length && JSON.stringify(out.palettes) === palettesBefore) throw new Error('nothing changed');
  return { show: out, ids };
}

/**
 * The swatch a preset of one layer shows: its colour (palette colours looked up, white and the
 * other channels mixed in), or an effect's first colour. Null for a preset of several layers.
 */
export function swatchOf(show: Show, p: Preset): string | null {
  const layer = p.layers.length === 1 ? p.layers[0]! : undefined;
  if (!layer) return null;
  if (layer.kind === 'effect') return effectSwatch(show, layer);
  const light = resolveColour(layer.colour, new Map(show.palettes.map((x) => [x.id, x])));
  return displayColour(light.hex, light);
}

/**
 * Off: one plain layer with no light in it, at 0 % or with no colour and no White, Amber or UV.
 * A black colour with White, Amber or UV (an amber-only colour, say) is a lit colour like any other.
 */
export const isOff = (p: Preset) => {
  if (p.layers.length !== 1 || p.layers[0]!.kind !== 'static') return false;
  const layer = p.layers[0]!;
  if (layer.intensity === 0) return true;
  const c = layer.colour;
  return 'hex' in c && /^#0{6}$/.test(c.hex) && !c.white && !c.amber && !c.uv;
};
/** One plain, lit layer: the only kind of colour the editor can recolour (never an effect). */
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

// ---- The effects list ----

export interface AddEffect {
  group: string;
  /** Empty = "Effect N", numbered after the group's own effects. */
  name: string;
  effect: EffectLayer;
}

/** Adds an effect to a group's effects list as a normal preset. Returns the new show and the preset's id. */
export function addEffect(show: Show, input: AddEffect): { show: Show; id: string } {
  const group = show.groups.find((g) => g.id === input.group);
  if (!group) throw new Error(`the show has no group "${input.group}"`);
  if (group.kind === 'smoke') throw new Error("smoke machines can't run effects");
  const out = structuredClone(show);
  const name = input.name.trim() ? cleanName(input.name) : nextName(out.presets.filter((p) => p.group === group.id), 'Effect');
  const id = uniqueId(`${group.id} ${name}`, out.presets.map((p) => p.id));
  out.presets.push({ id, name, group: group.id, layers: [structuredClone(input.effect)], fade: 3, swatch: effectSwatch(out, input.effect) });
  return { show: out, id };
}

export interface EditEffect {
  preset: string;
  effect: EffectLayer;
}

/** New settings for an effect in a group's list. Its name is changed with editColour, like a colour's. */
export function editEffect(show: Show, input: EditEffect): Show {
  const out = structuredClone(show);
  const target = out.presets.find((p) => p.id === input.preset);
  if (!target) throw new Error('that effect is not in the list');
  if (!isEffectPreset(target)) throw new Error('that is not an effect');
  if (target.custom) throw new Error("that effect can't be edited");
  const before = JSON.stringify([target.layers, target.swatch]);
  target.layers = [structuredClone(input.effect)];
  target.swatch = effectSwatch(out, input.effect);
  if (JSON.stringify([target.layers, target.swatch]) === before) throw new Error('nothing changed');
  return out;
}

/** The roles that repeat once per segment (as the engine's channel plan counts them). */
const SEGMENT_ROLES: readonly ChannelRole[] = ['red', 'green', 'blue', 'white', 'amber', 'uv'];

/** How many segments a fixture type has: the most times any colour role repeats, at least 1. */
export function profileSegments(profile: Profile): number {
  const seen = new Map<ChannelRole, number>();
  for (const c of profile.channels) {
    if (c.fine || !SEGMENT_ROLES.includes(c.role)) continue;
    seen.set(c.role, (seen.get(c.role) ?? 0) + 1);
  }
  return Math.max(1, ...seen.values());
}

/** The length of a group's line: the segments of all its fixtures (0 for a group the show doesn't have). */
export function groupSegments(show: Show, groupId: string): number {
  const group = show.groups.find((g) => g.id === groupId);
  let n = 0;
  for (const id of group?.fixtures ?? []) {
    const fixture = show.fixtures.find((f) => f.id === id);
    const profile = fixture ? findProfile(show, fixture.profile) : undefined;
    if (profile) n += profileSegments(profile);
  }
  return n;
}

/** A group with this many segments or more counts as the background and gets every ready-made effect. */
const BACKGROUND_SEGMENTS = 8;

interface ReadyMade {
  name: string;
  effect: EffectLayer['effect'];
  waves?: number;
  beats?: number;
}

const BACKGROUND_EFFECTS: ReadyMade[] = [
  { name: 'Colour fade', effect: 'colourFade', beats: 16 },
  { name: 'Wave', effect: 'wave' },
  { name: 'Three waves', effect: 'wave', waves: 3 },
  { name: 'Chase', effect: 'chase' },
  { name: 'Sparkle', effect: 'sparkle' },
  { name: 'Meteor', effect: 'meteor' },
  { name: 'Fill', effect: 'fill' },
  { name: 'Yo-yo', effect: 'yoyo' },
  { name: 'Breathe', effect: 'breathe' },
];

const OTHER_EFFECTS: ReadyMade[] = [
  { name: 'Colour fade', effect: 'colourFade', beats: 16 },
  { name: 'Breathe', effect: 'breathe' },
  { name: 'Wave', effect: 'wave' },
];

/**
 * True when a colour reads as a white rather than a colour: warm, neutral and cool whites and
 * pale tints (red, green and blue fairly close together), and black (only white light, or Off).
 */
function isWhitish(c: { hex: string }): boolean {
  const n = parseInt(c.hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const top = Math.max(...rgb);
  if (top === 0) return true;
  return (top - Math.min(...rgb)) / top < 0.7;
}

/** The first three coloured swatches of a group's list (not the whites, not Off), as the list gives them. */
function readyColours(show: Show, groupId: string, palettes: ReadonlyMap<string, Palette>): ColourSpec[] {
  const colours: ColourSpec[] = [];
  for (const p of show.presets) {
    if (colours.length === 3) break;
    if (p.group !== groupId || p.custom || !canRecolour(p)) continue;
    const layer = p.layers[0] as StaticLayer;
    // A colour of White, Amber or UV only (a black hex) is judged by how it looks.
    const c = resolveColour(layer.colour, palettes);
    if (layer.intensity <= 0 || isWhitish({ hex: displayColour(c.hex, c) })) continue;
    colours.push(structuredClone(layer.colour));
  }
  return colours;
}

/**
 * The first time a show runs with effects: adds the ready-made effects to every light group
 * whose line has more than one segment and that has at least two coloured swatches. Groups of
 * 8 segments or more (the background) get the whole set; the others a colour fade, breathe and
 * wave. Then `operator.effectsAdded` is set, so they are never added again (even once deleted).
 */
export function ensureEffects(show: Show): Show {
  const out = structuredClone(show);
  if (out.operator.effectsAdded) return out;
  const palettes = new Map(out.palettes.map((p) => [p.id, p]));
  for (const group of out.groups) {
    if (group.kind === 'smoke' || groupIsWhiteOnly(out, group.id)) continue;
    const segments = groupSegments(out, group.id);
    if (segments <= 1) continue;
    const colours = readyColours(out, group.id, palettes);
    if (colours.length < 2) continue;
    for (const made of segments >= BACKGROUND_SEGMENTS ? BACKGROUND_EFFECTS : OTHER_EFFECTS) {
      const effect: EffectLayer = {
        kind: 'effect', effect: made.effect, colours: structuredClone(colours), speed: { beats: made.beats ?? 4 },
        direction: 'ltr', waves: made.waves ?? 1, size: 0.5, edge: 'soft', intensity: 1,
      };
      const id = uniqueId(`${group.id} ${made.name}`, out.presets.map((p) => p.id));
      out.presets.push({ id, name: made.name, group: group.id, layers: [effect], fade: 3, swatch: effectSwatch(out, effect) });
    }
  }
  out.operator.effectsAdded = true;
  return out;
}
