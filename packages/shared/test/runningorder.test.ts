import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addSong, applyPicks, checkReferences, cleanName, deleteItem, ensureRunningOrder, livePresetId, moveItem,
  parseLivePreset, parseShow, renameItem, saveItem, saveQuickLook, type Show, type Stage,
} from '../src/index.ts';

const load = (path: string): Show => parseShow(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));
const rig = (): Show => load('../../../shows/stage-l1.json');
const demo = (): Show => load('../../../server/seed/demo-show.json');

const nameOf = (s: Show, id: string) => s.looks.find((l) => l.id === id)!.name;
const order = (s: Show) => s.operator.runningOrder.map((id) => nameOf(s, id));
const look = (s: Show, name: string) => s.looks.find((l) => l.name === name)!;
const firstPreset = (s: Show, group: string) => s.presets.find((p) => p.group === group)!.id;
const emptyStage: Stage = { groups: {}, levels: {} };

/** A rig with a running order, ready for the edit functions. */
const ready = () => ensureRunningOrder(rig());

test('live preset ids round-trip and lower-case the colour', () => {
  const id = livePresetId('key-lights', '#3A6FC8');
  assert.equal(id, 'live:key-lights:#3a6fc8');
  assert.deepEqual(parseLivePreset(id), { group: 'key-lights', colour: '#3a6fc8' });
  assert.equal(parseLivePreset('zils'), null);
  assert.equal(parseLivePreset('live:key-lights:red'), null);
});

test('the stage L1 show gets a running order with Basic lights first', () => {
  const s = ensureRunningOrder(rig());
  assert.deepEqual(order(s), ['Basic lights', 'Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5', 'Sermon', 'Midweek calm']);
  assert.equal(s.operator.runningOrder[0], s.operator.safeLook);
  assert.ok(s.operator.quickLooks.some((q) => q.tab === 'plain' && nameOf(s, q.look) === 'All white'));
  assert.deepEqual(ensureRunningOrder(s), s); // second run changes nothing
  assert.deepEqual(checkReferences(s), []);
});

test('the new looks copy Worship, Sermon and Prayer, and the originals stay', () => {
  const before = rig();
  const s = ensureRunningOrder(before);
  const worship = look(before, 'Worship');
  for (let n = 1; n <= 5; n++) {
    const song = look(s, `Song ${n}`);
    assert.notEqual(song.id, worship.id);
    assert.deepEqual(song.groups, worship.groups);
  }
  assert.equal(s.looks.filter((l) => l.name === 'Sermon').length, 2); // the original and the copy
  assert.deepEqual(look(s, 'Midweek calm').groups, look(before, 'Prayer').groups);
  for (const l of before.looks) assert.deepEqual(s.looks.find((x) => x.id === l.id), l);
});

test('every old look except the safe look becomes a quick look, and Basic lights is not one', () => {
  const s = ensureRunningOrder(rig());
  const quick = s.operator.quickLooks.map((q) => [nameOf(s, q.look), q.tab]);
  assert.deepEqual(quick, [
    ['Walk-in', 'colours'], ['Worship', 'colours'], ['Sermon', 'colours'],
    ['Response', 'colours'], ['Prayer', 'colours'], ['All white', 'plain'],
  ]);
});

test('a show without a Safe look gets an empty Basic lights look', () => {
  const before = demo();
  const s = ensureRunningOrder(before);
  const basic = look(s, 'Basic lights');
  assert.deepEqual(basic.groups, []);
  assert.equal(s.operator.safeLook, basic.id);
  assert.equal(s.operator.runningOrder[0], basic.id);
  assert.deepEqual(look(s, 'Song 1').groups, look(before, 'Worship').groups);
  assert.deepEqual(checkReferences(s), []);
});

test('an existing safe look is renamed Basic lights and kept', () => {
  const before = rig();
  before.operator.safeLook = 'all-white';
  const s = ensureRunningOrder(before);
  assert.equal(s.operator.safeLook, 'all-white');
  assert.equal(nameOf(s, 'all-white'), 'Basic lights');
  assert.equal(s.operator.runningOrder[0], 'all-white');
  assert.ok(!s.operator.quickLooks.some((q) => q.look === 'all-white'));
  assert.equal(s.looks.length, before.looks.length + 7);
});

test('a missing Worship, Sermon or Prayer falls back to Basic lights', () => {
  const before = demo();
  before.looks = before.looks.filter((l) => !['Worship', 'Sermon', 'Prayer'].includes(l.name));
  before.operator.looks = before.operator.looks.filter((id) => before.looks.some((l) => l.id === id));
  const s = ensureRunningOrder(before);
  for (const name of ['Song 1', 'Sermon', 'Midweek calm']) assert.deepEqual(look(s, name).groups, []);
});

