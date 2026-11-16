// A quick look with `only`: a song's section sets just some of a look's groups (Auto-follow, the section rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/index.ts';
import { demoShow, maxStep } from './helpers.ts';

test('a quick look with only sets just those groups and leaves the look, the tempo and the other groups', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply({ type: 'tempo', bpm: 97 }, 0.5);
  e.frame(1);
  // "word" would set all four groups; only the back wall may change.
  assert.equal(e.apply({ type: 'quickLook', id: 'word', only: ['back-wall'], fade: 1 }, 1), null);
  const step = maxStep(e, 1, 3);
  assert.ok(step < 0.05, `largest step ${step}`);
  const s = e.liveState(3, 'ok');
  assert.equal(s.groups['back-wall']!.preset, 'back-dim-blue');
  assert.equal(s.groups['front-wash']!.preset, 'front-warm');
  assert.equal(s.groups.audience!.preset, 'aud-low');
  assert.equal(s.groups.pulpit!.preset, null);
  assert.equal(s.look, 'worship');
  assert.equal(s.lastLook, 'worship');
  assert.equal(s.tempo, 97);
  assert.equal(s.canUndo, true);
});

test('a quick look with an empty only changes nothing', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.frame(1);
  const before = e.liveState(1, 'ok');
  assert.equal(e.apply({ type: 'quickLook', id: 'word', only: [], fade: 0 }, 1), null);
  e.frame(2);
  assert.deepEqual(Object.fromEntries(Object.entries(e.liveState(2, 'ok').groups).map(([g, v]) => [g, v.preset])), Object.fromEntries(Object.entries(before.groups).map(([g, v]) => [g, v.preset])));
});
