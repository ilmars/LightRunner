// Rendering a preset's layer stack for one segment. Every layer is a pure
// function of its phase, the segment's position in its group's line and its
// parameters: static layers are one colour, effect layers move (effects.ts).

import { resolveColour, type Layer, type Palette, type Preset } from '../../shared/src/index.ts';
import { compileEffect, cyclesPerSecond, renderEffect, safeRate, type CompiledEffect, type SafeRates } from './effects.ts';
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
  /**
   * Each layer's phase in cycles (by layer index), advanced by advancePhases()
   * at the layer's safe rate. Missing counts as 0.
   */
  cycles: readonly number[];
}

/** A layer with its colours looked up once, so rendering does no lookups. */
export type CompiledLayer = { kind: 'static'; light: Light } | CompiledEffect;

export interface CompiledPreset {
  id: string;
  group: string;
  fade: number;
  layers: CompiledLayer[];
}

/** `rates` keeps effects' safe rates between compiles, so an unchanged effect isn't measured again. */
export function compilePreset(preset: Preset, palettes: ReadonlyMap<string, Palette>, rates?: SafeRates): CompiledPreset {
  return {
    id: preset.id,
    group: preset.group,
    fade: preset.fade,
    layers: preset.layers.map((l) => compileLayer(l, palettes, rates)),
  };
}

function compileLayer(layer: Layer, palettes: ReadonlyMap<string, Palette>, rates?: SafeRates): CompiledLayer {
  if (layer.kind === 'effect') return compileEffect(layer, palettes, rates);
  const c = resolveColour(layer.colour, palettes);
  return { kind: 'static', light: fromHex(c.hex, c, layer.intensity) };
}

/** A preset that is not in the show: Safe's warm wash, or Blackout. */
export function fixedPreset(id: string, group: string, light: Light, fade: number): CompiledPreset {
  return { id, group, fade, layers: [{ kind: 'static', light }] };
}

/** True when the preset shows an effect (its top layer), so its light moves by itself. */
export function moves(preset: CompiledPreset): boolean {
  return preset.layers[preset.layers.length - 1]?.kind === 'effect';
}

/**
 * Move each effect layer's phase on by `dt` seconds at its safe rate (the beats it
 * asks for at the stage tempo, or its seconds, with the speed dial; halved while it
 * would flash). The phase only ever grows by rate × time, so a tempo change, the
 * speed dial or light safety starting to slow an effect never makes it jump.
 */
export function advancePhases(cycles: number[], preset: CompiledPreset, dt: number, beatsPerSecond: number, speed: number): void {
  const layers = preset.layers;
  while (cycles.length < layers.length) cycles.push(0);
  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l]!;
    if (layer.kind === 'effect') cycles[l]! += dt * safeRate(layer, cyclesPerSecond(layer, beatsPerSecond, speed));
  }
}

export function renderPreset(out: Light, preset: CompiledPreset, ctx: LayerContext): Light {
  // Layers render bottom to top. For now the top one covers the rest; Phase 2b
  // adds blend modes and opacity.
  const n = preset.layers.length - 1;
  const top = preset.layers[n];
  if (!top) return copy(out, dark());
  if (top.kind === 'effect') return renderEffect(out, top, ctx, ctx.cycles[n] ?? 0);
  return copy(out, top.light);
}
