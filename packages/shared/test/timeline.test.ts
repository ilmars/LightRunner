import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changesBetween, followAt, mergeClock, parseShow, stateAt, type Show, type Timeline, type TimelineBlock } from '../src/index.ts';

const rigJson = () => JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8'));
const rig = (): Show => parseShow(rigJson());

let n = 0;
const block = (start: number, what: TimelineBlock['what'], extra: Partial<TimelineBlock> = {}): TimelineBlock => ({ id: `b${++n}`, start, rise: 0, what, ...extra });
const timeline = (layers: Timeline['layers'], extra: Partial<Timeline> = {}): Timeline => ({ id: 'service', name: 'Service', layers, markers: [], offsetMs: 0, ...extra });

test('a show without timelines reads as having none, and one with a full timeline is kept', () => {
  const raw = rigJson();
  delete raw.timelines;
  assert.deepEqual(parseShow(raw).timelines, []);
  const full = {
    id: 'sunday', name: 'Sunday',
    recording: { id: 'rec1', name: 'Sermon.mp3', duration: 2400, loudness: 'AAEC', peaks: 'AAEC' },
    layers: [
      { group: 'stage', blocks: [{ id: 'a', start: 0, rise: 0, what: { kind: 'dark' } }, { id: 'b', start: 210, end: 230.5, rise: 5, what: { kind: 'look', look: 'worship' } }] },
      { group: 'front-lights', blocks: [
        { id: 'c', start: 45, rise: 20, what: { kind: 'colour', preset: 'front-lights-silti-3200k', level: 0.8 } },
        { id: 'd', start: 90, rise: 2, what: { kind: 'effect', preset: 'front-lights-silti-3200k', speed: { seconds: 8 } } },
        { id: 'e', start: 100, rise: 0, what: { kind: 'follow', low: 0.2, high: 1 } },
        { id: 'f', start: 120, rise: 0, what: { kind: 'level', level: 0.5 } },
        { id: 'g', start: 130, rise: 0, what: { kind: 'full' } },
      ] },
    ],
    markers: [{ t: 12, text: 'Welcome' }],
    offsetMs: -120,
  };
  const show = parseShow({ ...rigJson(), timelines: [full] });
  assert.deepEqual(show.timelines[0], full);
  // Defaults: no offset means 0, no rise means 0.
  const small = parseShow({ ...rigJson(), timelines: [{ id: 't', name: 'T', layers: [{ group: 'stage', blocks: [{ id: 'x', start: 0, what: { kind: 'dark' } }] }], markers: [] }] });
  assert.equal(small.timelines[0]!.offsetMs, 0);
  assert.equal(small.timelines[0]!.layers[0]!.blocks[0]!.rise, 0);
  // Wrong values are refused.
  const bad = (t: object) => assert.throws(() => parseShow({ ...rigJson(), timelines: [{ ...full, ...t }] }));
  bad({ offsetMs: 900 });
  bad({ layers: [{ group: 'stage', blocks: [{ id: 'a', start: 0, rise: 700, what: { kind: 'dark' } }] }] });
  bad({ layers: [{ group: 'stage', blocks: [{ id: 'a', start: 0, rise: 0, what: { kind: 'colour', preset: 'x', level: 2 } }] }] });
  bad({ layers: [{ group: 'stage', blocks: [{ id: 'a', start: 0, rise: 0, what: { kind: 'spin' } }] }] });
});

test('a timeline pointing at things that are gone still loads (the runner skips them)', () => {
  const show = parseShow({ ...rigJson(), timelines: [{ id: 't', name: 'T', markers: [], offsetMs: 0, layers: [
    { group: 'gone-group', blocks: [{ id: 'a', start: 0, rise: 0, what: { kind: 'colour', preset: 'gone', level: 1 } }] },
    { group: 'stage', blocks: [{ id: 'b', start: 0, rise: 0, what: { kind: 'look', look: 'gone-look' } }] },
  ] }] });
  assert.equal(show.timelines.length, 1);
});

const FRONT = 'front-lights';
const warm = 'front-lights-silti-3200k';
const cold = 'front-lights-neitrali-5600k';

