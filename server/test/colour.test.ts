// The operator page's colour maths (web/shared/colour.js): strip places, saturation and exact values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUE_STOPS, WHITE_STOPS, hexRgb, parseChannel, parseHex, rgbHex, stripColour, stripMix, stripPick } from '../../web/shared/colour.js';

const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not ${b}`);
/** Two hex colours that differ by at most `tol` in any channel. */
const close = (a: string, b: string, tol = 1) => {
  const x = hexRgb(a), y = hexRgb(b);
  assert.ok(x.every((v, i) => Math.abs(v - y[i]!) <= tol), `${a} is not ${b}`);
};

test('hex and R, G, B: typed values are read or refused', () => {
  assert.equal(parseHex('#FF8800'), '#ff8800');
  assert.equal(parseHex('ff8800'), '#ff8800');
  assert.equal(parseHex('  #0a0B0c '), '#0a0b0c');
  for (const bad of ['', '#', '#ff880', '#ff88000', '#gg8800', 'red', '#f80', '##ff8800']) assert.equal(parseHex(bad), null, bad);
  assert.equal(parseChannel('0'), 0);
  assert.equal(parseChannel('255'), 255);
  assert.equal(parseChannel(' 128 '), 128);
  assert.equal(parseChannel('007'), 7);
  for (const bad of ['', '256', '-1', '1.5', '12a', 'x', '1000']) assert.equal(parseChannel(bad), null, bad);
  assert.deepEqual(hexRgb('#ff8000'), [255, 128, 0]);
  assert.equal(rgbHex([255, 127.6, -3]), '#ff8000');
  assert.equal(rgbHex([300, 0, 0]), '#ff0000');
});

test('the strip at full saturation and strength is the strip as before', () => {
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    assert.equal(stripMix(false, p, 1, 1), stripColour(HUE_STOPS, p), `hue at ${p}`);
    assert.equal(stripMix(true, p, 0.3, 1), stripColour(WHITE_STOPS, p), `warm to cool at ${p} (no saturation there)`);
  }
  assert.equal(stripColour(HUE_STOPS, 0), '#ff0000');
  assert.equal(stripColour(HUE_STOPS, 1), '#ff0000');
  assert.equal(stripColour(WHITE_STOPS, 0), '#ffb46b');
});

test('saturation pales a colour towards white light; 0 % is white, at the same strength', () => {
  assert.equal(stripMix(false, 0, 0, 1), '#ffffff');
  assert.equal(stripMix(false, 0, 0.5, 1), '#ff8080');
  assert.equal(stripMix(false, 4 / 7, 0.5, 1), '#8080ff', 'blue at half saturation');
  assert.equal(stripMix(false, 0, 1, 0.5), '#800000', 'half strength');
  // Between two stops where the strip is darker (violet to pink), white light is as strong as the strip there.
  const p = 5.5 / 7;
  const top = Math.max(...hexRgb(stripColour(HUE_STOPS, p)));
  assert.deepEqual(hexRgb(stripMix(false, p, 0, 1)), [top, top, top]);
});

test('a colour made on the strip gives its place, saturation and strength back', () => {
  for (let i = 0; i < 70; i++) {
    const p = i / 70;
    for (const s of [1, 0.75, 0.4, 0.1]) {
      for (const v of [1, 0.6]) {
        const hex = stripMix(false, p, s, v);
        const got = stripPick(false, hex);
        // Rounding to whole channels moves a pale or dim colour's place a little.
        near(got.p!, p, s < 0.2 ? 0.03 : 0.006, `place of ${hex}`);
        near(got.s, s, 0.02, `saturation of ${hex}`);
        near(got.v, v, s < 0.2 ? 0.03 : 0.01, `strength of ${hex}`);
        close(stripMix(false, got.p!, got.s, got.v), hex);
      }
    }
  }
  for (let i = 0; i <= 20; i++) {
    const p = i / 20;
    const got = stripPick(true, stripMix(true, p, 1, 1));
    near(got.p!, p, 0.02, `warm to cool place ${p}`);
    near(got.v, 1, 0.01);
  }
});

test('a typed colour that is not on the strip gets the nearest place, and is kept as typed', () => {
  // A pale, dim orange: its hue is on the strip (between red and amber), not its saturation or strength.
  const typed = '#804020';
  const got = stripPick(false, typed);
  near(got.s, 0.75, 0.001);
  near(got.v, 128 / 255, 0.001);
  const full = hexRgb(stripColour(HUE_STOPS, got.p!));
  // The hue: green is a third of the way from blue (0) to red (255), as in #804020.
  near(full[1], 255 / 3, 2, 'the nearest place has the same hue');
  close(stripMix(false, got.p!, got.s, got.v), typed);
  // Warm white typed on the colour strip: an orange of little saturation.
  const warm = stripPick(false, '#ffb46b');
  near(warm.s, 1 - 107 / 255, 0.001);
  assert.ok(warm.p! > 0 && warm.p! < 1 / 7, 'between red and amber');
  // A saturated colour typed for a white-only group: the nearest white.
  assert.equal(stripPick(true, '#0000ff').p, 1, 'blue is nearest the cool end');
  assert.equal(stripPick(true, '#ff6600').p, 0, 'orange is nearest the warm end');
});

test('black and greys have no hue: they keep the place they had', () => {
  assert.deepEqual(stripPick(false, '#000000'), { p: null, s: 1, v: 0 });
  assert.deepEqual(stripPick(false, '#000000', { p: 0.3, s: 0.6 }), { p: 0.3, s: 0.6, v: 0 });
  assert.deepEqual(stripPick(false, '#ffffff'), { p: null, s: 0, v: 1 });
  const grey = stripPick(false, '#808080', { p: 0, s: 1 });
  assert.equal(grey.p, 0);
  assert.equal(grey.s, 0);
  near(grey.v, 128 / 255, 0.001);
  assert.equal(stripMix(false, grey.p!, grey.s, grey.v), '#808080');
  assert.deepEqual(stripPick(true, '#000000', { p: 0.5 }), { p: 0.5, s: 1, v: 0 });
});
