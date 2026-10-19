// Comparing a show with an incoming one (a show file or a Lightkey project)
// and merging only the changes someone picked. Items are matched by id.

import { parseShow, type Fixture, type Group, type Look, type Preset, type Profile, type Show } from './schema.ts';

export type ItemKind = 'profile' | 'fixture' | 'group' | 'preset' | 'look';
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

type Item = Profile | Fixture | Group | Preset | Look;
const LISTS: Record<ItemKind, 'profiles' | 'fixtures' | 'groups' | 'presets' | 'looks'> = {
  profile: 'profiles', fixture: 'fixtures', group: 'groups', preset: 'presets', look: 'looks',
};
const ORDER: ItemKind[] = ['profile', 'fixture', 'group', 'preset', 'look'];
const kindsFor = (scope: Scope): ItemKind[] => (scope === 'patch' ? ['profile', 'fixture'] : ORDER);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const list = (show: Show, kind: ItemKind) => show[LISTS[kind]] as Item[];

/**
 * Whether a group is a smoke machine belongs to this installation: show files and
 * Lightkey projects don't know about smoke, and every group in them reads as a light.
 * So an import never changes it, and it is never shown as a difference.
 */
const withoutKind = (kind: ItemKind, x: Item): unknown => {
  if (kind !== 'group') return x;
  const { kind: _ignored, ...rest } = x as Group;
  return rest;
};
const sameItem = (kind: ItemKind, a: Item, b: Item) => same(withoutKind(kind, a), withoutKind(kind, b));

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
      if (fa.gamma !== fb.gamma) out.push('dimming curve changed');
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
    case 'preset': {
      const pa = a as Preset, pb = b as Preset;
      if (!same(pa.layers, pb.layers)) out.push('colour or level changed');
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
    for (const [id, b] of next) {
      const a = now.get(id);
      if (!a) items.push({ kind, id, change: 'added', name: label(b, incoming), details: [] });
      else if (!sameItem(kind, a, b)) items.push({ kind, id, change: 'changed', name: label(b, incoming), details: describe(kind, a, b, current, incoming) });
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
 * leaves its groups, a removed group takes its presets). Throws with a
 * readable message if the result would be broken.
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
      const taken = structuredClone(item);
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
