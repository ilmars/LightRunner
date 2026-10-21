// The stage plan's geometry: shapes and editing them on the Patch page (web/patch/plan.js),
// and where the shapes are drawn (web/shared/stage.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR_LENGTH, BAR_THICKNESS, MIN_THICKNESS, aimBeam, alignFixtures, boundsOf, moveTogether, placeRow, resizeEnd, resizeOutline, resizeThickness,
  setBarAngle, setShape, shapeOf, spaceEvenly, touches, turnBar,
} from '../../web/patch/plan.js';
import { BEAM_REACH, barAxis, barEnds, beamCone, outlineCells } from '../../web/shared/stage.js';

const near = (a: number, b: number, what = '') => assert.ok(Math.abs(a - b) < 0.002, `${what} ${a} is not ${b}`);
const nearPoint = (p: { x: number; y: number }, x: number, y: number) => { near(p.x, x, 'x'); near(p.y, y, 'y'); };

test('a fixture without a stored shape is drawn as before', () => {
  assert.equal(shapeOf({ x: 0.5, y: 0.5 }), 'dot');
  assert.equal(shapeOf({ x: 0.5, y: 0.5, w: 0.2, h: 0.03 }), 'bar');
  assert.equal(shapeOf({ x: 0.5, y: 0.5, w: 0.2 }), 'bar');
  assert.equal(shapeOf({ x: 0.5, y: 0.5 }, true), 'smoke', 'in a smoke group');
  assert.equal(shapeOf({ x: 0.5, y: 0.5, shape: 'beam' }, true), 'beam', 'a stored shape wins');
});

test('a bar from before angles keeps its look: across, or upright when taller than wide', () => {
  assert.deepEqual(barAxis({ x: 0.5, y: 0.5, w: 0.2, h: 0.03 }), { length: 0.2, thickness: 0.03, angle: 0 });
  const upright = barAxis({ x: 0.5, y: 0.5, w: 0.0125, h: 0.48 });
  near(upright.length, 0.2);
  near(upright.thickness, 0.03);
  assert.equal(upright.angle, 90);
  // Its ends are where the old drawing had them: top and bottom.
  const [top, bottom] = barEnds({ x: 0.5, y: 0.5, w: 0.0125, h: 0.48 });
  nearPoint(top, 0.5, 0.26);
  nearPoint(bottom, 0.5, 0.74);
});

test('choosing a shape stores it and gives it a starting size', () => {
  const f: any = { x: 0.5, y: 0.5 };
  setShape(f, 'bar');
  assert.deepEqual([f.shape, f.w, f.h, f.angle], ['bar', BAR_LENGTH, BAR_THICKNESS, 0]);
  setShape(f, 'beam');
  assert.deepEqual([f.shape, f.angle, f.reach, f.w, f.h], ['beam', -90, BEAM_REACH, undefined, undefined]);
  setShape(f, 'outline');
  assert.equal(f.shape, 'outline');
  assert.ok(f.w > 0 && f.h > 0 && f.angle === undefined && f.reach === undefined);
  setShape(f, 'smoke');
  assert.deepEqual([f.shape, f.w, f.h], ['smoke', undefined, undefined]);
  // A dot in a smoke group is stored as a dot, so it doesn't become a cloud again.
  setShape(f, 'dot', true);
  assert.equal(f.shape, 'dot');
});

test('a new outline near the edge is moved just enough to fit on the plan', () => {
  const f: any = { x: 0.844, y: 0.1 };
  setShape(f, 'outline');
  near(f.y, f.h / 2);
  assert.equal(f.x, 0.844);
});

test('a bar keeps its size when it is already a bar', () => {
  const f: any = { x: 0.5, y: 0.5, w: 0.3, h: 0.05 };
  setShape(f, 'bar');
  assert.deepEqual([f.shape, f.w, f.h], ['bar', 0.3, 0.05]);
});