test('Save keeps existing presets and turns an Any colour pick into a custom preset', () => {
  const s = ready();
  const song = look(s, 'Song 1');
  const front = song.groups.find((e) => e.group === 'front-lights')!.preset;
  const stage: Stage = {
    groups: { 'key-lights': livePresetId('key-lights', '#3A6FC8'), 'front-lights': front, background: null },
    levels: { 'key-lights': 0.4 },
  };
  const saved = saveItem(s, song.id, stage);
  assert.equal(saved.presets.length, s.presets.length + 1);
  const after = saved.looks.find((l) => l.id === song.id)!;
  assert.equal(after.name, 'Song 1');
  assert.deepEqual(saved.operator.runningOrder, s.operator.runningOrder);
  assert.equal(after.groups.length, 2);
  const key = after.groups.find((e) => e.group === 'key-lights')!;
  const made = saved.presets.find((p) => p.id === key.preset)!;
  assert.equal(made.custom, true);
  assert.equal(made.name, 'Custom');
  assert.equal(made.group, 'key-lights');
  assert.equal(made.swatch, '#3a6fc8');
  assert.deepEqual(made.layers, [{ kind: 'static', colour: { hex: '#3a6fc8' }, intensity: 1 }]);
  assert.equal(made.fade, 3);
  assert.equal(key.level, 0.4);
  const fr = after.groups.find((e) => e.group === 'front-lights')!;
  assert.equal(fr.preset, front);
  assert.equal(fr.level, 1);
  assert.deepEqual(saved.presets.find((p) => p.id === front), s.presets.find((p) => p.id === front));
  assert.deepEqual(checkReferences(saved), []);
  // the input is untouched
  assert.deepEqual(look(s, 'Song 1'), song);
  assert.equal(s.presets.length, ready().presets.length);
});

