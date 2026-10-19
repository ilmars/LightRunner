// Effect layers: moving patterns along a group's line of segments, the
// 3-swings-a-second light-safety rule, and how effects fade like any look.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EffectLayer, findProfile, parseShow, type Preset, type Show } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { compileEffect, cyclesPerSecond, renderEffect, safeRate, type CompiledEffect } from '../src/effects.ts';
import { dark, type Light } from '../src/light.ts';
import { planChannels, visibleLevel } from '../src/output.ts';
import { FRAME, beyondOwnMotion, segmentsOf } from './helpers.ts';

const RED = { hex: '#ff0000' };
const BLUE = { hex: '#0000ff' };
const GREEN = { hex: '#00ff00' };
const DIM = { hex: '#202020' };

type EffectInput = Partial<Omit<EffectLayer, 'kind'>> & Pick<EffectLayer, 'effect'>;

function fx(input: EffectInput): CompiledEffect {
  return compileEffect(EffectLayer.parse({ kind: 'effect', colours: [RED], speed: { beats: 4 }, ...input }), new Map());
}

function at(f: CompiledEffect, index: number, count: number, phase: number): Light {
  return renderEffect(dark(), f, { index, count }, phase);
}

/** Brightness of every segment of a line at one moment. */
function line(f: CompiledEffect, count: number, phase: number): number[] {
  return Array.from({ length: count }, (_, k) => at(f, k, count, phase).i);
}

// ---- The maths of single effects ----

test('a soft one-colour wave differs along a 32-segment line', () => {
  const wave = fx({ effect: 'wave', edge: 'soft' });
  for (const phase of [0, 0.3, 0.5, 2.75]) {
    const a = at(wave, 0, 32, phase).i, b = at(wave, 8, 32, phase).i;
    assert.ok(Math.abs(a - b) > 0.2, `phase ${phase}: segment 1 at ${a}, segment 9 at ${b}`);
  }
  // It rolls: one segment goes through dark and full once a cycle.
  const seen = Array.from({ length: 100 }, (_, n) => at(wave, 5, 32, n / 100).i);
  assert.ok(Math.min(...seen) < 0.01 && Math.max(...seen) > 0.99);
});

test('three waves repeat every ~10.7 segments', () => {
  const three = fx({ effect: 'wave', edge: 'soft', waves: 3 });
  const levels = line(three, 32, 0);
  // Peaks along the line (the last segment is already close to the fourth wave's start).
  const peaks = levels.flatMap((v, k) => ((k === 0 || v >= levels[k - 1]!) && k < 31 && v >= levels[k + 1]! ? [k] : []));
  assert.equal(peaks.length, 3, `peaks at ${peaks}`);
  for (let p = 1; p < peaks.length; p++) {
    const gap = peaks[p]! - peaks[p - 1]!;
    assert.ok(gap === 10 || gap === 11, `gap ${gap}`);
  }
  // Exactly: segment k + 32/3 would be segment k again.
  for (let k = 0; k < 32; k++) {
    const want = 0.5 + 0.5 * Math.cos(2 * Math.PI * (0.2 - 3 * k / 32));
    assert.ok(Math.abs(at(three, k, 32, 0.2).i - want) < 1e-9, `segment ${k}`);
  }
});

test('right to left mirrors the line; centre out and outside in are symmetric', () => {
  const kinds: EffectInput[] = [
    { effect: 'wave', edge: 'soft' }, { effect: 'wave', edge: 'hard', waves: 3, size: 0.3 },
    { effect: 'wave', colours: [RED, BLUE, GREEN] }, { effect: 'chase', edge: 'hard', size: 0.25 },
    { effect: 'chase', waves: 2 }, { effect: 'meteor' }, { effect: 'meteor', edge: 'hard' },
    { effect: 'fill', colours: [RED, BLUE] }, { effect: 'yoyo', size: 0.2 }, { effect: 'yoyo', edge: 'hard' },
  ];
  for (const kind of kinds) {
    const ltr = fx({ ...kind, direction: 'ltr' }), rtl = fx({ ...kind, direction: 'rtl' });
    const out = fx({ ...kind, direction: 'centreOut' }), inside = fx({ ...kind, direction: 'outsideIn' });
    for (const count of [32, 6, 7]) {
      for (const phase of [0, 0.13, 0.5, 0.71, 3.3]) {
        for (let k = 0; k < count; k++) {
          const what = `${JSON.stringify(kind)} count ${count} phase ${phase} segment ${k}`;
          assert.deepEqual(at(rtl, k, count, phase), at(ltr, count - 1 - k, count, phase), what);
          assert.deepEqual(at(out, k, count, phase), at(out, count - 1 - k, count, phase), what);
          assert.deepEqual(at(inside, k, count, phase), at(inside, count - 1 - k, count, phase), what);
        }
      }
    }
  }
});

