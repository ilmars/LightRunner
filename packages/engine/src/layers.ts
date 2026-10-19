// Rendering a preset's layer stack for one segment. Every layer is a pure
// function of effect time, the segment's position in its group's line and its
// parameters. Phase 1 has static layers only; Phase 2 adds effects here.

import { resolveColour, type Layer, type Palette, type Preset } from '../../shared/src/index.ts';
import { copy, dark, fromHex, type Light } from './light.ts';

export interface LayerContext {
  /**
   * The segment's position in its group's line, 0-based. The line is the group's
   * fixtures in group order, each fixture's segments in order (backwards when the
   * fixture is reversed).
   */
  index: number;
  /** Number of segments in the group's line. */
  count: number;
  /** Effect time in seconds, already scaled by the speed dial. */
  time: number;
  /** This preset run's beat phase in beats: the stage tempo and the speed dial, counted from the run's start. */
  beats: number;
}

/** A layer with its colours looked up once, so rendering does no lookups. */
export type CompiledLayer = { kind: 'static'; light: Light };

export interface CompiledPreset {
  id: string;
  group: string;
  fade: number;
  layers: CompiledLayer[];
}

export function compilePreset(preset: Preset, palettes: ReadonlyMap<string, Palette>): CompiledPreset {
  return {
    id: preset.id,
    group: preset.group,
    fade: preset.fade,
    layers: preset.layers.map((l) => compileLayer(l, palettes)),
  };
}

function compileLayer(layer: Layer, palettes: ReadonlyMap<string, Palette>): CompiledLayer {
  const c = resolveColour(layer.colour, palettes);
  return { kind: 'static', light: fromHex(c.hex, c, layer.intensity) };
}

/** A preset that is not in the show: Safe's warm wash, or Blackout. */
export function fixedPreset(id: string, group: string, light: Light, fade: number): CompiledPreset {
  return { id, group, fade, layers: [{ kind: 'static', light }] };
}

export function renderPreset(out: Light, preset: CompiledPreset, _ctx: LayerContext): Light {
  // Layers render bottom to top. With static layers only, the top one covers
  // the rest; Phase 2b adds blend modes and opacity.
  const top = preset.layers[preset.layers.length - 1];
  if (!top) return copy(out, dark());
  return copy(out, top.light);
}
