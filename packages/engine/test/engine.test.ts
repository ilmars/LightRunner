import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Show } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { close, demoShow, levelsShow, lightOf, maxStep } from './helpers.ts';

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

test("a look sets each group's saved level with the look's fade", () => {
  const e = new Engine(levelsShow());
  e.apply({ type: 'look', id: 'song-3' }, 0);
  const s0 = e.liveState(0, 'ok');
  assert.equal(s0.groups['front-wash'].level, 0.4);
  assert.equal(s0.groups.audience.level, 0.5);
  assert.equal(s0.groups['back-wall'].level, 1);
  const step = maxStep(e, 0, 4);
  assert.ok(step < 0.05, `largest step ${step}`);
  assert.ok(close(lightOf(e, 'front-1').i, 0.8 * 0.4));
  assert.ok(close(lightOf(e, 'aud-1').i, 0.15 * 0.5));
  // A look without a level brings the group back to full.
  e.apply({ type: 'look', id: 'worship' }, 4);
  e.frame(9);
  assert.equal(e.liveState(9, 'ok').groups['front-wash'].level, 1);
  assert.ok(close(lightOf(e, 'front-1').i, 0.8));
});

test('a 1 s look that lights a dark group and raises its level from 0 stays under 5% per frame', () => {
  const e = new Engine(levelsShow());
  e.apply({ type: 'groupLevel', group: 'front-wash', value: 0 }, 0);
  e.frame(1);
  // "word" has a full-intensity front wash, the steepest case.
  e.apply({ type: 'look', id: 'word', fade: 1 }, 1);
  const step = maxStep(e, 1, 3);
  assert.ok(step < 0.05, `largest step ${step}`);
  assert.ok(close(lightOf(e, 'front-1').i, 1));
});

test('a quick look changes only its groups and keeps the current look', () => {
  const e = new Engine(levelsShow());
  e.apply({ type: 'look', id: 'song-3' }, 0);
  e.frame(4);
  assert.equal(e.liveState(4, 'ok').lookChanged, false);
  assert.equal(e.apply({ type: 'quickLook', id: 'accent' }, 4), null);
  const step = maxStep(e, 4, 7);
  assert.ok(step < 0.05, `largest step ${step}`);
  const s = e.liveState(7, 'ok');
  assert.equal(s.look, 'song-3');
  assert.equal(s.lastLook, 'song-3');
  assert.equal(s.lookChanged, true);
  assert.equal(s.groups.pulpit.preset, 'pulpit-on');
  assert.equal(s.groups.pulpit.level, 0.7);
  assert.equal(s.groups.audience.preset, 'aud-blue');
  assert.equal(s.groups.audience.level, 1);
  assert.equal(s.groups['back-wall'].preset, 'back-purple');
  assert.equal(s.groups['front-wash'].level, 0.4);
  assert.equal(s.canUndo, true);
  assert.match(e.apply({ type: 'quickLook', id: 'nope' }, 7)!, /unknown look/);
});

