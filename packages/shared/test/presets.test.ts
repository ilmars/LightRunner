import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addColour, canRecolour, checkReferences, deleteColour, editColour, EffectLayer, ensureRunningOrder, groupIsWhiteOnly, isEffectPreset, isOff, listNames, parseShow, presetUsers,
  type Show, type StaticLayer,
} from '../src/index.ts';

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

test('with every group and no name, the whole set shares one "Colour N"', () => {
  let s = addColour(rig(), { group: 'key-lights', colour: '#111111', name: '', allGroups: false }).show; // Colour 1 in the key lights only
  s = addColour(s, { group: 'background', colour: '#222222', name: '', allGroups: true }).show;
  const made = s.presets.filter((p) => p.swatch === '#222222');
  assert.equal(made.length, 4);
  assert.deepEqual([...new Set(made.map((p) => p.name))], ['Colour 2']);
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

test('a listed colour with amber or UV is not the plain colour', () => {
  const s = rig();
  s.presets.push({ id: 'amber-red', name: 'Amber red', group: 'key-lights', fade: 3, swatch: '#ff4800', layers: [{ kind: 'static', colour: { hex: '#ff0000', amber: 0.6 }, intensity: 1 }] });
  s.presets.push({ id: 'uv-blue', name: 'UV blue', group: 'key-lights', fade: 3, swatch: '#4040ff', layers: [{ kind: 'static', colour: { hex: '#0000ff', uv: 0.5 }, intensity: 1 }] });
  s.presets = s.presets.filter((p) => p.group !== 'key-lights' || !['#ff0000', '#0000ff'].includes(p.swatch ?? ''));
  for (const colour of ['#ff0000', '#0000ff']) {
    const { show, ids } = addColour(s, { group: 'key-lights', colour, name: '', allGroups: false });
    assert.equal(ids.length, 1);
    assert.deepEqual((show.presets.find((p) => p.id === ids[0])!.layers[0] as StaticLayer).colour, { hex: colour });
  }
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

const ready = () => ensureRunningOrder(rig());
const preset = (s: Show, id: string) => s.presets.find((p) => p.id === id)!;

test('a colour is used by the running-order items first, then the quick looks', () => {
  const s = ready();
  assert.deepEqual(presetUsers(s, 'key-lights-silti-balts'), ['Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5', 'Worship', 'Response']);
  assert.deepEqual(presetUsers(s, 'key-lights-zils'), []);
  assert.equal(listNames(['A', 'B']), 'A, B');
  assert.equal(listNames(['A', 'B', 'C', 'D', 'E', 'F']), 'A, B, C, D and 2 more');
});

test('a colour can be renamed and recoloured; the swatch and layer follow', () => {
  const before = ready();
  const { show, ids } = editColour(before, { preset: 'key-lights-zils', name: ' Deep sea ', colour: '#103A7C', sameName: false });
  assert.deepEqual(ids, ['key-lights-zils']);
  assert.deepEqual(preset(show, 'key-lights-zils'), {
    id: 'key-lights-zils', name: 'Deep sea', group: 'key-lights', fade: 3, swatch: '#103a7c',
    layers: [{ kind: 'static', colour: { hex: '#103a7c' }, intensity: 1 }],
  });
  assert.equal(preset(show, 'background-zils').name, 'Zils'); // other groups untouched
  assert.equal(preset(before, 'key-lights-zils').name, 'Zils'); // input not changed
  assert.deepEqual(checkReferences(show), []);
  parseShow(JSON.parse(JSON.stringify(show)));
  // Name only, colour only.
  assert.equal(preset(editColour(before, { preset: 'key-lights-zils', name: 'Sea', sameName: false }).show, 'key-lights-zils').swatch, '#0000ff');
  const colourOnly = preset(editColour(before, { preset: 'key-lights-zils', colour: '#103a7c', sameName: false }).show, 'key-lights-zils');
  assert.equal(colourOnly.name, 'Zils');
  assert.equal(colourOnly.swatch, '#103a7c');
});

test('a dimmer colour keeps its brightness', () => {
  const s = rig();
  const half = s.presets.find((p) => p.name === 'Silti 50%')!;
  const dim = preset(editColour(s, { preset: half.id, colour: '#ff0000', sameName: false }).show, half.id);
  assert.equal(dim.layers[0]!.intensity, 0.5);
});

test('an Off colour can be renamed but not given a colour', () => {
  const s = rig();
  assert.throws(() => editColour(s, { preset: 'key-lights-off', colour: '#ff0000', sameName: false }), /^Error: Off can't be given a colour; add a new colour instead\.$/);
  assert.throws(() => editColour(s, { preset: 'key-lights-off', name: 'Dark', colour: '#ff0000', sameName: true }), /Off can't be given a colour/);
  const { show, ids } = editColour(s, { preset: 'key-lights-off', name: 'Dark', sameName: true });
  assert.equal(ids.length, 5); // every group's "Izslēgts"
  for (const id of ids) {
    assert.equal(preset(show, id).name, 'Dark');
    assert.deepEqual(preset(show, id).layers, preset(s, id).layers);
    assert.equal(preset(show, id).swatch, preset(s, id).swatch);
  }
});

test('the same-name switch leaves an Off colour of that name unlit, and only the groups the page shows change', () => {
  const s = rig();
  // A lit colour in the key lights that shares a name with another group's Off.
  s.presets.find((p) => p.id === 'key-lights-zils')!.name = 'Izslēgts';
  s.operator.groups = s.operator.groups.filter((g) => g !== 'drum-cage');
  const { show, ids } = editColour(s, { preset: 'key-lights-zils', colour: '#103a7c', sameName: true });
  assert.deepEqual(ids, ['key-lights-zils']); // the Offs of the other groups have no colour to change
  const named = editColour(s, { preset: 'key-lights-zils', name: 'Dark', sameName: true });
  assert.ok(!named.ids.includes('drum-cage-off'), 'a group the page does not show is not changed');
  assert.ok(named.ids.includes('background-off') && named.ids.includes('b8-side-bar-off'));
  assert.equal(preset(show, 'key-lights-zils').swatch, '#103a7c');
});

test('a colour change keeps the other channels of the colour, also from a palette', () => {
  const s = rig();
  s.presets.push({ id: 'warm-mix', name: 'Warm mix', group: 'key-lights', fade: 3, swatch: '#112233', layers: [{ kind: 'static', colour: { hex: '#112233', white: 0.4 }, intensity: 0.8 }] });
  const mixed = preset(editColour(s, { preset: 'warm-mix', colour: '#445566', sameName: false }).show, 'warm-mix');
  assert.deepEqual(mixed.layers, [{ kind: 'static', colour: { hex: '#445566', white: 0.4 }, intensity: 0.8 }]);
  // The swatch shows the white mixed in, as the stage shows it.
  assert.equal(mixed.swatch, '#aabbcc');
  s.presets.push({ id: 'amber-red', name: 'Amber red', group: 'key-lights', fade: 3, swatch: '#ff0000', layers: [{ kind: 'static', colour: { hex: '#ff0000', amber: 0.6 }, intensity: 1 }] });
  const amber = preset(editColour(s, { preset: 'amber-red', colour: '#ff0000', sameName: false }).show, 'amber-red');
  assert.deepEqual((amber.layers[0] as StaticLayer).colour, { hex: '#ff0000', amber: 0.6 });
  assert.equal(amber.swatch, '#ff4800');
  // A palette colour becomes a hex colour that carries the palette entry's white.
  const palette = s.palettes.find((p) => p.id === 'lightkey')!;
  palette.colours[7] = { hex: '#0000ff', white: 0.3 };
  const zils = preset(editColour(s, { preset: 'key-lights-zils', colour: '#103a7c', sameName: false }).show, 'key-lights-zils');
  assert.deepEqual(zils.layers, [{ kind: 'static', colour: { hex: '#103a7c', white: 0.3 }, intensity: 1 }]);
});

test('with the same-name switch, the other groups\' colours of that name change too', () => {
  const { show, ids } = editColour(ready(), { preset: 'key-lights-zils', name: 'Deep sea', colour: '#103a7c', sameName: true });
  assert.deepEqual(ids.sort(), ['b8-side-bar-zils', 'background-zils', 'drum-cage-zils', 'key-lights-zils']);
  for (const id of ids) {
    assert.equal(preset(show, id).name, 'Deep sea');
    assert.equal(preset(show, id).swatch, '#103a7c');
  }
  assert.equal(show.presets.find((p) => p.group === 'front-lights' && p.name === 'Deep sea'), undefined);
  assert.equal(show.presets.filter((p) => p.name === 'Zils').length, 0);
});

test('editing refuses hidden presets, missing ones, bad input and no change', () => {
  const s = ready();
  const hidden = saveHidden(s);
  assert.throws(() => editColour(hidden.show, { preset: hidden.id, name: 'x', sameName: false }), /can't be edited/);
  assert.throws(() => editColour(s, { preset: 'nope', name: 'x', sameName: false }), /not in the list/);
  assert.throws(() => editColour(s, { preset: 'key-lights-zils', name: '  ', sameName: false }), /name is needed/);
  assert.throws(() => editColour(s, { preset: 'key-lights-zils', colour: 'blue', sameName: false }), /not a colour/);
  assert.throws(() => editColour(s, { preset: 'key-lights-zils', sameName: false }), /nothing to change/);
  const plain = addColour(s, { group: 'key-lights', colour: '#123456', name: 'Plain', allGroups: false });
  assert.throws(() => editColour(plain.show, { preset: plain.ids[0]!, name: 'Plain', colour: '#123456', sameName: false }), /nothing changed/);
  assert.equal(preset(editColour(s, { preset: 'key-lights-zils', name: 'y'.repeat(60), sameName: false }).show, 'key-lights-zils').name, 'y'.repeat(40));
});

/** A show holding a hidden (custom) preset, as Save makes for an Any colour pick. */
function saveHidden(s: Show): { show: Show; id: string } {
  const show = structuredClone(s);
  show.presets.push({ id: 'custom-9', name: 'Custom', group: 'key-lights', custom: true, fade: 3, swatch: '#123456', layers: [{ kind: 'static', colour: { hex: '#123456' }, intensity: 1 }] });
  return { show, id: 'custom-9' };
}

test('a colour no look uses can be deleted; a used one is refused with the names', () => {
  const s = ready();
  const gone = deleteColour(s, 'key-lights-zils');
  assert.equal(gone.presets.some((p) => p.id === 'key-lights-zils'), false);
  assert.equal(gone.presets.length, s.presets.length - 1);
  assert.equal(s.presets.some((p) => p.id === 'key-lights-zils'), true);
  assert.deepEqual(checkReferences(gone), []);
  assert.throws(() => deleteColour(s, 'key-lights-vesi-balts'), /^Error: Used in Sermon, All white\. Change those first\.$/);
  assert.throws(() => deleteColour(s, 'key-lights-silti-balts'), /^Error: Used in Song 1, Song 2, Song 3, Song 4 and 3 more\. Change those first\.$/);
  assert.throws(() => deleteColour(s, 'nope'), /not in the list/);
  const hidden = saveHidden(s);
  assert.throws(() => deleteColour(hidden.show, hidden.id), /can't be deleted/);
});

test('an effect preset is in the show like a colour, but is never recoloured or taken for a plain colour', () => {
  const s = rig();
  const wave = EffectLayer.parse({ kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }, { palette: 'lightkey', index: 1 }], speed: { beats: 4 } });
  assert.deepEqual(wave, {
    kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }, { palette: 'lightkey', index: 1 }], speed: { beats: 4 },
    direction: 'ltr', waves: 1, size: 0.5, edge: 'soft', intensity: 1,
  });
  s.presets.push({ id: 'bg-wave', name: 'Wave', group: 'background', fade: 3, swatch: '#ff0000', layers: [wave] });
  const show = parseShow(s);
  const effect = preset(show, 'bg-wave');
  assert.equal(isEffectPreset(effect), true);
  assert.equal(isEffectPreset(preset(show, 'background-zils')), false);
  assert.equal(canRecolour(effect), false);
  assert.equal(isOff(effect), false);
  assert.throws(() => editColour(show, { preset: 'bg-wave', colour: '#00ff00', sameName: false }), /that colour can't be changed here/);
  // An effect of one colour doesn't count as that colour in the list.
  const one = EffectLayer.parse({ kind: 'effect', effect: 'breathe', colours: [{ hex: '#123456' }], speed: { beats: 4 } });
  show.presets.push({ id: 'bg-breathe', name: 'Breathe', group: 'background', fade: 3, swatch: '#123456', layers: [one] });
  assert.equal(addColour(show, { group: 'background', colour: '#123456', name: '', allGroups: false }).ids.length, 1);
  // A missing palette inside an effect is a broken reference.
  s.presets.at(-1)!.layers = [{ ...wave, colours: [{ palette: 'nope', index: 0 }] }];
  assert.throws(() => parseShow(s), /unknown palette "nope"/);
});
