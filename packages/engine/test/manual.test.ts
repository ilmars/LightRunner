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

test('one manual command can hold many lights and segments at once: all in the same frame, one reply', () => {
  const e = onWhite();
  const targets = [{ fixture: 'bar1' }, { fixture: 'bar2', segment: 3 }, { fixture: 'bar2', segment: 4 }];
  assert.equal(e.apply({ type: 'manual', targets, colour: '#ff0000', intensity: 0.5 }, 1), null);
  assert.deepEqual(e.liveState(1, 'ok').held.map((h) => [h.fixture, h.segment]), [['bar1', null], ['bar2', 3], ['bar2', 4]]);
  // They take over together: every one of them is at the same point of its fade, frame after frame.
  for (let t = 1; t < 1.3; t += 0.025) {
    const v = rgbOf(e, t, 0, 0);
    const frame = e.frame(t).visual;
    for (const s of [3, 4]) assert.deepEqual(Array.from(frame.subarray((8 + s) * 3, (8 + s) * 3 + 3)), v, `t ${t}`);
  }
  assert.equal(e.apply({ type: 'release', targets }, 2), null);
  assert.deepEqual(e.liveState(2, 'ok').held, []);
});

test('a manual command with one bad target is refused whole: nothing is held', () => {
  for (const bad of [{ fixture: 'bar1', segment: 8 }, { fixture: 'nope' }, { group: 'nope' }]) {
    const e = onWhite();
    const error = e.apply({ type: 'manual', targets: [{ fixture: 'bar2' }, { fixture: 'bar1', segment: 0 }, bad], colour: '#ff0000' }, 1);
    assert.ok(error, JSON.stringify(bad));
    assert.deepEqual(e.liveState(1, 'ok').held, [], JSON.stringify(bad));
    e.apply({ type: 'manual', target: { fixture: 'bar2' }, colour: '#00ff00' }, 1);
    assert.ok(e.apply({ type: 'release', targets: [{ fixture: 'bar2' }, bad] }, 1), `release ${JSON.stringify(bad)}`);
    assert.equal(e.liveState(1, 'ok').held.length, 1, 'a refused release lets go of nothing');
  }
  const show = barsShow();
  show.fixtures.push({ id: 'hazer', name: 'Hazer', profile: BAR10, universe: 2, address: 1, x: 0.5, y: 0.5 });
  show.groups.push({ id: 'haze', name: 'Haze', kind: 'smoke', fixtures: ['hazer'] });
  const smoke = new Engine(show, 0);
  assert.match(smoke.apply({ type: 'manual', targets: [{ fixture: 'bar1' }, { fixture: 'hazer' }], intensity: 1 }, 0)!, /smoke/);
  assert.deepEqual(smoke.liveState(0, 'ok').held, []);
});

test('releaseSegments: a new colour for a whole light lets go of its held segments in the same change', () => {
  const e = onWhite();
  e.apply({ type: 'manual', targets: [{ fixture: 'bar1', segment: 1 }, { fixture: 'bar1', segment: 2 }], colour: '#00ff00', intensity: 1 }, 1);
  e.apply({ type: 'manual', target: { fixture: 'bar2', segment: 0 }, colour: '#00ff00', intensity: 1 }, 1);
  for (let t = 1; t < 2; t += 0.025) e.frame(t);
  assert.equal(e.apply({ type: 'manual', targets: [{ fixture: 'bar1' }], colour: '#ff0000', intensity: 1, releaseSegments: true }, 2), null);
  // The segments of bar1 go (they fade to its new red); the one of bar2, not named, stays.
  assert.deepEqual(e.liveState(2, 'ok').held.map((h) => [h.fixture, h.segment]), [['bar1', null], ['bar2', 0]]);
  for (let t = 2; t < 3.5; t += 0.025) e.frame(t);
  assert.deepEqual(rgbOf(e, 3.5, 0, 1), [255, 0, 0]);
  assert.deepEqual(rgbOf(e, 3.5, 1, 0), [0, 255, 0]);
  // Release with releaseSegments lets go of the light and its segments.
  e.apply({ type: 'manual', target: { fixture: 'bar1', segment: 5 }, colour: '#0000ff' }, 3.5);
  assert.equal(e.apply({ type: 'release', targets: [{ fixture: 'bar1' }], releaseSegments: true }, 3.5), null);
  assert.deepEqual(e.liveState(3.5, 'ok').held.map((h) => [h.fixture, h.segment]), [['bar2', 0]]);
  const { worst } = beyondOwnMotion(e, 3.5, 5);
  assert.ok(worst <= 0.05, `largest step ${worst}`);
});