test('changing a level or preset marks the look changed; Back to look clears it', () => {
  const e = new Engine(levelsShow());
  assert.equal(e.liveState(0, 'ok').lookChanged, false);
  e.apply({ type: 'look', id: 'song-3' }, 0);
  e.frame(4);
  assert.equal(e.liveState(4, 'ok').lookChanged, false);
  e.apply({ type: 'groupLevel', group: 'front-wash', value: 1 }, 4);
  e.frame(5);
  assert.equal(e.liveState(5, 'ok').lookChanged, true);
  e.apply({ type: 'backToLook' }, 5);
  e.frame(10);
  let s = e.liveState(10, 'ok');
  assert.equal(s.lookChanged, false);
  assert.equal(s.groups['front-wash'].level, 0.4);
  e.apply({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber' }, 10);
  assert.equal(e.liveState(10, 'ok').lookChanged, true);
  e.apply({ type: 'backToLook' }, 11);
  assert.equal(e.liveState(11, 'ok').lookChanged, false);
  // A group the look does not list can change without marking it.
  e.apply({ type: 'groupPreset', group: 'pulpit', preset: 'pulpit-on' }, 12);
  e.apply({ type: 'groupLevel', group: 'pulpit', value: 0.3 }, 12);
  assert.equal(e.liveState(12, 'ok').lookChanged, false);
  e.apply({ type: 'blackout' }, 13);
  assert.equal(e.liveState(13, 'ok').lookChanged, false);
  e.apply({ type: 'safe' }, 14);
  assert.equal(e.liveState(14, 'ok').lookChanged, false);
  s = new Engine(levelsShow()).liveState(0, 'ok');
  assert.equal(s.look, null);
  assert.equal(s.lookChanged, false);
});

test('Undo after a look brings the levels back too', () => {
  const e = new Engine(levelsShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.frame(5);
  e.apply({ type: 'look', id: 'song-3' }, 5);
  e.frame(10);
  assert.equal(e.liveState(10, 'ok').groups['front-wash'].level, 0.4);
  assert.equal(e.apply({ type: 'undo' }, 10), null);
  const s = e.liveState(10, 'ok');
  assert.equal(s.groups['front-wash'].level, 1);
  assert.equal(s.groups.audience.level, 1);
  const step = maxStep(e, 10, 13);
  assert.ok(step < 0.05, `largest step ${step}`);
  assert.ok(close(lightOf(e, 'front-1').i, 0.8));
  assert.ok(close(lightOf(e, 'aud-1').i, 0.15));
});

test("Safe uses the safe look's presets, resets every dimmer to full and is not changed right after", () => {
  const e = new Engine(levelsShow(true));
  e.apply({ type: 'look', id: 'song-3' }, 0);
  e.apply({ type: 'master', value: 0.2 }, 0);
  e.apply({ type: 'groupLevel', group: 'back-wall', value: 0.3 }, 0);
  e.frame(4);
  e.apply({ type: 'safe' }, 4);
  const step = maxStep(e, 4, 8);
  assert.ok(step < 0.05, `largest step ${step}`);
  const s = e.liveState(8, 'ok');
  assert.equal(s.look, 'safe');
  assert.equal(s.lookChanged, false);
  assert.equal(s.master, 1);
  assert.equal(s.groups['front-wash'].preset, 'front-dim');
  // The safe look's saved level (0.5) is not used: Basic lights keeps no dimmer levels.
  assert.equal(s.groups['front-wash'].level, 1);
  assert.equal(s.groups.audience.level, 1);
  // Groups the safe look does not list keep the plain warm wash at full.
  assert.equal(s.groups['back-wall'].level, 1);
  assert.ok(close(lightOf(e, 'back-1').i, 0.8));
  e.apply({ type: 'groupLevel', group: 'front-wash', value: 0.5 }, 8);
  assert.equal(e.liveState(9, 'ok').lookChanged, true);
  e.apply({ type: 'groupLevel', group: 'front-wash', value: 1 }, 9);
  assert.equal(e.liveState(10, 'ok').lookChanged, false);
  e.apply({ type: 'groupLevel', group: 'back-wall', value: 0.5 }, 10);
  assert.equal(e.liveState(11, 'ok').lookChanged, true, 'a group the safe look does not list counts too');
});

test('recorded is true for a look and false for a dimmer change', () => {
  const e = new Engine(levelsShow());
  assert.equal(e.recorded, false);
  e.apply({ type: 'look', id: 'song-3' }, 0);
  assert.equal(e.recorded, true);
  e.apply({ type: 'groupLevel', group: 'front-wash', value: 1 }, 4);
  assert.equal(e.recorded, false);
  e.apply({ type: 'quickLook', id: 'accent' }, 5);
  assert.equal(e.recorded, true);
  e.apply({ type: 'quickLook', id: 'accent' }, 6);
  assert.equal(e.recorded, false);
  e.apply({ type: 'look', id: 'nope' }, 7);
  assert.equal(e.recorded, false);
  e.apply({ type: 'master', value: 0.5 }, 8);
  assert.equal(e.recorded, false);
});

test('Back to look works after Basic lights and keeps Master where it was', () => {
  const e = new Engine(levelsShow(true));
  e.apply({ type: 'look', id: 'song-3' }, 0);
  e.apply({ type: 'safe' }, 4);
  e.apply({ type: 'master', value: 0.6 }, 8);
  e.apply({ type: 'groupLevel', group: 'front-wash', value: 0.3 }, 8);
  e.apply({ type: 'groupLevel', group: 'back-wall', value: 0.4 }, 8);
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-blue' }, 8);
  e.frame(9);
  assert.equal(e.liveState(9, 'ok').lookChanged, true);
  assert.equal(e.apply({ type: 'backToLook' }, 9), null);
  const step = maxStep(e, 9, 14);
  assert.ok(step < 0.05, `largest step ${step}`);
  const s = e.liveState(14, 'ok');
  assert.equal(s.look, 'safe');
  assert.equal(s.lookChanged, false);
  assert.equal(s.groups['front-wash'].level, 1);
  assert.equal(s.groups['back-wall'].level, 1);
  assert.equal(s.groups.audience.preset, 'aud-low');
  assert.equal(s.groups['back-wall'].preset, '__safe');
  assert.equal(s.master, 0.6);
});

test('Any colour runs a live colour on the group and Undo brings back the preset before it', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(5);
  const before = e.liveState(5, 'ok').groups['back-wall'].preset;
  assert.ok(before);
  assert.equal(e.apply({ type: 'groupColour', group: 'back-wall', colour: '#FF8000', fade: 1 }, 5), null);
  assert.equal(e.recorded, true);
  e.frame(6.5);
  assert.equal(e.liveState(6.5, 'ok').groups['back-wall'].preset, 'live:back-wall:#ff8000');
  const l = lightOf(e, 'back-1');
  assert.ok(close(l.r, 1) && close(l.g, 128 / 255) && close(l.b, 0) && close(l.i, 1), JSON.stringify(l));
  // the other groups are untouched
  assert.notEqual(e.liveState(6.5, 'ok').groups['front-wash'].preset, 'live:back-wall:#ff8000');
  assert.equal(e.apply({ type: 'undo' }, 7), null);
  e.frame(10);
  assert.equal(e.liveState(10, 'ok').groups['back-wall'].preset, before);
});

test('a live colour survives a restart through runtime() and restore()', () => {
  const a = new Engine(demoShow());
  a.apply({ type: 'look', id: 'walk-in' }, 0);
  a.apply({ type: 'groupColour', group: 'audience', colour: '#00ff80', fade: 0 }, 1);
  const before = Array.from(a.frame(5).universes.get(0)!);
  const rt = a.runtime();
  assert.equal(rt.groups.audience, 'live:audience:#00ff80');
  const b = new Engine(demoShow());
  b.restore(rt, 100);
  assert.deepEqual(Array.from(b.frame(100).universes.get(0)!), before);
  assert.equal(b.liveState(100, 'ok').groups.audience.preset, 'live:audience:#00ff80');
});

test('Any colour reports an unknown group and a colour that is not hex', () => {
  const e = new Engine(demoShow());
  assert.match(e.apply({ type: 'groupColour', group: 'nope', colour: '#ffffff' }, 0)!, /unknown group "nope"/);
  assert.match(e.apply({ type: 'groupColour', group: 'audience', colour: 'red' }, 0)!, /colour/);
  assert.equal(e.recorded, false);
});

test('Flash puts the group at full white whatever the master and level, and drops back on release', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 }, 0);
  e.apply({ type: 'master', value: 0.2 }, 0);
  e.apply({ type: 'groupLevel', group: 'audience', value: 0.3 }, 0);
  e.frame(5);
  const dim = lightOf(e, 'aud-1');
  assert.ok(dim.i < 0.2);
  assert.equal(e.apply({ type: 'flash', groups: ['audience'], on: true }, 5), null);
  assert.deepEqual(e.liveState(5, 'ok').flashing, ['audience']);
  e.frame(5.025);
  for (const id of ['aud-1', 'aud-2']) {
    const l = lightOf(e, id);
    assert.equal(l.i, 1);
    assert.ok(l.r === l.g && l.g === l.b && l.w === 0, JSON.stringify(l));
  }
  // other groups are not flashed
  assert.ok(lightOf(e, 'back-1').i < 0.2);
  // releasing a group that is not flashing does nothing
  assert.equal(e.apply({ type: 'flash', groups: ['back-wall'], on: false }, 5.05), null);
  assert.deepEqual(e.liveState(5.05, 'ok').flashing, ['audience']);
  e.apply({ type: 'flash', groups: ['audience'], on: false }, 6);
  e.frame(6.025);
  assert.ok(close(lightOf(e, 'aud-1').i, dim.i));
  assert.deepEqual(e.liveState(6.025, 'ok').flashing, []);
  assert.match(e.apply({ type: 'flash', groups: ['nope'], on: true }, 7)!, /unknown group "nope"/);
});

