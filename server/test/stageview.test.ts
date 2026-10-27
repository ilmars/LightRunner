// The stage view's data and geometry: LEDs per fixture, where a light hangs, and where its pool and beam fall
// (web/shared/stageview.js, no DOM), and what the layout carries to the pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseShow } from '../../packages/shared/src/index.ts';
import { App } from '../src/app.ts';
import { operatorLayout } from '../src/layout.ts';
import { copyOf } from '../../web/patch/types.js';
import { PLAN_ASPECT, barEnds } from '../../web/shared/stage.js';
import {
  fitStageLength, frontPlacement, frontScene, hangsOf, isPanel, isStrip, ledLayout, ledPoints, panelGrid, poolOf, sharedStrengths, softLightOverlaps, softShareAt,
  stageSizeFrom, stageSizeWith, stageViewFrom,
} from '../../web/shared/stageview.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const near = (a: number, b: number, what = '') => assert.ok(Math.abs(a - b) < 1e-6, `${what} ${a} is not ${b}`);

// ---- LEDs spread over segments ----

test('LEDs are spread evenly over the segments, the remainder going to the first', () => {
  assert.deepEqual(ledLayout(3, 6), [0, 0, 1, 1, 2, 2], 'SixBar 500');
  assert.deepEqual(ledLayout(8, 24), [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7], 'SonicPulse Bar 10');
  assert.deepEqual(ledLayout(4, 12), [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3], 'SonicPulse Bar 05');
  assert.deepEqual(ledLayout(3, 8), [0, 0, 0, 1, 1, 1, 2, 2], '8 over 3: 3, 3, 2');
  assert.deepEqual(ledLayout(4, 5), [0, 0, 1, 2, 3], 'one over: the first segment gets it');
  assert.deepEqual(ledLayout(1, 3), [0, 0, 0]);
});

test('a light without a LED count draws one LED per segment', () => {
  assert.deepEqual(ledLayout(4), [0, 1, 2, 3]);
  assert.deepEqual(ledLayout(4, undefined), [0, 1, 2, 3]);
  assert.deepEqual(ledLayout(1), [0]);
});

test('fewer LEDs than segments: no crash, every segment shown once', () => {
  assert.deepEqual(ledLayout(8, 4), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ledLayout(3, 3), [0, 1, 2]);
  // Nonsense counts are ignored the same way.
  for (const leds of [0, -2, NaN, Infinity, null as any]) assert.deepEqual(ledLayout(3, leds), [0, 1, 2]);
  // And never an empty bar.
  assert.deepEqual(ledLayout(0, 5), [0, 0, 0, 0, 0]);
});

test('every segment keeps at least one LED, whatever the counts', () => {
  for (let segments = 1; segments <= 12; segments++) {
    for (const leds of [undefined, 1, 2, 5, 7, 16, 24, 100]) {
      const layout = ledLayout(segments, leds);
      for (let s = 0; s < segments; s++) assert.ok(layout.includes(s), `${segments} segments, ${leds} leds: segment ${s}`);
      assert.deepEqual([...layout].sort((a, b) => a - b), layout, 'in order along the bar');
      const per = Array.from({ length: segments }, (_, s) => layout.filter((x) => x === s).length);
      assert.ok(Math.max(...per) - Math.min(...per) <= 1, 'even to within one');
      assert.deepEqual([...per].sort((a, b) => b - a), per, 'the first segments have the extra');
    }
  }
});

// ---- Hangs on ----

const planOf = (extra: object) => ({ x: 0.5, y: 0.5, ...extra });

test('a stored Hangs on wins over the guess', () => {
  assert.equal(hangsOf(planOf({ y: 0.9, hangs: 'truss' })), 'truss');
  assert.equal(hangsOf(planOf({ shape: 'beam', hangs: 'riser' })), 'riser');
});

