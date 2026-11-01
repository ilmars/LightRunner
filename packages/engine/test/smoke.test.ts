// Smoke and haze machines: a smoke group is only ever turned on by its own
// slider or a held Puff. Looks, Basic lights, Flash All, Master, Undo and a
// restart never turn it on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShow, type Show } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { close, demoShow, lightOf, maxStep } from './helpers.ts';

/** DMX channel 60 (offset 59) of universe 0: the hazer. */
const HAZER = 59;
const LIGHTS = ['front-wash', 'back-wall', 'audience', 'pulpit'];

/**
 * The demo show with a 1-channel hazer in a smoke group "Haze". Worship, a quick
 * look and the Basic lights look all list it (as an import could), to check they
 * are ignored for it. With `shared`, the hazer is also in the front wash group.
 */
function hazeShow(opts: { shared?: boolean; kind?: 'light' | 'smoke' } = {}): Show {
  const show = demoShow();
  show.fixtures.push({ id: 'hazer', name: 'Hazer', profile: 'generic-dimmer', universe: 0, address: 60, x: 0.5, y: 0.1 });
  show.groups.push({ id: 'haze', name: 'Haze', kind: opts.kind ?? 'smoke', fixtures: ['hazer'] });
  if (opts.shared) show.groups.find((g) => g.id === 'front-wash')!.fixtures.push('hazer');
  show.presets.push({ id: 'haze-on', name: 'On', group: 'haze', layers: [{ kind: 'static', colour: { hex: '#ffffff' }, intensity: 1 }], fade: 3 });
  show.looks.find((l) => l.id === 'worship')!.groups.push({ group: 'haze', preset: 'haze-on', level: 1 });
  show.looks.push(
    { id: 'haze-quick', name: 'Haze quick', groups: [{ group: 'haze', preset: 'haze-on', level: 0 }, { group: 'back-wall', preset: 'back-amber' }] },
    { id: 'basic', name: 'Basic lights', groups: [{ group: 'haze', preset: 'haze-on' }, { group: 'audience', preset: 'aud-low' }] },
  );
  show.operator.safeLook = 'basic';
  return parseShow(show);
}

const dmxAt = (e: Engine, t: number) => e.frame(t).universes.get(0)![HAZER]!;
const smokeAt = (e: Engine, t: number) => {
  e.frame(t);
  return lightOf(e, 'hazer').i;
};

test('a smoke group starts off and follows its own slider, smoothed and linear', () => {
  const e = new Engine(hazeShow());
  assert.equal(dmxAt(e, 0), 0);
  e.apply({ type: 'look', id: 'worship' }, 0);
  assert.equal(dmxAt(e, 5), 0, 'a look never turns it on');
  assert.equal(e.liveState(5, 'ok').groups.haze.level, 0);

  e.apply({ type: 'groupLevel', group: 'haze', value: 0.5 }, 5);
  const mid = smokeAt(e, 5.1);
  assert.ok(mid > 0 && mid < 0.5, `smoothed, not a step: ${mid}`);
  // No gamma: 50 % is DMX 128, where a light dimmer would get 56.
  assert.equal(dmxAt(e, 5.5), Math.round(0.5 * 255));
  assert.ok(close(lightOf(e, 'hazer').i, 0.5));
});

test('Master dims the lights but not the smoke', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.5 }, 0);
  e.apply({ type: 'master', value: 0.2 }, 0);
  e.frame(5);
  assert.ok(close(lightOf(e, 'hazer').i, 0.5));
  assert.ok(close(lightOf(e, 'front-1').i, 0.8 * 0.2), 'Master still dims the lights');
});

test('Basic lights turns smoke off, even when the Basic lights look lists it', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.7 }, 0);
  e.frame(3);
  e.apply({ type: 'safe' }, 3);
  // Off, but without a step: the stage keeps the 5 % rule.
  const step = maxStep(e, 3, 6);
  assert.ok(step < 0.05, `largest step ${step}`);
  assert.equal(dmxAt(e, 6), 0);
  const s = e.liveState(6, 'ok');
  assert.equal(s.groups.haze.level, 0);
  assert.equal(s.groups.haze.preset, null, 'never the safe light');
  assert.equal(s.lookChanged, false);
  assert.ok(close(lightOf(e, 'front-1').i, 0.8), 'the lights get the safe light');
});

test('Back to look on Basic lights turns smoke off', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'safe' }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.6 }, 3);
  assert.ok(close(smokeAt(e, 4), 0.6));
  e.apply({ type: 'backToLook' }, 4);
  assert.equal(smokeAt(e, 6), 0);
});

test('Blackout turns smoke off; Puff and the next look leave it off', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.6 }, 0);
  e.frame(3);
  e.apply({ type: 'blackout' }, 3);
  assert.equal(dmxAt(e, 4.5), 0);
  e.apply({ type: 'flash', groups: ['haze'], on: true }, 4.5);
  assert.equal(dmxAt(e, 4.6), 0, 'no Puff during Blackout');
  e.apply({ type: 'flash', groups: ['haze'], on: false }, 4.6);
  e.apply({ type: 'look', id: 'worship' }, 5);
  assert.equal(dmxAt(e, 10), 0);
});