test('Across and Upright turn a bar and keep its length and thickness', () => {
  const f: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03 };
  setBarAngle(f, 90);
  assert.equal(f.angle, 90);
  const [top, bottom] = barEnds(f);
  nearPoint(top, 0.5, 0.26);
  nearPoint(bottom, 0.5, 0.74);
  // An upright bar from before angles is stored the new way the first time it is turned.
  const old: any = { x: 0.5, y: 0.5, w: 0.0125, h: 0.48 };
  setBarAngle(old, 0);
  near(old.w, 0.2);
  near(old.h, 0.03);
  assert.equal(old.angle, 0);
});

test('the turning handle points the bar at the pointer, in 15° steps unless free', () => {
  const f: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03, angle: 0 };
  // Down and to the right at 40° on screen (the plan is 2.4 times as wide as it is tall).
  const p = { x: 0.5 + Math.cos(Math.PI * 40 / 180) * 0.1, y: 0.5 + Math.sin(Math.PI * 40 / 180) * 0.1 * 2.4 };
  turnBar(f, p, false);
  assert.equal(f.angle, 45);
  turnBar(f, p, true);
  assert.equal(f.angle, 40);
  near(f.w, 0.2, 'length');
  // Pointing left is ±180.
  turnBar(f, { x: 0.2, y: 0.5 }, false);
  assert.equal(Math.abs(f.angle), 180);
});

test('dragging one end of a bar moves that end and leaves the other where it is', () => {
  const f: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03 };
  resizeEnd(f, 'end', { x: 0.7, y: 0.9 });
  near(f.x, 0.55);
  near(f.w, 0.3);
  assert.equal(f.y, 0.5, 'an across bar never moves up or down from its ends');
  // Past the other end it stops at twice the bar's thickness (0.03 of the height).
  resizeEnd(f, 'start', { x: 0.95, y: 0.5 });
  near(f.x + f.w / 2, 0.7);
  near(f.w, 0.025);
  // An end never leaves the plan.
  resizeEnd(f, 'start', { x: -0.4, y: 0.5 });
  near(f.x - f.w / 2, 0);
  near(f.x + f.w / 2, 0.7);
});

test('a turned bar is resized along its own line', () => {
  const f: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03, angle: 90 };
  const [, bottom] = barEnds(f);
  resizeEnd(f, 'start', { x: 0.9, y: 0.1 });
  const [top, stays] = barEnds(f);
  nearPoint(stays, bottom.x, bottom.y);
  nearPoint(top, 0.5, 0.1);
  assert.equal(f.x, 0.5);
  // At 45° the dragged end follows the pointer's place along the line.
  const slant: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03, angle: 45 };
  const [start] = barEnds(slant);
  const target = { x: 0.5 + 0.15 * Math.SQRT1_2, y: 0.5 + 0.15 * Math.SQRT1_2 * 2.4 };
  resizeEnd(slant, 'end', target);
  const [kept, end] = barEnds(slant);
  nearPoint(kept, start.x, start.y);
  nearPoint(end, target.x, target.y);
});

test('the side handle sets the thickness, evenly about the middle, up to half the length', () => {
  const across: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03 };
  resizeThickness(across, { x: 0.1, y: 0.45 });
  near(across.h, 0.1);
  near(across.y, 0.5);
  resizeThickness(across, { x: 0.5, y: 0.5 });
  near(across.h, MIN_THICKNESS);
  resizeThickness(across, { x: 0.5, y: 1 });
  near(across.h, 0.24, 'half its length on screen');
  const upright: any = { x: 0.5, y: 0.5, w: 0.2, h: 0.03, angle: 90 };
  resizeThickness(upright, { x: 0.52, y: 0.1 });
  near(upright.h, 0.096, 'thickness is measured across the bar');
});

