// Comparing a show with an incoming one (a show file or a Lightkey project)
// and merging only the changes someone picked. Items are matched by id.

import { presetsUsingPaletteEntry, swatchOf } from './presets.ts';
import { isEffectPreset, layerColours, parseShow, type ColourSpec, type Fixture, type Group, type Look, type Palette, type Preset, type Profile, type Show } from './schema.ts';

/** `palette`: the shared colours (from Lightkey) that colours in every group can point to. */
export type ItemKind = 'profile' | 'fixture' | 'group' | 'palette' | 'preset' | 'look';
export type Change = 'added' | 'changed' | 'removed';

export interface DiffItem {
  kind: ItemKind;
  id: string;
  change: Change;
  name: string;
  /** What changed, in plain words. */
  details: string[];
}

/** "patch" compares fixture types and fixtures only (e.g. a Lightkey project, which has no looks of ours). */
export type Scope = 'all' | 'patch';

export interface Pick {
  kind: ItemKind;
  id: string;
  change: Change;
}

type Item = Profile | Fixture | Group | Palette | Preset | Look;
const LISTS: Record<ItemKind, 'profiles' | 'fixtures' | 'groups' | 'palettes' | 'presets' | 'looks'> = {
  profile: 'profiles', fixture: 'fixtures', group: 'groups', palette: 'palettes', preset: 'presets', look: 'looks',
};
// Shared colours come before presets: a preset is checked against the shared colours it points to.
const ORDER: ItemKind[] = ['profile', 'fixture', 'group', 'palette', 'preset', 'look'];
const kindsFor = (scope: Scope): ItemKind[] => (scope === 'patch' ? ['profile', 'fixture'] : ORDER);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const list = (show: Show, kind: ItemKind) => show[LISTS[kind]] as Item[];

/** True when a preset's swatch is just what its colour (shared colours looked up in its own show) shows. */
const swatchFollows = (show: Show, p: Preset) => p.swatch !== undefined && p.swatch === swatchOf(show, p);

/**
 * What is compared of an item.
 * - Whether a group is a smoke machine belongs to this installation: show files and
 *   Lightkey projects don't know about smoke, and every group in them reads as a light.
 *   So an import never changes it, and it is never shown as a difference.
 * - A preset's swatch that only follows a shared colour is left out: the shared colour is
 *   compared on its own, and taking it brings the swatch along.
 * - A fixture is compared field by field, whatever order its fields are in (see takenFixture).
 */
const comparable = (kind: ItemKind, x: Item, show: Show): unknown => {
  if (kind === 'fixture') return Object.entries(x).filter(([, v]) => v !== undefined).sort(([k1], [k2]) => (k1 < k2 ? -1 : 1));
  if (kind === 'group') {
    const { kind: _ignored, ...rest } = x as Group;
    return rest;
  }
  if (kind === 'preset' && swatchFollows(show, x as Preset)) {
    const { swatch: _ignored, ...rest } = x as Preset;
    return rest;
  }
  return x;
};
const sameItem = (kind: ItemKind, a: Item, b: Item, show: Show, incoming: Show) => same(comparable(kind, a, show), comparable(kind, b, incoming));

/**
 * What our fixture becomes when the file's one is taken. Its shape on the stage plan belongs to this
 * installation, like a group's smoke setting: a file whose fixture has no shape, angle or reach (every
 * Lightkey project) keeps ours, and an outline keeps its size too, since a size from Lightkey means a line.
 */
function takenFixture(ours: Fixture, theirs: Fixture): Fixture {
  if (theirs.shape !== undefined || theirs.angle !== undefined || theirs.reach !== undefined) return theirs;
  const kept: Partial<Fixture> = { shape: ours.shape, angle: ours.angle, reach: ours.reach };
  if (ours.shape === 'outline') Object.assign(kept, { w: ours.w, h: ours.h });
  const out = { ...theirs };
  for (const [k, v] of Object.entries(kept)) {
    if (v === undefined) delete out[k as keyof Fixture];
    else Object.assign(out, { [k]: v });
  }
  return out;
}

/** "colour 8 (Zils)": a shared colour, numbered from 1, with the names of the colours that point to it. */
function sharedColourLabel(show: Show, incoming: Show, palette: string, index: number): string {
  const names: string[] = [];
  for (const s of [show, incoming]) {
    for (const p of presetsUsingPaletteEntry(s, palette, index)) {
      if (!p.custom && !isEffectPreset(p) && !names.includes(p.name)) names.push(p.name);
    }
  }
  const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ' and more' : '');
  return `colour ${index + 1}${names.length ? ` (${shown})` : ''}`;
}

