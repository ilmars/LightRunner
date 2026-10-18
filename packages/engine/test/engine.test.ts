import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/index.ts';
import { close, demoShow, lightOf, maxStep } from './helpers.ts';

const GAMMA = 2.2;
const dmx = (v: number) => Math.round(Math.pow(v, GAMMA) * 255);

test('the stage starts dark', () => {
  const e = new Engine(demoShow());
  const f = e.frame(0);
  assert.ok(f.universes.get(0)!.every((v) => v === 0));
});

test('a look fades in over its fade time and lands on the preset values', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(0);
  assert.equal(lightOf(e, 'back-1').i, 0);
  const step = maxStep(e, 0, 3);
  assert.ok(step < 0.05, `largest step ${step}`);
  const back = lightOf(e, 'back-1');
  assert.ok(close(back.i, 0.8 * 0xff / 0xff, 1e-9));
  // generic-rgb back-1 at address 25: blue channel only, gamma applied
  const u = e.frame(3).universes.get(0)!;
  const blue = 0xff / 0xff;
  assert.equal(u[26], dmx(blue * 0.8));
  assert.equal(u[24], dmx((0x1f / 0xff) * 0.8));
});

test('a second look mid-fade continues smoothly', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  const step = maxStep(e, 0, 8, (t) => {
    if (Math.abs(t - 1.5) < 1e-9) e.apply({ type: 'look', id: 'word' }, t);
  });
  assert.ok(step < 0.05, `largest step ${step}`);
  assert.ok(close(lightOf(e, 'front-1').i, 1));
});

test('a group preset leaves every other group untouched', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(5);
  const front = Array.from(e.frame(5).universes.get(0)!.slice(0, 24));
  e.apply({ type: 'groupPreset', group: 'back-wall', preset: 'back-purple' }, 5);
  for (let t = 5; t < 9; t += 0.025) {
    assert.deepEqual(Array.from(e.frame(t).universes.get(0)!.slice(0, 24)), front);
  }
  const state = e.liveState(9, 'ok');
  assert.equal(state.groups['back-wall'].changed, true);
  assert.equal(state.groups['front-wash'].changed, false);
});

test('a light in two groups follows the most recent change, with a fade', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(4);
  assert.ok(close(lightOf(e, 'pulpit').i, lightOf(e, 'front-1').i));
  e.apply({ type: 'groupPreset', group: 'pulpit', preset: 'pulpit-on' }, 4);
  const step = maxStep(e, 4, 7);
  assert.ok(step < 0.05, `largest step ${step}`);
  assert.ok(close(lightOf(e, 'pulpit').i, 1));
  e.apply({ type: 'groupPreset', group: 'front-wash', preset: 'front-warm' }, 7);
  e.frame(11);
  assert.ok(close(lightOf(e, 'pulpit').i, 0.8));
});

test('manual follows the finger and release fades back to the running preset', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(4);
  e.apply({ type: 'manual', target: { group: 'back-wall' }, colour: '#ff0000', intensity: 1 }, 4);
  for (let t = 4; t <= 5; t += 0.025) e.frame(t);
  const red = lightOf(e, 'back-3');
  assert.ok(red.r > 0.99 && red.b < 0.01 && red.i > 0.99);
  assert.equal(e.liveState(5, 'ok').groups['back-wall'].manual, true);
  e.apply({ type: 'release', target: { group: 'back-wall' } }, 5);
  const step = maxStep(e, 5, 6.5);
  assert.ok(step < 0.05, `largest step ${step}`);
  const back = lightOf(e, 'back-3');
  assert.ok(close(back.i, 0.8) && back.b > 0.99);
  assert.equal(e.liveState(6.5, 'ok').groups['back-wall'].manual, false);
});

test('Safe brings a warm wash, resets master and clears manual', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'master', value: 0.2 }, 0);
  e.apply({ type: 'manual', target: { fixture: 'aud-1' }, colour: '#00ff00' }, 0);
  e.frame(4);
  e.apply({ type: 'safe' }, 4);
  e.frame(6);
  const s = e.liveState(6, 'ok');
  assert.equal(s.look, 'safe');
  assert.equal(s.master, 1);
  assert.deepEqual(s.fixturesManual, []);
  for (const l of e.lights()) assert.ok(close(l.i, 0.8, 1e-6), `intensity ${l.i}`);
});

test('Blackout goes dark in 1 s, and any look brings the whole stage back', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.apply({ type: 'groupPreset', group: 'pulpit', preset: 'pulpit-on' }, 0);
  e.frame(4);
  e.apply({ type: 'blackout' }, 4);
  e.frame(5);
  assert.ok(e.frame(5).universes.get(0)!.every((v) => v === 0));
  // Worship does not list the pulpit group, so it returns to what it ran before.
  e.apply({ type: 'look', id: 'worship' }, 5);
  e.frame(15);
  assert.ok(close(lightOf(e, 'pulpit').i, 1));
  assert.ok(close(lightOf(e, 'front-1').i, 0.8));
});

test('Back to look returns changed groups and clears manual', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'word' }, 0);
  e.apply({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber' }, 0);
  e.apply({ type: 'manual', target: { group: 'audience' }, intensity: 0 }, 0);
  e.frame(4);
  e.apply({ type: 'backToLook' }, 4);
  e.frame(10);
  const s = e.liveState(10, 'ok');
  assert.equal(s.groups['back-wall'].preset, 'back-dim-blue');
  assert.equal(s.groups['back-wall'].changed, false);
  assert.equal(s.groups.audience.manual, false);
  assert.ok(close(lightOf(e, 'aud-1').i, 0.6));
});

