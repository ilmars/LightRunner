// Types for model.js, so the tests can check it.

export interface View { pxPerSec: number; scroll: number }
export interface Tick { t: number; x: number; label: string }
export interface NewTimeline {
  id: string;
  name: string;
  layers: { group: string; blocks: { id: string; start: number; end?: number; rise: number; what: { kind: 'dark' } }[] }[];
  markers: { t: number; text: string }[];
  offsetMs: number;
}

export const MAX_ZOOM: number;
export const MAX_BARS: number;
export function formatTime(s: number): string;
export function formatLength(s: number): string;
export function parseTime(text: string): number | null;
export function timeToX(t: number, view: View): number;
export function xToTime(x: number, view: View, duration: number): number;
export function fitZoom(duration: number, width: number): number;
export function clampScroll(scroll: number, pxPerSec: number, width: number, duration: number): number;
export function zoomed(view: View, factor: number, anchorX: number, width: number, duration: number): View;
export function followScroll(scroll: number, t: number, width: number, pxPerSec: number, duration: number): number;
export function rulerStep(pxPerSec: number, minPx?: number): number;
export function rulerTicks(view: View, width: number, duration: number): Tick[];
export function markerRows(markers: { t: number }[], pxPerSec: number, labelPx?: number): number[];
export function nextMarkerText(markers: { t?: number; text: string }[]): string;
export function blockSpans<B extends { start: number; end?: number }>(blocks: B[], duration: number): { block: B; start: number; end: number }[];
export function viewLength(timeline: { layers: { blocks: { start: number; end?: number }[] }[]; markers?: { t: number }[]; recording?: { duration: number } }): number;
export function slugId(name: string, taken: Iterable<string>, fallback?: string): string;
export function newBlockId(timeline: { layers: { blocks: { id: string }[] }[] }): string;
export function newTimeline(name: string, takenIds: Iterable<string>): NewTimeline;
export function mixToMono(channels: Float32Array[]): Float32Array;
export function normalisePeaks(values: number[]): number[];
export function barsFor(duration: number): number;
