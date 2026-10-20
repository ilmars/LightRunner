// Types for plan.js, so the tests can check it.

export type Shape = 'dot' | 'across' | 'upright';
export interface PlanSize { x: number; y: number; w?: number; h?: number }
export interface Point { x: number; y: number }

export const BAR_LENGTH: number;
export const BAR_THICKNESS: number;
export const MIN_LENGTH: number;
export const MIN_THICKNESS: number;
export function shapeOf(f: PlanSize, aspect: number): Shape;
export function setShape(f: PlanSize, shape: Shape, aspect: number): void;
export function resizeEnd(f: PlanSize, end: 'start' | 'end', p: Point, aspect: number): void;
export function resizeThickness(f: PlanSize, p: Point, aspect: number): void;
export function placeRow(spot: Point, count: number, shape: Shape): Point[];