test('Flash does nothing during Blackout', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'word' }, 0);
  e.apply({ type: 'blackout' }, 5);
  e.frame(7);
  e.apply({ type: 'flash', groups: ['audience', 'front-wash'], on: true }, 7);
  e.frame(7.025);
  assert.ok(e.lights().every((l) => l.i === 0));
  assert.ok(e.frame(7.05).universes.get(0)!.every((v) => v === 0));
});

test('Flash is not an Undo step and is not saved in runtime()', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  const rt = JSON.stringify(e.runtime());
  e.apply({ type: 'flash', groups: ['audience'], on: true }, 1);
  assert.equal(e.recorded, false);
  assert.equal(JSON.stringify(e.runtime()), rt);
  e.apply({ type: 'flash', groups: ['audience'], on: false }, 2);
  e.apply({ type: 'undo' }, 3);
  assert.equal(e.liveState(3, 'ok').look, null);
  assert.equal(e.liveState(3, 'ok').canUndo, false);
});

test('Flash follows group membership when the show is edited', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'flash', groups: ['audience'], on: true }, 0);
  e.frame(0);
  assert.equal(lightOf(e, 'aud-1').i, 1);
  const edited = demoShow();
  edited.groups.find((g) => g.id === 'audience')!.fixtures = ['aud-2'];
  e.setShow(edited, 1);
  e.frame(1.025);
  assert.equal(lightOf(e, 'aud-2').i, 1);
  assert.equal(lightOf(e, 'aud-1').i, 0);
});

