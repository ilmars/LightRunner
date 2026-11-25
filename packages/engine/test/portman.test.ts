// The Portman P1 Mini LED's built-in types: channel order from Portman's DMX chart, and what the engine writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_PROFILES, PORTMAN_P1_MINI, Profile as ProfileSchema, type Fixture, type Profile } from '../../shared/src/index.ts';
import { dark, fromHex, type Light } from '../src/index.ts';
import { planChannels, writeCells, writeFixture } from '../src/output.ts';

const G = 2.2;
const mode = (id: string) => PORTMAN_P1_MINI.find((p) => p.id === `portman-p1-mini-${id}`)!;
const plan = (p: Profile) => {
  const fixture: Fixture = { id: 'f', name: 'f', profile: p.id, universe: 0, address: 1, x: 0.5, y: 0.5 };
  return planChannels(fixture, p, G);
};
/** Channel names, 1-based like the chart. */
const at = (p: Profile, ch: number) => p.channels[ch - 1].name;
const AMBER = fromHex('#000000', { amber: 1 }, 1);

test('the P1 Mini has its five modes, valid and built in', () => {
  assert.deepEqual(
    PORTMAN_P1_MINI.map((p) => [p.id, p.channels.length]),
    [
      ['portman-p1-mini-simple', 19], ['portman-p1-mini-standard', 43], ['portman-p1-mini-standard-fine', 50],
      ['portman-p1-mini-pixel', 42], ['portman-p1-mini-pixel-fine', 49],
    ],
  );
  for (const p of PORTMAN_P1_MINI) {
    ProfileSchema.parse(p);
    assert.ok(BUILT_IN_PROFILES.includes(p), p.id);
    assert.match(p.name, new RegExp(`^Portman P1 Mini, .+ \\(${p.channels.length} ch\\)$`));
  }
});

test('P1 Mini channels sit where the DMX chart puts them', () => {
  const simple = mode('simple');
  assert.equal(at(simple, 1), 'Filament 1');
  assert.equal(at(simple, 7), 'Filament 7');
  assert.deepEqual([8, 9, 10, 11, 12].map((c) => at(simple, c)), ['All glow red', 'All glow green', 'All glow blue', 'All glow white', 'Glow dimmer (kept at full)']);
  assert.deepEqual([13, 14, 15, 16, 17, 18, 19].map((c) => at(simple, c)),
    ['Glow strobe', 'Filament strobe', 'Glow colour wheel', 'Macro', 'Macro direction', 'Macro speed', 'Control']);

  const standard = mode('standard');
  assert.equal(at(standard, 8), 'Glow 1 red');
  assert.equal(at(standard, 35), 'Glow 7 white');
  assert.equal(at(standard, 36), 'Glow dimmer (kept at full)');
  assert.equal(at(standard, 43), 'Control');

  const standardFine = mode('standard-fine');
  assert.deepEqual([1, 2, 13, 14].map((c) => at(standardFine, c)), ['Filament 1', 'Filament 1 fine', 'Filament 7', 'Filament 7 fine']);
  assert.equal(at(standardFine, 15), 'Glow 1 red');
  assert.equal(at(standardFine, 43), 'Glow dimmer (kept at full)');
  assert.equal(at(standardFine, 50), 'Control');

  const pixel = mode('pixel');
  assert.deepEqual([1, 2, 5, 6, 31, 35].map((c) => at(pixel, c)), ['Filament 1', 'Glow 1 red', 'Glow 1 white', 'Filament 2', 'Filament 7', 'Glow 7 white']);
  assert.equal(at(pixel, 36), 'Glow strobe');
  assert.equal(at(pixel, 42), 'Control');

  const pixelFine = mode('pixel-fine');
  assert.deepEqual([1, 2, 3, 6, 7, 37, 38, 42].map((c) => at(pixelFine, c)),
    ['Filament 1', 'Filament 1 fine', 'Glow 1 red', 'Glow 1 white', 'Filament 2', 'Filament 7', 'Filament 7 fine', 'Glow 7 white']);
  assert.equal(at(pixelFine, 43), 'Glow strobe');
  assert.equal(at(pixelFine, 49), 'Control');
});

test('every P1 Mini mode has seven segments, one per pixel', () => {
  for (const p of PORTMAN_P1_MINI) {
    const pl = plan(p);
    assert.equal(pl.cells, 7, p.id);
    assert.equal(pl.hasDimmer, false, p.id);
    // The 16-bit modes pair each filament with its fine byte.
    const fine = p.id.endsWith('-fine');
    assert.equal(pl.channels.filter((c) => c.role === 'amber' && c.fineAt === c.at + 1).length, fine ? 7 : 0, p.id);
  }
});

test('amber lights the filaments; the glow stays dark and the fixed channels hold', () => {
  for (const p of PORTMAN_P1_MINI) {
    const buf = new Uint8Array(512);
    writeFixture(buf, plan(p), AMBER);
    p.channels.forEach((ch, n) => {
      const want = ch.role === 'amber' ? 255 : ch.role === 'other' || ch.role === 'strobe' ? ch.default : 0;
      assert.equal(buf[n], want, `${p.id} channel ${n + 1} (${ch.name})`);
    });
  }
  // Blackout keeps the glow dimmer at full and the strobes open, everything else at 0.
  const standard = mode('standard');
  const buf = new Uint8Array(512);
  writeFixture(buf, plan(standard), dark());
  assert.equal(buf[35], 255);
  assert.deepEqual(Array.from(buf.subarray(0, 35)), new Array(35).fill(0));
  assert.deepEqual(Array.from(buf.subarray(36, 43)), new Array(7).fill(0));
});

test('each pixel takes its own light, filament and glow', () => {
  const pixel = mode('pixel');
  const lights: Light[] = Array.from({ length: 7 }, () => dark());
  lights[0] = fromHex('#ff0000', 0, 1); // pixel 1: red glow
  lights[6] = fromHex('#000000', { amber: 1 }, 1); // pixel 7: filament
  const buf = new Uint8Array(512);
  writeCells(buf, plan(pixel), lights);
  assert.deepEqual(Array.from(buf.subarray(0, 5)), [0, 255, 0, 0, 0]);
  assert.deepEqual(Array.from(buf.subarray(30, 35)), [255, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(buf.subarray(5, 30)), new Array(25).fill(0));

  // The fine modes send the filament level as 16 bits.
  const fine = mode('pixel-fine');
  const half = fromHex('#000000', { amber: 1 }, 0.5);
  const fb = new Uint8Array(512);
  writeFixture(fb, plan(fine), half);
  const v16 = Math.round(Math.pow(0.5, G) * 65535);
  assert.deepEqual([fb[0], fb[1]], [v16 >> 8, v16 & 255]);
});
