import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Crossfade, Ramp, ease } from '../src/fade.ts';
import { fromHex, mix, dark } from '../src/light.ts';
import { close } from './helpers.ts';

test('ease runs 0 to 1 smoothly and stays in range', () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(0.5), 0.5);
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
  for (let p = 0; p < 1; p += 0.01) assert.ok(ease(p + 0.01) >= ease(p));
});

test('crossfade weights sum to 1 once something has settled', () => {
  const x = new Crossfade<string>();
  x.push('a', () => 'a', 0, 0);
  x.push('b', () => 'b', 0, 2);
  for (let t = 0; t <= 3; t += 0.1) {
    const sum = x.weights(t).reduce((s, w) => s + w.weight, 0);
    assert.ok(close(sum, 1), `sum ${sum} at ${t}`);
  }
});

test('a push mid-fade continues from the current mix', () => {
  const x = new Crossfade<string>();
  x.push('a', () => 'a', 0, 0);
  x.push('b', () => 'b', 0, 2);
  const before = Object.fromEntries(x.weights(1).map((w) => [w.item, w.weight]));
  x.push('c', () => 'c', 1, 2);
  const after = Object.fromEntries(x.weights(1).map((w) => [w.item, w.weight]));
  assert.ok(close(before.a, after.a));
  assert.ok(close(before.b, after.b));
  assert.ok(close(after.c, 0));
  const end = x.weights(3);
  assert.deepEqual(end.map((w) => w.item), ['c']);
  assert.equal(end[0].weight, 1);
});

test('pushing an item still in the mix reuses it', () => {
  const x = new Crossfade<{ n: number }>();
  const a = x.push('a', () => ({ n: 1 }), 0, 0);
  x.push('b', () => ({ n: 2 }), 0, 2);
  const again = x.push('a', () => ({ n: 3 }), 1, 2);
  assert.equal(again, a);
  // a fades back up from its current weight, not from zero
  const w = x.weights(1).find((e) => e.item === a)!.weight;
  assert.ok(close(w, 0.5));
});

test('quick taps never drop an entry that is still visible', () => {
  const x = new Crossfade<string>();
  x.push('a', () => 'a', 0, 0);
  let prev = new Map(x.weights(0).map((w) => [w.item, w.weight]));
  const keys = ['b', 'c', 'd', 'e', 'f', 'g'];
  for (let t = 0, k = 0; t < 4; t += 0.025) {
    if (k < keys.length && t >= k * 0.2) {
      x.push(keys[k], () => keys[k], t, 3);
      k++;
    }
    const now = new Map(x.weights(t).map((w) => [w.item, w.weight]));
    for (const [item, w] of prev) {
      const step = Math.abs((now.get(item) ?? 0) - w);
      assert.ok(step < 0.05, `${item} stepped ${step} at ${t}`);
    }
    prev = now;
  }
});

test('ramp eases from where it is when interrupted', () => {
  const r = new Ramp(0);
  r.set(1, 0, 1);
  const mid = r.value(0.5);
  r.set(0, 0.5, 1);
  assert.ok(close(r.value(0.5), mid));
  assert.equal(r.value(2), 0);
});

test('a dark hex colour becomes full colour at lower intensity', () => {
  const l = fromHex('#400000');
  assert.ok(close(l.r, 1));
  assert.ok(close(l.i, 0x40 / 255));
});

test('red to blue keeps full brightness halfway', () => {
  const out = mix(dark(), [fromHex('#ff0000'), fromHex('#0000ff')], [0.5, 0.5]);
  assert.ok(close(out.r, 1) && close(out.b, 1) && close(out.i, 1));
});

test('fading up from dark keeps the target colour', () => {
  const out = mix(dark(), [dark(), fromHex('#ff0000')], [0.8, 0.2]);
  assert.ok(close(out.r, 1) && close(out.g, 0) && close(out.b, 0));
  assert.ok(close(out.i, 0.2));
});