test('the smoke slider is refused during Blackout', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'blackout' }, 1);
  assert.equal(e.apply({ type: 'groupLevel', group: 'haze', value: 0.8 }, 2), 'Blackout is on.');
  assert.equal(dmxAt(e, 3), 0);
  assert.equal(e.liveState(3, 'ok').groups.haze.level, 0);
  // Light dimmers still move in Blackout, as before.
  assert.equal(e.apply({ type: 'groupLevel', group: 'back-wall', value: 0.5 }, 3), null);
  e.apply({ type: 'look', id: 'worship' }, 4);
  assert.equal(e.apply({ type: 'groupLevel', group: 'haze', value: 0.8 }, 5), null, 'after Blackout it works again');
});

test('leaving Blackout quietly (a live timeline starts): no light moves, no Undo step, and a later look does not bring the old stage back', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'word', fade: 0 }, 0);
  e.frame(1);
  assert.ok(lightOf(e, 'pulpit').i > 0.9, 'the Sermon lights the pulpit');
  e.apply({ type: 'blackout' }, 1);
  e.frame(4);
  const dark = e.fixtureIds().map((f) => lightOf(e, f).i);
  const undo = e.liveState(4, 'ok').canUndo;
  assert.equal(e.leaveBlackout(4), true);
  assert.equal(e.leaveBlackout(4), false, 'only once');
  const state = e.liveState(4, 'ok');
  assert.equal(state.look, null);
  assert.equal(state.canUndo, undo, 'no Undo step');
  for (const t of [4.1, 5, 8]) {
    e.frame(t);
    assert.deepEqual(e.fixtureIds().map((f) => lightOf(e, f).i), dark, `nothing moved at ${t}`);
  }
  assert.equal(e.runtime().beforeBlackout ?? null, null);
  // The smoke slider works again.
  assert.equal(e.apply({ type: 'groupLevel', group: 'haze', value: 0.8 }, 8), null);
  // Worship doesn't list the pulpit: it stays dark (Blackout's memory is gone).
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 9);
  assert.notEqual(e.liveState(12, 'ok').groups.pulpit!.preset, 'pulpit-on');
  // Not in Blackout: nothing happens.
  assert.equal(e.leaveBlackout(12), false);
  assert.equal(e.liveState(12, 'ok').look, 'worship');
});

test('a Puff held longer than 15 s ends by itself', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.2 }, 0);
  e.apply({ type: 'flash', groups: ['haze'], on: true }, 10);
  assert.equal(dmxAt(e, 10.025), 255);
  // Another "on" while it is held doesn't start the 15 s again.
  e.apply({ type: 'flash', groups: ['haze'], on: true }, 20);
  assert.equal(dmxAt(e, 24.9), 255);
  assert.ok(close(smokeAt(e, 25), 0.2), 'back to its slider after 15 s');
  assert.deepEqual(e.liveState(25, 'ok').flashing, []);
  assert.ok(close(smokeAt(e, 40), 0.2), 'and it stays there while the button is still down');
  // Letting go and holding again gives a new Puff.
  e.apply({ type: 'flash', groups: ['haze'], on: false }, 41);
  e.apply({ type: 'flash', groups: ['haze'], on: true }, 42);
  assert.equal(dmxAt(e, 42.025), 255);
});

test('Flash of several groups (All) leaves smoke out', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.frame(5);
  e.apply({ type: 'flash', groups: [...LIGHTS, 'haze'], on: true }, 5);
  e.frame(5.025);
  assert.equal(lightOf(e, 'hazer').i, 0);
  assert.equal(lightOf(e, 'front-1').i, 1, 'the lights flash');
  assert.deepEqual(e.liveState(5.025, 'ok').flashing.sort(), [...LIGHTS].sort());
  e.apply({ type: 'flash', groups: [...LIGHTS, 'haze'], on: false }, 5.1);
  assert.deepEqual(e.liveState(5.1, 'ok').flashing, []);
});

test('Puff goes to full while held, ignoring Master and the slider, then back', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.2 }, 0);
  e.apply({ type: 'master', value: 0.3 }, 0);
  e.frame(3);
  const front = lightOf(e, 'front-1');
  e.apply({ type: 'flash', groups: ['haze'], on: true }, 3);
  assert.equal(dmxAt(e, 3.025), 255);
  assert.deepEqual(lightOf(e, 'front-1'), front, 'Puff leaves the lights alone');
  assert.deepEqual(e.liveState(3.025, 'ok').flashing, ['haze']);
  assert.equal(e.liveState(3.025, 'ok').groups.haze.level, 0.2, 'the slider keeps its level');
  e.apply({ type: 'flash', groups: ['haze'], on: false }, 4);
  assert.ok(close(smokeAt(e, 4.025), 0.2));
});

