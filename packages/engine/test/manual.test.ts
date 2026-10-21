// Manual control of single lights (Individual lights on the operator page): a whole fixture, or one
// segment of a bar, held at a colour and level until released, then fading back to what its group runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseShow, type Show } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { beyondOwnMotion, segmentsOf } from './helpers.ts';

const BAR10 = 'stairville-sonicpulse-led-bar-10-39-ch';
const stage = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));

/** Two 8-segment bars in one group (the second hung reversed), with white, blue and a dim blue. */
function barsShow(): Show {
  const source = stage();
  return parseShow({
    schemaVersion: source.schemaVersion,
    name: 'Bars',
    profiles: source.profiles.filter((p) => p.id === BAR10),
    fixtures: [
      { id: 'bar1', name: 'Bar 1', profile: BAR10, universe: 1, address: 1 },
      { id: 'bar2', name: 'Bar 2', profile: BAR10, universe: 1, address: 40, reversed: true },
    ],
    groups: [{ id: 'bars', name: 'Bars', fixtures: ['bar1', 'bar2'] }],
    presets: [
      { id: 'white', name: 'White', group: 'bars', layers: [{ kind: 'static', colour: { hex: '#ffffff' } }], fade: 0 },
      { id: 'blue', name: 'Blue', group: 'bars', layers: [{ kind: 'static', colour: { hex: '#0000ff' } }], fade: 2 },
    ],
    looks: [],
  });
}

/** The visual's colour of one segment (fixtures in show order, 8 segments each). */
const rgbOf = (e: Engine, now: number, fixture: number, segment: number) =>
  Array.from(e.frame(now).visual.subarray((fixture * 8 + segment) * 3, (fixture * 8 + segment) * 3 + 3));

/** A bars engine running white, settled. */
function onWhite(): Engine {
  const e = new Engine(barsShow(), 0);
  assert.equal(e.apply({ type: 'groupPreset', group: 'bars', preset: 'white', fade: 0 }, 0), null);
  e.frame(0);
  e.frame(1);
  return e;
}

test('one segment of a bar can be held: it fades in, the rest of the bar keeps its group', () => {
  const e = onWhite();
  const before = segmentsOf(e, 'bar1');
  assert.equal(e.apply({ type: 'manual', target: { fixture: 'bar1', segment: 2 }, colour: '#ff0000', intensity: 0.5 }, 1), null);
  // Taking hold follows the finger (0.2 s), like any manual move; then it holds.
  for (let t = 1; t < 2; t += 0.025) e.frame(t);
  const [r, g, b] = rgbOf(e, 2, 0, 2);
  assert.ok(Math.abs(r! - 128) <= 1 && g === 0 && b === 0, `segment 3: ${[r, g, b]}`);
  const held = segmentsOf(e, 'bar1');
  for (let c = 0; c < 8; c++) if (c !== 2) assert.equal(held[c], before[c], `segment ${c + 1} untouched`);
  assert.deepEqual(segmentsOf(e, 'bar2'), new Array(8).fill(1), 'the other bar untouched');

  const s = e.liveState(2, 'ok');
  assert.deepEqual(s.held, [{ fixture: 'bar1', segment: 2, colour: '#ff0000', level: 0.5 }]);
  assert.deepEqual(s.fixturesManual, [], 'a held segment is not a held fixture');
});

test('a released segment fades back to what its group runs then, without a jump', () => {
  const e = onWhite();
  e.apply({ type: 'manual', target: { fixture: 'bar2', segment: 5 }, colour: '#ff0000', intensity: 1 }, 1);
  for (let t = 1; t < 2; t += 0.025) e.frame(t);
  // While it is held the group moves on to blue; the held segment stays red.
  e.apply({ type: 'groupPreset', group: 'bars', preset: 'blue' }, 2);
  for (let t = 2; t < 4.5; t += 0.025) e.frame(t);
  assert.deepEqual(rgbOf(e, 4.5, 1, 5), [255, 0, 0]);
  assert.deepEqual(rgbOf(e, 4.5, 1, 4), [0, 0, 255]);

  e.apply({ type: 'release', target: { fixture: 'bar2', segment: 5 } }, 4.5);
  assert.deepEqual(e.liveState(4.5, 'ok').held, [], 'released: no longer held, while it fades back');
  const { worst } = beyondOwnMotion(e, 4.5, 6);
  assert.ok(worst <= 0.05, `largest step ${worst}`);
  assert.deepEqual(rgbOf(e, 6, 1, 5), [0, 0, 255]);
});