test('stateAt: stage Dark at 0, a front-lights colour at 45 (rise 20), stage full at 210', () => {
  const show = rig();
  const tl = timeline([
    { group: 'stage', blocks: [block(0, { kind: 'dark' }), block(210, { kind: 'full' }, { rise: 3 })] },
    { group: FRONT, blocks: [block(45, { kind: 'colour', preset: warm, level: 0.7 }, { rise: 20 })] },
  ]);
  const lights = show.groups.filter((g) => g.kind !== 'smoke').map((g) => g.id);

  const at10 = stateAt(tl, show, 10);
  assert.deepEqual([...at10.keys()].sort(), [...lights].sort());
  for (const g of lights) {
    assert.equal(at10.get(g)!.level, 0, g);
    assert.equal(at10.get(g)!.preset, undefined, 'Dark keeps the colour');
    assert.equal(at10.get(g)!.started, 0);
  }

  const at50 = stateAt(tl, show, 50);
  assert.deepEqual(at50.get(FRONT), { block: tl.layers[1]!.blocks[0]!.id, preset: warm, level: 0.7, rise: 20, started: 45 });
  assert.equal(at50.get('key-lights')!.level, 0, 'the other groups stay dark');

  const at220 = stateAt(tl, show, 220);
  for (const g of lights) {
    assert.equal(at220.get(g)!.level, 1, g);
    assert.equal(at220.get(g)!.preset, undefined, 'full keeps the colour');
    assert.equal(at220.get(g)!.rise, 3);
    assert.equal(at220.get(g)!.started, 210);
  }
  // Nothing before the first block.
  assert.equal(stateAt(tl, show, -1).size, 0);
  // Same answer asked again, in any order: it is a function of the time.
  assert.deepEqual(stateAt(tl, show, 50), at50);
});

test('stateAt: the most recently started block wins; at the same start the group beats the stage', () => {
  const show = rig();
  const tl = timeline([
    { group: 'stage', blocks: [block(0, { kind: 'dark' }), block(100, { kind: 'dark' })] },
    { group: FRONT, blocks: [block(60, { kind: 'level', level: 0.5 }), block(100, { kind: 'colour', preset: cold, level: 1 })] },
  ]);
  // 80: the group's block (60) is newer than the stage's (0).
  assert.equal(stateAt(tl, show, 80).get(FRONT)!.level, 0.5);
  // 100: both start at 100, the group's own layer wins.
  assert.equal(stateAt(tl, show, 100).get(FRONT)!.preset, cold);
  assert.equal(stateAt(tl, show, 100).get('key-lights')!.level, 0);
  // A stage block after the group's own block takes the group back.
  const later = timeline([
    { group: FRONT, blocks: [block(60, { kind: 'level', level: 0.5 })] },
    { group: 'stage', blocks: [block(90, { kind: 'dark' })] },
  ]);
  assert.equal(stateAt(later, show, 95).get(FRONT)!.level, 0);
});

test('stateAt: a stage look gives each group its preset and level; groups not in it are untouched', () => {
  const show = rig();
  const worship = show.looks.find((l) => l.id === 'worship')!;
  const tl = timeline([{ group: 'stage', blocks: [block(5, { kind: 'look', look: 'worship' }, { rise: 4 })] }]);
  const s = stateAt(tl, show, 6);
  for (const e of worship.groups) {
    assert.equal(s.get(e.group)!.preset, e.preset, e.group);
    assert.equal(s.get(e.group)!.level, e.level ?? 1, e.group);
    assert.equal(s.get(e.group)!.rise, 4);
  }
  const notIn = show.groups.filter((g) => g.kind !== 'smoke' && !worship.groups.some((e) => e.group === g.id));
  for (const g of notIn) assert.equal(s.has(g.id), false, g.id);
});

test('stateAt: a smoke group never gets a target', () => {
  const show = rig();
  show.groups.find((g) => g.id === 'background')!.kind = 'smoke';
  const tl = timeline([{ group: 'stage', blocks: [block(0, { kind: 'full' })] }, { group: 'background', blocks: [block(0, { kind: 'level', level: 1 })] }]);
  const s = stateAt(tl, show, 1);
  assert.equal(s.has('background'), false);
  assert.equal(s.get(FRONT)!.level, 1);
});

