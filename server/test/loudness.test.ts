// The audio maths shared by the Timeline page and the server (web/shared/loudness.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBytes, encodeBytes, loudnessTrack, peaksTrack } from '../../web/shared/loudness.js';

const RATE = 8000;
/** `secs` of silence, then `secs` of a 440 Hz tone at amplitude `amp`. */
function silenceThenTone(secs: number, amp: number): Float32Array {
  const out = new Float32Array(RATE * secs * 2);
  for (let i = RATE * secs; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / RATE);
  return out;
}

test('loudness: one value per 40 ms; silence is 0 and the loud end is 1, however loud the file is', () => {
  for (const amp of [0.9, 0.1]) {
    const track = loudnessTrack(silenceThenTone(2, amp), RATE);
    assert.equal(track.length, 100);
    assert.ok(track.slice(0, 48).every((v) => v < 0.02), 'silence first');
    assert.ok(track.slice(52).every((v) => v > 0.95 && v <= 1), `the tone is about 1 (amp ${amp})`);
    assert.ok(track.every((v) => v >= 0 && v <= 1));
  }
});

test('loudness: the loudest 5% is clipped at 1, and a silent file stays at 0', () => {
  const s = new Float32Array(RATE * 4).fill(0.1);
  // A short loud burst: well above the 95th percentile.
  for (let i = RATE; i < RATE + 800; i++) s[i] = 0.9;
  const track = loudnessTrack(s, RATE);
  assert.equal(Math.max(...track), 1);
  assert.ok(track.filter((v) => v === 1).length >= 1);
  assert.ok(Math.abs(track[0]! - 1) < 0.01, 'the 95th percentile (the common level here) is 1');
  assert.deepEqual(loudnessTrack(new Float32Array(RATE), RATE), new Array(25).fill(0));
  assert.deepEqual(loudnessTrack(new Float32Array(0), RATE), []);
});

test('peaks: the biggest swing in each bar', () => {
  const s = new Float32Array(1000);
  s[10] = 0.5; s[600] = -0.8;
  const p = peaksTrack(s, 4);
  assert.equal(p.length, 4);
  assert.ok(Math.abs(p[0]! - 0.5) < 1e-6);
  assert.equal(p[1], 0);
  assert.ok(Math.abs(p[2]! - 0.8) < 1e-6);
  assert.equal(p[3], 0);
  assert.deepEqual(peaksTrack(new Float32Array(0), 5), [0, 0, 0, 0, 0]);
  assert.equal(peaksTrack(new Float32Array(3), 10).length, 10);
  assert.deepEqual(peaksTrack(s, 0), []);
});

test('bytes: values from 0 to 1 are kept as one byte each, as base64', () => {
  assert.deepEqual([...decodeBytes(encodeBytes([0, 1, 0.5, 2, -1]))], [0, 255, 128, 255, 0]);
  assert.equal(encodeBytes([]), '');
  assert.equal(decodeBytes('').length, 0);
  // A long track survives (no argument limit in the encoder).
  const long = Array.from({ length: 200000 }, (_, i) => (i % 256) / 255);
  const back = decodeBytes(encodeBytes(long));
  assert.equal(back.length, 200000);
  assert.equal(back[1000], 1000 % 256);
  // The same base64 the show file holds.
  assert.equal(encodeBytes([0, 1 / 255, 2 / 255]), Buffer.from([0, 1, 2]).toString('base64'));
});
