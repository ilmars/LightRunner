// Built-in real lights listed by maker, for Patch's "Browse by manufacturer" and library search.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_FIXTURES, BUILT_IN_KEY, BUILT_IN_PROFILES, PORTMAN_P1_MINI, builtInHitsOf, builtInMakers, builtInModes, searchBuiltIns } from '../src/index.ts';

const P1 = `${BUILT_IN_KEY}portman-lights/p1-mini-led`;

test('Portman Lights is a maker with one built-in light, the P1 Mini', () => {
  assert.deepEqual(builtInMakers(), [{ key: 'portman-lights', name: 'Portman Lights', count: 1 }]);
  assert.deepEqual(builtInHitsOf('portman-lights'), [{ key: P1, manufacturer: 'Portman Lights', name: 'P1 Mini LED', categories: ['Color Changer', 'Dimmer'] }]);
  assert.deepEqual(builtInHitsOf('stairville'), []);
  // Every built-in light's modes are built-in types.
  for (const f of BUILT_IN_FIXTURES) for (const m of f.modes) assert.ok(BUILT_IN_PROFILES.includes(m.profile), m.profile.id);
});

test('search finds it by maker, name or both, and not by a word it lacks', () => {
  for (const q of ['portman', 'P1 mini', 'portman p1', 'mini LED']) assert.deepEqual(searchBuiltIns(q).map((h) => h.key), [P1], q);
  for (const q of ['sonicpulse', 'portman bar', 'p', '  ']) assert.deepEqual(searchBuiltIns(q), [], q);
});

test('its modes say which built-in type each one is', () => {
  const info = builtInModes(P1)!;
  assert.equal(info.manufacturer, 'Portman Lights');
  assert.deepEqual(info.modes.map((m) => [m.index, m.name, m.channels, m.profile]), [
    [0, 'Simple', 19, 'portman-p1-mini-simple'],
    [1, 'Standard', 43, 'portman-p1-mini-standard'],
    [2, 'Standard fine', 50, 'portman-p1-mini-standard-fine'],
    [3, 'Pixel', 42, 'portman-p1-mini-pixel'],
    [4, 'Pixel fine', 49, 'portman-p1-mini-pixel-fine'],
  ]);
  assert.deepEqual(info.modes.map((m) => m.profile), PORTMAN_P1_MINI.map((p) => p.id));
  assert.deepEqual(info.modes[3].roles, ['amber', 'red', 'green', 'blue', 'white']);
  assert.equal(builtInModes('stairville/sonicpulse-led-bar-10'), undefined);
});
