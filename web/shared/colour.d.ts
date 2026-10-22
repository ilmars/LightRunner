// Types for colour.js, so the tests can check it.

export const HUE_STOPS: string[];
export const WHITE_STOPS: string[];
export function hexRgb(hex: string): [number, number, number];
export function rgbHex(rgb: number[]): string;
export function stripColour(stops: string[], p: number): string;
export function parseHex(text: string): string | null;
export function parseChannel(text: string): number | null;
export function stripMix(whiteOnly: boolean, p: number, s: number, v: number): string;
export function stripPick(whiteOnly: boolean, hex: string, prev?: { p: number | null; s?: number }): { p: number | null; s: number; v: number };