test('the guess for a fixture without Hangs on', () => {
  assert.equal(hangsOf(planOf({ shape: 'outline', w: 0.2, h: 0.2 })), 'riser', 'an outline');
  assert.equal(hangsOf(planOf({ y: 0.9, shape: 'beam' })), 'truss', 'a beam, even at the front');
  assert.equal(hangsOf(planOf({ y: 0.1, shape: 'beam' })), 'truss');
  assert.equal(hangsOf(planOf({ y: 0.9, shape: 'smoke' })), 'wall', 'smoke');
  assert.equal(hangsOf(planOf({ y: 0.5, w: 0.0125, h: 0.38 })), 'side', 'an upright bar');
  assert.equal(hangsOf(planOf({ y: 0.1, w: 0.0125, h: 0.38 })), 'side', 'an upright bar at the back');
  assert.equal(hangsOf(planOf({ y: 0.1, w: 0.2, h: 0.04 })), 'wall', 'a bar near the back');
  assert.equal(hangsOf(planOf({ y: 0.45, w: 0.2, h: 0.04 })), 'wall', 'a bar in the middle');
  assert.equal(hangsOf(planOf({ y: 0.3, w: 0.2, h: 0.04 })), 'wall', 'a bar at 0.3');
  assert.equal(hangsOf(planOf({ y: 0.6, w: 0.2, h: 0.04 })), 'wall', 'a bar at 0.6');
  assert.equal(hangsOf(planOf({ y: 0.68, w: 0.2, h: 0.04 })), 'truss', 'a bar below the middle');
  assert.equal(hangsOf(planOf({ y: 0.9, w: 0.2, h: 0.04 })), 'stand', 'a bar at the front');
  assert.equal(hangsOf(planOf({ y: 0.1 })), 'wall', 'a dot near the back');
  assert.equal(hangsOf(planOf({ y: 0.29 })), 'wall');
  assert.equal(hangsOf(planOf({ y: 0.5 })), 'truss', 'a dot in the middle');
  assert.equal(hangsOf(planOf({ y: 0.75 })), 'truss', 'the front starts past 0.75');
  assert.equal(hangsOf(planOf({ y: 0.8 })), 'stand', 'a dot at the front');
});

test('the guess uses the shape the layout gives, or works it out from the size', () => {
  assert.equal(hangsOf({ x: 0.5, y: 0.5, w: 0.2, h: 0.04 }), hangsOf({ x: 0.5, y: 0.5, w: 0.2, h: 0.04, shape: 'bar' }));
  assert.equal(hangsOf({ x: 0.5, y: 0.5, w: null, h: null, hangs: null }), 'truss', 'the layout sends null for what is missing');
  // A turned bar is upright when it points up or down, whatever its w and h say.
  assert.equal(hangsOf(planOf({ y: 0.5, w: 0.2, h: 0.04, angle: 90 })), 'side');
  assert.equal(hangsOf(planOf({ y: 0.5, w: 0.2, h: 0.04, angle: -90 })), 'side');
  assert.equal(hangsOf(planOf({ y: 0.5, w: 0.2, h: 0.04, angle: 30 })), 'wall');
});

test('the church rig: the guess alone is right for most lights, and the show says the rest', () => {
  const show = parseShow(readJson('shows/stage-l1.json'));
  const layout = operatorLayout(show, show.fixtures.map((f) => f.id));
  const explicit: Record<string, string> = {
    p1: 'stand', p2: 'stand', p3: 'stand', p4: 'stand', b1: 'truss', b2: 'truss',
    b3: 'wall', b4: 'wall', b5: 'wall', b6: 'wall', l1: 'riser', b8: 'side',
  };
  assert.deepEqual(layout.fixtures.map((f) => f.id), Object.keys(explicit));
  for (const f of layout.fixtures) {
    assert.equal(f.hangs, explicit[f.id], `${f.id} hangs on ${explicit[f.id]} in the show`);
    assert.equal(hangsOf(f), explicit[f.id], `${f.id} drawn`);
    // Without the field, the guess: the key lights (a bar near the back) and the drum cage need the show to say.
    const guessed = hangsOf({ ...f, hangs: null });
    if (['b1', 'b2', 'l1'].includes(f.id)) assert.equal(guessed, 'wall', `${f.id} guessed`);
    else assert.equal(guessed, explicit[f.id], `${f.id} guessed`);
  }
});

// ---- The layout carries leds and hangs ----

test('the church show gives its three bar types their real LEDs', () => {
  const show = parseShow(readJson('shows/stage-l1.json'));
  const leds = Object.fromEntries(show.profiles.map((p) => [p.id, p.leds ?? null]));
  assert.deepEqual(leds, {
    'neewer-as600b-cct-8-bit': null,
    'elation-sixbar-500-18-ch': 6,
    'stairville-sonicpulse-led-bar-10-39-ch': 24,
    'generic-led-strip-rgb-3-ch': null,
    'stairville-sonicpulse-led-bar-05-23-ch': 12,
  });
  const layout = operatorLayout(show, show.fixtures.map((f) => f.id));
  const by = (id: string) => layout.fixtures.find((f) => f.id === id)!;
  assert.deepEqual(['p1', 'b1', 'b3', 'l1', 'b8'].map((id) => by(id).leds), [null, 6, 24, null, 12]);
  assert.deepEqual(['p1', 'b1', 'b3', 'l1', 'b8'].map((id) => by(id).segments), [1, 3, 8, 1, 4]);
  // Each bar's LEDs divide over its segments with none left over.
  for (const id of ['b1', 'b3', 'b8']) assert.equal(ledLayout(by(id).segments, by(id).leds ?? undefined).length, by(id).leds);
});