test('a beam is aimed and sized from its tip', () => {
  const f: any = { x: 0.5, y: 0.9, shape: 'beam', angle: -90, reach: 0.14 };
  aimBeam(f, { x: 0.5, y: 0.9 - 0.2 * 2.4 }, false);
  assert.equal(f.angle, -90);
  near(f.reach, 0.2);
  aimBeam(f, { x: 0.7, y: 0.9 }, false);
  assert.equal(f.angle, 0);
  near(f.reach, 0.2);
  const cone = beamCone(f);
  nearPoint(cone.tip, 0.7, 0.9);
  assert.ok(cone.left.y < cone.tip.y && cone.right.y > cone.tip.y, 'the cone opens both sides of where it points');
});

test('an outline is sized from its corner, evenly about the middle', () => {
  const f: any = { x: 0.5, y: 0.5, shape: 'outline', w: 0.1, h: 0.1 };
  resizeOutline(f, { x: 0.6, y: 0.7 });
  near(f.w, 0.2);
  near(f.h, 0.4);
  resizeOutline(f, { x: 0.5, y: 0.5 });
  assert.ok(f.w > 0 && f.h > 0, 'never shrinks to nothing');
});

test('an outline\'s cells run clockwise from the top left, and round its corners', () => {
  const box = { left: 0, top: 0, width: 100, height: 50 };
  const one = outlineCells(box, 1);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0]!.slice(0, 1), [[0, 0]]);
  assert.equal(one[0]!.length, 5, 'one cell goes all the way round');
  const four = outlineCells(box, 4);
  // 300 px round: 75 px each; the first runs along the top.
  assert.deepEqual(four[0], [[0, 0], [75, 0]]);
  assert.deepEqual(four[1], [[75, 0], [100, 0], [100, 50]]);
  // Reversed runs the other way: down the left side first.
  const back = outlineCells(box, 4, true);
  assert.deepEqual(back[0], [[0, 0], [0, 50], [25, 50]]);
});

test('new fixtures go in a row from the spot, kept on the plan', () => {
  assert.deepEqual(placeRow({ x: 0.3, y: 0.4 }, 1, 'dot'), [{ x: 0.3, y: 0.4 }]);
  const dots = placeRow({ x: 0.3, y: 0.4 }, 3, 'dot');
  assert.deepEqual(dots.map((p) => p.y), [0.4, 0.4, 0.4]);
  assert.equal(dots[0]!.x, 0.3);
  assert.ok(dots[1]!.x > dots[0]!.x && dots[2]!.x > dots[1]!.x);
  const late = placeRow({ x: 0.95, y: 0.4 }, 4, 'dot');
  assert.ok(late.at(-1)!.x <= 0.97);
  const bars = placeRow({ x: 0.1, y: 0.4 }, 3, 'bar');
  assert.ok(bars[1]!.x - bars[0]!.x >= BAR_LENGTH);
  assert.equal(placeRow({ x: 0.02, y: 0.4 }, 1, 'bar')[0]!.x, BAR_LENGTH / 2);
  const many = placeRow({ x: 0.5, y: 0.4 }, 40, 'dot');
  assert.ok(many.every((p) => p.x >= 0 && p.x <= 1));
});

// ---- Several fixtures at once ----

test('a fixture\'s bounds: a point for a dot, the space a bar or outline takes up on screen', () => {
  assert.deepEqual(boundsOf({ x: 0.3, y: 0.4 }), { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4 });
  const across = boundsOf({ x: 0.5, y: 0.5, w: 0.2, h: 0.04 });
  near(across.left, 0.4); near(across.right, 0.6); near(across.top, 0.48); near(across.bottom, 0.52);
  // Upright: as long on screen, so 0.2 of the width is 0.48 of the height.
  const upright = boundsOf({ x: 0.5, y: 0.5, w: 0.2, h: 0.03, angle: 90 });
  near(upright.top, 0.26); near(upright.bottom, 0.74);
  near(upright.right - upright.left, 0.03 / 2.4);
  const box = boundsOf({ x: 0.5, y: 0.5, shape: 'outline', w: 0.1, h: 0.2 });
  near(box.left, 0.45); near(box.bottom, 0.6);
  // A beam is where its lamp is; its cone is light, not the fixture.
  assert.deepEqual(boundsOf({ x: 0.5, y: 0.9, shape: 'beam', angle: -90, reach: 0.2 }), { left: 0.5, right: 0.5, top: 0.9, bottom: 0.9 });
});