function describe(kind: ItemKind, a: Item, b: Item, show: Show, incoming: Show): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`name "${a.name}" → "${b.name}"`);
  switch (kind) {
    case 'profile': {
      const pa = a as Profile, pb = b as Profile;
      if (pa.channels.length !== pb.channels.length) out.push(`${pa.channels.length} → ${pb.channels.length} channels`);
      else if (!same(pa.channels, pb.channels)) out.push('channel layout changed');
      break;
    }
    case 'fixture': {
      const fa = a as Fixture, fb = b as Fixture;
      if (fa.profile !== fb.profile) out.push(`type ${fa.profile} → ${fb.profile}`);
      if (fa.universe !== fb.universe || fa.address !== fb.address) out.push(`address ${fa.universe}/${fa.address} → ${fb.universe}/${fb.address}`);
      if (fa.x !== fb.x || fa.y !== fb.y || fa.w !== fb.w || fa.h !== fb.h) out.push('moved on the stage plan');
      if (fa.shape !== fb.shape || fa.angle !== fb.angle || fa.reach !== fb.reach) out.push('changed on the stage plan');
      if (fa.gamma !== fb.gamma) out.push('dimming curve changed');
      if (!!fa.reversed !== !!fb.reversed) out.push(fb.reversed ? 'reversed on' : 'reversed off');
      break;
    }
    case 'group': {
      const ga = a as Group, gb = b as Group;
      const nameOf = (s: Show, id: string) => s.fixtures.find((f) => f.id === id)?.name ?? id;
      const added = gb.fixtures.filter((f) => !ga.fixtures.includes(f));
      const removed = ga.fixtures.filter((f) => !gb.fixtures.includes(f));
      if (added.length) out.push(`adds ${added.map((f) => nameOf(incoming, f)).join(', ')}`);
      if (removed.length) out.push(`drops ${removed.map((f) => nameOf(show, f)).join(', ')}`);
      if (!added.length && !removed.length && !same(ga.fixtures, gb.fixtures)) out.push('fixture order changed');
      break;
    }
    case 'palette': {
      const ca = (a as Palette).colours, cb = (b as Palette).colours;
      for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
        const x = ca[i], y = cb[i];
        const label = sharedColourLabel(show, incoming, a.id, i);
        if (!x) out.push(`adds ${label} ${y!.hex.toLowerCase()}`);
        else if (!y) out.push(`drops ${label}`);
        else {
          const parts: string[] = [];
          if (x.hex.toLowerCase() !== y.hex.toLowerCase()) parts.push(`${x.hex.toLowerCase()} → ${y.hex.toLowerCase()}`);
          if ((x.white ?? 0) !== (y.white ?? 0) || (x.amber ?? 0) !== (y.amber ?? 0) || (x.uv ?? 0) !== (y.uv ?? 0)) parts.push('white, amber or UV changed');
          if (parts.length) out.push(`${label} ${parts.join(', ')}`);
        }
      }
      break;
    }
    case 'preset': {
      const pa = a as Preset, pb = b as Preset;
      if (!same(pa.layers, pb.layers)) out.push(isEffectPreset(pa) || isEffectPreset(pb) ? 'effect changed' : 'colour or level changed');
      else if (pa.swatch !== pb.swatch && !(swatchFollows(show, pa) && swatchFollows(incoming, pb))) out.push(`button colour ${pa.swatch ?? 'none'} → ${pb.swatch ?? 'none'}`);
      if (pa.fade !== pb.fade) out.push(`fade ${pa.fade} s → ${pb.fade} s`);
      if (pa.group !== pb.group) out.push(`group ${pa.group} → ${pb.group}`);
      break;
    }
    case 'look': {
      const la = a as Look, lb = b as Look;
      if (!same(la.groups, lb.groups)) out.push('presets changed');
      if (la.section !== lb.section) out.push(`section "${la.section ?? ''}" → "${lb.section ?? ''}"`);
      break;
    }
  }
  if (!out.length) out.push('details changed');
  return out;
}

