import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addColour, addEffect, canRecolour, checkReferences, deleteColour, displayColour, editColour, editEffect, EffectLayer, ensureEffects, ensureRunningOrder, groupIsWhiteOnly,
  effectKey, groupSegments, isEffectPreset, isOff, listNames, parseShow, presetUsers, presetsUsingPaletteEntry, resolveColour, resolveEffect,
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

test('a colour with white, amber or UV is added with them, kept to whole percent, and the swatch shows them', () => {
  const before = rig();
  const { show, ids } = addColour(before, { group: 'key-lights', colour: '#FF8800', name: 'Warm glow', allGroups: false, white: 0.35, amber: 1, uv: 0 });
  const made = show.presets.find((p) => p.id === ids[0])!;
  assert.deepEqual(made.layers, [{ kind: 'static', colour: { hex: '#ff8800', white: 0.35, amber: 1 }, intensity: 1 }]);
  assert.equal(made.swatch, displayColour('#ff8800', { white: 0.35, amber: 1 }));
  assert.notEqual(made.swatch, '#ff8800');
  // The same colour again is refused; the plain colour is another one.
  assert.throws(() => addColour(show, { group: 'key-lights', colour: '#ff8800', name: 'x', allGroups: false, white: 0.351, amber: 1 }), { message: 'that colour is already in the list' });
  assert.equal(addColour(show, { group: 'key-lights', colour: '#ff8800', name: 'x', allGroups: false }).ids.length, 1);
  // Levels outside 0..1 are refused.
  assert.throws(() => addColour(before, { group: 'key-lights', colour: '#ff8800', name: 'x', allGroups: false, amber: 1.5 }), /amber level is between 0 and 100 %/);
  // Every colour group gets the same light, also one with no amber channel (the engine makes amber from red and green there).
  const all = addColour(before, { group: 'key-lights', colour: '#ff8800', name: 'Warm glow', allGroups: true, white: 0.35, amber: 1 });
  assert.deepEqual(all.ids.map((id) => all.show.presets.find((p) => p.id === id)!.group).sort(), [...COLOUR_GROUPS].sort());
  for (const id of all.ids) assert.deepEqual(all.show.presets.find((p) => p.id === id)!.layers[0], made.layers[0]);
  parseShow(JSON.parse(JSON.stringify(all.show)));
});

