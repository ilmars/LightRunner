import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourList, commandFor, lightGroups, nextItemId, stageIndexOf, type DeviceLayout, type DeviceState } from '../src/index.ts';

const layout: DeviceLayout = {
  basicLights: 'basic',
  runningOrder: [{ id: 'basic' }, { id: 'one' }, { id: 'two' }, { id: 'three' }],
  groups: [
    { id: 'front', kind: 'light', presets: [{ id: 'f-warm' }, { id: 'f-pulse', effect: {} }, { id: 'f-blue' }] },
    { id: 'haze', kind: 'smoke', presets: [] },
    { id: 'back', kind: 'light', presets: [{ id: 'b-red' }] },
  ],
};
const at = (look: string | null, lastLook: string | null = null, master = 1): DeviceState => ({ look, lastLook, master });
const cmd = (a: Parameters<typeof commandFor>[0], s = at(null)) => commandFor(a, layout, s);

test('Next on a fresh stage starts the first song, not Basic lights', () => {
  assert.equal(nextItemId(layout, at(null)), 'one');
});

test('Next goes to the item after the one on stage', () => {
  assert.equal(nextItemId(layout, at('one', 'one')), 'two');
  assert.equal(nextItemId(layout, at('two', 'two')), 'three');
});

test('Basic lights on stage counts as the first item', () => {
  assert.equal(nextItemId(layout, at('safe')), 'one');
  assert.equal(nextItemId(layout, at('safe', 'two')), 'one');
});

test('after Blackout, Next carries on from the last look', () => {
  assert.equal(nextItemId(layout, at('blackout', 'two')), 'three');
  assert.equal(nextItemId(layout, at(null, 'one')), 'two');
});

test('a look outside the running order falls back to the last look', () => {
  assert.equal(nextItemId(layout, at('quick-thing', 'one')), 'two');
});

test('a last look that is not in the order starts the first song', () => {
  assert.equal(nextItemId(layout, at('blackout', 'gone')), 'one');
});

test('Next at the end of the list is null', () => {
  assert.equal(nextItemId(layout, at('three', 'three')), null);
  assert.equal(nextItemId(layout, at('blackout', 'three')), null);
});

test('Next with an empty running order is null', () => {
  assert.equal(nextItemId({ runningOrder: [], basicLights: null }, at(null)), null);
});

test('stageIndexOf finds the item on stage', () => {
  assert.equal(stageIndexOf(layout, at('two')), 2);
  assert.equal(stageIndexOf(layout, at('safe')), 0);
  assert.equal(stageIndexOf(layout, at('blackout')), -1);
  assert.equal(stageIndexOf(layout, at(null)), -1);
});

test('light groups leave smoke out, and colours leave effects out', () => {
  assert.deepEqual(lightGroups(layout).map((g) => g.id), ['front', 'back']);
  assert.deepEqual(colourList(layout.groups![0]!).map((p) => p.id), ['f-warm', 'f-blue']);
});

test('item N starts that item: Basic lights as safe, the rest as looks', () => {
  assert.deepEqual(cmd({ kind: 'item', n: 1 }), { type: 'safe' });
  assert.deepEqual(cmd({ kind: 'item', n: 3 }), { type: 'look', id: 'two' });
});

test('next starts the next item, and refuses at the end', () => {
  assert.deepEqual(cmd({ kind: 'next' }, at('one', 'one')), { type: 'look', id: 'two' });
  assert.deepEqual(cmd({ kind: 'next' }, at('safe')), { type: 'look', id: 'one' });
  assert.deepEqual(cmd({ kind: 'next' }, at('three', 'three')), { error: 'End of the list.' });
});

test('the plain buttons send their command', () => {
  assert.deepEqual(cmd({ kind: 'backToLook' }), { type: 'backToLook' });
  assert.deepEqual(cmd({ kind: 'undo' }), { type: 'undo' });
  assert.deepEqual(cmd({ kind: 'basic' }), { type: 'safe' });
  assert.deepEqual(cmd({ kind: 'blackout' }), { type: 'blackout' });
  // The iPad's Blackout does not toggle, so neither does a device's.
  assert.deepEqual(cmd({ kind: 'blackout' }, at('blackout', 'one')), { type: 'blackout' });
});

test('group N is the Nth light group, and its level is clamped', () => {
  assert.deepEqual(cmd({ kind: 'groupLevel', group: 1, value: 0.4 }), { type: 'groupLevel', group: 'front', value: 0.4 });
  assert.deepEqual(cmd({ kind: 'groupLevel', group: 2, value: 1.5 }), { type: 'groupLevel', group: 'back', value: 1 });
  assert.deepEqual(cmd({ kind: 'groupLevel', group: 2, value: -1 }), { type: 'groupLevel', group: 'back', value: 0 });
});

test('colour K is the Kth colour of the group, effects not counted', () => {
  assert.deepEqual(cmd({ kind: 'groupColour', group: 1, colour: 2 }), { type: 'groupPreset', group: 'front', preset: 'f-blue' });
  assert.deepEqual(cmd({ kind: 'groupColour', group: 2, colour: 1 }), { type: 'groupPreset', group: 'back', preset: 'b-red' });
});

test('flash takes one group, or all the light groups', () => {
  assert.deepEqual(cmd({ kind: 'flash', group: 2, on: true }), { type: 'flash', groups: ['back'], on: true });
  assert.deepEqual(cmd({ kind: 'flash', group: 'all', on: false }), { type: 'flash', groups: ['front', 'back'], on: false });
});

test('master sets and steps, between 0 and 1', () => {
  assert.deepEqual(cmd({ kind: 'master', value: 0.8 }), { type: 'master', value: 0.8 });
  assert.deepEqual(cmd({ kind: 'master', value: 3 }), { type: 'master', value: 1 });
  assert.deepEqual(cmd({ kind: 'masterStep', by: -0.1 }, at('one', 'one', 0.5)), { type: 'master', value: 0.4 });
  assert.deepEqual(cmd({ kind: 'masterStep', by: 0.1 }, at('one', 'one', 0.95)), { type: 'master', value: 1 });
  assert.deepEqual(cmd({ kind: 'masterStep', by: -0.1 }, at('one', 'one', 0.05)), { type: 'master', value: 0 });
});

test('a position that is not there is refused in plain words', () => {
  assert.deepEqual(cmd({ kind: 'item', n: 17 }), { error: 'There is no song 17.' });
  assert.deepEqual(cmd({ kind: 'item', n: 0 }), { error: 'There is no song 0.' });
  assert.deepEqual(cmd({ kind: 'groupLevel', group: 7, value: 0.5 }), { error: 'There is no group 7.' });
  assert.deepEqual(cmd({ kind: 'groupLevel', group: 3, value: 0.5 }), { error: 'There is no group 3.' }, 'smoke is not counted');
  assert.deepEqual(cmd({ kind: 'groupColour', group: 0, colour: 1 }), { error: 'There is no group 0.' });
  assert.deepEqual(cmd({ kind: 'groupColour', group: 2, colour: 9 }), { error: 'Group 2 has no colour 9.' });
  assert.deepEqual(cmd({ kind: 'groupColour', group: 1, colour: 3 }), { error: 'Group 1 has no colour 3.' }, 'an effect is not a colour');
  assert.deepEqual(cmd({ kind: 'flash', group: 5, on: true }), { error: 'There is no group 5.' });
});