test('an Any colour group comes back after Blackout when the next look does not list it', () => {
  const show = demoShow();
  show.looks.push({ id: 'pulpit-only', name: 'Pulpit only', section: 'Other', swatch: '#ffffff', groups: [{ group: 'pulpit', preset: 'pulpit-on' }] });
  const e2 = new Engine(show);
  e2.apply({ type: 'look', id: 'walk-in' }, 0);
  e2.apply({ type: 'groupColour', group: 'audience', colour: '#00ff80', fade: 0 }, 1);
  e2.apply({ type: 'blackout' }, 5);
  e2.frame(7);
  assert.equal(e2.apply({ type: 'look', id: 'pulpit-only' }, 7), null);
  const step = maxStep(e2, 7, 12);
  assert.ok(step < 0.05, `largest step ${step}`);
  assert.equal(e2.liveState(12, 'ok').groups.audience.preset, 'live:audience:#00ff80');
  const l = lightOf(e2, 'aud-1');
  assert.ok(close(l.r, 0) && close(l.g, 1) && close(l.i, 1), JSON.stringify(l));
});

test('a group on the built-in safe light before Blackout comes back to it', () => {
  const show = demoShow();
  show.looks.push({ id: 'pulpit-only', name: 'Pulpit only', section: 'Other', swatch: '#ffffff', groups: [{ group: 'pulpit', preset: 'pulpit-on' }] });
  const e = new Engine(show);
  e.apply({ type: 'safe' }, 0);
  e.apply({ type: 'blackout' }, 5);
  e.frame(7);
  assert.equal(e.apply({ type: 'look', id: 'pulpit-only' }, 7), null);
  e.frame(12);
  assert.equal(e.liveState(12, 'ok').groups.audience.preset, '__safe');
  assert.ok(lightOf(e, 'aud-1').i > 0.3);
});