test('align lines fixtures up by their edges or middles', () => {
  const make = () => [
    { x: 0.2, y: 0.3 } as any,
    { x: 0.5, y: 0.5, w: 0.2, h: 0.04 } as any,
    { x: 0.7, y: 0.8 } as any,
  ];
  let fs = make();
  alignFixtures(fs, 'left');
  near(fs[0].x, 0.2); near(fs[1].x - fs[1].w / 2, 0.2); near(fs[2].x, 0.2);
  fs = make();
  alignFixtures(fs, 'right');
  near(fs[2].x, 0.7); near(fs[1].x + fs[1].w / 2, 0.7);
  fs = make();
  alignFixtures(fs, 'centre');
  // The middle of the group: from 0.2 to 0.7.
  for (const f of fs) near(f.x, 0.45);
  fs = make();
  alignFixtures(fs, 'top');
  near(fs[0].y, 0.3); near(fs[1].y - 0.02, 0.3); near(fs[2].y, 0.3);
  fs = make();
  alignFixtures(fs, 'bottom');
  for (const f of fs) assert.ok(f.y <= 0.8 + 1e-9);
  near(fs[1].y + 0.02, 0.8);
  fs = make();
  alignFixtures(fs, 'middle');
  for (const f of fs) near(f.y, 0.55);
  // Only what was asked moves.
  fs = make();
  alignFixtures(fs, 'left');
  assert.deepEqual(fs.map((f) => f.y), [0.3, 0.5, 0.8]);
});

test('space evenly keeps the outermost two and spaces the rest between them', () => {
  const fs: any[] = [{ x: 0.554, y: 0.892 }, { x: 0.47, y: 0.9 }, { x: 0.449, y: 0.892 }, { x: 0.397, y: 0.892 }];
  spaceEvenly(fs, 'x');
  // In order across: 0.397, then even steps, to 0.554; the list's own order doesn't matter.
  assert.deepEqual(fs.map((f) => f.x), [0.554, 0.502, 0.449, 0.397]);
  assert.deepEqual(fs.map((f) => f.y), [0.892, 0.9, 0.892, 0.892], 'only across');
  const down: any[] = [{ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.2 }, { x: 0.1, y: 0.9 }];
  spaceEvenly(down, 'y');
  assert.deepEqual(down.map((f) => f.y), [0.1, 0.5, 0.9]);
});

test('several fixtures move together and all stay on the plan', () => {
  const fs: any[] = [{ x: 0.1, y: 0.5 }, { x: 0.3, y: 0.6 }];
  const starts = fs.map((f) => ({ x: f.x, y: f.y }));
  moveTogether(fs, starts, -0.3, 0.1);
  // The first can only go 0.1 to the left, so both do.
  assert.deepEqual(fs.map((f) => [f.x, f.y]), [[0, 0.6], [0.2, 0.7]]);
});

test('a box selects every fixture it touches', () => {
  const box = { left: 0.3, top: 0.3, right: 0.6, bottom: 0.6 };
  assert.equal(touches({ x: 0.4, y: 0.4 }, box), true);
  assert.equal(touches({ x: 0.7, y: 0.4 }, box), false);
  // A bar whose end reaches into the box.
  assert.equal(touches({ x: 0.75, y: 0.5, w: 0.4, h: 0.03 }, box), true);
  assert.equal(touches({ x: 0.85, y: 0.5, w: 0.4, h: 0.03 }, box), false);
});