test('a colour of Amber alone (black with amber) is a lit colour, not Off; black with nothing in it is refused', () => {
  const before = rig();
  const { show, ids } = addColour(before, { group: 'key-lights', colour: '#000000', name: 'Amber', allGroups: false, amber: 1 });
  const made = show.presets.find((p) => p.id === ids[0])!;
  assert.deepEqual(made.layers, [{ kind: 'static', colour: { hex: '#000000', amber: 1 }, intensity: 1 }]);
  assert.equal(made.swatch, '#ffbf00');
  assert.equal(isOff(made), false);
  assert.equal(canRecolour(made), true);
  // The editor treats it as a normal colour: a brightness and a new hue are fine.
  const dimmer = editColour(show, { preset: made.id, level: 0.5, sameName: false }).show;
  assert.equal((dimmer.presets.find((p) => p.id === made.id)!.layers[0] as StaticLayer).intensity, 0.5);
  const red = editColour(show, { preset: made.id, colour: '#ff0000', sameName: false }).show;
  assert.deepEqual((red.presets.find((p) => p.id === made.id)!.layers[0] as StaticLayer).colour, { hex: '#ff0000', amber: 1 });
  // An effect with it first shows amber, not black.
  const fxShow = addEffect(show, { group: 'key-lights', name: 'Amber wave', effect: EffectLayer.parse({ kind: 'effect', effect: 'wave', colours: [{ hex: '#000000', amber: 1 }], speed: { beats: 4 } }) });
  assert.equal(fxShow.show.presets.find((p) => p.id === fxShow.id)!.swatch, '#ffbf00');
  // Black with no White, Amber or UV has no light: that is Off, and is not added as a colour.
  assert.throws(() => addColour(before, { group: 'key-lights', colour: '#000000', name: 'x', allGroups: false }), /has no light/);
  assert.equal(isOff({ id: 'x', name: 'x', group: 'key-lights', fade: 3, layers: [{ kind: 'static', colour: { hex: '#000000' }, intensity: 1 }] }), true);
  assert.equal(isOff({ id: 'x', name: 'x', group: 'key-lights', fade: 3, layers: [{ kind: 'static', colour: { hex: '#000000', uv: 0.2 }, intensity: 1 }] }), false);
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

test('brightness changes only the layer intensity', () => {
  const s = rig();
  const { show, ids } = addColour(s, { group: 'key-lights', colour: '#2A4B9C', name: 'Plain', allGroups: false });
  const id = ids[0]!;
  const dim = editColour(show, { preset: id, level: 0.5, sameName: false });
  assert.deepEqual(dim.ids, [id]);
  assert.deepEqual(preset(dim.show, id).layers, [{ kind: 'static', colour: { hex: '#2a4b9c' }, intensity: 0.5 }]);
  assert.equal(preset(dim.show, id).swatch, '#2a4b9c'); // swatches show full brightness
  assert.equal(preset(show, id).layers[0]!.intensity, 1); // input not changed
  // A palette colour stays a palette colour when only its brightness changes, and the palette is not touched.
  const zils = editColour(s, { preset: 'key-lights-zils', level: 0.25, sameName: true });
  assert.deepEqual(zils.ids.sort(), ['b8-side-bar-zils', 'background-zils', 'drum-cage-zils', 'key-lights-zils']);
  for (const zid of zils.ids) assert.deepEqual(preset(zils.show, zid).layers, [{ kind: 'static', colour: { palette: 'lightkey', index: 7 }, intensity: 0.25 }]);
  assert.deepEqual(zils.show.palettes, s.palettes);
  // Brightness together with a new colour.
  const both = preset(editColour(s, { preset: 'key-lights-zils', colour: '#103a7c', level: 0.6, sameName: false }).show, 'key-lights-zils');
  assert.deepEqual(both.layers, [{ kind: 'static', colour: { hex: '#103a7c' }, intensity: 0.6 }]);
  assert.throws(() => editColour(show, { preset: id, level: 0.01, sameName: false }), /brightness/);
  assert.throws(() => editColour(show, { preset: id, level: 1, sameName: false }), { message: 'nothing changed' });
});

test('fade changes the preset fade, also for an effect', () => {
  const s = rig();
  const slow = editColour(s, { preset: 'key-lights-zils', fade: 12.5, sameName: false });
  assert.deepEqual(slow.ids, ['key-lights-zils']);
  assert.equal(preset(slow.show, 'key-lights-zils').fade, 12.5);
  assert.equal(preset(slow.show, 'key-lights-zils').swatch, '#0000ff');
  assert.equal(preset(slow.show, 'background-zils').fade, 3);
  assert.equal(preset(editColour(s, { preset: 'key-lights-zils', fade: 0, sameName: false }).show, 'key-lights-zils').fade, 0);
  // Off takes a fade too.
  assert.equal(preset(editColour(s, { preset: 'key-lights-off', fade: 1, sameName: false }).show, 'key-lights-off').fade, 1);
  const { show, id } = addEffect(s, { group: 'background', name: 'Wave', effect: EffectLayer.parse({ kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }], speed: { beats: 4 } }) });
  const fx = editColour(show, { preset: id, fade: 8, sameName: false });
  assert.equal(preset(fx.show, id).fade, 8);
  assert.deepEqual(preset(fx.show, id).layers, preset(show, id).layers);
  assert.throws(() => editColour(s, { preset: 'key-lights-zils', fade: 601, sameName: false }), /fade/);
  assert.throws(() => editColour(s, { preset: 'key-lights-zils', fade: 3, sameName: false }), { message: 'nothing changed' });
});

