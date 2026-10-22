// What the command schema lets through for manual control: a bad target is refused, never widened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '../src/index.ts';

const ok = (cmd: unknown) => Command.safeParse(cmd).success;

test('a malformed segment is refused, for manual and release, never widened to the whole light', () => {
  for (const segment of ['2', -1, 600, 1.5]) {
    const target = { fixture: 'b3', segment };
    assert.equal(ok({ type: 'manual', target, colour: '#ff0000' }), false, `manual segment ${JSON.stringify(segment)}`);
    assert.equal(ok({ type: 'release', target }), false, `release segment ${JSON.stringify(segment)}`);
    assert.equal(ok({ type: 'manual', targets: [{ fixture: 'b4' }, target], intensity: 1 }), false, `in a list: ${JSON.stringify(segment)}`);
    assert.equal(ok({ type: 'release', targets: [target] }), false, `release list ${JSON.stringify(segment)}`);
  }
  // Nor is anything else a target doesn't have.
  assert.equal(ok({ type: 'release', target: { fixture: 'b3', segmnet: 2 } }), false);
  assert.equal(ok({ type: 'release', target: { group: 'background', fixture: 'b3' } }), false);
});

test('the good forms keep what they say', () => {
  const parse = (cmd: unknown) => Command.parse(cmd) as Extract<Command, { type: 'manual' | 'release' }>;
  assert.deepEqual(parse({ type: 'manual', target: { fixture: 'b3', segment: 2 }, intensity: 1 }).target, { fixture: 'b3', segment: 2 });
  assert.deepEqual(parse({ type: 'manual', target: { fixture: 'b3' }, intensity: 1 }).target, { fixture: 'b3' });
  assert.deepEqual(parse({ type: 'release', target: { group: 'background' } }).target, { group: 'background' });
  assert.deepEqual(parse({ type: 'release', target: { fixture: 'b3', segment: 0 } }).target, { fixture: 'b3', segment: 0 });
  assert.deepEqual(parse({ type: 'release', targets: [{ fixture: 'b3' }, { fixture: 'b4', segment: 7 }], releaseSegments: true }).targets,
    [{ fixture: 'b3' }, { fixture: 'b4', segment: 7 }]);
});

test('manual and release take one target or a list of up to 512, never both or neither', () => {
  const many = (n: number) => Array.from({ length: n }, (_, k) => ({ fixture: 'b3', segment: k % 8 }));
  assert.equal(ok({ type: 'manual', targets: many(512), intensity: 0.5 }), true);
  assert.equal(ok({ type: 'manual', targets: many(513), intensity: 0.5 }), false);
  assert.equal(ok({ type: 'manual', targets: [], intensity: 0.5 }), false);
  assert.equal(ok({ type: 'manual', intensity: 0.5 }), false);
  assert.equal(ok({ type: 'manual', target: { fixture: 'b3' }, targets: [{ fixture: 'b4' }], intensity: 0.5 }), false);
  assert.equal(ok({ type: 'release' }), false);
  assert.equal(ok({ type: 'release', targets: many(513) }), false);
  assert.equal(ok({ type: 'release', target: { fixture: 'b3' }, targets: [{ fixture: 'b4' }] }), false);
  // A Prepare draft wraps stage commands; the list form is no stage command it could get round the check with.
  assert.equal(ok({ type: 'draft', cmd: { type: 'manual', targets: [{ fixture: 'b3' }] } }), true);
});

test('White, Amber and UV go with a colour: on their own they are refused', () => {
  assert.equal(ok({ type: 'manual', target: { fixture: 'b3' }, colour: '#000000', white: 1 }), true);
  for (const extra of ['white', 'amber', 'uv']) {
    assert.equal(ok({ type: 'manual', target: { fixture: 'b3' }, [extra]: 0.5 }), false, extra);
    assert.equal(ok({ type: 'manual', target: { fixture: 'b3' }, intensity: 1, [extra]: 0.5 }), false, `${extra} with a level`);
  }
});