/** The demo show with a look "mine" that lists only the audience, and a custom audience preset of the given light. */
function savedShow(layer: { hex: string; white?: number; intensity: number }, point: boolean): Show {
  const show = demoShow();
  show.presets.push({
    id: 'custom-1', name: 'Custom', group: 'audience', custom: true, fade: 3, swatch: layer.hex,
    layers: [{ kind: 'static', colour: { hex: layer.hex, ...(layer.white ? { white: layer.white } : {}) }, intensity: layer.intensity }],
  });
  show.looks.push({ id: 'mine', name: 'Mine', section: 'Other', swatch: '#ffffff', groups: [{ group: 'audience', preset: point ? 'custom-1' : 'aud-low' }] });
  return show;
}

test('Save clears changed: a live colour is adopted by the saved custom preset without a visual change', () => {
  const e = new Engine(savedShow({ hex: '#00ff80', intensity: 1 }, false));
  e.apply({ type: 'look', id: 'mine', fade: 0 }, 0);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#00ff80', fade: 0 }, 1);
  e.frame(2);
  assert.equal(e.liveState(2, 'ok').lookChanged, true);
  const before = Array.from(e.frame(2.025).universes.get(0)!);
  const undoable = e.liveState(2, 'ok').canUndo;
  e.setShow(savedShow({ hex: '#00ff80', intensity: 1 }, true), 2.05);
  const after = Array.from(e.frame(2.05).universes.get(0)!);
  assert.deepEqual(after, before);
  const s = e.liveState(2.05, 'ok');
  assert.equal(s.lookChanged, false);
  assert.equal(s.groups.audience.preset, 'custom-1');
  assert.equal(s.canUndo, undoable);
  assert.equal(e.runtime().groups.audience, 'custom-1');
  const step = maxStep(e, 2.05, 6);
  assert.ok(step < 1e-9, `largest step ${step}`);
});

test('Save clears changed for a group on the built-in safe light', () => {
  const light = { hex: '#ffd2a0', white: 0.5, intensity: 0.8 };
  const empty = savedShow(light, false);
  empty.looks.push({ id: 'basic', name: 'Basic lights', section: 'Other', swatch: '#ffd2a0', groups: [] });
  empty.operator.safeLook = 'basic';
  const e = new Engine(empty);
  e.apply({ type: 'look', id: 'mine', fade: 0 }, 0);
  e.apply({ type: 'safe' }, 1);
  e.frame(4);
  assert.equal(e.liveState(4, 'ok').groups.audience.preset, '__safe');
  assert.equal(e.liveState(4, 'ok').lookChanged, false);
  const before = Array.from(e.frame(4.025).universes.get(0)!);
  // Save on Basic lights: the audience entry now names the "Basic light" custom preset.
  const saved = savedShow(light, false);
  saved.looks.push({ id: 'basic', name: 'Basic lights', section: 'Other', swatch: '#ffd2a0', groups: [{ group: 'audience', preset: 'custom-1' }] });
  saved.operator.safeLook = 'basic';
  e.setShow(saved, 4.05);
  assert.deepEqual(Array.from(e.frame(4.05).universes.get(0)!), before);
  const s = e.liveState(4.05, 'ok');
  assert.equal(s.groups.audience.preset, 'custom-1');
  assert.equal(s.groups['back-wall'].preset, '__safe');
  assert.equal(s.lookChanged, false);
});

test('a custom preset of a different colour is not adopted', () => {
  const e = new Engine(savedShow({ hex: '#00ff80', intensity: 1 }, false));
  e.apply({ type: 'look', id: 'mine', fade: 0 }, 0);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#00ff81', fade: 0 }, 1);
  e.setShow(savedShow({ hex: '#00ff80', intensity: 1 }, true), 2);
  const s = e.liveState(2, 'ok');
  assert.equal(s.lookChanged, true);
  assert.equal(s.groups.audience.preset, 'live:audience:#00ff81');
});

test('Basic lights notices a change to a group the safe look does not list', () => {
  const show = demoShow();
  show.looks.push({ id: 'basic', name: 'Basic lights', section: 'Other', swatch: '#ffd2a0', groups: [] });
  show.operator.safeLook = 'basic';
  const e = new Engine(show);
  e.apply({ type: 'safe' }, 0);
  e.frame(3);
  assert.equal(e.liveState(3, 'ok').lookChanged, false);
  e.apply({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 }, 3);
  e.frame(4);
  assert.equal(e.liveState(4, 'ok').lookChanged, true);
  assert.equal(e.apply({ type: 'backToLook' }, 4), null);
  e.frame(9);
  assert.equal(e.liveState(9, 'ok').lookChanged, false);
  assert.equal(e.liveState(9, 'ok').groups['back-wall'].preset, '__safe');
});