test('a soft colour fade from red to blue passes through mixed colours and never through dark', () => {
  const fade = fx({ effect: 'colourFade', colours: [RED, BLUE], edge: 'soft' });
  let mixed = false;
  for (let n = 0; n <= 400; n++) {
    const l = at(fade, 3, 32, n / 100);
    assert.ok(l.i > 0.99, `phase ${n / 100}: intensity ${l.i}`);
    if (l.r > 0.3 && l.b > 0.3) mixed = true;
    // Every segment is the same.
    assert.deepEqual(at(fade, 17, 32, n / 100), l);
  }
  assert.ok(mixed, 'never showed a mix of red and blue');
  // Hard switches: only red or blue, one colour a cycle.
  const hard = fx({ effect: 'colourFade', colours: [RED, BLUE], edge: 'hard' });
  assert.deepEqual([at(hard, 0, 1, 0.5).r, at(hard, 0, 1, 0.5).b], [1, 0]);
  assert.deepEqual([at(hard, 0, 1, 1.5).r, at(hard, 0, 1, 1.5).b], [0, 1]);
  assert.deepEqual([at(hard, 0, 1, 2.5).r, at(hard, 0, 1, 2.5).b], [1, 0]);
});

test('sparkle is the same for the same inputs, and sparks about `size` of the line', () => {
  const sparkle = (f: CompiledEffect) => Array.from({ length: 200 }, (_, n) => line(f, 32, n / 37));
  const a = fx({ effect: 'sparkle', colours: [BLUE, RED], size: 0.25 });
  const b = fx({ effect: 'sparkle', colours: [BLUE, RED], size: 0.25 });
  assert.deepEqual(sparkle(a), sparkle(b));
  // Hard: each segment is the base (blue at 40 %) or a spark (red at full).
  const hard = fx({ effect: 'sparkle', colours: [BLUE, RED], size: 0.25, edge: 'hard' });
  let sparks = 0, all = 0;
  for (let s = 0; s < 400; s++) {
    for (let k = 0; k < 32; k++) {
      const l = at(hard, k, 32, (s + 0.5) / 8);
      if (l.r === 1 && l.i === 1) sparks++;
      else assert.ok(l.b === 1 && Math.abs(l.i - 0.4) < 1e-12, `segment ${k} slot ${s}: ${JSON.stringify(l)}`);
      all++;
    }
  }
  assert.ok(sparks / all > 0.2 && sparks / all < 0.3, `sparked ${sparks / all}`);
});

test('breathe, meteor, fill and yo-yo do what their names say', () => {
  // Breathe: all segments together, between 1 − size and 1, the next colour each cycle.
  const breathe = fx({ effect: 'breathe', colours: [RED, BLUE], size: 0.6, edge: 'hard' });
  assert.ok(Math.abs(at(breathe, 0, 32, 0).i - 0.4) < 1e-9);
  assert.ok(Math.abs(at(breathe, 0, 32, 0.5).i - 1) < 1e-9);
  assert.equal(at(breathe, 0, 32, 0.5).r, 1);
  assert.equal(at(breathe, 0, 32, 1.5).b, 1);
  assert.deepEqual(line(breathe, 32, 0.3), new Array(32).fill(at(breathe, 0, 32, 0.3).i));

  // Meteor: a full head with a dimming tail behind it.
  const meteor = fx({ effect: 'meteor', size: 0.25, edge: 'hard' });
  const m = line(meteor, 32, 0.5);
  const head = m.indexOf(Math.max(...m));
  assert.ok(m[head]! > 0.9, `head ${m[head]}`);
  for (let k = head + 1; k < 32; k++) assert.equal(m[k], 0, 'nothing ahead of the head');
  for (let k = head - 1; k > head - 6; k--) assert.ok(m[k]! < m[k + 1]! && m[k]! > 0, 'the tail fades');

  // Fill: empty at the start of a cycle, full half way, empty again; the next colour each cycle.
  const fill = fx({ effect: 'fill', colours: [RED, BLUE], edge: 'hard' });
  assert.deepEqual(line(fill, 32, 0), new Array(32).fill(0));
  assert.deepEqual(line(fill, 32, 0.5), new Array(32).fill(1));
  const quarter = line(fill, 32, 0.25);
  assert.ok(quarter[0] === 1 && quarter[31] === 0 && quarter.filter((v) => v === 1).length === 16, `${quarter}`);
  assert.equal(at(fill, 0, 32, 1.5).b, 1);

  // Yo-yo: a block at one end, then the other, then back.
  const yoyo = fx({ effect: 'yoyo', size: 0.25, edge: 'hard' });
  const lit = (phase: number) => line(yoyo, 32, phase).flatMap((v, k) => (v > 0 ? [k] : []));
  assert.equal(lit(0)[0], 0);
  assert.equal(lit(0.5).at(-1), 31);
  assert.equal(lit(1)[0], 0);
  assert.ok(lit(0.25).length >= 7 && lit(0.25).length <= 9, `${lit(0.25)}`);
});