test('brightness is refused for Off, effects and multi-layer presets', () => {
  const s = rig();
  assert.throws(() => editColour(s, { preset: 'key-lights-off', level: 0.5, sameName: false }), { message: "Off can't be given a colour; add a new colour instead." });
  const { show, id } = addEffect(s, { group: 'background', name: 'Wave', effect: EffectLayer.parse({ kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }], speed: { beats: 4 } }) });
  assert.throws(() => editColour(show, { preset: id, level: 0.5, sameName: false }), { message: "that colour can't be changed here" });
  const layers: StaticLayer[] = [{ kind: 'static', colour: { hex: '#ff0000' }, intensity: 1 }, { kind: 'static', colour: { hex: '#0000ff' }, intensity: 0.5 }];
  show.presets.push({ id: 'two', name: 'Two', group: 'key-lights', fade: 3, swatch: '#ff0000', layers });
  assert.throws(() => editColour(show, { preset: 'two', level: 0.5, sameName: false }), { message: "that colour can't be changed here" });
  assert.throws(() => editColour(show, { preset: 'two', fade: 5, level: 0.5, sameName: false }), { message: "that colour can't be changed here" });
  assert.equal(preset(editColour(show, { preset: 'two', fade: 5, sameName: false }).show, 'two').fade, 5);
});

const ZILS = ['b8-side-bar-zils', 'background-zils', 'drum-cage-zils', 'key-lights-zils'];
const zilsPoint = (s: Show, id: string) => JSON.stringify((preset(s, id).layers[0] as StaticLayer).colour) === JSON.stringify({ palette: 'lightkey', index: 7 });

test('with shared on, a new colour changes the palette entry and every colour that points to it', () => {
  const s = ready();
  const { show, ids } = editColour(s, { preset: 'key-lights-zils', colour: '#103A7C', shared: true, sameName: false });
  assert.equal(show.palettes.find((p) => p.id === 'lightkey')!.colours[7]!.hex, '#103a7c');
  for (const id of ZILS) {
    assert.equal(zilsPoint(show, id), true, id); // still pointing to the palette
    assert.equal(preset(show, id).swatch, '#103a7c', id);
    assert.equal(preset(show, id).name, 'Zils');
  }
  assert.deepEqual([...ids].sort(), ZILS); // every group's Zils, though only one was edited
  assert.equal(s.palettes.find((p) => p.id === 'lightkey')!.colours[7]!.hex, '#0000ff'); // input not changed
  assert.deepEqual(checkReferences(show), []);
  parseShow(JSON.parse(JSON.stringify(show)));
  // The palette entry keeps its white, and the swatches show it.
  const withWhite = structuredClone(s);
  withWhite.palettes.find((p) => p.id === 'lightkey')!.colours[7] = { hex: '#0000ff', white: 0.3 };
  const mixed = editColour(withWhite, { preset: 'background-zils', colour: '#103a7c', shared: true, sameName: false }).show;
  assert.deepEqual(mixed.palettes.find((p) => p.id === 'lightkey')!.colours[7], { hex: '#103a7c', white: 0.3 });
  assert.equal(preset(mixed, 'key-lights-zils').swatch, displayColour('#103a7c', { white: 0.3 }));
  // A plain colour has no palette entry: shared does nothing.
  const plain = addColour(s, { group: 'key-lights', colour: '#123456', name: 'Plain', allGroups: false });
  const edited = editColour(plain.show, { preset: plain.ids[0]!, colour: '#654321', shared: true, sameName: false });
  assert.deepEqual(edited.ids, plain.ids);
  assert.deepEqual(edited.show.palettes, s.palettes);
});

test('with shared off, a palette colour is cut loose and the others stay', () => {
  const s = ready();
  const { show, ids } = editColour(s, { preset: 'key-lights-zils', colour: '#103a7c', shared: false, sameName: false });
  assert.deepEqual(ids, ['key-lights-zils']);
  assert.deepEqual(preset(show, 'key-lights-zils').layers, [{ kind: 'static', colour: { hex: '#103a7c' }, intensity: 1 }]);
  assert.equal(preset(show, 'key-lights-zils').swatch, '#103a7c');
  assert.deepEqual(show.palettes, s.palettes);
  for (const id of ZILS.filter((x) => x !== 'key-lights-zils')) {
    assert.equal(zilsPoint(show, id), true, id);
    assert.equal(preset(show, id).swatch, '#0000ff', id);
  }
});

