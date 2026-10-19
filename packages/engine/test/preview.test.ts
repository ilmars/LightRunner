import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureRunningOrder } from '../../shared/src/index.ts';
import { Engine, settledVisual } from '../src/index.ts';
import { demoShow } from './helpers.ts';

test('settledVisual shows a look settled, without touching any stage', () => {
  const show = demoShow();
  const ids = new Engine(show, 0).fixtureIds();
  const visual = settledVisual(show, 'prayer');
  assert.equal(visual.length, ids.length * 3);
  const audience = show.groups.find((g) => g.id === 'audience')!.fixtures;
  assert.ok(audience.length > 0);
  for (const id of audience) {
    const k = ids.indexOf(id) * 3;
    const [r, g, b] = [visual[k], visual[k + 1], visual[k + 2]];
    assert.ok(b > r && b > g, `${id} is blue, got ${r},${g},${b}`);
  }
  assert.notDeepEqual([...settledVisual(show, 'walk-in')], [...visual]);
});

test('settledVisual of Basic lights is the safe light', () => {
  const show = ensureRunningOrder(demoShow());
  const visual = settledVisual(show, show.operator.safeLook!);
  assert.ok(visual.length > 0);
  for (let k = 0; k < visual.length; k += 3) {
    assert.ok(visual[k] + visual[k + 1] + visual[k + 2] > 0, `fixture ${k / 3} is lit`);
    assert.ok(visual[k] >= visual[k + 2], `fixture ${k / 3} is warm`);
  }
});