/** Everything that differs between the current show and an incoming one. */
export function diffShows(current: Show, incoming: Show, scope: Scope = 'all'): DiffItem[] {
  const items: DiffItem[] = [];
  for (const kind of kindsFor(scope)) {
    const now = new Map(list(current, kind).map((x) => [x.id, x]));
    const next = new Map(list(incoming, kind).map((x) => [x.id, x]));
    // Presets share names across groups ("Zils"), so they are shown with their group.
    const label = (x: Item, s: Show) => {
      if (kind !== 'preset') return x.name;
      const group = (x as Preset).group;
      return `${s.groups.find((g) => g.id === group)?.name ?? group}: ${x.name}`;
    };
    for (const [id, file] of next) {
      const a = now.get(id);
      // What taking it would give: for a fixture, the file's one with our shape where the file has none.
      const b = a && kind === 'fixture' ? takenFixture(a as Fixture, file as Fixture) : file;
      if (!a) items.push({ kind, id, change: 'added', name: label(b, incoming), details: [] });
      else if (!sameItem(kind, a, b, current, incoming)) items.push({ kind, id, change: 'changed', name: label(b, incoming), details: describe(kind, a, b, current, incoming) });
    }
    for (const [id, a] of now) {
      if (!next.has(id)) items.push({ kind, id, change: 'removed', name: label(a, current), details: [] });
    }
  }
  return items;
}

/**
 * The current show with only the picked changes taken from `incoming`.
 * Removing something also removes what depends on it (a removed fixture
 * leaves its groups, a removed group takes its presets). A taken preset, and
 * every preset pointing to a taken shared colour, gets the swatch of the
 * shared colour it now points to. Throws with a readable message if the
 * result would be broken.
 */
export function applyPicks(current: Show, incoming: Show, picks: Pick[]): Show {
  const out: Show = structuredClone(current);
  const sorted = [...picks].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  for (const p of sorted) {
    const key = LISTS[p.kind];
    const items = out[key] as Item[];
    if (p.change === 'removed') {
      (out[key] as Item[]) = items.filter((x) => x.id !== p.id);
      cascadeRemove(out, p.kind, p.id);
      continue;
    }
    const item = (list(incoming, p.kind)).find((x) => x.id === p.id);
    if (!item) throw new Error(`the file has no ${p.kind} "${p.id}"`);
    const k = items.findIndex((x) => x.id === p.id);
    if (k >= 0) {
      const taken = structuredClone(p.kind === 'fixture' ? takenFixture(items[k] as Fixture, item as Fixture) : item);
      // A smoke group stays a smoke group (and a light group a light group), whatever the file says.
      if (p.kind === 'group') (taken as Group).kind = (items[k] as Group).kind;
      items[k] = taken;
    } else {
      items.push(structuredClone(item));
      // New groups and looks show up on the operator page too.
      if (p.kind === 'group' && out.operator.groups.length) out.operator.groups.push(p.id);
      if (p.kind === 'look' && out.operator.looks.length) out.operator.looks.push(p.id);
    }
  }
  // Swatches agree with the shared colours they end up pointing to (the same rule as the colour editor).
  const taken = (kind: ItemKind) => new Set(picks.filter((p) => p.kind === kind && p.change !== 'removed').map((p) => p.id));
  const palettes = taken('palette'), presets = taken('preset');
  const points = (c: ColourSpec) => 'palette' in c;
  for (const p of out.presets) {
    const layer = p.layers.length === 1 ? p.layers[0]! : undefined;
    if (!layer) continue;
    const specs = layerColours(layer);
    if (!specs.some(points)) continue;
    if (presets.has(p.id) || specs.some((c) => 'palette' in c && palettes.has(c.palette))) p.swatch = swatchOf(out, p) ?? p.swatch;
  }
  try {
    return parseShow(out);
  } catch (err) {
    throw new Error(`Those changes don't fit together: ${(err as Error).message.replace(/^Show has broken references:\n- /, '').split('\n- ').join('; ')}. Tick what they depend on too.`);
  }
}

function cascadeRemove(show: Show, kind: ItemKind, id: string): void {
  switch (kind) {
    case 'profile':
      if (show.fixtures.some((f) => f.profile === id)) throw new Error(`fixture type "${id}" is still used by fixtures; remove those too`);
      break;
    case 'fixture':
      for (const g of show.groups) g.fixtures = g.fixtures.filter((f) => f !== id);
      break;
    case 'group':
      for (const p of show.presets.filter((x) => x.group === id)) cascadeRemove(show, 'preset', p.id);
      show.presets = show.presets.filter((x) => x.group !== id);
      for (const l of show.looks) l.groups = l.groups.filter((e) => e.group !== id);
      show.operator.groups = show.operator.groups.filter((g) => g !== id);
      break;
    case 'preset':
      for (const l of show.looks) l.groups = l.groups.filter((e) => e.preset !== id);
      break;
    case 'look':
      show.operator.looks = show.operator.looks.filter((l) => l !== id);
      show.operator.runningOrder = show.operator.runningOrder.filter((l) => l !== id);
      show.operator.quickLooks = show.operator.quickLooks.filter((q) => q.look !== id);
      if (show.operator.safeLook === id) show.operator.safeLook = undefined;
      break;
  }
}
