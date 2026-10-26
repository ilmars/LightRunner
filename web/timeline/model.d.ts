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
export function newTimeline(name: string, takenIds: Iterable<string>, groupIds?: string[]): NewTimeline;
export function shownLayers(timeline: { layers: { group: string }[] }, groups: { id: string }[]): { group: string; missing: boolean }[];
export function addableGroups(timeline: { layers: { group: string }[] }, groups: { id: string; kind?: string }[]): string[];
export function dragIntent(dx: number, dy: number, finger: boolean): 'drag' | 'scroll' | null;

export interface Times { start: number; end?: number }
export interface Hit { id: string; part: 'start' | 'end' | 'move' }
export const MIN_RISE: number;
export const MIN_BLOCK: number;
export const SNAP_PX: number;
export function shownRise(rise: number): number;
export function formatRise(rise: number): string;
export function snapTime(t: number, targets: number[], pxPerSec: number, snapPx?: number): { t: number; to: number | null };
export function clampEnd(blocks: { id: string; start: number; end?: number }[], id: string, end: number): number | undefined;
export function dragBlock(
  blocks: { id: string; start: number; end?: number }[], id: string, part: 'move' | 'start' | 'end', dt: number,
  ctx: { targets: number[]; pxPerSec: number; length: number },
): Times;
export function moveBlock(blocks: { id: string; start: number; end?: number }[], id: string, t: number): Times;
export function hitTest(
  spans: { id: string; start: number; end: number; endEdge: boolean }[], x: number, pxPerSec: number,
  opts: { selected: string | null; handlePx: number; selectedHandlePx: number },
): Hit | null;
export function newBlockStart(blocks: { start: number }[], t: number, targets: number[], pxPerSec: number): number | null;
export function lookFade(look: { groups: { group?: string; preset: string; fade?: number }[] } | undefined, presets: { id: string; fade?: number }[]): number;
export function riseAfterLookChange(rise: number, oldFade: number, newFade: number): number;
export function blockMissing(
  group: string, what: { kind: string; preset?: string; look?: string },
  show: { groups: { id: string }[]; presets: { id: string; group: string }[]; looks: { id: string }[] },
): boolean;
export function mixToMono(channels: Float32Array[]): Float32Array;
export function normalisePeaks(values: number[]): number[];
export function barsFor(duration: number): number;