test('a held segment sits on top of a held fixture, and comes back to it when released', () => {
  const e = onWhite();
  e.apply({ type: 'manual', target: { fixture: 'bar1' }, colour: '#00ff00', intensity: 1 }, 1);
  e.apply({ type: 'manual', target: { fixture: 'bar1', segment: 0 }, colour: '#ff0000', intensity: 1 }, 1);
  for (let t = 1; t < 2; t += 0.025) e.frame(t);
  assert.deepEqual(rgbOf(e, 2, 0, 0), [255, 0, 0]);
  assert.deepEqual(rgbOf(e, 2, 0, 1), [0, 255, 0]);
  assert.deepEqual(e.liveState(2, 'ok').held, [
    { fixture: 'bar1', segment: null, colour: '#00ff00', level: 1 },
    { fixture: 'bar1', segment: 0, colour: '#ff0000', level: 1 },
  ]);
  assert.deepEqual(e.liveState(2, 'ok').fixturesManual, ['bar1']);

  e.apply({ type: 'release', target: { fixture: 'bar1', segment: 0 } }, 2);
  const { worst } = beyondOwnMotion(e, 2, 3.5);
  assert.ok(worst <= 0.05, `largest step ${worst}`);
  assert.deepEqual(rgbOf(e, 3.5, 0, 0), [0, 255, 0]);
});

test('Release all, Basic lights and Blackout let go of held segments too', () => {
  for (const cmd of [{ type: 'releaseAll' }, { type: 'safe' }, { type: 'blackout' }, { type: 'backToLook' }] as const) {
    const e = onWhite();
    e.apply({ type: 'manual', target: { fixture: 'bar1', segment: 3 }, colour: '#ff0000' }, 1);
    e.apply({ type: 'manual', target: { fixture: 'bar2' }, intensity: 0.2 }, 1);
    e.frame(1.5);
    assert.equal(e.liveState(1.5, 'ok').held.length, 2);
    assert.equal(e.apply(cmd, 1.5), null);
    assert.deepEqual(e.liveState(1.5, 'ok').held, [], cmd.type);
    const { worst } = beyondOwnMotion(e, 1.5, 3);
    assert.ok(worst <= 0.05, `${cmd.type}: largest step ${worst}`);
  }
});

test('a segment that the fixture does not have is refused, as is a smoke machine', () => {
  const e = onWhite();
  assert.match(e.apply({ type: 'manual', target: { fixture: 'bar1', segment: 8 }, colour: '#ff0000' }, 1)!, /segment 9/);
  assert.match(e.apply({ type: 'manual', target: { fixture: 'nope', segment: 0 }, colour: '#ff0000' }, 1)!, /unknown fixture/);
  assert.match(e.apply({ type: 'release', target: { fixture: 'bar1', segment: 8 } }, 1)!, /segment 9/);
  assert.equal(e.apply({ type: 'release', target: { fixture: 'bar1', segment: 1 } }, 1), null, 'releasing one that is not held is harmless');

  const show = barsShow();
  show.groups[0]!.kind = 'smoke';
  const smoke = new Engine(show, 0);
  assert.match(smoke.apply({ type: 'manual', target: { fixture: 'bar1', segment: 0 }, intensity: 1 }, 0)!, /smoke/);
});

test('a held light can carry White, Amber and UV, and the live state shows its colour as the page draws it', () => {
  const e = onWhite();
  e.apply({ type: 'manual', target: { fixture: 'bar1' }, colour: '#000000', white: 1, intensity: 0.8 }, 1);
  for (let t = 1; t < 2; t += 0.025) e.frame(t);
  // Bar 10 segments are RGBW: the white channel carries it.
  const u = e.frame(2).universes.get(1)!;
  assert.equal(u[0 + 7 + 3], 255, 'segment 1 white at the dimmer level');
  assert.equal(u[0 + 7], 0, 'segment 1 red off');
  assert.deepEqual(e.liveState(2, 'ok').held, [{ fixture: 'bar1', segment: null, colour: '#ffffff', level: 0.8 }]);
});

test('a group under manual control is not in the held lights list', () => {
  const e = onWhite();
  e.apply({ type: 'manual', target: { group: 'bars' }, colour: '#ff0000' }, 1);
  const s = e.liveState(1, 'ok');
  assert.equal(s.groups.bars!.manual, true);
  assert.deepEqual(s.held, []);
});