test('a show from before the stage view still parses and draws: no LEDs, no Hangs on', () => {
  const demo = readJson('server/seed/demo-show.json');
  for (const p of demo.profiles ?? []) assert.equal('leds' in p, false);
  for (const f of demo.fixtures) assert.equal('hangs' in f, false);
  const show = parseShow(demo);
  const layout = operatorLayout(show, show.fixtures.map((f) => f.id));
  assert.ok(layout.fixtures.length > 0);
  for (const f of layout.fixtures) {
    assert.equal(f.leds, null);
    assert.equal(f.hangs, null);
    assert.deepEqual(ledLayout(f.segments, f.leds ?? undefined), Array.from({ length: f.segments }, (_, k) => k), 'one LED per segment');
    assert.ok(['truss', 'wall', 'riser', 'stand', 'side'].includes(hangsOf(f)));
  }
});

test('LEDs and Hangs on are checked when a show is read', () => {
  const show = readJson('shows/stage-l1.json');
  const withProfile = (patch: object) => ({ ...show, profiles: show.profiles.map((p: any, k: number) => (k === 1 ? { ...p, ...patch } : p)) });
  const withFixture = (patch: object) => ({ ...show, fixtures: show.fixtures.map((f: any, k: number) => (k === 0 ? { ...f, ...patch } : f)) });
  for (const leds of [0, -1, 513, 2.5, '6']) assert.throws(() => parseShow(withProfile({ leds })), `leds ${leds}`);
  for (const leds of [1, 512]) assert.doesNotThrow(() => parseShow(withProfile({ leds })), `leds ${leds}`);
  for (const hangs of ['ceiling', '', 3]) assert.throws(() => parseShow(withFixture({ hangs })), `hangs ${hangs}`);
  for (const hangs of ['truss', 'wall', 'riser', 'stand', 'side']) assert.doesNotThrow(() => parseShow(withFixture({ hangs })), hangs);
});

test('a copy of a fixture type keeps its LEDs', () => {
  const show = readJson('shows/stage-l1.json');
  const sixbar = show.profiles.find((p: any) => p.id === 'elation-sixbar-500-18-ch');
  assert.equal(copyOf(sixbar, new Set()).leds, 6);
  assert.equal('leds' in copyOf(show.profiles[0], new Set()), false, 'none when the type has none');
});

// ---- Geometry from above ----

test('panels: one segment with 16 or more LEDs, and no bar shape', () => {
  assert.equal(isPanel({ x: 0.5, y: 0.5, segments: 1, leds: 16 }), true);
  assert.equal(isPanel({ x: 0.5, y: 0.5, segments: 1, leds: 15 }), false);
  assert.equal(isPanel({ x: 0.5, y: 0.5, segments: 1, leds: null }), false, 'no count: one lamp, honest');
  assert.equal(isPanel({ x: 0.5, y: 0.5, segments: 2, leds: 40 }), false);
  assert.equal(isPanel({ x: 0.5, y: 0.5, segments: 1, leds: 40, w: 0.2, h: 0.04 }), false, 'a bar is a bar');
  assert.equal(isPanel({ x: 0.5, y: 0.5, segments: 1, leds: 40, shape: 'beam' }), false);
  const { cols, rows } = panelGrid(48);
  assert.ok(cols * rows >= 48 && cols >= rows);
  assert.deepEqual(panelGrid(1), { cols: 1, rows: 1 });
  for (let n = 1; n <= 512; n++) { const g = panelGrid(n); assert.ok(g.cols * g.rows >= n && (g.cols - 1) * g.rows < n + g.rows, `${n}`); }
});

test('a bar\'s LEDs lie along its middle line, in order, in the colour of their segment', () => {
  const bar = { x: 0.5, y: 0.4, w: 0.2, h: 0.04, segments: 3, leds: 6 };
  const pts = ledPoints(bar);
  assert.deepEqual(pts.map((p: any) => p.segment), [0, 0, 1, 1, 2, 2]);
  const [a, b] = barEnds(bar);
  pts.forEach((p: any, k: number) => {
    const t = (k + 0.5) / 6;
    near(p.x, a.x + (b.x - a.x) * t, `x ${k}`);
    near(p.y, a.y + (b.y - a.y) * t, `y ${k}`);
  });
  // No LED count: one per segment. A turned bar: along its angle.
  assert.deepEqual(ledPoints({ ...bar, leds: null }).map((p: any) => p.segment), [0, 1, 2]);
  const upright = ledPoints({ x: 0.5, y: 0.5, w: 0.0125, h: 0.38, segments: 4, leds: 12 });
  assert.equal(upright.length, 12);
  near(upright[0].x, 0.5); near(upright[11].x, 0.5);
  assert.ok(upright[0].y < upright[11].y, 'the first segment is at the top');
  assert.deepEqual(ledPoints({ x: 0.5, y: 0.5, segments: 1 }), [], 'a lamp is not a bar');
});