test('master and group level fades never step', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(4);
  e.apply({ type: 'master', value: 0.5 }, 4);
  e.apply({ type: 'groupLevel', group: 'back-wall', value: 0.5 }, 4);
  e.frame(5);
  assert.ok(close(lightOf(e, 'back-1').i, 0.8 * 0.25));
  assert.ok(close(lightOf(e, 'aud-1').i, 0.6 * 0.5));
});

test('the 16-bit pulpit dimmer writes coarse and fine bytes', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  const u = e.frame(5).universes.get(0)!;
  // pulpit at 51: dimmer coarse 51, fine 52 (0-based 50, 51)
  const v16 = Math.round(Math.pow(0.35 * 1, GAMMA) * 65535);
  const i = lightOf(e, 'pulpit').i;
  const expected = Math.round(Math.pow(i, GAMMA) * 65535);
  assert.equal(u[50], expected >> 8);
  assert.equal(u[51], expected & 255);
  assert.ok(Math.abs(expected - v16) < 700);
});

test('restore puts the stage back exactly, with no fade', () => {
  const a = new Engine(demoShow());
  a.apply({ type: 'look', id: 'worship' }, 0);
  a.apply({ type: 'groupPreset', group: 'pulpit', preset: 'pulpit-on' }, 0);
  a.apply({ type: 'master', value: 0.7 }, 0);
  const before = Array.from(a.frame(10).universes.get(0)!);
  const b = new Engine(demoShow());
  b.restore(a.runtime(), 100);
  assert.deepEqual(Array.from(b.frame(100).universes.get(0)!), before);
  assert.equal(b.liveState(100, 'ok').look, 'worship');
});

test('editing the show keeps the stage running', () => {
  const show = demoShow();
  const e = new Engine(show);
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(5);
  const before = Array.from(e.frame(5).universes.get(0)!);
  e.setShow(demoShow(), 5);
  assert.deepEqual(Array.from(e.frame(5.025).universes.get(0)!), before);
});

test('unknown ids are reported, not thrown', () => {
  const e = new Engine(demoShow());
  assert.match(e.apply({ type: 'look', id: 'nope' }, 0)!, /unknown look/);
  assert.match(e.apply({ type: 'groupPreset', group: 'back-wall', preset: 'front-warm' }, 0)!, /unknown preset/);
});

test('Undo fades back to the stage before the last change', () => {
  const e = new Engine(demoShow());
  assert.equal(e.liveState(0, 'ok').canUndo, false);
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.apply({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber' }, 4);
  e.apply({ type: 'look', id: 'worship' }, 8);
  e.frame(12);
  assert.equal(e.apply({ type: 'undo' }, 12), null);
  const step = maxStep(e, 12, 15);
  assert.ok(step < 0.05, `largest step ${step}`);
  let s = e.liveState(15, 'ok');
  assert.equal(s.look, 'walk-in');
  assert.equal(s.groups['back-wall'].preset, 'back-amber');
  e.apply({ type: 'undo' }, 15);
  e.apply({ type: 'undo' }, 15.5);
  e.frame(20);
  s = e.liveState(20, 'ok');
  assert.equal(s.look, null);
  assert.ok(e.lights().every((l) => l.i === 0));
  assert.equal(s.canUndo, false);
  assert.match(e.apply({ type: 'undo' }, 20)!, /nothing to undo/);
});

test('Undo after Blackout brings the stage back', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'word' }, 0);
  e.apply({ type: 'blackout' }, 5);
  e.frame(7);
  assert.ok(e.lights().every((l) => l.i === 0));
  e.apply({ type: 'undo' }, 7);
  e.frame(10);
  const s = e.liveState(10, 'ok');
  assert.equal(s.look, 'word');
  assert.equal(s.lastLook, 'word');
  assert.ok(close(lightOf(e, 'front-1').i, 1));
});

test('the fade countdown and last look are reported', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'prayer' }, 0);
  assert.ok(close(e.liveState(2, 'ok').lookFadeLeft, 4));
  e.apply({ type: 'safe' }, 7);
  const s = e.liveState(7, 'ok');
  assert.equal(s.look, 'safe');
  assert.equal(s.lastLook, 'prayer');
});

test('the operator fade time overrides each look and preset fade, and Auto goes back', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'fadeTime', value: 0 }, 0);
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(0);
  assert.ok(close(lightOf(e, 'back-1').i, 0.8));
  assert.equal(e.liveState(0, 'ok').fadeTime, 0);
  e.apply({ type: 'fadeTime', value: 10 }, 1);
  e.apply({ type: 'groupPreset', group: 'back-wall', preset: 'back-dim-blue' }, 1);
  e.frame(6);
  const mid = lightOf(e, 'back-1').i;
  assert.ok(mid > 0.45 && mid < 0.65, `half way at ${mid}`);
  e.apply({ type: 'fadeTime', value: null }, 20);
  e.apply({ type: 'look', id: 'worship' }, 20);
  assert.ok(close(e.liveState(20, 'ok').lookFadeLeft, 5));
  assert.equal(e.runtime().fadeTime, null);
});
