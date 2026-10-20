// The stage plan's geometry on the Patch page (web/patch/plan.js): shapes, resizing and where new fixtures go.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAR_LENGTH, BAR_THICKNESS, MIN_THICKNESS, placeRow, resizeEnd, resizeThickness, setShape, shapeOf } from '../../web/patch/plan.js';

// The Patch page's plan is 2.4 times as wide as it is tall.
const ASPECT = 2.4;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.0015, `${a} is not ${b}`);

test('a fixture without a size is a dot; a bar is across or upright by its longer side on screen', () => {
  assert.equal(shapeOf({ x: 0.5, y: 0.5 }, ASPECT), 'dot');
  assert.equal(shapeOf({ x: 0.5, y: 0.5, w: 0.2, h: 0.03 }, ASPECT), 'across');
  // 0.01 of the width is 0.024 of the height: thinner than it is tall.
  assert.equal(shapeOf({ x: 0.5, y: 0.5, w: 0.01, h: 0.3 }, ASPECT), 'upright');
  // Only a width (as some imports have) still draws as a bar.
  assert.equal(shapeOf({ x: 0.5, y: 0.5, w: 0.2 }, ASPECT), 'across');
});

test('a dot becomes a bar of the usual size, and a bar a dot again', () => {
  const f: any = { x: 0.5, y: 0.5 };
  setShape(f, 'across', ASPECT);
  assert.deepEqual([f.w, f.h], [BAR_LENGTH, BAR_THICKNESS]);
  setShape(f, 'dot', ASPECT);
  assert.ok(!('w' in f) && !('h' in f));
  setShape(f, 'upright', ASPECT);
  near(f.h, BAR_LENGTH * ASPECT);
  near(f.w, BAR_THICKNESS / ASPECT);
});

test('turning a bar keeps its length and thickness on screen', () => {
  const f: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03 };
  setShape(f, 'upright', ASPECT);
  near(f.h, 0.48);
  near(f.w, 0.0125);
  setShape(f, 'across', ASPECT);
  near(f.w, 0.2);
  near(f.h, 0.03);
  // Already across: nothing changes.
  setShape(f, 'across', ASPECT);
  near(f.w, 0.2);
});

test('an upright bar longer than the plan is tall is cut to fit', () => {
  const f: any = { x: 0.5, y: 0.5, w: 0.6, h: 0.03 };
  setShape(f, 'upright', ASPECT);
  assert.equal(f.h, 1);
});

test('dragging one end of a bar moves that end and leaves the other where it is', () => {
  const f: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03 };
  // Right end from 0.6 to 0.7; the left end stays at 0.4.
  resizeEnd(f, 'end', { x: 0.7, y: 0.9 }, ASPECT);
  near(f.x, 0.55);
  near(f.w, 0.3);
  assert.equal(f.y, 0.5, 'an across bar never moves up or down from its ends');
  // Left end past the right one stops short of it, at twice the bar's thickness (0.03 of the height).
  resizeEnd(f, 'start', { x: 0.95, y: 0.5 }, ASPECT);
  near(f.x + f.w / 2, 0.7);
  near(f.w, 0.025);
  // An end never leaves the plan.
  resizeEnd(f, 'start', { x: -0.4, y: 0.5 }, ASPECT);
  near(f.x - f.w / 2, 0);
  near(f.x + f.w / 2, 0.7);
});

test('an upright bar is resized from its top and bottom', () => {
  const f: any = { x: 0.3, y: 0.5, w: 0.0125, h: 0.4 };
  resizeEnd(f, 'start', { x: 0.9, y: 0.1 }, ASPECT);
  near(f.y, 0.4);
  near(f.h, 0.6);
  assert.equal(f.x, 0.3);
});

test('the side handle sets the thickness, evenly about the middle', () => {
  const across: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03 };
  resizeThickness(across, { x: 0.1, y: 0.45 }, ASPECT);
  near(across.h, 0.1);
  near(across.y, 0.5);
  resizeThickness(across, { x: 0.5, y: 0.5 }, ASPECT);
  near(across.h, MIN_THICKNESS);
  const upright: any = { x: 0.5, y: 0.5, w: 0.0125, h: 0.4 };
  resizeThickness(upright, { x: 0.52, y: 0.1 }, ASPECT);
  near(upright.w, 0.04);
});

test('a bar never turns while it is resized', () => {
  // Thick and short: shortening stops at twice its thickness, so it stays a bar.
  const thick: any = { x: 0.5, y: 0.5, w: 0.1, h: 0.06 };
  resizeEnd(thick, 'end', { x: 0, y: 0.5 }, ASPECT);
  near(thick.w, 0.05);
  assert.equal(shapeOf(thick, ASPECT), 'across');
  // Thickening stops at half its length.
  resizeThickness(thick, { x: 0.5, y: 1 }, ASPECT);
  near(thick.h, 0.06);
  assert.equal(shapeOf(thick, ASPECT), 'across');
  const upright: any = { x: 0.5, y: 0.5, w: 0.0125, h: 0.1 };
  resizeThickness(upright, { x: 1, y: 0.5 }, ASPECT);
  assert.equal(shapeOf(upright, ASPECT), 'upright');
});

test('new fixtures go in a row from the spot, kept on the plan', () => {
  assert.deepEqual(placeRow({ x: 0.3, y: 0.4 }, 1, 'dot'), [{ x: 0.3, y: 0.4 }]);
  const dots = placeRow({ x: 0.3, y: 0.4 }, 3, 'dot');
  assert.deepEqual(dots.map((p) => p.y), [0.4, 0.4, 0.4]);
  assert.equal(dots[0]!.x, 0.3);
  assert.ok(dots[1]!.x > dots[0]!.x && dots[2]!.x > dots[1]!.x);
  // Near the right edge the row moves left so its last one stays on the plan.
  const late = placeRow({ x: 0.95, y: 0.4 }, 4, 'dot');
  assert.ok(late.at(-1)!.x <= 0.97);
  // Bars are spaced so they don't overlap, and squeezed when there are too many to fit.
  const bars = placeRow({ x: 0.1, y: 0.4 }, 3, 'across');
  assert.ok(bars[1]!.x - bars[0]!.x >= BAR_LENGTH);
  // One bar at the edge is moved in so it doesn't hang off the plan.
  assert.equal(placeRow({ x: 0.02, y: 0.4 }, 1, 'across')[0]!.x, BAR_LENGTH / 2);
  const many = placeRow({ x: 0.5, y: 0.4 }, 40, 'dot');
  assert.ok(many.every((p) => p.x >= 0 && p.x <= 1));
});