test('saving the same colour twice makes two custom presets with unique ids', () => {
  let s = ready();
  const stage: Stage = { groups: { 'key-lights': livePresetId('key-lights', '#112233') }, levels: {} };
  s = saveItem(s, look(s, 'Song 1').id, stage);
  s = saveItem(s, look(s, 'Song 2').id, stage);
  const ids = s.presets.filter((p) => p.custom).map((p) => p.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});

test('Save stores the targets it is given, so saving mid-fade saves where the fade is going', () => {
  const s = ready();
  const target = firstPreset(s, 'background');
  const saved = saveItem(s, look(s, 'Song 3').id, { groups: { background: target }, levels: { background: 0.25 } });
  assert.deepEqual(look(saved, 'Song 3').groups, [{ group: 'background', preset: target, level: 0.25 }]);
});

test('Save refuses an unknown look, group or preset', () => {
  const s = ready();
  assert.throws(() => saveItem(s, 'nope', emptyStage), /isn't in the show/);
  assert.throws(() => saveItem(s, look(s, 'Song 1').id, { groups: { nowhere: 'x' }, levels: {} }), /no group/);
  assert.throws(() => saveItem(s, look(s, 'Song 1').id, { groups: { background: 'nope' }, levels: {} }), /no preset/);
});

test('Add song puts "Song 6" after the given item, holding the stage', () => {
  const s = ready();
  const p = firstPreset(s, 'front-lights');
  const { show, id } = addSong(s, look(s, 'Song 2').id, { groups: { 'front-lights': p }, levels: { 'front-lights': 0.5 } });
  assert.deepEqual(order(show), ['Basic lights', 'Song 1', 'Song 2', 'Song 6', 'Song 3', 'Song 4', 'Song 5', 'Sermon', 'Midweek calm']);
  assert.equal(nameOf(show, id), 'Song 6');
  assert.deepEqual(show.looks.find((l) => l.id === id)!.groups, [{ group: 'front-lights', preset: p, level: 0.5 }]);
  assert.equal(order(s).length, 8);
  // an id that is not in the list goes at the end
  assert.equal(order(addSong(s, 'nope', emptyStage).show).at(-1), 'Song 6');
  assert.deepEqual(checkReferences(show), []);
});

test('Add song counts Song names, and keeps ids unique', () => {
  let s = ready();
  s = deleteItem(s, look(s, 'Song 1').id);
  const { show, id } = addSong(s, s.operator.safeLook!, emptyStage);
  assert.equal(nameOf(show, id), 'Song 5');
  assert.equal(new Set(show.looks.map((l) => l.id)).size, show.looks.length);
});

test('Rename trims and cuts the name', () => {
  const s = ready();
  const calm = look(s, 'Midweek calm').id;
  const r = renameItem(s, calm, `  ${'x'.repeat(50)}  `);
  assert.equal(nameOf(r, calm), 'x'.repeat(40));
  assert.equal(nameOf(s, calm), 'Midweek calm');
  assert.throws(() => renameItem(s, calm, '  '), { message: 'a name is needed' });
  assert.throws(() => renameItem(s, 'nope', 'x'), /isn't in the running order/);
});

test('Basic lights cannot be deleted or moved', () => {
  const s = ready();
  assert.throws(() => deleteItem(s, s.operator.safeLook!), { message: "Basic lights can't be deleted" });
  assert.throws(() => moveItem(s, s.operator.safeLook!, 3), { message: 'Basic lights stays first' });
});

test('Move clamps below Basic lights; delete keeps a look a quick look still uses', () => {
  const s = ready();
  const sermon = s.operator.runningOrder.find((id) => nameOf(s, id) === 'Sermon')!;
  assert.deepEqual(order(moveItem(s, sermon, 0)).slice(0, 3), ['Basic lights', 'Sermon', 'Song 1']);
  assert.deepEqual(order(moveItem(s, look(s, 'Song 1').id, 99)).slice(-2), ['Midweek calm', 'Song 1']);
  assert.deepEqual(order(moveItem(s, look(s, 'Song 1').id, 3)).slice(0, 5), ['Basic lights', 'Song 2', 'Song 3', 'Song 1', 'Song 4']);
  assert.deepEqual(order(s).slice(0, 3), ['Basic lights', 'Song 1', 'Song 2']); // input untouched

  const song = look(s, 'Song 2').id;
  const used = structuredClone(s);
  used.operator.quickLooks.push({ look: song, tab: 'effects' });
  const gone = deleteItem(used, look(used, 'Song 1').id);
  assert.ok(!gone.looks.some((l) => l.name === 'Song 1'));
  assert.ok(!order(gone).includes('Song 1'));
  const kept = deleteItem(used, song);
  assert.ok(!kept.operator.runningOrder.includes(song));
  assert.ok(kept.looks.some((l) => l.id === song));
  assert.deepEqual(checkReferences(gone), []);
  assert.deepEqual(checkReferences(kept), []);
});

test('names are trimmed, cut to 40 characters, and empty names are refused', () => {
  assert.equal(cleanName('  x  '), 'x');
  assert.equal(cleanName('y'.repeat(50)), 'y'.repeat(40));
  assert.throws(() => cleanName('   '), { message: 'a name is needed' });
});

test('Save as quick look sets only the chosen groups and needs at least one', () => {
  const s = ready();
  const stage: Stage = {
    groups: { 'front-lights': firstPreset(s, 'front-lights'), background: livePresetId('background', '#ff0000'), 'key-lights': firstPreset(s, 'key-lights') },
    levels: { background: 0.6 },
  };
  const { show, id } = saveQuickLook(s, { name: ' Red wall ', tab: 'effects', groups: ['background', 'front-lights'] }, stage);
  const l = show.looks.find((x) => x.id === id)!;
  assert.equal(l.name, 'Red wall');
  assert.deepEqual(l.groups.map((e) => e.group).sort(), ['background', 'front-lights']);
  assert.equal(l.groups.find((e) => e.group === 'background')!.level, 0.6);
  assert.deepEqual(show.operator.quickLooks.at(-1), { look: id, tab: 'effects' });
  assert.ok(!show.operator.runningOrder.includes(id));
  assert.deepEqual(checkReferences(show), []);
  assert.throws(() => saveQuickLook(s, { name: 'x', tab: 'plain', groups: [] }, stage), { message: 'pick at least one group' });
  assert.throws(() => saveQuickLook(s, { name: '', tab: 'plain', groups: ['background'] }, stage), { message: 'a name is needed' });
});

test('generated ids are slugs of the name, made unique', () => {
  const s = ready();
  const input = { name: 'Zils / Blue', tab: 'colours' as const, groups: ['background'] };
  const stage: Stage = { groups: { background: firstPreset(s, 'background') }, levels: {} };
  const first = saveQuickLook(s, input, stage);
  const second = saveQuickLook(first.show, input, stage);
  assert.equal(first.id, 'zils-blue');
  assert.equal(second.id, 'zils-blue-2');
});

test('parseShow refuses a running order or quick look naming an unknown look', () => {
  const raw = JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8'));
  assert.throws(() => parseShow({ ...raw, operator: { ...raw.operator, runningOrder: ['nope'] } }), /running order lists unknown look "nope"/);
  assert.throws(() => parseShow({ ...raw, operator: { ...raw.operator, quickLooks: [{ look: 'nope', tab: 'plain' }] } }), /quick looks list unknown look "nope"/);
  assert.throws(() => parseShow({ ...raw, operator: { ...raw.operator, quickLooks: [{ look: 'walk-in', tab: 'nowhere' }] } }));
});

test('removing a look in merge drops it from the running order and quick looks', () => {
  const s = ready();
  const incoming: Show = structuredClone(s);
  const copy = s.operator.runningOrder.find((id) => nameOf(s, id) === 'Sermon')!;
  incoming.looks = incoming.looks.filter((l) => l.id !== copy);
  incoming.operator.runningOrder = incoming.operator.runningOrder.filter((id) => id !== copy);
  const merged = applyPicks(s, incoming, [{ kind: 'look', id: copy, change: 'removed' }]);
  assert.ok(!merged.operator.runningOrder.includes(copy));

  const quick = s.operator.quickLooks.find((q) => nameOf(s, q.look) === 'Sermon')!.look;
  const incoming2: Show = structuredClone(s);
  incoming2.looks = incoming2.looks.filter((l) => l.id !== quick);
  incoming2.operator.quickLooks = incoming2.operator.quickLooks.filter((q) => q.look !== quick);
  const merged2 = applyPicks(s, incoming2, [{ kind: 'look', id: quick, change: 'removed' }]);
  assert.ok(!merged2.operator.quickLooks.some((q) => q.look === quick));
});
