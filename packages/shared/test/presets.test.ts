import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addColour, checkReferences, groupIsWhiteOnly, parseShow, type Show } from '../src/index.ts';

const rig = (): Show => parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')));
const names = (s: Show, group: string) => s.presets.filter((p) => p.group === group && !p.custom).map((p) => p.name);
const COLOUR_GROUPS = ['key-lights', 'background', 'drum-cage', 'b8-side-bar'];

test('white-only means no fixture with a red, green or blue channel', () => {
  const s = rig();
  assert.equal(groupIsWhiteOnly(s, 'front-lights'), true);
  assert.equal(groupIsWhiteOnly(s, 'key-lights'), false);
  assert.equal(groupIsWhiteOnly(s, 'nope'), true);
});

test('a colour is added to one group as a normal preset', () => {
  const before = rig();
  const { show, ids } = addColour(before, { group: 'key-lights', colour: '#2A4B9C', name: '  Deep blue ', allGroups: false });
  assert.equal(ids.length, 1);
  assert.deepEqual(show.presets.find((p) => p.id === ids[0]), {
    id: ids[0], name: 'Deep blue', group: 'key-lights', fade: 3, swatch: '#2a4b9c',
    layers: [{ kind: 'static', colour: { hex: '#2a4b9c' }, intensity: 1 }],
  });
  assert.equal(show.presets.length, before.presets.length + 1);
  assert.deepEqual(names(show, 'background'), names(before, 'background')); // other groups untouched
  assert.deepEqual(checkReferences(show), []);
  assert.equal(before.presets.some((p) => p.id === ids[0]), false); // the input is not changed
  parseShow(JSON.parse(JSON.stringify(show))); // still a valid show
});

test('an empty name becomes Colour N with the next free number in the group', () => {
  let s = rig();
  const added: string[] = [];
  for (const hex of ['#112233', '#223344', '#334455']) {
    s = addColour(s, { group: 'key-lights', colour: hex, name: '   ', allGroups: false }).show;
    added.push(s.presets.at(-1)!.name);
  }
  assert.deepEqual(added, ['Colour 1', 'Colour 2', 'Colour 3']);
  // A gap in the middle is not refilled: the next number is one past the highest in use.
  s.presets = s.presets.filter((p) => p.name !== 'Colour 2');
  assert.equal(addColour(s, { group: 'key-lights', colour: '#445566', name: '', allGroups: false }).show.presets.at(-1)!.name, 'Colour 4');
  // Numbers are per group.
  assert.equal(addColour(s, { group: 'background', colour: '#445566', name: '', allGroups: false }).show.presets.at(-1)!.name, 'Colour 1');
});

test('a long name is cut to 40 characters', () => {
  const { show } = addColour(rig(), { group: 'key-lights', colour: '#123456', name: 'x'.repeat(60), allGroups: false });
  assert.equal(show.presets.at(-1)!.name, 'x'.repeat(40));
});

test('every colour group gets it, and white-only groups are left out', () => {
  const { show, ids } = addColour(rig(), { group: 'background', colour: '#2a4b9c', name: 'Deep blue', allGroups: true });
  assert.equal(ids.length, COLOUR_GROUPS.length);
  assert.equal(new Set(ids).size, ids.length); // unique ids
  for (const g of COLOUR_GROUPS) assert.ok(names(show, g).includes('Deep blue'), g);
  assert.ok(!names(show, 'front-lights').includes('Deep blue'));
  assert.deepEqual(checkReferences(show), []);
});

test('a white-only group adds to the white-only groups only', () => {
  const { show, ids } = addColour(rig(), { group: 'front-lights', colour: '#ffe0b0', name: '', allGroups: true });
  assert.equal(ids.length, 1);
  assert.ok(names(show, 'front-lights').includes('Colour 1'));
  for (const g of COLOUR_GROUPS) assert.ok(!names(show, g).includes('Colour 1'), g);
});

test('groups the operator page does not show are skipped for every group', () => {
  const s = rig();
  s.operator.groups = s.operator.groups.filter((g) => g !== 'drum-cage');
  const { show } = addColour(s, { group: 'background', colour: '#2a4b9c', name: 'Deep blue', allGroups: true });
  assert.ok(!names(show, 'drum-cage').includes('Deep blue'));
  assert.ok(names(show, 'b8-side-bar').includes('Deep blue'));
});

test('a colour a group already lists is not added again', () => {
  const s = rig();
  // Zils is a palette colour (#0000ff); picking that exact colour on the strip is not new.
  const hex = '#0000FF';
  s.presets = s.presets.filter((p) => p.name !== 'Zils' || p.group === 'key-lights'); // only the key lights keep it
  assert.throws(() => addColour(s, { group: 'key-lights', colour: hex, name: 'Again', allGroups: false }), /already in the list/);
  // With every group, the others still get it and the key lights are skipped.
  const all = addColour(s, { group: 'key-lights', colour: hex, name: 'Again', allGroups: true });
  assert.equal(all.ids.length, COLOUR_GROUPS.length - 1);
  assert.ok(!all.ids.some((id) => all.show.presets.find((p) => p.id === id)!.group === 'key-lights'));
});

test('nothing left to add is an error', () => {
  const once = addColour(rig(), { group: 'background', colour: '#2a4b9c', name: 'Deep blue', allGroups: true }).show;
  assert.throws(() => addColour(once, { group: 'background', colour: '#2a4b9c', name: 'Deep blue', allGroups: true }), /every group already has that colour/);
});

test('bad input is refused', () => {
  assert.throws(() => addColour(rig(), { group: 'nope', colour: '#123456', name: 'a', allGroups: false }), /no group/);
  assert.throws(() => addColour(rig(), { group: 'key-lights', colour: 'blue', name: 'a', allGroups: false }), /not a colour/);
});

test('ids stay unique when the name is already used', () => {
  let s = rig();
  s = addColour(s, { group: 'key-lights', colour: '#111111', name: 'Deep blue', allGroups: false }).show;
  s = addColour(s, { group: 'key-lights', colour: '#222222', name: 'Deep blue', allGroups: false }).show;
  const ids = s.presets.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});