test('intensity scales the result', () => {
  const half = fx({ effect: 'wave', intensity: 0.5 });
  const full = fx({ effect: 'wave' });
  for (let k = 0; k < 32; k++) assert.ok(Math.abs(at(half, k, 32, 0.3).i - at(full, k, 32, 0.3).i / 2) < 1e-12);
});

// ---- Light safety ----

/**
 * The most brightness swings (rise and fall, or fall and rise, by 20 % or more)
 * any segment makes in any one second, running at `rate` cycles a second.
 */
function swingsPerSecond(f: CompiledEffect, count: number, rate: number, seconds = 3): number {
  const STEP = 0.001;
  let worst = 0;
  for (let k = 0; k < count; k++) {
    // Each change of 20 % or more against the last one: a rise after a fall, or a fall after a rise.
    const changes: number[] = [];
    let lo = at(f, k, count, 0).i, hi = lo, dir = 0;
    for (let n = 0; n * STEP <= seconds; n++) {
      const t = n * STEP;
      const v = at(f, k, count, rate * t).i;
      if (dir !== -1 && hi - v >= 0.2) {
        changes.push(t);
        dir = -1;
        lo = hi = v;
      } else if (dir !== 1 && v - lo >= 0.2) {
        changes.push(t);
        dir = 1;
        lo = hi = v;
      }
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    // Two opposite changes make one swing; count them in every one-second window.
    for (let a = 0, b = 0; a < changes.length; a++) {
      while (b < changes.length && changes[b]! < changes[a]! + 1) b++;
      worst = Math.max(worst, Math.floor((b - a) / 2));
    }
  }
  return worst;
}

test('light safety: a hard chase at 1 beat a cycle and 240 bpm is slowed to 3 swings a second or fewer', () => {
  const chase = fx({ effect: 'chase', edge: 'hard', speed: { beats: 1 } });
  const asked = cyclesPerSecond(chase, 240 / 60, 1);
  assert.equal(asked, 4);
  const rate = safeRate(chase, asked);
  assert.ok(rate < asked, `not slowed: ${rate}`);
  assert.ok(swingsPerSecond(chase, 32, rate) <= 3, `${swingsPerSecond(chase, 32, rate)} swings a second`);
  // Unslowed it would break the rule.
  assert.ok(swingsPerSecond(chase, 32, asked) > 3);
  // A soft colour fade at the same tempo changes colour, not brightness: not slowed.
  const fade = fx({ effect: 'colourFade', colours: [RED, BLUE], speed: { beats: 1 } });
  assert.equal(safeRate(fade, cyclesPerSecond(fade, 4, 1)), 4);
});

test('light safety holds for every kind, edge and setting at fast tempos', () => {
  const colourSets = [[RED], [RED, BLUE, GREEN], [RED, DIM], [DIM, RED, DIM, BLUE]];
  for (const effect of EffectLayer.shape.effect.options) {
    for (const edge of ['soft', 'hard'] as const) {
      for (const [waves, size] of [[1, 0.5], [3, 0.1], [2, 0.9]] as const) {
        for (const colours of colourSets) {
          const f = fx({ effect, edge, waves, size, colours, speed: { beats: 0.25 } });
          // 240 bpm at a quarter beat a cycle: 16 cycles a second asked for.
          const rate = safeRate(f, cyclesPerSecond(f, 4, 1));
          const count = waves === 3 ? 32 : 6;
          const swings = swingsPerSecond(f, count, rate, 2);
          assert.ok(swings <= 3, `${effect} ${edge} waves ${waves} size ${size} colours ${colours.length}: ${swings} swings a second at ${rate} cycles a second`);
        }
      }
    }
  }
});

// ---- In the engine ----

const stage = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));
const BG = 'background';
/** The background line: b6, b5, b4, b3 in group order, 8 segments each. */
const BG_LINE = ['b6', 'b5', 'b4', 'b3'];