/** The demo show with a plain preset "aud-new" added to a group, as Add to colours makes it. */
function withAddedColour(hex: string, intensity = 1, group = 'audience'): Show {
  const show = demoShow();
  show.presets.push({ id: 'aud-new', name: 'Colour 1', group, fade: 3, swatch: hex, layers: [{ kind: 'static', colour: { hex }, intensity }] });
  return show;
}

test('a group running a colour live adopts the same colour added to its list, with no visible change', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply({ type: 'groupColour', group: 'audience', colour: '#00ff80' }, 1);
  e.frame(2);
  const mid = e.liveState(2, 'ok').groups.audience.progress;
  assert.ok(mid < 1, 'still fading in when the colour is added');
  const before = Array.from(e.frame(2.025).universes.get(0)!);
  const undoable = e.liveState(2.025, 'ok').canUndo;
  e.setShow(withAddedColour('#00ff80'), 2.025);
  assert.deepEqual(Array.from(e.frame(2.025).universes.get(0)!), before);
  const s = e.liveState(2.025, 'ok');
  assert.equal(s.groups.audience.preset, 'aud-new');
  assert.equal(s.canUndo, undoable);
  assert.equal(e.runtime().groups.audience, 'aud-new');
  const step = maxStep(e, 2.05, 9);
  assert.ok(step < 0.05, `largest step ${step}`);
});

test('a live colour is not adopted by a different colour, another group or a different level', () => {
  const run = (show: Show) => {
    const e = new Engine(demoShow());
    e.apply({ type: 'groupColour', group: 'audience', colour: '#00ff80', fade: 0 }, 0);
    e.setShow(show, 1);
    return e.liveState(1, 'ok').groups.audience.preset;
  };
  const live = 'live:audience:#00ff80';
  assert.equal(run(withAddedColour('#00ff81')), live);
  assert.equal(run(withAddedColour('#00ff80', 1, 'pulpit')), live);
  assert.equal(run(withAddedColour('#00ff80', 0.5)), live);
  assert.equal(run(withAddedColour('#00ff80')), 'aud-new');
});

test('a preset the show already had is not taken over by a live colour of the same light', () => {
  const e = new Engine(withAddedColour('#00ff80'));
  e.apply({ type: 'groupColour', group: 'audience', colour: '#00ff80', fade: 0 }, 0);
  e.setShow(withAddedColour('#00ff80'), 1);
  assert.equal(e.liveState(1, 'ok').groups.audience.preset, 'live:audience:#00ff80');
});

test('undoing the added colour turns the group back into the same colour live', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'groupColour', group: 'audience', colour: '#00ff80', fade: 0 }, 0);
  e.setShow(withAddedColour('#00ff80'), 1);
  assert.equal(e.liveState(1, 'ok').groups.audience.preset, 'aud-new');
  e.frame(2);
  const before = Array.from(e.frame(2.025).universes.get(0)!);
  e.setShow(demoShow(), 2.025); // Undo takes the preset away again
  assert.deepEqual(Array.from(e.frame(2.025).universes.get(0)!), before);
  assert.equal(e.liveState(2.025, 'ok').groups.audience.preset, 'live:audience:#00ff80');
  assert.equal(e.runtime().groups.audience, 'live:audience:#00ff80');
  assert.ok(maxStep(e, 2.05, 6) < 0.05);
});

