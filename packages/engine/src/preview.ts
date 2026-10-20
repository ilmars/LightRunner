// Pictures that never touch the stage: a look as it looks once settled (for the
// Preview page), and an effect moving along a group's line (for the effect editor).

import { findProfile, type EffectLayer, type EffectKind, type Palette, type Show } from '../../shared/src/index.ts';
import { compileEffect, cyclesPerSecond, renderEffect, safeRate } from './effects.ts';
import { Engine } from './engine.ts';
import { dark, withoutUv } from './light.ts';
import { planChannels, visualOf } from './output.ts';

/** Seconds after the look starts (the engine runs on seconds): far past any fade or ramp, so everything has settled. */
const SETTLED = 60;

/**
 * The look at rest, as the visualiser draws it: 3 bytes (RGB) per segment, fixtures in
 * show order (the same order as the engine's fixtures), each fixture's segments in order.
 * Master is 1, so nothing is dimmed, and a group the look doesn't set stays dark. The safe
 * look runs as Basic lights does.
 */
export function settledVisual(show: Show, lookId: string): Uint8Array {
  const engine = new Engine(show, 0);
  if (lookId === show.operator.safeLook) engine.apply({ type: 'safe' }, 0);
  else engine.apply({ type: 'look', id: lookId, fade: 0 }, 0);
  engine.frame(0);
  // The visual buffer belongs to the engine, so keep a copy.
  return Uint8Array.from(engine.frame(SETTLED).visual);
}

export interface EffectFramesOptions {
  /** Stage tempo in beats per minute. */
  bpm: number;
  /** The speed dial (1 is as set). */
  speed: number;
  /** About this many frames a second (20). */
  fps?: number;
  /** The loop is at most this long, in seconds (8). */
  seconds?: number;
}

export interface EffectFrames {
  /** Frames a second to play them at: near the asked rate, so the loop takes exactly its time. */
  fps: number;
  /** How many frames the loop has. */
  count: number;
  /** Segments in the group's line. */
  segments: number;
  /** Each fixture's segments, in group order (the line's order), so a drawing can leave gaps between fixtures. */
  fixtures: number[];
  /** The rate the effect runs at, in cycles per second: its speed at this tempo and speed dial, slowed by light safety. */
  rate: number;
  /** 3 bytes (RGB, as the visualiser draws them) per segment of the line, frame after frame. */
  frames: Uint8Array;
}

/**
 * How many cycles the effect takes to come back to exactly where it started. Effects that
 * go through their colours one a cycle need a cycle for each colour; sparkle never repeats.
 */
function repeatCycles(kind: EffectKind, colours: number): number {
  switch (kind) {
    case 'colourFade': case 'chase': case 'fill': case 'breathe': return colours;
    case 'wave': case 'meteor': case 'yoyo': return 1;
    case 'sparkle': return Infinity;
  }
}

/**
 * An effect running on a group's line, as the engine would run it there and the visualiser
 * would draw it: the group's fixtures in group order, each fixture's segments in order
 * (backwards when it is reversed), at the stage tempo and speed dial, slowed by light
 * safety as on stage. Master and the group's level are full. It loops: whole repeats of
 * the effect when they fit in `seconds`, else whole cycles, else just `seconds` of it.
 * Returns a refusal, in plain words, for an unknown group or a smoke machine.
 */
export function effectFrames(show: Show, groupId: string, effect: EffectLayer, opts: EffectFramesOptions): EffectFrames | string {
  const group = show.groups.find((g) => g.id === groupId);
  if (!group) return `unknown group "${groupId}"`;
  if (group.kind === 'smoke') return "smoke machines can't run effects";
  const fps = opts.fps ?? 20;
  const longest = opts.seconds ?? 8;

  // The line, as the engine makes it. A fixture without a known type has no segments there either;
  // one that is also in a smoke group is a smoke machine and shows dark.
  const smoke = new Set(show.groups.filter((g) => g.kind === 'smoke').flatMap((g) => g.fixtures));
  const parts: { cells: number; hasUv: boolean; smoke: boolean }[] = [];
  for (const id of group.fixtures) {
    const fixture = show.fixtures.find((f) => f.id === id);
    const profile = fixture ? findProfile(show, fixture.profile) : undefined;
    if (!fixture || !profile) continue;
    const plan = planChannels(fixture, profile, show.settings.gamma);
    parts.push({ cells: plan.cells, hasUv: plan.hasUv, smoke: smoke.has(id) });
  }
  const segments = parts.reduce((n, p) => n + p.cells, 0);

  const palettes = new Map<string, Palette>(show.palettes.map((p) => [p.id, p]));
  const fx = compileEffect(effect, palettes);
  const rate = safeRate(fx, cyclesPerSecond(fx, (opts.bpm / 60) * opts.speed, opts.speed));

  // The loop, in cycles.
  let cycles = 0;
  if (rate > 0 && Number.isFinite(rate)) {
    const fit = longest * rate;
    const repeat = repeatCycles(fx.effect, fx.colours.length);
    if (repeat <= fit) cycles = repeat * Math.floor(fit / repeat);
    else cycles = fit >= 1 ? Math.floor(fit) : fit;
  }
  const seconds = cycles > 0 ? cycles / rate : 0;
  const count = Math.max(1, Math.min(Math.round(longest * fps), Math.round(seconds * fps)));

  const frames = new Uint8Array(count * segments * 3);
  const light = dark();
  const at = { index: 0, count: segments };
  for (let f = 0; f < count; f++) {
    const phase = (cycles * f) / count;
    // Frame by line position, so a reversed fixture's segments come out mirrored: the line's
    // position k is its segment cells − 1 − k, as on stage.
    let start = 0;
    for (const p of parts) {
      for (let c = 0; c < p.cells && !p.smoke; c++) {
        at.index = start + c;
        renderEffect(light, fx, at, phase);
        if (!p.hasUv) withoutUv(light);
        visualOf(light, frames, (f * segments + start + c) * 3);
      }
      start += p.cells;
    }
  }
  return { fps: seconds > 0 ? count / seconds : fps, count, segments, fixtures: parts.map((p) => p.cells), rate, frames };
}
