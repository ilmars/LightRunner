// What the operator page needs to draw its buttons and mini visualiser.

import type { Show } from '../../packages/shared/src/index.ts';

export interface OperatorLook {
  id: string;
  name: string;
  swatch: string | null;
  section: string | null;
  /** Colour this look gives each operator group (same order as `groups`); null = left alone. */
  colours: (string | null)[];
}

export interface OperatorGroup {
  id: string;
  name: string;
  presets: { id: string; name: string; swatch: string | null }[];
}

export interface OperatorLayout {
  show: string;
  looks: OperatorLook[];
  groups: OperatorGroup[];
  /** In the same order as the bytes of each visualiser frame. */
  fixtures: { id: string; name: string; x: number; y: number; w: number | null; h: number | null }[];
  /** Fixture ids of each group, for tapping a group on the mini visualiser. */
  members: Record<string, string[]>;
  manualForOperators: boolean;
}

export function operatorLayout(show: Show, fixtureOrder: string[]): OperatorLayout {
  const lookIds = show.operator.looks.length ? show.operator.looks : show.looks.map((l) => l.id);
  const groupIds = show.operator.groups.length ? show.operator.groups : show.groups.map((g) => g.id);
  const byId = new Map(show.fixtures.map((f) => [f.id, f]));
  const presetById = new Map(show.presets.map((p) => [p.id, p]));
  return {
    show: show.name,
    looks: lookIds.flatMap((id) => {
      const l = show.looks.find((x) => x.id === id);
      if (!l) return [];
      const colours = groupIds.map((gid) => {
        const entry = l.groups.find((e) => e.group === gid);
        const preset = entry ? presetById.get(entry.preset) : undefined;
        if (!preset) return null;
        const lit = preset.layers.some((layer) => layer.intensity > 0);
        return lit ? preset.swatch ?? '#888888' : '#000000';
      });
      return [{ id: l.id, name: l.name, swatch: l.swatch ?? null, section: l.section ?? null, colours }];
    }),
    groups: groupIds.flatMap((id) => {
      const g = show.groups.find((x) => x.id === id);
      if (!g) return [];
      const presets = show.presets
        .filter((p) => p.group === id)
        .map((p) => ({ id: p.id, name: p.name, swatch: p.swatch ?? null }));
      return [{ id: g.id, name: g.name, presets }];
    }),
    fixtures: fixtureOrder.flatMap((id) => {
      const f = byId.get(id);
      return f ? [{ id, name: f.name, x: f.x, y: f.y, w: f.w ?? null, h: f.h ?? null }] : [];
    }),
    members: Object.fromEntries(show.groups.map((g) => [g.id, g.fixtures])),
    manualForOperators: show.operator.manualForOperators,
  };
}
