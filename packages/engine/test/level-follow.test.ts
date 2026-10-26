// Timeline support in the engine: a fade on a group's level, a smoothed level that
// follows a voice, and commands that leave Undo alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShow, type Show } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { close, demoShow, FRAME, lightOf } from './helpers.ts';

/** aud-1 sits in the audience group and shows 0.6 under the Walk-in look. */
const AUD = 0.6;
const aud = (e: Engine) => lightOf(e, 'aud-1').i / AUD;

function settled(): Engine {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.frame(4);
  return e;
}

test('a group level with a fade of 20 s is half way at 10 s and never steps more than 5 % a frame', () => {
  const e = settled();
  e.apply({ type: 'groupLevel', group: 'audience', value: 0, fade: 20 }, 4);
  let prev = aud(e);
  assert.ok(close(prev, 1));
  let worst = 0;
  let half = NaN;
  for (let t = 4; t <= 24 + 1e-9; t += FRAME) {
    e.frame(t);
    const v = aud(e);
    worst = Math.max(worst, Math.abs(v - prev));
    prev = v;
    if (Math.abs(t - 14) < FRAME / 2) half = v;
  }
  assert.ok(close(half, 0.5, 0.01), `half way at 10 s into the fade: ${half}`);
  assert.ok(worst < 0.05, `largest step ${worst}`);
  assert.ok(close(prev, 0, 1e-9));
  assert.equal(e.liveState(24, 'ok').groups.audience.level, 0);
});

test('a group level without a fade still smooths over 0.2 s', () => {
  const e = settled();
  e.apply({ type: 'groupLevel', group: 'audience', value: 0 }, 4);
  e.frame(4.1);
  const mid = aud(e);
  assert.ok(mid > 0 && mid < 1, `smoothed: ${mid}`);
  e.frame(4.3);
  assert.ok(close(aud(e), 0));
});

test('a level that follows a voice rises at most 0.025 a frame (under the 0.05 limit) and falls at most 0.02', () => {
  const e = settled();
  // Down from 1 to 0 first: falls at most 0.02 a frame.
  e.setLevelFollow('audience', 0, 4);
  let prev = aud(e);
  let t = 4;
  let worstFall = 0;
  for (let n = 0; n < 80; n++) {
    t += FRAME;
    e.frame(t);
    const v = aud(e);
    worstFall = Math.max(worstFall, prev - v);
    assert.ok(v <= prev + 1e-9, 'never rises while the voice is quiet');
    prev = v;
  }
  assert.ok(worstFall <= 0.02 + 1e-9, `fall ${worstFall}`);
  assert.ok(close(prev, 0, 1e-9), `reached silence: ${prev}`);
  // Then jump straight back to 1.
  e.setLevelFollow('audience', 1, t);
  let worstRise = 0;
  let frames = 0;
  for (let n = 0; n < 40; n++) {
    t += FRAME;
    e.frame(t);
    const v = aud(e);
    worstRise = Math.max(worstRise, v - prev);
    if (close(v, 1, 1e-9) && !frames) frames = n + 1;
    prev = v;
  }
  assert.ok(worstRise <= 0.025 + 1e-9, `rise ${worstRise}`);
  assert.ok(worstRise > 0.024, `rises as fast as allowed: ${worstRise}`);
  assert.ok(frames > 0 && frames <= 41, `back to full in ${frames} frames`);
});

test('the follow limits are per second, so they hold at 20 frames a second too', () => {
  const e = settled();
  e.setLevelFollow('audience', 0, 4);
  let t = 4;
  let prev = aud(e);
  for (let n = 0; n < 100; n++) {
    t += 0.05;
    e.frame(t);
    prev = aud(e);
  }
  assert.ok(close(prev, 0, 1e-9));
  e.setLevelFollow('audience', 1, t);
  let worst = 0;
  for (let n = 0; n < 40; n++) {
    t += 0.05;
    e.frame(t);
    const v = aud(e);
    worst = Math.max(worst, v - prev);
    prev = v;
  }
  assert.ok(worst <= 0.05 + 1e-9, `rise per 50 ms frame ${worst}`);
  assert.ok(worst > 0.049, `and not slower than the limit: ${worst}`);
});

test('null hands the level back to 1 in about a second', () => {
  const e = settled();
  e.setLevelFollow('audience', 0, 4);
  let t = 4;
  for (let n = 0; n < 80; n++) e.frame((t += FRAME));
  assert.ok(close(aud(e), 0, 1e-9));
  e.setLevelFollow('audience', null, t);
  let prev = aud(e);
  let worst = 0;
  const from = t;
  let back = NaN;
  for (let n = 0; n < 60; n++) {
    e.frame((t += FRAME));
    const v = aud(e);
    worst = Math.max(worst, v - prev);
    if (Number.isNaN(back) && close(v, 1, 1e-9)) back = t - from;
    prev = v;
  }
  assert.ok(worst <= 0.025 + 1e-9, `rise ${worst}`);
  assert.ok(back > 0.9 && back < 1.2, `back to 1 after ${back} s`);
});

