// effectFrames: the effect editor's moving strip, rendered by the engine's own effect
// code for a group's line, at the stage tempo and speed, with light safety.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveEffectLayer, parseShow, type Show } from '../../shared/src/index.ts';
import { Engine, effectFrames, type EffectFrames } from '../src/index.ts';
import { FRAME, demoShow } from './helpers.ts';

const BAR10 = 'stairville-sonicpulse-led-bar-10-39-ch';
const stage = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));

/** Two 8-segment bars in one group, the second hung the other way round (unless `reversed` is false). */
function barsShow(reversed = true): Show {
  const source = stage();
  return parseShow({
    schemaVersion: source.schemaVersion,
    name: 'Bars',
    profiles: source.profiles.filter((p) => p.id === BAR10),
    fixtures: [
      { id: 'bar1', name: 'Bar 1', profile: BAR10, universe: 1, address: 1 },
      { id: 'bar2', name: 'Bar 2', profile: BAR10, universe: 1, address: 40, reversed },
    ],
    groups: [{ id: 'bars', name: 'Bars', fixtures: ['bar1', 'bar2'] }, { id: 'haze', name: 'Haze', kind: 'smoke', fixtures: [] }],
    presets: [],
    looks: [],
  });
}

const fx = (over: Partial<LiveEffectLayer> = {}): LiveEffectLayer => LiveEffectLayer.parse({
  kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }, { hex: '#0000ff' }], speed: { beats: 4 }, ...over,
});

const frames = (show: Show, effect: LiveEffectLayer, bpm = 120, speed = 1): EffectFrames => {
  const out = effectFrames(show, 'bars', effect, { bpm, speed });
  if (typeof out === 'string') throw new Error(out);
  return out;
};

/** Segment `k` of frame `f`, as RGB. */
const cell = (r: EffectFrames, f: number, k: number) => Array.from(r.frames.subarray((f * r.segments + k) * 3, (f * r.segments + k + 1) * 3));

/** The engine running the same effect on the same group, from time 0, framed up to `t`. */
function engineAt(show: Show, effect: LiveEffectLayer, bpm: number, t: number): { visual: Uint8Array; phase: number } {
  const e = new Engine(show, 0);
  assert.equal(e.apply({ type: 'tempo', bpm }, 0), null);
  assert.equal(e.apply({ type: 'groupEffect', group: 'bars', effect, fade: 0 }, 0), null);
  let visual = e.frame(0).visual;
  for (let s = FRAME; s < t; s += FRAME) e.frame(s);
  visual = e.frame(t).visual;
  return { visual: Uint8Array.from(visual), phase: e.effectPhase('bars')! };
}

/** Each byte of the strip's frame `f` within 1 of the engine's picture, with bar 2's segments mirrored when it is reversed. */
function assertMatchesEngine(r: EffectFrames, f: number, visual: Uint8Array, reversed: boolean): void {
  for (let k = 0; k < 16; k++) {
    // Line position k: bar 1's segment k, or bar 2's segment k − 8 (from its far end when reversed).
    const seg = k < 8 ? k : reversed ? 8 + (15 - k) : k;
    const want = Array.from(visual.subarray(seg * 3, seg * 3 + 3));
    const got = cell(r, f, k);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c]! - want[c]!) <= 1, `frame ${f} line ${k}: ${got} vs engine ${want}`);
  }
}

test('effectFrames gives RGB for every segment of the group line, looping whole cycles in at most 8 s', () => {
  const r = frames(barsShow(), fx());
  assert.deepEqual(r.fixtures, [8, 8]);
  assert.equal(r.segments, 16);
  assert.ok(r.count >= 1 && r.count <= 160, `${r.count} frames`);
  assert.equal(r.frames.length, r.count * 16 * 3);
  // 4 beats at 120 bpm is half a cycle a second; the loop is whole cycles, at about 20 frames a second.
  assert.equal(r.rate, 0.5);
  const seconds = r.count / r.fps;
  assert.ok(seconds <= 8 + 1e-9, `${seconds} s`);
  assert.ok(Math.abs(r.fps - 20) < 1, `${r.fps} fps`);
  const cycles = seconds * r.rate;
  assert.ok(Math.abs(cycles - Math.round(cycles)) < 1e-9 && cycles >= 1, `${cycles} cycles`);

  // A slow free-running effect still fits in 8 s.
  const slow = frames(barsShow(), fx({ effect: 'colourFade', speed: { seconds: 60 } }));
  assert.ok(slow.count <= 160 && slow.count / slow.fps <= 8 + 1e-9);
});

test('a wave differs along the line and over time', () => {
  const r = frames(barsShow(), fx());
  assert.notDeepEqual(cell(r, 0, 0), cell(r, 0, 4));
  assert.notDeepEqual(cell(r, 0, 0), cell(r, 10, 0));
  // Every segment is lit: a two-colour wave never goes dark.
  for (let k = 0; k < 16; k++) assert.ok(Math.max(...cell(r, 0, k)) > 0, `segment ${k}`);
});

test('the strip follows the line: a reversed fixture shows its segments mirrored, as the engine lights them', () => {
  const effect = fx({ waves: 1 });
  const reversed = frames(barsShow(true), effect);
  const plain = frames(barsShow(false), effect);
  // The line is the same either way; only which segment of the bar is lit where changes.
  assert.deepEqual(reversed.frames, plain.frames);
  const f = 7;
  const t = f / reversed.fps;
  assertMatchesEngine(reversed, f, engineAt(barsShow(true), effect, 120, t).visual, true);
  assertMatchesEngine(plain, f, engineAt(barsShow(false), effect, 120, t).visual, false);
});

test('an effect light safety slows matches the engine running it at the same moment', () => {
  // A chase every quarter beat at 240 bpm asks for 16 cycles a second; light safety halves it to 2.
  const effect = fx({ effect: 'chase', colours: [{ hex: '#ff0000' }], speed: { beats: 0.25 }, edge: 'soft' });
  const r = frames(barsShow(), effect, 240);
  assert.equal(r.rate, 2);
  for (const f of [3, 11, 25]) {
    const t = f / r.fps;
    const live = engineAt(barsShow(), effect, 240, t);
    assert.ok(Math.abs(live.phase - r.rate * t) < 1e-6, `engine phase ${live.phase} vs ${r.rate * t}`);
    assertMatchesEngine(r, f, live.visual, true);
  }
});

test('the stage tempo and the speed dial set the rate', () => {
  assert.equal(frames(barsShow(), fx(), 60).rate, 0.25);
  assert.equal(frames(barsShow(), fx(), 120, 2).rate, 1);
  assert.equal(frames(barsShow(), fx({ speed: { seconds: 4 } }), 200, 0.5).rate, 0.125);
});

test('effectFrames refuses unknown groups and smoke machines', () => {
  assert.match(effectFrames(barsShow(), 'nope', fx(), { bpm: 120, speed: 1 }) as string, /unknown group "nope"/);
  assert.equal(effectFrames(barsShow(), 'haze', fx(), { bpm: 120, speed: 1 }), "smoke machines can't run effects");
  // The demo show's groups work too: one segment per fixture.
  const show = demoShow();
  const g = show.groups.find((x) => x.kind !== 'smoke')!;
  const r = effectFrames(show, g.id, fx(), { bpm: 120, speed: 1 });
  assert.ok(typeof r !== 'string');
  assert.equal(r.segments, r.fixtures.reduce((a, b) => a + b, 0));
});
