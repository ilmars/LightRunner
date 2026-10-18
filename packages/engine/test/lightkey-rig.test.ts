import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseShow } from '../../shared/src/index.ts';
import { Engine, fromHex } from '../src/index.ts';
import { kelvinOf } from '../src/output.ts';

const show = () => parseShow(JSON.parse(readFileSync(new URL('../../../shows/dieva-majas-l1.json', import.meta.url), 'utf8')));
const dmx = (v: number) => Math.round(Math.pow(v, 2.2) * 255);

test('warm colours give warm colour temperature, blue gives cool', () => {
  assert.ok(kelvinOf(fromHex('#ffb46b')) < 3400);
  assert.ok(Math.abs(kelvinOf(fromHex('#ffeedd')) - 5600) < 400);
  assert.equal(kelvinOf(fromHex('#0000ff')), 10000);
});

test('the imported rig drives every channel of a look', () => {
  const e = new Engine(show());
  e.apply({ type: 'look', id: 'sermon' }, 0);
  const u = e.frame(10).universes.get(1)!;
  assert.ok(u, 'universe 1');
  // P1 AS600B at 1: dimmer full, colour temperature ~5600 K in a 2500–10000 K range
  // (a colour temperature, so linear: no gamma).
  assert.equal(u[0], 255);
  assert.ok(Math.abs(u[1] - Math.round(((5600 - 2500) / 7500) * 255)) <= 6, `cct ${u[1]}`);
  // B1 SixBar 500 at 10: three identical RGBWAUV segments, cool white #dcebff.
  const seg = Array.from(u.slice(9, 15));
  assert.deepEqual(Array.from(u.slice(15, 21)), seg);
  assert.deepEqual(Array.from(u.slice(21, 27)), seg);
  assert.equal(seg[2], 255); // blue is the brightest channel
  // B6 SonicPulse Bar 10 at 165: dimmer, strobe open (0), mode channels 0, then blue segments.
  assert.equal(u[164], 255);
  assert.deepEqual(Array.from(u.slice(165, 171)), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(u.slice(171, 175)), [0, 0, 255, 0]);
});

test('key lights are off in Walk-in while the front lights sit at half', () => {
  const e = new Engine(show());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  const u = e.frame(10).universes.get(1)!;
  assert.ok(u.slice(9, 27).every((v) => v === 0));
  assert.equal(u[0], dmx(0.5));
});
