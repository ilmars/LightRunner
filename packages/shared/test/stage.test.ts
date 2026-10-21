import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureShape, parseShow, type Show } from '../src/index.ts';

const rig = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));
const fixture = (show: Show, id: string) => show.fixtures.find((f) => f.id === id)!;

test('a fixture without a stored shape is drawn as before: a bar when it has a size, else a dot', () => {
  const show = rig();
  assert.equal(fixtureShape(show, fixture(show, 'p1')), 'dot');
  assert.equal(fixtureShape(show, fixture(show, 'b3')), 'bar');
  assert.equal(fixtureShape(show, fixture(show, 'l1')), 'bar', 'a strip with only a width is a bar');
});

test('a fixture in a smoke group is a cloud unless it was given another shape', () => {
  const show = rig();
  show.groups.push({ id: 'haze', name: 'Haze', kind: 'smoke', fixtures: ['p4'] });
  assert.equal(fixtureShape(show, fixture(show, 'p4')), 'smoke');
  fixture(show, 'p4').shape = 'beam';
  assert.equal(fixtureShape(show, fixture(show, 'p4')), 'beam');
});

test('a stored shape wins, and the new fields pass the schema', () => {
  const show = rig();
  Object.assign(fixture(show, 'l1'), { shape: 'outline', w: 0.1, h: 0.2 });
  Object.assign(fixture(show, 'p1'), { shape: 'beam', angle: -90, reach: 0.15 });
  Object.assign(fixture(show, 'b8'), { shape: 'bar', angle: 30 });
  const again = parseShow(JSON.parse(JSON.stringify(show)));
  assert.equal(fixtureShape(again, fixture(again, 'l1')), 'outline');
  assert.deepEqual([fixture(again, 'p1').angle, fixture(again, 'p1').reach], [-90, 0.15]);
  assert.throws(() => parseShow({ ...JSON.parse(JSON.stringify(show)), fixtures: [{ ...fixture(show, 'p1'), shape: 'star' }] }));
});