test('a bar hung from the truss throws a pool below each of its segments, downstage of it', () => {
  const bar = { x: 0.4, y: 0.24, w: 0.093, h: 0.04, segments: 3, leds: 6, hangs: 'truss' };
  const pool = poolOf(bar, 'truss', 'above');
  assert.equal(pool.spots.length, 3);
  assert.deepEqual(pool.spots.map((s: any) => s.segment), [0, 1, 2]);
  const [a, b] = barEnds(bar);
  pool.spots.forEach((s: any, k: number) => {
    const t = (k + 0.5) / 3;
    near(s.x, a.x + (b.x - a.x) * t, 'x under its segment');
    assert.ok(s.y > bar.y, 'downstage: further down the plan');
  });
  assert.ok(pool.r > 0 && pool.squash > 0 && pool.squash <= 1 && pool.alpha > 0 && pool.alpha <= 1);
});

test('where the pool falls follows where the light hangs', () => {
  const lamp = { x: 0.5, y: 0.89, segments: 1 };
  const stand = poolOf(lamp, 'stand', 'above');
  assert.equal(stand.spots.length, 1);
  assert.ok(stand.spots[0].y < lamp.y, 'a stand light throws upstage, towards the back');
  near(stand.spots[0].x, lamp.x);

  const wallBar = { x: 0.6, y: 0.39, w: 0.22, h: 0.04, segments: 8 };
  const wall = poolOf(wallBar, 'wall', 'above');
  assert.equal(wall.spots.length, 8);
  assert.ok(wall.spots.every((s: any) => Math.abs(s.y - wallBar.y) < 0.08), 'hugs the bar');
  assert.ok(wall.r < poolOf({ ...wallBar, segments: 3 }, 'truss', 'above').r, 'a wall pool is tighter than a truss one');

  const strip = poolOf({ x: 0.84, y: 0.1, w: 0.2, h: 0, segments: 1 }, 'riser', 'above');
  // A long strip with one segment glows along itself: a few pools in its one colour, centred on it.
  assert.ok(strip.spots.length >= 1 && strip.spots.every((s: any) => s.segment === 0));
  near(strip.spots.reduce((sum: number, s: any) => sum + s.x, 0) / strip.spots.length, 0.84);
  assert.ok(strip.spots.every((s: any) => Math.abs(s.y - 0.1) < 0.06 && s.x > 0.84 - 0.1 && s.x < 0.84 + 0.1), 'glows round itself');

  const side = { x: 0.69, y: 0.73, w: 0.0125, h: 0.38, segments: 4 };
  const beside = poolOf(side, 'side', 'above');
  assert.equal(beside.spots.length, 4);
  assert.ok(beside.spots.every((s: any) => s.x < side.x), 'beside the bar, towards the middle of the stage');
  const ys = beside.spots.map((s: any) => s.y);
  assert.deepEqual([...ys].sort((p, q) => p - q), ys, 'one under another down the bar');
});

test('a long bar with few segments throws several pools near it, not one huge one', () => {
  const long = { x: 0.5, y: 0.2, w: 0.3, h: 0.04, segments: 1 };
  const pool = poolOf(long, 'wall', 'above');
  assert.ok(pool.spots.length > 1, 'more than one pool');
  assert.ok(pool.spots.every((s: any) => s.segment === 0));
  assert.ok(pool.r < 0.1, `a pool stays small (${pool.r})`);
  // Two segments over many pools: the first half in the first segment's colour, the rest in the second's.
  const two = poolOf({ ...long, segments: 2 }, 'wall', 'above');
  const segs = two.spots.map((s: any) => s.segment);
  assert.deepEqual([...segs].sort(), segs, 'in order along the bar');
  assert.equal(segs[0], 0);
  assert.equal(segs.at(-1), 1);
  // The church's bars keep one pool per segment.
  assert.equal(poolOf({ x: 0.6, y: 0.39, w: 0.221, h: 0.04, segments: 8 }, 'wall', 'above').spots.length, 8);
  assert.equal(poolOf({ x: 0.39, y: 0.24, w: 0.093, h: 0.04, segments: 3 }, 'truss', 'above').spots.length, 3);
});