test('stateAt: a block with an end hands the group back to the one before, else to nothing', () => {
  const show = rig();
  const tl = timeline([{ group: FRONT, blocks: [
    block(10, { kind: 'colour', preset: warm, level: 1 }),
    block(30, { kind: 'colour', preset: cold, level: 1 }, { end: 40, rise: 2 }),
    block(100, { kind: 'level', level: 0.2 }, { end: 110 }),
  ] }]);
  const id = (i: number) => tl.layers[0]!.blocks[i]!.id;
  assert.equal(stateAt(tl, show, 35).get(FRONT)!.preset, cold);
  // Past the end of the cold block: back to the warm one (it has no end of its own).
  const back = stateAt(tl, show, 45).get(FRONT)!;
  assert.equal(back.block, id(0));
  assert.equal(back.preset, warm);
  assert.equal(back.started, 10);
  // The block ends exactly at 40: at 40 it has passed.
  assert.equal(stateAt(tl, show, 40).get(FRONT)!.block, id(0));
  // The last block ends too: back to the warm one again, not to nothing.
  assert.equal(stateAt(tl, show, 105).get(FRONT)!.level, 0.2);
  assert.equal(stateAt(tl, show, 120).get(FRONT)!.block, id(0));
  // Nothing before it: no target.
  const alone = timeline([{ group: FRONT, blocks: [block(10, { kind: 'level', level: 0.3 }, { end: 20 })] }]);
  assert.equal(stateAt(alone, show, 15).get(FRONT)!.level, 0.3);
  assert.equal(stateAt(alone, show, 25).has(FRONT), false);
  // An earlier block that has itself ended is not handed back to.
  const both = timeline([{ group: FRONT, blocks: [block(0, { kind: 'level', level: 0.1 }, { end: 20 }), block(10, { kind: 'level', level: 0.9 }, { end: 30 })] }]);
  assert.equal(stateAt(both, show, 25).get(FRONT)!.level, 0.9);
  assert.equal(stateAt(both, show, 35).has(FRONT), false);
  // An ended block on the stage layer hands back to the stage's earlier block; the group's own block is then the newer one.
  const stage = timeline([{ group: 'stage', blocks: [block(0, { kind: 'dark' }), block(50, { kind: 'full' }, { end: 60 })] }, { group: FRONT, blocks: [block(20, { kind: 'level', level: 0.4 })] }]);
  assert.equal(stateAt(stage, show, 55).get(FRONT)!.level, 1);
  assert.equal(stateAt(stage, show, 65).get(FRONT)!.level, 0.4);
  assert.equal(stateAt(stage, show, 65).get('key-lights')!.level, 0);
});

test('stateAt: effects, follow the voice and the block are carried through', () => {
  const show = rig();
  show.presets.push({ id: 'front-lights-wave', name: 'Wave', group: FRONT, fade: 3, layers: [{ kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }], speed: { beats: 4 }, direction: 'ltr', waves: 1, size: 0.5, edge: 'soft', intensity: 1 }] });
  const tl = timeline([{ group: FRONT, blocks: [
    block(0, { kind: 'effect', preset: 'front-lights-wave', speed: { seconds: 6 } }, { rise: 3 }),
    block(20, { kind: 'follow', low: 0.2, high: 0.9 }),
    block(40, { kind: 'follow', low: 0.1, high: 1, preset: warm }, { rise: 1.5 }),
  ] }]);
  assert.deepEqual(stateAt(tl, show, 5).get(FRONT), { block: tl.layers[0]!.blocks[0]!.id, effect: { preset: 'front-lights-wave', speed: { seconds: 6 } }, rise: 3, started: 0 });
  assert.deepEqual(stateAt(tl, show, 25).get(FRONT), { block: tl.layers[0]!.blocks[1]!.id, follow: { low: 0.2, high: 0.9 }, rise: 0, started: 20 });
  assert.deepEqual(stateAt(tl, show, 45).get(FRONT), { block: tl.layers[0]!.blocks[2]!.id, preset: warm, follow: { low: 0.1, high: 1 }, rise: 1.5, started: 40 });
  // An effect with no speed of its own has none here either.
  const plain = timeline([{ group: FRONT, blocks: [block(0, { kind: 'effect', preset: 'front-lights-wave' })] }]);
  assert.equal('speed' in stateAt(plain, show, 1).get(FRONT)!.effect!, false);
});

