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
    // The envelope follower takes a few frames (about 60 ms) to reach the tone.
    assert.ok(track.slice(56).every((v) => v > 0.95 && v <= 1), `the tone is about 1 (amp ${amp})`);
    assert.ok(track.every((v) => v >= 0 && v <= 1));
  }
});

test('loudness: the loudest 5% is clipped at 1, and a silent file stays at 0', () => {
  // A minute, so the burst and its slow fade are well under 5 % of it.
  const s = new Float32Array(RATE * 60).fill(0.1);
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

test('loudness: a sample rate that does not divide by 25 still gives exactly 25 values a second', () => {
  for (const rate of [44117, 22050, 48000, 11025]) {
    const track = loudnessTrack(new Float32Array(rate * 60).fill(0.2), rate);
    assert.equal(track.length, 1500, `${rate} Hz over a minute`);
  }
  // Fifteen minutes at an odd rate stays in step (no drift from rounding the window).
  assert.equal(loudnessTrack(new Float32Array(44117 * 900), 44117).length, 22500);
});

test('loudness: a recording that is mostly silence still gets its loud part to 1', () => {
  // Under 5 % tone: the 95th percentile is silence, so the loudest value is used instead.
  const s = silenceThenTone(10, 0.5);
  s.fill(0, 80000 + 800);
  const track = loudnessTrack(s, RATE);
  assert.equal(Math.max(...track), 1);
  assert.ok(track.slice(0, 250).every((v) => v === 0), 'silence stays 0');
  assert.ok(Math.max(...track.slice(250, 256)) > 0.9);
  assert.deepEqual(loudnessTrack(new Float32Array(RATE * 3), RATE), new Array(75).fill(0));
});

test('loudness: speech with gaps gives a smooth track: it falls slowly and never steps far in 40 ms', () => {
  // Words of 120 ms with gaps of 80 ms, loud and quiet: the raw RMS jumps from loud to silence in one 40 ms step.
  const s = new Float32Array(RATE * 6);
  for (let i = 0; i < s.length; i++) {
    const phase = (i / RATE) % 0.2;
    if (phase < 0.12) s[i] = (Math.floor(i / (RATE * 0.2)) % 2 ? 0.9 : 0.5) * Math.sin((2 * Math.PI * 300 * i) / RATE);
  }
  const track = loudnessTrack(s, RATE);
  let fall = 0, rise = 0;
  for (let k = 1; k < track.length; k++) {
    fall = Math.max(fall, track[k - 1]! - track[k]!);
    rise = Math.max(rise, track[k]! - track[k - 1]!);
  }
  assert.ok(fall <= 0.25, `largest fall in 40 ms ${fall}`);
  assert.ok(rise > fall, `rises faster than it falls (${rise} vs ${fall})`);
  // The words still show: the track is clearly above silence in the middle of speech.
  assert.ok(track.slice(50).every((v) => v > 0.2));
});
