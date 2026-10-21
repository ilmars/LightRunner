// Types for stage.js, so the tests can check it.

import type { PlanFixture, Point } from '../patch/plan.d.ts';

export const PLAN_ASPECT: number;
export const BEAM_HALF_SPREAD: number;
export const BEAM_REACH: number;
export function barAxis(f: PlanFixture): { length: number; thickness: number; angle: number };
export function along(length: number, angle: number): Point;
export function barEnds(f: PlanFixture): [Point, Point];
export function beamCone(f: PlanFixture): { lamp: Point; left: Point; right: Point; tip: Point };
export function outlineCells(box: { left: number; top: number; width: number; height: number }, count: number, reversed?: boolean): [number, number][][];
