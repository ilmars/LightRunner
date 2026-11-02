// Types for loudness.js, so the tests can check it.

export const LOUDNESS_RATE: number;
export function loudnessTrack(samples: Float32Array, sampleRate: number): number[];
export function peaksTrack(samples: Float32Array, bars: number): number[];
/** Values from 0 to 1, one byte each, as base64. */
export function encodeBytes(values: number[]): string;
/** The bytes (0..255) of a base64 string. */
export function decodeBytes(text: string): Uint8Array;