test('same-name and shared together change each preset once', () => {
  const s = ready();
  const { show, ids } = editColour(s, { preset: 'key-lights-zils', name: 'Deep sea', colour: '#103a7c', shared: true, sameName: true });
  assert.deepEqual([...ids].sort(), ZILS);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ZILS) {
    assert.equal(zilsPoint(show, id), true, id);
    assert.equal(preset(show, id).name, 'Deep sea');
    assert.equal(preset(show, id).swatch, '#103a7c');
  }
  assert.equal(show.palettes.find((p) => p.id === 'lightkey')!.colours[7]!.hex, '#103a7c');
  // A same-named colour that is a plain colour takes the colour as its own; the palette ones share it.
  const mixed = structuredClone(s);
  preset(mixed, 'background-zils').layers = [{ kind: 'static', colour: { hex: '#0000ff' }, intensity: 1 }];
  const out = editColour(mixed, { preset: 'key-lights-zils', colour: '#103a7c', shared: true, sameName: true });
  assert.deepEqual([...out.ids].sort(), ZILS);
  assert.deepEqual(preset(out.show, 'background-zils').layers, [{ kind: 'static', colour: { hex: '#103a7c' }, intensity: 1 }]);
  assert.equal(out.show.palettes.find((p) => p.id === 'lightkey')!.colours[7]!.hex, '#103a7c');
  assert.equal(zilsPoint(out.show, 'drum-cage-zils'), true);
});