test('a group under manual control tells its colour and level, so the page can show what its lights show', () => {
  const e = onWhite();
  assert.equal(e.liveState(1, 'ok').groups.bars!.hold, null);
  e.apply({ type: 'manual', target: { group: 'bars' }, colour: '#ff0000', intensity: 0.4 }, 1);
  assert.deepEqual(e.liveState(1, 'ok').groups.bars!.hold, { colour: '#ff0000', level: 0.4 });
  e.apply({ type: 'release', target: { group: 'bars' } }, 1);
  assert.equal(e.liveState(1, 'ok').groups.bars!.hold, null);
});

/**
 * A reversed bar shared by two groups (bar2 is in "bars" and in "end"), with one of its segments held while
 * everything else moves underneath: a group change, the bar handed over to the other group, a hold of the whole
 * bar taken and released, and Master below full while it is taken and released.
 */
test('a held segment of a shared, reversed bar holds while its groups, its owner, its light and Master move under it', () => {
  const show = barsShow();
  show.groups.push({ id: 'end', name: 'End', kind: 'light', fixtures: ['bar2'] });
  show.presets.push({ id: 'end-green', name: 'Green', group: 'end', layers: [{ kind: 'static', colour: { hex: '#00ff00' }, intensity: 1 }], fade: 2 });
  const e = new Engine(parseShow(show), 0);
  e.apply({ type: 'groupPreset', group: 'bars', preset: 'white', fade: 0 }, 0);
  e.frame(0);
  e.frame(1);
  e.apply({ type: 'manual', target: { fixture: 'bar2', segment: 6 }, colour: '#ff0000', intensity: 0.8 }, 1);
  for (let t = 1; t < 1.5; t += 0.025) e.frame(t);

  // Judged as the jump check judges: a take follows the finger for 0.2 s, so its first 0.25 s aren't judged.
  let worst = -Infinity;
  const judge = (from: number, to: number) => { worst = Math.max(worst, beyondOwnMotion(e, from, to).worst); };
  const heldIsRed = (t: number) => {
    const [r, g, b] = rgbOf(e, t, 1, 6);
    assert.ok(r! > 0 && g === 0 && b === 0, `segment 7 at ${t}: ${[r, g, b]}`);
  };
  e.apply({ type: 'groupPreset', group: 'bars', preset: 'blue' }, 1.5);
  judge(1.5, 4);
  heldIsRed(4);
  e.apply({ type: 'groupPreset', group: 'end', preset: 'end-green' }, 4);
  judge(4, 6.5);
  heldIsRed(6.5);
  assert.deepEqual(rgbOf(e, 6.5, 1, 5), [0, 255, 0], 'the rest of bar2 went to its new owner');
  e.apply({ type: 'master', value: 0.5 }, 6.5);
  e.apply({ type: 'manual', target: { fixture: 'bar2' }, colour: '#0000ff', intensity: 1 }, 7);
  for (let t = 6.5; t < 7.25; t += 0.025) e.frame(t);
  judge(7.25, 8);
  heldIsRed(8);
  e.apply({ type: 'master', value: 0.7 }, 8);
  e.apply({ type: 'release', target: { fixture: 'bar2' } }, 8);
  judge(8, 10);
  heldIsRed(10);
  assert.deepEqual(rgbOf(e, 10, 1, 5), [0, Math.round(0.7 * 255), 0], 'back to its owner, at Master');
  // Let go at last, it fades back to the owning group's green.
  e.apply({ type: 'release', target: { fixture: 'bar2', segment: 6 } }, 10);
  judge(10, 11.5);
  assert.deepEqual(rgbOf(e, 11.5, 1, 6), [0, Math.round(0.7 * 255), 0]);
  assert.ok(worst <= 0.05, `largest step ${worst}`);
});

test('a level for a whole light that is not held keeps its colour: it starts from the light under its held segments', () => {
  const e = onWhite();
  e.apply({ type: 'manual', target: { fixture: 'bar1', segment: 0 }, colour: '#ff0000', intensity: 1 }, 1);
  for (let t = 1; t < 2; t += 0.025) e.frame(t);
  // Level 50 % on the whole bar (its held segment too, as the page sends it): no colour, only a level.
  assert.equal(e.apply({ type: 'manual', targets: [{ fixture: 'bar1' }, { fixture: 'bar1', segment: 0 }], intensity: 0.5 }, 2), null);
  for (let t = 2; t < 3; t += 0.025) e.frame(t);
  const [r, g, b] = rgbOf(e, 3, 0, 0);
  assert.ok(Math.abs(r! - 128) <= 1 && g === 0 && b === 0, `segment 1 stays red, at half: ${[r, g, b]}`);
  for (let c = 1; c < 8; c++) {
    const [x, y, z] = rgbOf(e, 3, 0, c);
    assert.ok(x === y && y === z && Math.abs(x! - 128) <= 1, `segment ${c + 1} stays white, at half: ${[x, y, z]}`);
  }
  assert.deepEqual(e.liveState(3, 'ok').held.find((h) => h.segment === null), { fixture: 'bar1', segment: null, colour: '#ffffff', level: 0.5 });
});