function effectPreset(id: string, group: string, layer: EffectInput, fade = 3): Preset {
  return { id, name: id, group, fade, layers: [EffectLayer.parse({ kind: 'effect', colours: [RED], speed: { beats: 4 }, ...layer })] };
}

function effectsShow(...presets: Preset[]): Show {
  const show = stage();
  show.presets.push(...presets);
  return show;
}

test('the engine renders each segment at its place in the line, reversed fixtures mirrored', () => {
  const layer: EffectInput = { effect: 'wave', edge: 'soft', speed: { beats: 4 } };
  const show = effectsShow(effectPreset('bg-wave', BG, layer));
  show.fixtures.find((f) => f.id === 'b3')!.reversed = true;
  const e = new Engine(show, 0);
  e.apply({ type: 'groupPreset', group: BG, preset: 'bg-wave', fade: 0 }, 0);
  for (let t = 0; t <= 2.3 + 1e-9; t += FRAME) e.frame(t);
  // Not slowed (half a cycle a second), so the phase is the beats ÷ 4.
  const phase = e.beatPhase(BG)! / 4;
  assert.ok(phase > 0.5);
  const wave = fx(layer);
  const bar = findProfile(show, 'stairville-sonicpulse-led-bar-10-39-ch')!;
  BG_LINE.forEach((id, n) => {
    const plan = planChannels(show.fixtures.find((f) => f.id === id)!, bar, show.settings.gamma);
    const seen = segmentsOf(e, id);
    for (let c = 0; c < 8; c++) {
      const position = n * 8 + (id === 'b3' ? 7 - c : c);
      const want = visibleLevel(plan, at(wave, position, 32, phase));
      assert.ok(Math.abs(seen[c]! - want) < 1e-9, `${id} segment ${c + 1}: ${seen[c]} want ${want} (line position ${position})`);
    }
  });
  assert.ok(new Set(segmentsOf(e, 'b6').map((v) => v.toFixed(3))).size > 4, 'the segments differ');
});

test('ownMotion is 0 for plain colours and follows a running effect', () => {
  const e = new Engine(effectsShow(effectPreset('bg-chase', BG, { effect: 'chase', edge: 'hard', speed: { beats: 1 } })), 0);
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  for (let t = 0; t <= 1; t += FRAME) e.frame(t);
  assert.equal(e.ownMotion().length, e.visibleLevels().length);
  assert.deepEqual(e.ownMotion(), new Array(e.visibleLevels().length).fill(0));
  e.apply({ type: 'groupPreset', group: BG, preset: 'bg-chase', fade: 0 }, 1);
  let moved = 0;
  for (let t = 1; t <= 3; t += FRAME) {
    e.frame(t);
    moved = Math.max(moved, ...e.ownMotion());
  }
  assert.ok(moved > 0.9, `own motion ${moved}`);
  // Only the background moves.
  const counts = e.segmentCounts();
  e.fixtureIds().forEach((id, f) => {
    if (BG_LINE.includes(id)) return;
    const start = counts.slice(0, f).reduce((a, b) => a + b, 0);
    assert.deepEqual(e.ownMotion().slice(start, start + counts[f]), new Array(counts[f]).fill(0), id);
  });
});

test('a soft wave fading to a plain colour over 3 s steps no segment more than its own motion + 5 %', () => {
  const e = new Engine(effectsShow(effectPreset('bg-wave', BG, { effect: 'wave', edge: 'soft', waves: 3, speed: { beats: 2 } })), 0);
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply({ type: 'groupPreset', group: BG, preset: 'bg-wave', fade: 3 }, 0);
  e.frame(0);
  const into = beyondOwnMotion(e, FRAME, 5);
  assert.ok(into.worst <= 0.05, `fading in: ${into.worst}`);
  assert.ok(into.motion > 0.02, `the wave moved by ${into.motion}`);
  e.apply({ type: 'groupPreset', group: BG, preset: 'background-zils', fade: 3 }, 5 + FRAME);
  const out = beyondOwnMotion(e, 5 + FRAME, 10);
  assert.ok(out.worst <= 0.05, `fading out: ${out.worst}`);
  // Afterwards the plain colour is still.
  assert.deepEqual(e.ownMotion(), new Array(e.visibleLevels().length).fill(0));
});

