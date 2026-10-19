// What the operator page needs to draw its buttons and mini visualiser.

import { SAFE_LIGHT, canRecolour, findProfile, groupIsWhiteOnly, presetUsers, resolveColour } from '../../packages/shared/src/index.ts';
import type { ChannelRole, GroupKind, Palette, PaletteColour, Preset, QuickTab, Show } from '../../packages/shared/src/index.ts';
import { planChannels } from '../../packages/engine/src/index.ts';

export interface OperatorLook {
  id: string;
  name: string;
  swatch: string | null;
  section: string | null;
  /** Colour this look gives each operator group (same order as `groups`); null = left alone (always for smoke groups). */
  colours: (string | null)[];
  /** Level this look gives each operator group (same order as `groups`); null = no level of its own (always for smoke groups). */
  levels: (number | null)[];
  /** What this look gives each operator group (same order as `groups`); null = not set (always for smoke groups). */
  entries: (OperatorEntry | null)[];
}

/** One group's colour in a look, with what the editor needs to show it. */
export interface OperatorEntry {
  preset: string;
  /** The preset's name ("Custom" for an Any colour pick). */
  name: string;
  /** The same colour as the look's `colours` entry for this group. */
  swatch: string;
  light: LiveLight | null;
}

export interface OperatorGroup {
  id: string;
  name: string;
  /** A smoke group is a smoke or haze machine: a level and Puff, no colour and no Flash. */
  kind: GroupKind;
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
  /** The running-order items and quick looks that use the colour, for the editor. */
  usedBy: string[];
  /** False for Off and multi-layer presets, which the editor can rename but not recolour. */
  canRecolour: boolean;
  /**
   * The preset as an Any colour pick would make it: its top layer's colour,
   * white, amber and UV, scaled by the layer's intensity (null if it has no layers).
   */
  light: LiveLight | null;
}

/** A light as an Any colour pick would make it: #rrggbb and white, amber and UV 0..1, intensity included. */
export interface LiveLight {
  hex: string;
  white: number;
  amber: number;
  uv: number;
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
  /** The engine's own Basic light (a group Basic lights doesn't list), as an Any colour pick would make it. */
  basicLight: LiveLight;
  /** The colour pages draw for the built-in Basic light. */
  basicSwatch: string;
  /**
   * In the same order as the bytes of each visualiser frame: 3 bytes per segment,
   * `segments` of them for each fixture. `reversed` fixtures run backwards along a group's line.
   */
  fixtures: { id: string; name: string; x: number; y: number; w: number | null; h: number | null; segments: number; reversed: boolean }[];
  /** Fixture ids of each group, for tapping a group on the mini visualiser. */
  members: Record<string, string[]>;
  manualForOperators: boolean;
}

export function operatorLayout(show: Show, fixtureOrder: string[]): OperatorLayout {
  const lookIds = show.operator.looks.length ? show.operator.looks : show.looks.map((l) => l.id);
  const groupIds = show.operator.groups.length ? show.operator.groups : show.groups.map((g) => g.id);
  const byId = new Map(show.fixtures.map((f) => [f.id, f]));
  const presetById = new Map(show.presets.map((p) => [p.id, p]));

  const smoke = new Set(show.groups.filter((g) => g.kind === 'smoke').map((g) => g.id));
  const palettes = new Map<string, Palette>(show.palettes.map((p) => [p.id, p]));

  const describe = (id: string): OperatorLook[] => {
    const l = show.looks.find((x) => x.id === id);
    if (!l) return [];
    // A look never sets a smoke group, even one an import listed.
    const picked = groupIds.map((gid) => (smoke.has(gid) ? undefined : l.groups.find((e) => e.group === gid)));
    const colours = picked.map((entry) => {
      const preset = entry ? presetById.get(entry.preset) : undefined;
      if (!preset) return null;
      const lit = preset.layers.some((layer) => layer.intensity > 0);
      return lit ? preset.swatch ?? '#888888' : '#000000';
    });
    const levels = picked.map((entry) => entry?.level ?? null);
    const entries = picked.map((entry, k): OperatorEntry | null => {
      const preset = entry ? presetById.get(entry.preset) : undefined;
      if (!entry || !preset) return null;
      return { preset: preset.id, name: preset.name, swatch: colours[k]!, light: presetLight(preset, palettes) };
    });
    return [{ id: l.id, name: l.name, swatch: l.swatch ?? null, section: l.section ?? null, colours, levels, entries }];
  };

  const hasRole = (fixtureId: string, roles: ChannelRole[]): boolean => {
    const f = byId.get(fixtureId);
    const profile = f ? findProfile(show, f.profile) : undefined;
    return !!profile?.channels.some((c) => roles.includes(c.role));
  };

  return {
    show: show.name,
    looks: lookIds.flatMap(describe),
    runningOrder: show.operator.runningOrder.flatMap(describe),
    quickLooks: show.operator.quickLooks.flatMap((q) => describe(q.look).map((l) => ({ ...l, tab: q.tab }))),
    basicLights: show.operator.safeLook ?? null,
    basicLight: liveLight(SAFE_LIGHT, SAFE_LIGHT.intensity),
    basicSwatch: SAFE_LIGHT.hex,
    groups: groupIds.flatMap((id) => {
      const g = show.groups.find((x) => x.id === id);
      if (!g) return [];
      const presets = show.presets
        .filter((p) => p.group === id && !p.custom)
        .map((p) => ({
          id: p.id, name: p.name, swatch: p.swatch ?? null,
          usedBy: presetUsers(show, p.id), canRecolour: canRecolour(p), light: presetLight(p, palettes),
        }));
      const any = (roles: ChannelRole[]) => g.fixtures.some((f) => hasRole(f, roles));
      return [{
        id: g.id, name: g.name, kind: g.kind, whiteOnly: groupIsWhiteOnly(show, g.id),
        extras: { white: any(['white']), amber: any(['amber']), uv: any(['uv']) },
        presets,
      }];
    }),
    fixtures: fixtureOrder.flatMap((id) => {
      const f = byId.get(id);
      const profile = f ? findProfile(show, f.profile) : undefined;
      if (!f || !profile) return [];
      const segments = planChannels(f, profile, show.settings.gamma).cells;
      return [{ id, name: f.name, x: f.x, y: f.y, w: f.w ?? null, h: f.h ?? null, segments, reversed: f.reversed ?? false }];
    }),
    members: Object.fromEntries(show.groups.map((g) => [g.id, g.fixtures])),
    manualForOperators: show.operator.manualForOperators,
  };
}

function presetLight(preset: Preset, palettes: ReadonlyMap<string, Palette>): OperatorPreset['light'] {
  const top = preset.layers[preset.layers.length - 1];
  if (!top) return null;
  return liveLight(resolveColour(top.colour, palettes), top.intensity);
}

function liveLight(c: PaletteColour, k: number): LiveLight {
  const n = parseInt(c.hex.slice(1), 16);
  const hex = `#${[16, 8, 0].map((s) => Math.round(((n >> s) & 255) * k).toString(16).padStart(2, '0')).join('')}`;
  const level = (v: number | undefined) => Math.round((v ?? 0) * k * 1000) / 1000;
  return { hex, white: level(c.white), amber: level(c.amber), uv: level(c.uv) };
}