test('stateAt: a block whose preset, look or group is gone is skipped, as if it were not there', () => {
  const show = rig();
  const tl = timeline([
    { group: 'stage', blocks: [block(0, { kind: 'dark' }), block(50, { kind: 'look', look: 'no-such-look' }), block(70, { kind: 'colour', preset: warm, level: 1 })] },
    { group: FRONT, blocks: [block(10, { kind: 'level', level: 0.5 }), block(30, { kind: 'colour', preset: 'deleted-preset', level: 1 }), block(31, { kind: 'colour', preset: 'drum-cage-sarkans', level: 1 }), block(32, { kind: 'follow', low: 0, high: 1, preset: 'deleted' })] },
    { group: 'gone-group', blocks: [block(0, { kind: 'full' })] },
  ]);
  // The front lights stay on the level block; the missing, the wrong-group and the follow with a missing colour are skipped.
  assert.equal(stateAt(tl, show, 60).get(FRONT)!.level, 0.5);
  assert.equal(stateAt(tl, show, 60).get('key-lights')!.level, 0);
  // Colour blocks on the stage layer don't exist (only look, Dark, Everything full are allowed there).
  assert.equal(stateAt(tl, show, 80).get('key-lights')!.level, 0);
  assert.equal(stateAt(tl, show, 80).has('gone-group'), false);
  // A look that lost its preset is skipped too.
  show.looks.find((l) => l.id === 'worship')!.groups.find((e) => e.group === FRONT)!.preset = 'deleted-preset';
  const lk = timeline([{ group: 'stage', blocks: [block(0, { kind: 'dark' }), block(10, { kind: 'look', look: 'worship' })] }]);
  assert.equal(stateAt(lk, show, 20).get(FRONT)!.level, 0);
  assert.equal(stateAt(lk, show, 20).get('key-lights')!.preset, 'key-lights-silti-balts');
});

test('changesBetween: groups whose block changed, appeared or went', () => {
  const show = rig();
  const tl = timeline([
    { group: 'stage', blocks: [block(0, { kind: 'dark' })] },
    { group: FRONT, blocks: [block(10, { kind: 'level', level: 0.5 }, { end: 20 })] },
  ]);
  const a = stateAt(tl, show, 5), b = stateAt(tl, show, 15), c = stateAt(tl, show, 25);
  assert.deepEqual(changesBetween(a, a), []);
  assert.deepEqual(changesBetween(a, b), [{ group: FRONT, target: b.get(FRONT)! }]);
  // Back to the stage's Dark: a change to the stage block.
  assert.deepEqual(changesBetween(b, c), [{ group: FRONT, target: c.get(FRONT)! }]);
  assert.equal(c.get(FRONT)!.block, tl.layers[0]!.blocks[0]!.id);
  // From nothing: every group is new; to nothing: every group goes.
  const none = new Map();
  assert.equal(changesBetween(none, a).length, a.size);
  assert.deepEqual(changesBetween(a, none).map((x) => x.target), [...a.keys()].map(() => null));
  assert.deepEqual(changesBetween(a, none).map((x) => x.group), [...a.keys()]);
  // A group that has no target any more is reported with null.
  const alone = timeline([{ group: FRONT, blocks: [block(10, { kind: 'level', level: 0.3 }, { end: 20 })] }]);
  assert.deepEqual(changesBetween(stateAt(alone, show, 15), stateAt(alone, show, 25)), [{ group: FRONT, target: null }]);
});

const rec = (bytes: number[]) => ({ id: 'r', name: 'r.mp3', duration: bytes.length / 25, loudness: Buffer.from(bytes).toString('base64'), peaks: '' });

test('followAt: 0 to 1, a straight line between the 25-a-second values, clamped at both ends', () => {
  const r = rec([0, 255, 51, 51]);
  assert.equal(followAt(r, 0), 0);
  assert.equal(followAt(r, 1 / 25), 1);
  assert.ok(Math.abs(followAt(r, 0.5 / 25) - 0.5) < 1e-9);
  assert.ok(Math.abs(followAt(r, 1.5 / 25) - 0.6) < 1e-9);
  assert.ok(Math.abs(followAt(r, 3 / 25) - 0.2) < 1e-9);
  assert.equal(followAt(r, -5), 0);
  assert.ok(Math.abs(followAt(r, 99) - 0.2) < 1e-9, 'after the end it holds the last value');
  assert.equal(followAt(rec([]), 3), 0);
  assert.equal(followAt(rec([]), 0), 0);
});

test('mergeClock: ease a little when close, more when further, jump when far', () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  let m = mergeClock(10, 10);
  assert.deepEqual(m, { pos: 10, jumped: false });
  m = mergeClock(10, 10.05);
  near(m.pos, 10.01);
  assert.equal(m.jumped, false);
  m = mergeClock(10, 9.95);
  near(m.pos, 9.99);
  m = mergeClock(10, 10.2);
  near(m.pos, 10.1);
  assert.equal(m.jumped, false);
  m = mergeClock(10, 9.8);
  near(m.pos, 9.9);
  m = mergeClock(10, 10.31);
  assert.deepEqual(m, { pos: 10.31, jumped: true });
  m = mergeClock(10, 4);
  assert.deepEqual(m, { pos: 4, jumped: true });
  m = mergeClock(10, 30);
  assert.deepEqual(m, { pos: 30, jumped: true });
});