test('following is a multiplier: it is not in the level, the saved runtime or Undo', () => {
  const e = settled();
  e.apply({ type: 'groupLevel', group: 'audience', value: 0.5 }, 4);
  e.frame(5);
  e.setLevelFollow('audience', 0, 5);
  for (let t = 5; t < 8; t += FRAME) e.frame(t);
  assert.ok(lightOf(e, 'aud-1').i < AUD * 0.5, 'the light is dimmed by the follow');
  const s = e.liveState(8, 'ok');
  assert.equal(s.groups.audience.level, 0.5);
  assert.equal(e.runtime().levels.audience, 0.5);
  // Undo goes back to the look, with the level the group had, not the followed one.
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-blue' }, 8);
  e.apply({ type: 'undo' }, 8.1);
  assert.equal(e.liveState(9, 'ok').groups.audience.level, 0.5);
});

test('other groups and smoke groups ignore the follow', () => {
  const show: Show = demoShow();
  show.fixtures.push({ id: 'hazer', name: 'Hazer', profile: 'generic-dimmer', universe: 0, address: 60, x: 0.5, y: 0.1 });
  show.groups.push({ id: 'haze', name: 'Haze', kind: 'smoke', fixtures: ['hazer'] });
  const e = new Engine(parseShow(show));
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.5 }, 0);
  e.frame(4);
  e.setLevelFollow('haze', 0, 4);
  e.setLevelFollow('nope', 0, 4);
  e.setLevelFollow('audience', 0, 4);
  for (let t = 4; t < 8; t += FRAME) e.frame(t);
  assert.ok(close(lightOf(e, 'hazer').i, 0.5), 'smoke is untouched');
  assert.ok(close(lightOf(e, 'back-1').i, 0.8), 'so is every other group');
  assert.ok(close(lightOf(e, 'aud-1').i, 0), 'the audience followed it to silence');
});

test('quiet commands leave Undo alone', () => {
  const e = new Engine(demoShow());
  assert.equal(e.apply({ type: 'look', id: 'walk-in' }, 0, { quiet: true }), null);
  assert.equal(e.recorded, false);
  assert.equal(e.apply({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber' }, 4, { quiet: true }), null);
  assert.equal(e.recorded, false);
  assert.equal(e.liveState(5, 'ok').canUndo, false);
  assert.match(e.apply({ type: 'undo' }, 5)!, /nothing to undo/);
  // The command did run.
  e.frame(8);
  assert.equal(e.liveState(8, 'ok').groups['back-wall'].preset, 'back-amber');
  // A command from someone else still adds its step, and Undo goes back to the quiet state.
  e.apply({ type: 'look', id: 'worship' }, 8);
  assert.equal(e.recorded, true);
  assert.equal(e.liveState(9, 'ok').canUndo, true);
  e.apply({ type: 'undo' }, 9);
  e.frame(14);
  const s = e.liveState(14, 'ok');
  assert.equal(s.look, 'walk-in');
  assert.equal(s.groups['back-wall'].preset, 'back-amber');
  assert.equal(s.canUndo, false);
});

/** Run `engine` for `secs` from `from` and return its time. */
function run(e: Engine, from: number, secs: number): number {
  let t = from;
  for (const end = from + secs; t < end - 1e-9; ) e.frame((t += FRAME));
  return t;
}

test('Basic lights and Blackout let go of a follow, so they never depend on the timeline runner', () => {
  for (const type of ['safe', 'blackout'] as const) {
    const e = settled();
    e.setLevelFollow('audience', 0, 4);
    let t = run(e, 4, 3);
    assert.ok(close(aud(e), 0, 1e-9), 'dimmed by the follow');
    e.apply({ type }, t);
    t = run(e, t, 4);
    // Whatever the button shows, nothing is held down now: the next look is at full.
    e.apply({ type: 'look', id: 'walk-in', fade: 0 }, t);
    t = run(e, t, 3);
    assert.ok(close(aud(e), 1, 1e-6), `${type}: the follow is gone (${aud(e)})`);
  }
});

test('a look from the timeline or anyone else leaves the follow alone', () => {
  const e = settled();
  e.setLevelFollow('audience', 0, 4);
  let t = run(e, 4, 3);
  e.apply({ type: 'look', id: 'worship', fade: 0 }, t, { quiet: true });
  t = run(e, t, 3);
  assert.ok(close(lightOf(e, 'aud-1').i, 0, 1e-9), 'still following');
  e.apply({ type: 'look', id: 'walk-in', fade: 0 }, t);
  t = run(e, t, 3);
  assert.ok(close(lightOf(e, 'aud-1').i, 0, 1e-9), 'a look does not clear it');
});