test('a beam keeps its own angle and reach: its pool is at the tip of the cone', () => {
  const beam = { x: 0.5, y: 0.5, shape: 'beam', angle: 0, reach: 0.2, segments: 1 };
  const pool = poolOf(beam, 'truss', 'above');
  assert.equal(pool.spots.length, 1);
  near(pool.spots[0].x, 0.7, 'x');
  near(pool.spots[0].y, 0.5, 'y');
  // The pool is as wide as the cone is at its end: 0.2 * tan(20 degrees) each side, in plan widths.
  near(pool.r, 0.2 * Math.tan((20 * Math.PI) / 180), 'r');
  // Pointing down the plan, the tip is lower, and the height is in plan heights.
  const down = poolOf({ ...beam, angle: 90 }, 'truss', 'above');
  near(down.spots[0].x, 0.5);
  near(down.spots[0].y, 0.5 + 0.2 * PLAN_ASPECT);
  // Without a reach or angle, a beam has the default ones, so it still draws.
  const plain = poolOf({ x: 0.5, y: 0.5, shape: 'beam', segments: 1 }, 'truss', 'above');
  assert.ok(plain.spots[0].y < 0.5, 'points up the plan');
});

test('pools are plain numbers for any fixture, and the only view is from above', () => {
  for (const hangs of ['truss', 'wall', 'riser', 'stand', 'side'] as const) {
    for (const f of [
      { x: 0.1, y: 0.1, segments: 1 }, { x: 0.9, y: 0.9, w: 0.3, h: 0.04, segments: 5 }, { x: 0.5, y: 0.5, shape: 'outline', w: 0.2, h: 0.3, segments: 1 },
      { x: 0.5, y: 0.5, shape: 'smoke', segments: 1 }, { x: 0.5, y: 0.5, w: 0.3, h: 0.04, angle: 45, segments: 2 }, { x: 0.99, y: 0.01, shape: 'beam', angle: 135, reach: 1, segments: 1 },
    ]) {
      const pool = poolOf(f, hangs, 'above');
      assert.ok(pool.spots.length >= 1);
      for (const s of pool.spots) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isInteger(s.segment) && s.segment >= 0 && s.segment < f.segments);
      assert.ok(Number.isFinite(pool.r) && pool.r > 0);
    }
  }
});

// ---- Geometry from the audience ----

test('the front scene scales with the box, and its parts stay in order and inside it', () => {
  for (const [w, h] of [[300, 124], [640, 300], [1600, 700], [120, 40]]) {
    const s = frontScene(w, h);
    assert.ok(0 < s.trussY && s.trussY < s.wallTop + 1 && s.wallTop < s.floorY && s.floorY < h, `${w}x${h}`);
    assert.ok(s.s > 0);
    assert.ok(s.s <= w / 640 + 1e-9 && s.s <= h / 300 + 1e-9, 'sizes scale with the smaller side');
  }
  const s = frontScene(640, 300);
  near(s.floorY, 240); near(s.wallTop, 48); near(s.trussY, 33); near(s.s, 1);
});

test('from the audience: left to right from the plan, each place by where the light hangs', () => {
  const w = 640, h = 300;
  const scene = frontScene(w, h);
  const truss = frontPlacement({ x: 0.39, y: 0.24, w: 0.093, h: 0.04, segments: 3, leds: 6 }, 'truss', w, h);
  near(truss.x, 0.39 * w);
  near(truss.length, 0.093 * w);
  assert.equal(truss.vertical, false);
  assert.ok(truss.top > scene.trussY && truss.top + truss.height < scene.floorY, 'hangs under the truss');
  assert.equal(truss.beamFrom, truss.top + truss.height);
  assert.deepEqual(truss.leds.map((l: any) => l.segment), [0, 0, 1, 1, 2, 2]);
  truss.leds.forEach((l: any, k: number) => {
    near(l.x, truss.x - truss.length / 2 + (truss.length * (k + 0.5)) / 6, `led ${k}`);
    near(l.y, truss.top + truss.height / 2, 'in the housing');
  });
  assert.deepEqual(truss.segments.map((s: any) => s.segment), [0, 1, 2]);
  near(truss.segments[1].x, truss.x);

  const wall = frontPlacement({ x: 0.86, y: 0.39, w: 0.22, h: 0.04, segments: 8, leds: 24 }, 'wall', w, h);
  near(wall.top + wall.height, scene.floorY, 'stands on the floor at the foot of the wall');
  assert.equal(wall.leds.length, 24);
  assert.equal(wall.segments.length, 8);

  const stand = frontPlacement({ x: 0.55, y: 0.89, segments: 1 }, 'stand', w, h);
  near(stand.x, 0.55 * w);
  assert.ok(stand.top > scene.floorY && stand.top + stand.height <= h, 'on its stand in front, inside the box');
  assert.equal(stand.leds.length, 1);

  const riser = frontPlacement({ x: 0.84, y: 0.1, w: 0.215, h: 0, segments: 1 }, 'riser', w, h);
  near(riser.length, 0.215 * w);
  near(riser.top + riser.height, scene.floorY, 'on the floor at the back');

  const side = frontPlacement({ x: 0.69, y: 0.73, w: 0.0125, h: 0.38, segments: 4, leds: 12 }, 'side', w, h);
  assert.equal(side.vertical, true);
  near(side.x, 0.69 * w);
  assert.ok(side.top >= scene.wallTop && side.top + side.length <= scene.floorY + 1e-9, 'upright between the wall top and the floor');
  assert.equal(side.leds.length, 12);
  assert.ok(side.leds[0].y < side.leds[11].y, 'the first segment at the top');
  near(side.leds[0].x, side.x);
});