test("with shared on, a same-named colour of another shared colour takes the colour as its own and leaves that shared colour alone", () => {
  // Background's Tirkīzs (shared colour 6) renamed to Zils; then Key lights' Zils (shared colour 7) is
  // recoloured with both switches on.
  const s = editColour(ready(), { preset: 'background-tirkizs', name: 'Zils', sameName: false }).show;
  const { show, ids } = editColour(s, { preset: 'key-lights-zils', colour: '#103a7c', shared: true, sameName: true });
  const colours = show.palettes.find((p) => p.id === 'lightkey')!.colours;
  assert.equal(colours[6]!.hex, '#00ffc8'); // Tirkīzs's shared colour is untouched
  assert.equal(colours[7]!.hex, '#103a7c');
  // The renamed one is cut loose with the new colour.
  assert.deepEqual(preset(show, 'background-tirkizs').layers, [{ kind: 'static', colour: { hex: '#103a7c' }, intensity: 1 }]);
  assert.equal(preset(show, 'background-tirkizs').swatch, '#103a7c');
  // The other groups' Tirkīzs still point to shared colour 6 and keep its colour.
  for (const id of ['key-lights-tirkizs', 'drum-cage-tirkizs', 'b8-side-bar-tirkizs']) {
    assert.deepEqual((preset(show, id).layers[0] as StaticLayer).colour, { palette: 'lightkey', index: 6 }, id);
    assert.equal(preset(show, id).swatch, '#00ffc8', id);
  }
  for (const id of ZILS) assert.equal(zilsPoint(show, id), true, id);
  assert.deepEqual([...ids].sort(), [...ZILS, 'background-tirkizs'].sort());
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

// ---- The effects list ----

const fx = (over: Partial<EffectLayer> = {}) => EffectLayer.parse({
  kind: 'effect', effect: 'wave', colours: [{ hex: '#FF0000' }, { hex: '#0000ff' }], speed: { beats: 4 }, ...over,
});

test('an effect is added to a group\'s list, named, or "Effect N" when the name is empty', () => {
  const s = ready();
  const first = addEffect(s, { group: 'background', name: '  Slow wave  ', effect: fx() });
  const made = preset(first.show, first.id);
  assert.deepEqual(made, { id: first.id, name: 'Slow wave', group: 'background', layers: [fx()], fade: 3, swatch: '#ff0000' });
  assert.equal(first.id, 'background-slow-wave');
  assert.equal(s.presets.some((p) => p.id === first.id), false, 'the input show is not changed');
  assert.deepEqual(checkReferences(first.show), []);

  const a = addEffect(first.show, { group: 'background', name: '', effect: fx() });
  assert.equal(preset(a.show, a.id).name, 'Effect 1');
  const b = addEffect(a.show, { group: 'background', name: ' ', effect: fx({ effect: 'chase' }) });
  assert.equal(preset(b.show, b.id).name, 'Effect 2');
  // Another group counts its own.
  const c = addEffect(b.show, { group: 'key-lights', name: '', effect: fx() });
  assert.equal(preset(c.show, c.id).name, 'Effect 1');
  assert.equal(new Set(c.show.presets.map((p) => p.id)).size, c.show.presets.length);
  // A long name is cut to 40 characters.
  assert.equal(preset(addEffect(s, { group: 'background', name: 'w'.repeat(60), effect: fx() }).show, 'background-' + 'w'.repeat(40)).name, 'w'.repeat(40));
});

test('adding an effect refuses a missing group and a smoke machine', () => {
  const s = ready();
  assert.throws(() => addEffect(s, { group: 'nope', name: 'x', effect: fx() }), { message: 'the show has no group "nope"' });
  const smoky = structuredClone(s);
  smoky.groups.find((g) => g.id === 'drum-cage')!.kind = 'smoke';
  assert.throws(() => addEffect(smoky, { group: 'drum-cage', name: 'x', effect: fx() }), { message: "smoke machines can't run effects" });
});

test('an effect\'s settings are edited in place; a colour is not an effect', () => {
  const s = ready();
  const { show, id } = addEffect(s, { group: 'background', name: 'Wave', effect: fx() });
  const hard = fx({ edge: 'hard', colours: [{ hex: '#00FF00' }] });
  const out = editEffect(show, { preset: id, effect: hard });
  assert.deepEqual(preset(out, id).layers, [hard]);
  assert.equal(preset(out, id).swatch, '#00ff00');
  assert.equal(preset(out, id).name, 'Wave');
  assert.deepEqual(preset(show, id).layers, [fx()], 'the input show is not changed');
  assert.throws(() => editEffect(show, { preset: 'background-zils', effect: hard }), { message: 'that is not an effect' });
  assert.throws(() => editEffect(show, { preset: 'nope', effect: hard }), { message: 'that effect is not in the list' });
  assert.throws(() => editEffect(show, { preset: id, effect: fx() }), { message: 'nothing changed' });
  const hidden = structuredClone(show);
  preset(hidden, id).custom = true;
  assert.throws(() => editEffect(hidden, { preset: id, effect: hard }), { message: "that effect can't be edited" });
});

test('an effect keeps its base colour through add, edit and the show file', () => {
  const s = ready();
  const base = { colour: { hex: '#ffb46b', white: 0.4 }, level: 0.5 };
  const { show, id } = addEffect(s, { group: 'background', name: 'Over warm', effect: fx({ effect: 'chase', base }) });
  assert.deepEqual((preset(show, id).layers[0] as EffectLayer).base, base);
  assert.equal(preset(show, id).swatch, '#ff0000', 'the swatch is still the first colour');
  // A new base level alone is a change; taking the base away is too.
  const dimmer = editEffect(show, { preset: id, effect: fx({ effect: 'chase', base: { ...base, level: 0.2 } }) });
  assert.equal((preset(dimmer, id).layers[0] as EffectLayer).base!.level, 0.2);
  const none = editEffect(dimmer, { preset: id, effect: fx({ effect: 'chase' }) });
  assert.equal((preset(none, id).layers[0] as EffectLayer).base, undefined);
  assert.throws(() => editEffect(show, { preset: id, effect: fx({ effect: 'chase', base }) }), { message: 'nothing changed' });
  assert.deepEqual(parseShow(JSON.parse(JSON.stringify(show))).presets.find((p) => p.id === id), preset(show, id));
  // Two effects that differ only in their base don't run the same.
  const keys = new Set([fx(), fx({ base }), fx({ base: { ...base, level: 0.2 } }), fx({ base: { ...base, colour: { hex: '#FFB46B', white: 0.4 } } })].map(effectKey));
  assert.equal(keys.size, 3, 'a hex in any case is the same colour');
});

test("an effect's base can be a shared palette colour: it counts as using it, and a missing one is a broken reference", () => {
  const s = rig();
  const layer = fx({ base: { colour: { palette: 'lightkey', index: 7 }, level: 0.3 } });
  s.presets.push({ id: 'bg-over', name: 'Over', group: 'background', fade: 3, layers: [layer] });
  const show = parseShow(s);
  assert.ok(presetsUsingPaletteEntry(show, 'lightkey', 7).some((p) => p.id === 'bg-over'));
  const palettes = new Map(show.palettes.map((p) => [p.id, p]));
  assert.deepEqual(resolveEffect(layer, palettes).base, { colour: resolveColour({ palette: 'lightkey', index: 7 }, palettes), level: 0.3 });
  s.presets.at(-1)!.layers = [fx({ base: { colour: { palette: 'nope', index: 0 }, level: 0.3 } })];
  assert.throws(() => parseShow(s), /unknown palette "nope"/);
});

test('an effect is renamed and deleted like a colour, but never given a colour there', () => {
  const s = ready();
  const { show, id } = addEffect(s, { group: 'background', name: 'Wave', effect: fx() });
  const renamed = editColour(show, { preset: id, name: 'Rolling', sameName: false }).show;
  assert.equal(preset(renamed, id).name, 'Rolling');
  assert.deepEqual(preset(renamed, id).layers, [fx()]);
  assert.throws(() => editColour(show, { preset: id, colour: '#00ff00', sameName: false }), { message: "that colour can't be changed here" });
  const gone = deleteColour(show, id);
  assert.equal(gone.presets.some((p) => p.id === id), false);
  // Used in a song: refused with the names.
  const used = structuredClone(show);
  used.looks.find((l) => l.name === 'Song 2')!.groups.find((e) => e.group === 'background')!.preset = id;
  assert.throws(() => deleteColour(used, id), /^Error: Used in Song 2\. Change those first\.$/);
});

test('a group\'s line is its fixtures\' segments', () => {
  const s = rig();
  assert.equal(groupSegments(s, 'background'), 32);
  assert.equal(groupSegments(s, 'key-lights'), 6);
  assert.equal(groupSegments(s, 'front-lights'), 4);
  assert.equal(groupSegments(s, 'drum-cage'), 1);
  assert.equal(groupSegments(s, 'b8-side-bar'), 4);
  assert.equal(groupSegments(s, 'nope'), 0);
});

test('ready-made effects are added once to every coloured group with more than one segment', () => {
  const s = ready();
  const out = ensureEffects(s);
  assert.equal(out.operator.effectsAdded, true);
  assert.equal(s.operator.effectsAdded, undefined, 'the input show is not changed');
  const effects = (show: Show, group: string) => show.presets.filter((p) => p.group === group && isEffectPreset(p));
  const named = (show: Show, group: string) => effects(show, group).map((p) => p.name);
  assert.deepEqual(named(out, 'background'), ['Colour fade', 'Wave', 'Three waves', 'Chase', 'Sparkle', 'Meteor', 'Fill', 'Yo-yo', 'Breathe']);
  assert.deepEqual(named(out, 'key-lights'), ['Colour fade', 'Breathe', 'Wave']);
  assert.deepEqual(named(out, 'b8-side-bar'), ['Colour fade', 'Breathe', 'Wave']);
  // White-only front lights and the one-segment drum cage get none.
  assert.deepEqual(named(out, 'front-lights'), []);
  assert.deepEqual(named(out, 'drum-cage'), []);
  // The colours are the group's first three coloured swatches (not the whites, not Off), by reference.
  const palettes = new Map(out.palettes.map((p) => [p.id, p]));
  for (const p of effects(out, 'background')) {
    const layer = p.layers[0]!;
    assert.equal(layer.kind, 'effect');
    if (layer.kind !== 'effect') continue;
    assert.deepEqual(layer.colours.map((c) => resolveColour(c, palettes).hex), ['#ff0000', '#ff5a00', '#ffc800']);
    assert.deepEqual(layer.speed, p.name === 'Colour fade' ? { beats: 16 } : { beats: 4 });
    assert.equal(layer.waves, p.name === 'Three waves' ? 3 : 1);
    assert.equal(p.swatch, '#ff0000');
    assert.equal(p.custom, undefined);
  }
  const kinds = effects(out, 'background').map((p) => (p.layers[0] as EffectLayer).effect);
  assert.deepEqual(kinds, ['colourFade', 'wave', 'wave', 'chase', 'sparkle', 'meteor', 'fill', 'yoyo', 'breathe']);
  assert.deepEqual(checkReferences(out), []);
  parseShow(JSON.parse(JSON.stringify(out)));

  // Never again: not on a second run, and not after the owner deleted them.
  assert.deepEqual(ensureEffects(out), out);
  const cleared = structuredClone(out);
  cleared.presets = cleared.presets.filter((p) => !isEffectPreset(p));
  assert.deepEqual(ensureEffects(cleared), cleared);
});
