// The audio maths of the Timeline: how loud a recording is, 25 times a second, and its waveform.
// Plain JavaScript that runs in the browser (the Timeline page works it out when a recording is added)
// and in the tests. The server only ever reads what this stored (see packages/shared/src/timeline.ts).

/** Loudness values per second. */
export const LOUDNESS_RATE = 25;

/** The p-quantile (0..1) of a list of numbers. */
function quantile(values, p) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * How loud the recording is, one value per 40 ms (25 a second): the RMS of each 40 ms, scaled so the
 * loud end is 1 (the 95th percentile of the whole recording maps to 1; anything louder is clipped).
 * A silent recording stays 0.
 * @param {Float32Array} samples mono samples, -1..1
 * @param {number} sampleRate
 * @returns {number[]} 0..1
 */
export function loudnessTrack(samples, sampleRate) {
  const window = Math.max(1, Math.round(sampleRate / LOUDNESS_RATE));
  const count = Math.ceil(samples.length / window);
  const rms = new Array(count);
  for (let w = 0; w < count; w++) {
    const from = w * window;
    const to = Math.min(samples.length, from + window);
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    rms[w] = Math.sqrt(sum / (to - from));
  }
  if (!count) return rms;
  const top = quantile(rms, 0.95);
  if (!(top > 1e-6)) return rms.map(() => 0);
  return rms.map((v) => Math.min(1, v / top));
}

/**
 * The waveform: the biggest swing (0..1) in each of `bars` equal parts of the recording.
 * @param {Float32Array} samples
 * @param {number} bars
 * @returns {number[]}
 */
export function peaksTrack(samples, bars) {
  const n = Math.max(0, Math.floor(bars));
  const out = new Array(n).fill(0);
  if (!samples.length) return out;
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * samples.length) / n);
    const to = Math.max(from + 1, Math.floor(((b + 1) * samples.length) / n));
    let peak = 0;
    for (let i = from; i < to && i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    out[b] = Math.min(1, peak);
  }
  return out;
}

/**
 * Values from 0 to 1 as one byte each (0..255), written as base64 (what a timeline keeps).
 * @param {number[]} values
 * @returns {string}
 */
export function encodeBytes(values) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < values.length; i += chunk) {
    const part = values.slice(i, i + chunk).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
    binary += String.fromCharCode(...part);
  }
  return btoa(binary);
}

/**
 * The bytes (0..255) of a base64 string written by encodeBytes.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function decodeBytes(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