test('from the audience: a beam lands where its cone ends on the plan, leaning when it is aimed sideways', () => {
  const w = 640, h = 300;
  const up = frontPlacement({ x: 0.3, y: 0.72, shape: 'beam', angle: -90, reach: 0.2, segments: 1 }, 'truss', w, h);
  near(up.beamTo!, 0.3 * w, 'aimed to the back: straight down');
  const down = frontPlacement({ x: 0.5, y: 0.28, shape: 'beam', angle: 90, reach: 0.3, segments: 1 }, 'truss', w, h);
  near(down.beamTo!, 0.5 * w, 'aimed at the audience: straight down');
  const across = frontPlacement({ x: 0.3, y: 0.5, shape: 'beam', angle: 0, reach: 0.2, segments: 1 }, 'truss', w, h);
  near(across.beamTo!, 0.5 * w, 'aimed to the right: lands its reach to the right');
  const slant = frontPlacement({ x: 0.6, y: 0.5, shape: 'beam', angle: -135, reach: 0.2, segments: 1 }, 'truss', w, h);
  near(slant.beamTo!, (0.6 - 0.2 * Math.SQRT1_2) * w, 'aimed back and to the left: a little to the left');
  const old = frontPlacement({ x: 0.3, y: 0.72, shape: 'beam', segments: 1 }, 'truss', w, h);
  near(old.beamTo!, 0.3 * w, 'no angle of its own: to the back, straight down');
  assert.equal(frontPlacement({ x: 0.3, y: 0.5, w: 0.1, h: 0.04, segments: 3 }, 'truss', w, h).beamTo, undefined, 'a bar shines straight down');
});

test('from the audience: a light without a length is a lamp, and a LED count of none is one per segment', () => {
  const lamp = frontPlacement({ x: 0.5, y: 0.5, segments: 1 }, 'truss', 640, 300);
  assert.ok(lamp.length > 0, 'a lamp has a body');
  assert.equal(lamp.leds.length, 1);
  const bar = frontPlacement({ x: 0.5, y: 0.5, w: 0.2, h: 0.04, segments: 4, leds: 2 }, 'wall', 640, 300);
  assert.deepEqual(bar.leds.map((l: any) => l.segment), [0, 1, 2, 3], 'fewer LEDs than segments: one each');
});

test('from the audience at the operator\'s small size and at 1600 px: bodies stay inside the box', () => {
  const rig: any[] = [
    { x: 0.554, y: 0.892, segments: 1, hangs: 'stand' }, { x: 0.391, y: 0.243, w: 0.093, h: 0.04, segments: 3, leds: 6, hangs: 'truss' },
    { x: 0.859, y: 0.392, w: 0.221, h: 0.04, segments: 8, leds: 24, hangs: 'wall' }, { x: 0.844, y: 0.1, w: 0.215, h: 0, segments: 1, hangs: 'riser' },
    { x: 0.69, y: 0.732, w: 0.012, h: 0.38, segments: 4, leds: 12, hangs: 'side' },
  ];
  for (const [w, h] of [[300, 124], [1600, 700]]) {
    for (const f of rig) {
      const p = frontPlacement(f, hangsOf(f), w, h);
      const left = p.vertical ? p.x - p.width / 2 : p.x - p.length / 2;
      const right = p.vertical ? p.x + p.width / 2 : p.x + p.length / 2;
      assert.ok(left >= -1e-9 && right <= w + 1e-9, `${w}x${h} ${f.hangs} is across`);
      assert.ok(p.top >= 0 && p.top + p.height <= h + 1e-9, `${w}x${h} ${f.hangs} is down`);
      for (const l of p.leds) assert.ok(l.x >= 0 && l.x <= w && l.y >= 0 && l.y <= h);
    }
  }
});

// ---- Strips ----

test('a bar with no thickness and no LED count is a strip (a line), anything else is not', () => {
  assert.equal(isStrip({ x: 0.844, y: 0.1, w: 0.215, h: 0, segments: 1 }), true, 'the drum cage strip');
  assert.equal(isStrip({ x: 0.5, y: 0.5, w: 0.2, h: null, segments: 3 }), true);
  assert.equal(isStrip({ x: 0.5, y: 0.5, w: 0.2, h: 0, segments: 3, leds: 30 }), false, 'a LED count: its LEDs are drawn');
  assert.equal(isStrip({ x: 0.5, y: 0.5, w: 0.221, h: 0.04, segments: 8 }), false, 'a bar with a body');
  assert.equal(isStrip({ x: 0.5, y: 0.5, segments: 1 }), false, 'a lamp');
  assert.equal(isStrip({ x: 0.5, y: 0.5, w: 0.2, h: 0, shape: 'outline', segments: 1 }), false, 'an outline is drawn as one');
});

