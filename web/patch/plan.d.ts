// Types for plan.js, so the tests can check it.
import type { Hangs } from '../shared/stageview.d.ts';

export type Shape = 'dot' | 'beam' | 'bar' | 'outline' | 'smoke';
export interface PlanFixture { x: number; y: number; w?: number; h?: number; shape?: Shape; angle?: number; reach?: number; hangs?: string | null }
export interface Point { x: number; y: number }

export const BAR_LENGTH: number;
export const BAR_THICKNESS: number;
export const OUTLINE_W: number;
export const OUTLINE_H: number;
export const MIN_LENGTH: number;
export const MIN_THICKNESS: number;
export function shapeOf(f: PlanFixture, inSmoke?: boolean): Shape;
export function setShape(f: PlanFixture, shape: Shape, inSmoke?: boolean): void;
export function setBarAngle(f: PlanFixture, angle: number): void;
export function turnBar(f: PlanFixture, p: Point, free: boolean): void;
export function resizeEnd(f: PlanFixture, end: 'start' | 'end', p: Point): void;
export function resizeThickness(f: PlanFixture, p: Point): void;
export function aimBeam(f: PlanFixture, p: Point, free: boolean): void;
export function resizeOutline(f: PlanFixture, p: Point): void;
export const HANGS_CHOICES: { value: Hangs; label: string }[];
export function guessHangs(f: PlanFixture, inSmoke?: boolean): Hangs;
export function setHangs(f: PlanFixture, value: string | null | undefined): void;
export function placeRow(spot: Point, count: number, shape: Shape): Point[];

export interface Bounds { left: number; right: number; top: number; bottom: number }
export function boundsOf(f: PlanFixture, inSmoke?: boolean): Bounds;
export function alignFixtures(list: PlanFixture[], how: 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom', inSmoke?: (f: PlanFixture) => boolean): void;
export function spaceEvenly(list: PlanFixture[], axis: 'x' | 'y'): void;
export function moveTogether(list: PlanFixture[], starts: Point[], dx: number, dy: number): void;
export function touches(f: PlanFixture, box: Bounds, inSmoke?: boolean): boolean;