test('a colour edited while it is lit fades to the new colour with its own fade, and stays the same preset', () => {
  const plain = (hex: string): Show => {
    const show = demoShow();
    const p = show.presets.find((x) => x.id === 'aud-blue')!;
    p.layers = [{ kind: 'static', colour: { hex }, intensity: 1 }];
    p.fade = 4;
    return show;
  };
  const e = new Engine(plain('#0000ff'));
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 }, 0);
  e.frame(1);
  const undoable = e.liveState(1, 'ok').canUndo;
  const before = lightOf(e, 'aud-1');
  e.setShow(plain('#ff8000'), 1);
  const at = (t: number) => { e.frame(t); return lightOf(e, 'aud-1'); };
  const start = at(1.025);
  assert.ok(close(start.r, before.r, 0.02) && close(start.b, before.b, 0.02), 'no jump when the edit lands');
  const mid = at(3);
  assert.ok(mid.r > 0.2 && mid.b > 0.2, `halfway between the two colours (${mid.r}, ${mid.b})`);
  const end = at(6);
  assert.ok(close(end.r, 1, 0.01) && close(end.g, 0.5, 0.02) && close(end.b, 0, 0.01), `settled on the new colour (${end.r}, ${end.g}, ${end.b})`);
  const s = e.liveState(6, 'ok');
  assert.equal(s.groups.audience.preset, 'aud-blue');
  assert.equal(s.canUndo, undoable);
  const e2 = new Engine(plain('#0000ff'));
  e2.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 }, 0);
  e2.frame(1);
  e2.setShow(plain('#ff8000'), 1);
  assert.ok(maxStep(e2, 1.025, 8) < 0.05);
});

test('a show edit that leaves a lit colour alone does not start a fade', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 }, 0);
  e.frame(1);
  const edited = demoShow();
  edited.looks.push({ id: 'extra', name: 'Extra', section: 'Other', swatch: '#ffffff', groups: [] });
  e.setShow(edited, 1);
  assert.equal(e.liveState(1.025, 'ok').groups.audience.progress, 1);
});

test('undoing the added colour during Blackout keeps the group\'s colour for the next look', () => {
  const withLook = (show: Show): Show => {
    show.looks.push({ id: 'pulpit-only', name: 'Pulpit only', section: 'Other', swatch: '#ffffff', groups: [{ group: 'pulpit', preset: 'pulpit-on' }] });
    return show;
  };
  const e = new Engine(withLook(demoShow()));
  e.apply({ type: 'groupColour', group: 'audience', colour: '#00ff80', fade: 0 }, 0);
  e.setShow(withLook(withAddedColour('#00ff80')), 1);
  assert.equal(e.liveState(1, 'ok').groups.audience.preset, 'aud-new');
  e.apply({ type: 'blackout' }, 2);
  e.frame(4);
  assert.equal(e.runtime().beforeBlackout?.audience, 'aud-new');
  e.setShow(withLook(demoShow()), 4); // Undo of the add while Blackout is on
  assert.equal(e.runtime().beforeBlackout?.audience, 'live:audience:#00ff80');
  assert.equal(e.apply({ type: 'look', id: 'pulpit-only' }, 5), null);
  e.frame(10);
  assert.equal(e.liveState(10, 'ok').groups.audience.preset, 'live:audience:#00ff80');
  const l = lightOf(e, 'aud-1');
  assert.ok(close(l.g, 1) && l.i > 0.9, JSON.stringify(l));
});

test('a Blackout memory of a removed preset that is not a plain colour is cleared', () => {
  const withLook = (show: Show): Show => {
    show.looks.push({ id: 'pulpit-only', name: 'Pulpit only', section: 'Other', swatch: '#ffffff', groups: [{ group: 'pulpit', preset: 'pulpit-on' }] });
    return show;
  };
  const e = new Engine(withLook(demoShow()));
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-low', fade: 0 }, 0);
  e.apply({ type: 'blackout' }, 1);
  const smaller = withLook(demoShow());
  smaller.presets = smaller.presets.filter((p) => p.id !== 'aud-low');
  e.setShow(smaller, 2);
  assert.equal(e.runtime().beforeBlackout?.audience ?? null, null);
  assert.equal(e.apply({ type: 'look', id: 'pulpit-only' }, 3), null);
});

test('a group on a preset the show loses, that is not a plain colour, is left alone', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-low', fade: 0 }, 0);
  const smaller = demoShow();
  smaller.presets = smaller.presets.filter((p) => p.id !== 'aud-low');
  e.setShow(smaller, 1);
  assert.equal(e.liveState(1, 'ok').groups.audience.preset, 'aud-low');
});