// ---- The view and size each browser keeps ----

test('the view kept is from above unless it says from the audience', () => {
  assert.equal(stageViewFrom('front'), 'front');
  for (const v of ['above', null, undefined, '', 'sideways', '{"x":1}']) assert.equal(stageViewFrom(v as any), 'above');
});

test('the stage view size is kept per page, and anything unreadable is nothing kept', () => {
  assert.deepEqual(stageSizeFrom(null, 'operator'), { w: null, h: null });
  assert.deepEqual(stageSizeFrom('not json', 'operator'), { w: null, h: null });
  assert.deepEqual(stageSizeFrom('[1,2]', 'operator'), { w: null, h: null });
  assert.deepEqual(stageSizeFrom('{"operator":{"h":-4,"w":"x"}}', 'operator'), { w: null, h: null });
  let kept = stageSizeWith(null, 'operator', { h: 200.4 });
  assert.deepEqual(stageSizeFrom(kept, 'operator'), { w: null, h: 200 });
  kept = stageSizeWith(kept, 'timeline', { w: 900, h: 320 });
  assert.deepEqual(stageSizeFrom(kept, 'timeline'), { w: 900, h: 320 });
  assert.deepEqual(stageSizeFrom(kept, 'operator'), { w: null, h: 200 }, 'the other page keeps its own');
  kept = stageSizeWith(kept, 'operator', null);
  assert.deepEqual(stageSizeFrom(kept, 'operator'), { w: null, h: null }, 'reset: forgotten');
  assert.deepEqual(stageSizeFrom(kept, 'timeline'), { w: 900, h: 320 });
  assert.deepEqual(JSON.parse(stageSizeWith('garbage', 'operator', { h: 150 })), { operator: { h: 150 } });
});

test('a wanted stage view length stays within its limits, the minimum winning when there is no room', () => {
  assert.equal(fitStageLength(200, 124, 300), 200);
  assert.equal(fitStageLength(50, 124, 300), 124);
  assert.equal(fitStageLength(900, 124, 300), 300);
  assert.equal(fitStageLength(200, 124, 80), 124, 'less room than the minimum');
  assert.equal(fitStageLength(NaN, 124, 300), 124);
  assert.equal(fitStageLength(500, 124, NaN), 500, 'no maximum known');
});

// ---- Soft light that overlaps ----

test('a soft light is strongest at its middle (a wash: at the foot of the wall) and gone at its edge', () => {
  const spot = { sprite: 'round', x: 0, y: 0, w: 100, h: 50, a: 0.4 };
  near(softShareAt(spot, 50, 25), 1);
  assert.equal(softShareAt(spot, 100, 25), 0);
  assert.equal(softShareAt(spot, 50, 0), 0);
  assert.ok(softShareAt(spot, 75, 25) > 0 && softShareAt(spot, 75, 25) < 1);
  const wash = { sprite: 'arch', x: 0, y: 0, w: 100, h: 200, a: 0.3 };
  near(softShareAt(wash, 50, 200), 1, 'the foot of the wall, in the middle');
  assert.ok(softShareAt(wash, 50, 100) < softShareAt(wash, 50, 160), 'fainter up the wall');
  assert.equal(softShareAt(wash, 50, 0), 0, 'gone at the top');
  assert.equal(softShareAt(wash, 50, 260), 0, 'nothing under the floor line');
});

test('overlapping lit pools share their light: All white never adds up to a bright floor', () => {
  const lone = [{ sprite: 'round', x: 0, y: 0, w: 40, h: 30, a: 0.38 }];
  near(sharedStrengths(lone, softLightOverlaps(lone), [1])[0], 0.38, 'alone');
  const apart = [{ sprite: 'round', x: 0, y: 0, w: 40, h: 30, a: 0.3 }, { sprite: 'round', x: 100, y: 0, w: 40, h: 30, a: 0.3 }];
  assert.deepEqual(sharedStrengths(apart, softLightOverlaps(apart), [1, 1]), [0.3, 0.3], 'apart: untouched');
  // Twelve pools on one spot, all lit, at 0.34 would add up to 4; shared, they stay under about 0.34 * 12^0.2 (0.56).
  const stack = Array.from({ length: 12 }, () => ({ sprite: 'round', x: 0, y: 0, w: 40, h: 30, a: 0.34 }));
  const all = sharedStrengths(stack, softLightOverlaps(stack), stack.map(() => 1));
  const total = all.reduce((sum, a) => sum + a, 0);
  assert.ok(total < 0.6, `the stack adds up to ${total}`);
  assert.ok(total > 0.34, 'but a little brighter than one');
  // Washes side by side up a wall (the church's background bars), all lit: the sum at the foot stays dim.
  const washes = Array.from({ length: 32 }, (_, k) => ({ sprite: 'arch', x: k * 18 - 54, y: 0, w: 108, h: 190, a: 0.3 }));
  const strong = sharedStrengths(washes, softLightOverlaps(washes), washes.map(() => 1));
  const atFoot = (x: number) => washes.reduce((sum, p, i) => sum + strong[i] * softShareAt(p, x, 190), 0);
  for (const x of [100, 250, 400]) assert.ok(atFoot(x) < 0.5, `the foot of the wall at ${x}: ${atFoot(x)}`);
});