test('looks and quick looks never change smoke, and it never counts as changed', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.6 }, 0);
  e.apply({ type: 'look', id: 'worship' }, 1);
  assert.ok(close(smokeAt(e, 6), 0.6), 'worship lists the hazer at full, and is ignored');
  let s = e.liveState(6, 'ok');
  assert.equal(s.lookChanged, false);
  assert.equal(s.groups.haze.changed, false);
  e.apply({ type: 'quickLook', id: 'haze-quick' }, 6);
  assert.ok(close(smokeAt(e, 12), 0.6), 'the quick look lists it at 0, and is ignored');
  e.apply({ type: 'look', id: 'walk-in' }, 12);
  e.apply({ type: 'look', id: 'worship' }, 13);
  e.apply({ type: 'backToLook' }, 14);
  assert.ok(close(smokeAt(e, 20), 0.6));
  s = e.liveState(20, 'ok');
  assert.equal(s.lookChanged, false);
  assert.equal(s.groups.haze.preset, null);
});

test('Undo leaves smoke alone', () => {
  const e = new Engine(hazeShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.6 }, 0);
  e.apply({ type: 'blackout' }, 3);
  assert.equal(smokeAt(e, 5), 0);
  e.apply({ type: 'undo' }, 5);
  assert.equal(smokeAt(e, 9), 0, 'undoing Blackout does not bring the smoke back');
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.4 }, 9);
  e.apply({ type: 'undo' }, 10); // the first look
  assert.ok(close(smokeAt(e, 14), 0.4));
});

test('after a restart smoke is off, whatever level it had', () => {
  const show = hazeShow();
  const before = new Engine(show);
  before.apply({ type: 'look', id: 'worship' }, 0);
  before.apply({ type: 'groupLevel', group: 'haze', value: 0.7 }, 0);
  before.frame(2);
  const rt = before.runtime();
  assert.equal(rt.levels.haze, 0.7);

  const after = new Engine(show, 100);
  after.restore(rt, 100);
  assert.equal(dmxAt(after, 100), 0);
  assert.equal(after.runtime().levels.haze, 0);
  assert.ok(close(lightOf(after, 'front-1').i, 0.8), 'the lights come back as they were');

  const off = new Engine(show, 100);
  off.restore({ ...rt, levels: { ...rt.levels, haze: 0 } }, 100);
  assert.equal(dmxAt(off, 100), 0);
});

test('a smoke group takes no colour, preset or manual control', () => {
  const e = new Engine(hazeShow());
  assert.match(e.apply({ type: 'groupPreset', group: 'haze', preset: 'haze-on' }, 0)!, /smoke/);
  assert.match(e.apply({ type: 'groupColour', group: 'haze', colour: '#ffffff' }, 0)!, /smoke/);
  assert.match(e.apply({ type: 'manual', target: { group: 'haze' }, intensity: 1 }, 0)!, /smoke/);
  assert.match(e.apply({ type: 'manual', target: { fixture: 'hazer' }, intensity: 1 }, 0)!, /smoke/);
  assert.equal(dmxAt(e, 2), 0);
});

test('a hazer that is also in a light group stays off when that group lights up', () => {
  const e = new Engine(hazeShow({ shared: true }));
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'groupPreset', group: 'front-wash', preset: 'front-bright' }, 1);
  assert.equal(dmxAt(e, 6), 0);
  e.apply({ type: 'safe' }, 6);
  assert.equal(dmxAt(e, 9), 0);
  e.apply({ type: 'flash', groups: ['front-wash'], on: true }, 9);
  assert.equal(dmxAt(e, 9.025), 0);
  assert.equal(lightOf(e, 'front-1').i, 1);
  e.apply({ type: 'flash', groups: ['front-wash'], on: false }, 9.1);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.3 }, 9.1);
  assert.equal(dmxAt(e, 10), Math.round(0.3 * 255), 'its own slider still drives it');
});

test('a group that becomes a smoke group goes off', () => {
  const light = hazeShow({ kind: 'light' });
  const e = new Engine(light);
  e.apply({ type: 'look', id: 'worship' }, 0);
  assert.ok(dmxAt(e, 5) > 0, 'as a light group, worship turns it on');
  // Someone is holding its Flash while the programmer saves it as a smoke group: that is no Puff.
  e.apply({ type: 'flash', groups: ['haze'], on: true }, 5);
  const smoke = structuredClone(light);
  smoke.groups.find((g) => g.id === 'haze')!.kind = 'smoke';
  e.setShow(smoke, 5);
  assert.equal(dmxAt(e, 5), 0);
  const s = e.liveState(5, 'ok');
  assert.equal(s.groups.haze.level, 0);
  assert.deepEqual(s.flashing, []);
});

test('a group that stops being a smoke group comes back at full, not at its smoke level', () => {
  const smoke = hazeShow();
  const e = new Engine(smoke);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.3 }, 0);
  e.frame(1);
  const light = structuredClone(smoke);
  light.groups.find((g) => g.id === 'haze')!.kind = 'light';
  e.setShow(light, 1);
  assert.equal(e.liveState(1, 'ok').groups.haze.level, 1);
  // As a light it is dark until something sets it (it has run no preset).
  assert.equal(dmxAt(e, 1), 0);
  e.apply({ type: 'safe' }, 1);
  assert.ok(dmxAt(e, 4) > 0, 'now Basic lights drives it, as the Patch hint warns');
});
