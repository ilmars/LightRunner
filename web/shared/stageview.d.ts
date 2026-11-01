// Types for stageview.js, so the tests can check it.

import type { Point } from '../patch/plan.d.ts';

export type Hangs = 'truss' | 'wall' | 'riser' | 'stand' | 'side';

/** A fixture as the layout gives it to the pages; anything missing may be null. `shape` is 'dot' | 'beam' | 'bar' | 'outline' | 'smoke', `hangs` one of Hangs. */
export interface ViewFixture {
  x: number; y: number;
  w?: number | null; h?: number | null;
  shape?: string | null;
  angle?: number | null; reach?: number | null;
  segments?: number;
  leds?: number | null;
  hangs?: string | null;
}

export const HANGS: Hangs[];
export function ledLayout(segments: number, leds?: number | null): number[];
export function isPanel(f: ViewFixture): boolean;
export function isStrip(f: ViewFixture): boolean;
export function panelGrid(leds: number): { cols: number; rows: number };
export function ledPoints(f: ViewFixture): (Point & { segment: number })[];
export function hangsOf(f: ViewFixture): Hangs;

export interface Pool { spots: (Point & { segment: number })[]; r: number; squash: number; alpha: number }
export function poolOf(f: ViewFixture, hangs: string, view?: 'above'): Pool;

export function frontScene(w: number, h: number): { trussY: number; wallTop: number; floorY: number; s: number };
export interface FrontPlacement {
  hangs: Hangs; x: number; vertical: boolean;
  left: number; top: number; width: number; height: number; length: number;
  segments: (Point & { segment: number })[];
  leds: (Point & { segment: number })[];
  beamFrom?: number;
  beamTo?: number;
  pole?: { from: number; to: number };
}
export function frontPlacement(f: ViewFixture, hangs: string, w: number, h: number): FrontPlacement;

export function stageViewFrom(stored: string | null | undefined): 'above' | 'front';
export function stageSizeFrom(stored: string | null | undefined, page: string): { w: number | null; h: number | null };
export function stageSizeWith(stored: string | null | undefined, page: string, size: { w?: number | null; h?: number | null } | null): string;
export function fitStageLength(want: number, min: number, max: number): number;

export interface SoftLight { sprite: string; x: number; y: number; w: number; h: number; a: number }
export function softShareAt(p: SoftLight, x: number, y: number): number;
export function softLightOverlaps(lights: SoftLight[]): [number, number][][];
export function sharedStrengths(lights: SoftLight[], overlaps: [number, number][][], lit: ArrayLike<number>, out?: number[]): number[];