test('a lit pool among dark ones keeps its own strength; dimmer neighbours share less', () => {
  // A key light's pool under the background bars' pools: only the key light is on.
  const pools = [
    { sprite: 'round', x: 40, y: 0, w: 60, h: 40, a: 0.42 },
    ...Array.from({ length: 6 }, (_, k) => ({ sprite: 'round', x: k * 25, y: 5, w: 40, h: 30, a: 0.3 })),
  ];
  const overlaps = softLightOverlaps(pools);
  assert.ok(overlaps[0].length > 0, 'they do overlap');
  const lit = [1, 0, 0, 0, 0, 0, 0];
  near(sharedStrengths(pools, overlaps, lit)[0], 0.42, 'dark neighbours take nothing');
  const allOn = sharedStrengths(pools, overlaps, pools.map(() => 1));
  assert.ok(allOn[0] < 0.42, 'all on: shared');
  const halfOn = sharedStrengths(pools, overlaps, [1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  assert.ok(halfOn[0] < 0.42 && halfOn[0] > allOn[0], 'neighbours at half share less than at full');
  // A light that is off: its strength doesn't matter, and nothing breaks.
  assert.ok(sharedStrengths(pools, overlaps, [0, 1, 1, 1, 1, 1, 1]).every((a) => Number.isFinite(a) && a > 0));
  // The answer goes into `out` when one is given.
  const out = new Array(pools.length);
  assert.equal(sharedStrengths(pools, overlaps, lit, out), out);
});

test('a show saved with Hangs on and LEDs reads back whole, in the show and in the layout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-stageview-'));
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath: join(root, 'server/seed/demo-show.json'), webDir: join(root, 'web'), log: () => {} });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    await app.start();
    await call('PUT', '/api/settings', { output: { kind: 'none' } });
    // The church show, which has both on its lights and bars.
    assert.equal((await call('PUT', '/api/show', readJson('shows/stage-l1.json'))).status, 200);
    const show = (await call('GET', '/api/show')).body;
    const user = show.fixtures.find((f: any) => f.id === 'b1');
    assert.equal(user.hangs, 'truss');
    const own = show.profiles.find((p: any) => p.id === user.profile);
    assert.equal(own.leds, 6);
    const edited = {
      ...show,
      profiles: show.profiles.map((p: any) => (p.id === own.id ? { ...p, leds: 12 } : p)),
      fixtures: show.fixtures.map((f: any) => (f.id === user.id ? { ...f, hangs: 'stand' } : f)),
    };
    assert.equal((await call('PUT', '/api/show?source=patch', edited)).status, 200);
    const back = (await call('GET', '/api/show')).body;
    assert.equal(back.profiles.find((p: any) => p.id === own.id).leds, 12);
    assert.equal(back.fixtures.find((f: any) => f.id === user.id).hangs, 'stand');
    assert.equal(back.fixtures.find((f: any) => f.id === 'b2').hangs, 'truss', 'the others are as they were');
    const layout = (await call('GET', '/api/layout')).body;
    const seen = layout.fixtures.find((f: any) => f.id === user.id);
    assert.equal(seen.hangs, 'stand');
    assert.equal(seen.leds, 12);
    // Taking either away again leaves a show without the fields, and the layout says null.
    const bare = {
      ...back,
      profiles: back.profiles.map(({ leds: _l, ...p }: any) => p),
      fixtures: back.fixtures.map(({ hangs: _h, ...f }: any) => f),
    };
    assert.equal((await call('PUT', '/api/show?source=patch', bare)).status, 200);
    const gone = (await call('GET', '/api/layout')).body.fixtures.find((f: any) => f.id === user.id);
    assert.deepEqual([gone.hangs, gone.leds], [null, null]);
    // A number that is not a whole 1 to 512 is refused.
    const bad = { ...bare, profiles: bare.profiles.map((p: any) => (p.id === own.id ? { ...p, leds: 513 } : p)) };
    assert.notEqual((await call('PUT', '/api/show?source=patch', bad)).status, 200);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