test('a tempo change never makes an effect jump, including when light safety starts slowing it', () => {
  for (const [from, to] of [[60, 180], [60, 240], [240, 60]]) {
    const e = new Engine(effectsShow(effectPreset('bg-wave', BG, { effect: 'wave', edge: 'soft', speed: { beats: 1 } })), 0);
    e.apply({ type: 'groupPreset', group: BG, preset: 'bg-wave', fade: 0 }, 0);
    e.apply({ type: 'tempo', bpm: from }, 0);
    for (let t = 0; t < 2; t += FRAME) e.frame(t);
    // The largest step the wave makes by itself at the new tempo.
    const steady = new Engine(effectsShow(effectPreset('bg-wave', BG, { effect: 'wave', edge: 'soft', speed: { beats: 1 } })), 0);
    steady.apply({ type: 'groupPreset', group: BG, preset: 'bg-wave', fade: 0 }, 0);
    steady.apply({ type: 'tempo', bpm: to }, 0);
    steady.frame(0);
    const usual = beyondOwnMotion(steady, FRAME, 2).step;

    e.frame(2);
    const prev = e.visibleLevels();
    e.apply({ type: 'tempo', bpm: to }, 2 + FRAME);
    e.frame(2 + FRAME);
    const now = e.visibleLevels(), own = e.ownMotion();
    for (let k = 0; k < now.length; k++) {
      const step = Math.abs(now[k]! - prev[k]!);
      assert.ok(step <= own[k]! + 0.05, `${from} → ${to} bpm, segment ${k}: stepped ${step}, own motion ${own[k]}`);
      assert.ok(step <= usual + 0.005, `${from} → ${to} bpm, segment ${k}: stepped ${step}, the wave's usual step ${usual}`);
    }
  }
});

test('Basic lights and Blackout replace a running effect with a still look', () => {
  const show = effectsShow(effectPreset('bg-chase', BG, { effect: 'chase', edge: 'hard', speed: { beats: 1 } }));
  for (const cmd of [{ type: 'safe' }, { type: 'blackout' }] as const) {
    const e = new Engine(show, 0);
    e.apply({ type: 'groupPreset', group: BG, preset: 'bg-chase', fade: 0 }, 0);
    for (let t = 0; t <= 1; t += FRAME) e.frame(t);
    e.apply(cmd, 1);
    const fade = beyondOwnMotion(e, 1, 4);
    assert.ok(fade.worst <= 0.05, `${cmd.type}: ${fade.worst}`);
    const before = e.visibleLevels();
    e.frame(4.5);
    assert.deepEqual(e.visibleLevels(), before, `${cmd.type} is still`);
    assert.deepEqual(e.ownMotion(), new Array(before.length).fill(0));
  }
});

test('Basic lights stays still even when its look lists an effect', () => {
  const show = effectsShow(effectPreset('bg-chase', BG, { effect: 'chase', edge: 'hard', speed: { beats: 1 } }));
  show.looks.push({ id: 'basic', name: 'Basic lights', groups: [{ group: BG, preset: 'bg-chase' }, { group: 'key-lights', preset: show.presets.find((p) => p.group === 'key-lights')!.id }] });
  show.operator.safeLook = 'basic';
  const e = new Engine(show, 0);
  e.apply({ type: 'safe' }, 0);
  for (let t = 0; t <= 3; t += FRAME) e.frame(t);
  const before = e.visibleLevels();
  e.frame(3.3);
  assert.deepEqual(e.visibleLevels(), before);
  assert.ok(segmentsOf(e, 'b6').every((v) => v > 0.5), 'the background gets the warm wash instead');
});

test('an effect edited while it runs fades to the new settings and keeps its place', () => {
  const show = effectsShow(effectPreset('bg-wave', BG, { effect: 'wave', edge: 'soft', speed: { beats: 4 } }));
  const e = new Engine(show, 0);
  e.apply({ type: 'groupPreset', group: BG, preset: 'bg-wave', fade: 0 }, 0);
  for (let t = 0; t <= 2; t += FRAME) e.frame(t);
  const edited = structuredClone(show);
  edited.presets.find((p) => p.id === 'bg-wave')!.layers = [EffectLayer.parse({ kind: 'effect', effect: 'wave', colours: [BLUE], edge: 'hard', waves: 3, size: 0.3, speed: { beats: 4 } })];
  e.setShow(edited, 2 + FRAME);
  const fade = beyondOwnMotion(e, 2 + FRAME, 6);
  assert.ok(fade.worst <= 0.05, `stepped ${fade.worst} beyond its own motion`);
  assert.equal(e.liveState(6, 'off').groups[BG]!.preset, 'bg-wave');
});
