// What the operator page needs to draw its buttons and mini visualiser.

import { findProfile, resolveColour } from '../../packages/shared/src/index.ts';
import type { ChannelRole, Palette, Preset, QuickTab, Show } from '../../packages/shared/src/index.ts';

export interface OperatorLook {
  id: string;
  name: string;
  swatch: string | null;
  section: string | null;
  /** Colour this look gives each operator group (same order as `groups`); null = left alone. */
  colours: (string | null)[];
  /** Level this look gives each operator group (same order as `groups`); null = no level of its own. */
  levels: (number | null)[];
}

export interface OperatorGroup {
  id: string;
  name: string;
  /** True when no fixture in the group can make colour, so the colour picker has nothing to do. */
  whiteOnly: boolean;
  /** Which extra channels some fixture in the group has, for the White, Amber and UV sliders. */
  extras: { white: boolean; amber: boolean; uv: boolean };
  presets: OperatorPreset[];
}

export interface OperatorPreset {
  id: string;
  name: string;
  swatch: string | null;
  /**
   * The preset as an Any colour pick would make it: its top layer's colour,
   * white, amber and UV, scaled by the layer's intensity (null if it has no layers).
   */
  light: { hex: string; white: number; amber: number; uv: number } | null;
}

export interface OperatorLayout {
  show: string;
  looks: OperatorLook[];
  /** The looks of the service, in order. The first is usually Basic lights. */
  runningOrder: OperatorLook[];
  /** Looks kept close at hand for the Quick looks tabs. */
  quickLooks: (OperatorLook & { tab: QuickTab })[];
  /** Id of the safe look (Basic lights), or null when the show has none. */
  basicLights: string | null;
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

  const describe = (id: string): OperatorLook[] => {
    const l = show.looks.find((x) => x.id === id);
    if (!l) return [];
    const entries = groupIds.map((gid) => l.groups.find((e) => e.group === gid));
    const colours = entries.map((entry) => {
      const preset = entry ? presetById.get(entry.preset) : undefined;
      if (!preset) return null;
      const lit = preset.layers.some((layer) => layer.intensity > 0);
      return lit ? preset.swatch ?? '#888888' : '#000000';
    });
    const levels = entries.map((entry) => entry?.level ?? null);
    return [{ id: l.id, name: l.name, swatch: l.swatch ?? null, section: l.section ?? null, colours, levels }];
  };

  const hasRole = (fixtureId: string, roles: ChannelRole[]): boolean => {
    const f = byId.get(fixtureId);
    const profile = f ? findProfile(show, f.profile) : undefined;
    return !!profile?.channels.some((c) => roles.includes(c.role));
  };
  const palettes = new Map<string, Palette>(show.palettes.map((p) => [p.id, p]));

  return {
    show: show.name,
    looks: lookIds.flatMap(describe),
    runningOrder: show.operator.runningOrder.flatMap(describe),
    quickLooks: show.operator.quickLooks.flatMap((q) => describe(q.look).map((l) => ({ ...l, tab: q.tab }))),
    basicLights: show.operator.safeLook ?? null,
    groups: groupIds.flatMap((id) => {
      const g = show.groups.find((x) => x.id === id);
      if (!g) return [];
      const presets = show.presets
        .filter((p) => p.group === id && !p.custom)
        .map((p) => ({ id: p.id, name: p.name, swatch: p.swatch ?? null, light: presetLight(p, palettes) }));
      const any = (roles: ChannelRole[]) => g.fixtures.some((f) => hasRole(f, roles));
      return [{
        id: g.id, name: g.name, whiteOnly: !any(['red', 'green', 'blue']),
        extras: { white: any(['white']), amber: any(['amber']), uv: any(['uv']) },
        presets,
      }];
    }),
    fixtures: fixtureOrder.flatMap((id) => {
      const f = byId.get(id);
      return f ? [{ id, name: f.name, x: f.x, y: f.y, w: f.w ?? null, h: f.h ?? null }] : [];
    }),
    members: Object.fromEntries(show.groups.map((g) => [g.id, g.fixtures])),
    manualForOperators: show.operator.manualForOperators,
  };
}

function presetLight(preset: Preset, palettes: ReadonlyMap<string, Palette>): OperatorPreset['light'] {
  const top = preset.layers[preset.layers.length - 1];
  if (!top) return null;
  const c = resolveColour(top.colour, palettes);
  const k = top.intensity;
  const n = parseInt(c.hex.slice(1), 16);
  const hex = `#${[16, 8, 0].map((s) => Math.round(((n >> s) & 255) * k).toString(16).padStart(2, '0')).join('')}`;
  const level = (v: number | undefined) => Math.round((v ?? 0) * k * 1000) / 1000;
  return { hex, white: level(c.white), amber: level(c.amber), uv: level(c.uv) };
}
