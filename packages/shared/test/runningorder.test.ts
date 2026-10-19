import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addSong, applyPicks, applyQuickLookToItem, setItemGroup, checkReferences, cleanName, deleteItem, ensureBasicLights, ensureRunningOrder, livePresetId, moveItem,
  parseLivePreset, parseShow, renameItem, saveItem, saveQuickLook, setItemTempo, BLACKOUT_PRESET, EffectLayer, SAFE_LIGHT, SAFE_PRESET,
  liveEffectId, parseLiveEffect, type Show, type Stage, type StaticLayer,
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

test('live preset ids carry white, amber and UV as percentages, leaving out the ones at 0', () => {
  const id = livePresetId('key-lights', '#FF0000', { white: 0.4, amber: 0.2, uv: 0 });
  assert.equal(id, 'live:key-lights:#ff0000:w40:a20');
  assert.deepEqual(parseLivePreset(id), { group: 'key-lights', colour: '#ff0000', white: 0.4, amber: 0.2 });
  assert.equal(livePresetId('k', '#000000', { uv: 1 }), 'live:k:#000000:u100');
  assert.deepEqual(parseLivePreset('live:k:#000000:u100'), { group: 'k', colour: '#000000', uv: 1 });
  assert.equal(livePresetId('k', '#000000', { white: 0.333, amber: 0.004 }), 'live:k:#000000:w33');
  assert.equal(livePresetId('k', '#123456', { white: 0, amber: 0, uv: 0 }), 'live:k:#123456');
  // Old ids still read the same.
  assert.deepEqual(parseLivePreset('live:k:#123456'), { group: 'k', colour: '#123456' });
  assert.equal(parseLivePreset('live:k:#123456:a101'), null);
  assert.equal(parseLivePreset('live:k:#123456:a20:w40'), null, 'white, amber, UV in that order');
  assert.equal(parseLivePreset('live:k:#123456:x5'), null);
});

test('Save turns a live colour with white, amber and UV into a custom preset that keeps them', () => {
  const s = ready();
  const stage: Stage = { groups: { 'key-lights': livePresetId('key-lights', '#ff0000', { white: 0.4, amber: 0.25, uv: 0.1 }) }, levels: {} };
  const saved = saveItem(s, look(s, 'Song 1').id, stage);
  const entry = look(saved, 'Song 1').groups[0]!;
  const preset = saved.presets.find((p) => p.id === entry.preset)!;
  assert.equal(preset.custom, true);
  assert.deepEqual(preset.layers, [{ kind: 'static', colour: { hex: '#ff0000', white: 0.4, amber: 0.25, uv: 0.1 }, intensity: 1 }]);
  // The swatch shows the amber and white mixed in, not plain red.
  assert.notEqual(preset.swatch, '#ff0000');
  assert.match(preset.swatch!, /^#ff[0-9a-f]{4}$/);
  assert.deepEqual(checkReferences(saved), []);
  // The saved show still reads.
  assert.deepEqual(parseShow(JSON.parse(JSON.stringify(saved))).presets.find((p) => p.id === preset.id)!.layers, preset.layers);
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

test('Save to Basic lights stores every group at full: Basic lights keeps no dimmer levels', () => {
  const s = ready();
  const target = firstPreset(s, 'background');
  const front = firstPreset(s, 'front-lights');
  const saved = saveItem(s, s.operator.safeLook!, { groups: { background: target, 'front-lights': front }, levels: { background: 0.25, 'front-lights': 0.6 } });
  assert.deepEqual(look(saved, 'Basic lights').groups, [
    { group: 'background', preset: target, level: 1 },
    { group: 'front-lights', preset: front, level: 1 },
  ]);
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

test('Add song numbers after the highest song, and keeps ids unique', () => {
  let s = ready();
  s = deleteItem(s, look(s, 'Song 1').id);
  const { show, id } = addSong(s, s.operator.safeLook!, emptyStage);
  assert.equal(nameOf(show, id), 'Song 6');
  assert.equal(new Set(show.looks.map((l) => l.id)).size, show.looks.length);

  // with no Song names at all, it starts at Song 1
  let bare = ready();
  for (let n = 1; n <= 5; n++) bare = deleteItem(bare, look(bare, `Song ${n}`).id);
  const first = addSong(bare, bare.operator.safeLook!, emptyStage);
  assert.equal(nameOf(first.show, first.id), 'Song 1');
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

test("Save after Basic lights stores the built-in safe light as one reusable Basic light preset", () => {
  let s = ready();
  const stage: Stage = { groups: { 'key-lights': SAFE_PRESET, background: SAFE_PRESET }, levels: { background: 0.5 } };
  s = saveItem(s, look(s, 'Song 1').id, stage);
  const made = s.presets.filter((p) => p.custom);
  assert.equal(made.length, 2, 'one per group');
  for (const p of made) {
    assert.equal(p.name, 'Basic light');
    assert.deepEqual(p.layers, [{ kind: 'static', colour: { hex: SAFE_LIGHT.hex, white: SAFE_LIGHT.white }, intensity: SAFE_LIGHT.intensity }]);
  }
  assert.equal(look(s, 'Song 1').groups.find((e) => e.group === 'background')!.level, 0.5);
  // A second Save, an added song and a quick look use the same presets.
  s = saveItem(s, look(s, 'Song 2').id, stage);
  s = addSong(s, look(s, 'Song 2').id, stage).show;
  s = saveQuickLook(s, { name: 'Calm', tab: 'plain', groups: ['background'] }, stage).show;
  assert.equal(s.presets.filter((p) => p.custom).length, 2);
  const bg = (name: string) => look(s, name).groups.find((e) => e.group === 'background')!.preset;
  assert.equal(bg('Song 2'), bg('Song 1'));
  assert.equal(bg('Calm'), bg('Song 1'));
  assert.deepEqual(checkReferences(s), []);
});

test('a stray Blackout on a group is saved as a dark "Off" preset, reused per group', () => {
  let s = ready();
  const stage: Stage = { groups: { background: BLACKOUT_PRESET }, levels: {} };
  s = saveItem(s, look(s, 'Song 1').id, stage);
  s = saveItem(s, look(s, 'Song 2').id, stage);
  const off = s.presets.filter((p) => p.custom);
  assert.equal(off.length, 1);
  assert.equal(off[0]!.name, 'Off');
  assert.equal(off[0]!.group, 'background');
  assert.ok(off[0]!.layers.every((l) => l.intensity === 0));
  assert.equal(look(s, 'Song 2').groups[0]!.preset, off[0]!.id);
});

test('Basic lights is made again when the show has lost it, and put first', () => {
  const s = ready();
  const songs = s.operator.runningOrder.slice(1);
  const lost = structuredClone(s);
  lost.looks = lost.looks.filter((l) => l.id !== s.operator.safeLook);
  lost.operator.runningOrder = songs;
  lost.operator.safeLook = undefined;
  const fixed = ensureBasicLights(lost);
  const safe = fixed.operator.safeLook!;
  assert.equal(nameOf(fixed, safe), 'Basic lights');
  assert.deepEqual(fixed.looks.find((l) => l.id === safe)!.groups, []);
  assert.deepEqual(fixed.operator.runningOrder, [safe, ...songs]);
  assert.deepEqual(checkReferences(fixed), []);
  assert.equal(lost.operator.safeLook, undefined, 'the input is not changed');
  // A safe look that was cleared but is still in the show is used again, not copied.
  const cleared = structuredClone(s);
  cleared.operator.safeLook = undefined;
  assert.deepEqual(ensureBasicLights(cleared), s);
});

test('Basic lights moves to the front and appears only once', () => {
  const s = ready();
  const [safe, ...songs] = s.operator.runningOrder;
  const middle = structuredClone(s);
  middle.operator.runningOrder = [songs[0]!, songs[1]!, safe!, ...songs.slice(2)];
  assert.deepEqual(ensureBasicLights(middle).operator.runningOrder, s.operator.runningOrder);
  const twice = structuredClone(s);
  twice.operator.runningOrder = [safe!, songs[0]!, safe!, ...songs.slice(1), safe!];
  assert.deepEqual(ensureBasicLights(twice).operator.runningOrder, s.operator.runningOrder);
  const empty = structuredClone(s);
  empty.operator.runningOrder = [];
  assert.deepEqual(ensureBasicLights(empty).operator.runningOrder, [safe]);
  assert.deepEqual(ensureBasicLights(s), s, 'a show that keeps the rule is left as it is');
});

// ---- Preview edits: change one song's group without touching the stage ----

/** A demo show with a running order, and the song at place 1 (Basic lights is first). */
const withSong = () => {
  const s = ensureRunningOrder(demo());
  return { show: s, song: s.operator.runningOrder[1]! };
};
const entryOf = (s: Show, itemId: string, group: string) => s.looks.find((l) => l.id === itemId)!.groups.find((e) => e.group === group);

test('setItemGroup sets a preset and a level in a song, leaving the rest', () => {
  const { show, song } = withSong();
  const before = structuredClone(show);
  const out = setItemGroup(show, song, { group: 'audience', preset: 'aud-blue', level: 0.4 });
  assert.deepEqual(entryOf(out, song, 'audience'), { group: 'audience', preset: 'aud-blue', level: 0.4 });
  const others = (s: Show) => s.looks.find((l) => l.id === song)!.groups.filter((e) => e.group !== 'audience');
  assert.deepEqual(others(out), others(before));
  assert.equal(nameOf(out, song), nameOf(before, song));
  assert.deepEqual(show, before, 'the input show is not changed');
  assert.deepEqual(checkReferences(out), []);
  // The entry stays in its place.
  assert.deepEqual(look(out, 'Song 1').groups.map((e) => e.group), look(before, 'Song 1').groups.map((e) => e.group));
});

test('setItemGroup keeps an Any colour as a new hidden Custom preset, with its amber', () => {
  const { show, song } = withSong();
  const out = setItemGroup(show, song, { group: 'back-wall', colour: '#ff0000', amber: 0.5 });
  assert.equal(out.presets.length, show.presets.length + 1);
  const entry = entryOf(out, song, 'back-wall')!;
  const made = out.presets.find((p) => p.id === entry.preset)!;
  assert.equal(made.custom, true);
  assert.equal(made.name, 'Custom');
  assert.equal(made.group, 'back-wall');
  assert.deepEqual((made.layers[0] as StaticLayer).colour, { hex: '#ff0000', amber: 0.5 });
  assert.deepEqual(checkReferences(out), []);
});

test('setItemGroup changes only the level of a group the song already sets, and adds a group it did not', () => {
  const { show, song } = withSong();
  const dimmed = setItemGroup(show, song, { group: 'audience', level: 0.25 });
  assert.deepEqual(entryOf(dimmed, song, 'audience'), { ...entryOf(show, song, 'audience'), level: 0.25 });
  // A group the song lists first has no entry yet: a preset adds one at the end.
  const bare = structuredClone(show);
  bare.looks.find((l) => l.id === song)!.groups = [];
  const added = setItemGroup(bare, song, { group: 'pulpit', preset: 'pulpit-on' });
  assert.deepEqual(look(added, 'Song 1').groups, [{ group: 'pulpit', preset: 'pulpit-on', level: 1 }]);
});

test('setItemGroup refuses a level for a group the song does not set, smoke, quick looks and both preset and colour', () => {
  const { show, song } = withSong();
  const bare = structuredClone(show);
  bare.looks.find((l) => l.id === song)!.groups = [];
  assert.throws(() => setItemGroup(bare, song, { group: 'audience', level: 0.5 }), { message: 'Give the group a colour first.' });
  assert.throws(() => setItemGroup(show, 'walk-in', { group: 'audience', level: 0.5 }), { message: 'only running-order items can be changed here' });
  assert.throws(() => setItemGroup(show, 'nope', { group: 'audience', level: 0.5 }), { message: 'only running-order items can be changed here' });
  assert.throws(() => setItemGroup(show, song, { group: 'ghost', level: 0.5 }), { message: 'the show has no group "ghost"' });
  const smoky = structuredClone(show);
  smoky.groups.find((g) => g.id === 'pulpit')!.kind = 'smoke';
  assert.throws(() => setItemGroup(smoky, song, { group: 'pulpit', level: 0.5 }), { message: "smoke machines aren't part of a song" });
  assert.throws(() => setItemGroup(show, song, { group: 'audience', preset: 'aud-blue', colour: '#ff0000' }), { message: 'pick a colour, a preset or an effect, not more than one' });
  const wave = EffectLayer.parse({ kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }], speed: { beats: 4 } });
  assert.throws(() => setItemGroup(show, song, { group: 'audience', preset: 'aud-blue', effect: wave }), { message: 'pick a colour, a preset or an effect, not more than one' });
  assert.throws(() => setItemGroup(show, song, { group: 'audience', colour: '#ff0000', effect: wave }), { message: 'pick a colour, a preset or an effect, not more than one' });
  assert.throws(() => setItemGroup(show, song, { group: 'audience' }), { message: 'nothing to change' });
  assert.throws(() => setItemGroup(show, song, { group: 'audience', preset: 'pulpit-on' }), { message: 'unknown preset "pulpit-on" for group "audience"' });
  assert.throws(() => setItemGroup(show, song, { group: 'audience', preset: 'nope' }), { message: 'unknown preset "nope" for group "audience"' });
});

test('Basic lights keeps its levels at full in setItemGroup and applyQuickLookToItem', () => {
  const { show } = withSong();
  const basic = show.operator.safeLook!;
  const withPreset = setItemGroup(show, basic, { group: 'audience', preset: 'aud-blue', level: 0.3 });
  assert.equal(entryOf(withPreset, basic, 'audience')!.level, 1);
  const withColour = setItemGroup(show, basic, { group: 'audience', colour: '#00ff00', level: 0.3 });
  assert.equal(entryOf(withColour, basic, 'audience')!.level, 1);
  const quick = structuredClone(show);
  quick.looks.find((l) => l.id === quick.operator.quickLooks[0]!.look)!.groups.forEach((e) => { e.level = 0.2; });
  const out = applyQuickLookToItem(quick, basic, quick.operator.quickLooks[0]!.look);
  for (const e of out.looks.find((l) => l.id === basic)!.groups) assert.equal(e.level, 1);
  assert.ok(out.looks.find((l) => l.id === basic)!.groups.length > 0);
});

test('applyQuickLookToItem copies only the groups the quick look lists', () => {
  const { show, song } = withSong();
  const quickId = show.operator.quickLooks[0]!.look;
  // A quick look that lists two of the song's four groups, one of them dimmed.
  const quick = structuredClone(show);
  quick.looks.find((l) => l.id === quickId)!.groups = [
    { group: 'front-wash', preset: 'front-dim', level: 0.6 },
    { group: 'audience', preset: 'aud-blue' },
  ];
  const before = structuredClone(quick);
  const out = applyQuickLookToItem(quick, song, quickId);
  assert.deepEqual(entryOf(out, song, 'front-wash'), { group: 'front-wash', preset: 'front-dim', level: 0.6 });
  assert.deepEqual(entryOf(out, song, 'audience'), { group: 'audience', preset: 'aud-blue', level: 1 });
  for (const group of ['back-wall', 'pulpit']) assert.deepEqual(entryOf(out, song, group), entryOf(before, song, group));
  assert.deepEqual(quick, before, 'the input show is not changed');
  assert.deepEqual(checkReferences(out), []);
  assert.throws(() => applyQuickLookToItem(show, song, song), { message: 'that is not a quick look' });
  assert.throws(() => applyQuickLookToItem(show, 'walk-in', quickId), { message: 'only running-order items can be changed here' });
});

test('applyQuickLookToItem skips a smoke group an older quick look lists', () => {
  const { show, song } = withSong();
  const quickId = show.operator.quickLooks[0]!.look;
  const quick = structuredClone(show);
  quick.groups.find((g) => g.id === 'pulpit')!.kind = 'smoke';
  quick.looks.find((l) => l.id === quickId)!.groups = [
    { group: 'front-wash', preset: 'front-dim', level: 0.6 },
    { group: 'pulpit', preset: firstPreset(quick, 'pulpit') },
  ];
  const songBefore = entryOf(quick, song, 'pulpit');
  const out = applyQuickLookToItem(quick, song, quickId);
  assert.deepEqual(entryOf(out, song, 'front-wash'), { group: 'front-wash', preset: 'front-dim', level: 0.6 });
  assert.deepEqual(entryOf(out, song, 'pulpit'), songBefore, 'the smoke group is left as it was');
});

// ---- Effects and tempo in songs ----

const wave = () => EffectLayer.parse({
  kind: 'effect', effect: 'wave', colours: [{ hex: '#1F3BFF' }, { hex: '#7a2bff', white: 0.2 }], speed: { beats: 4 }, waves: 3,
});

test('live effect ids name their group and count up', () => {
  assert.equal(liveEffectId('back-wall', 7), 'fx:back-wall:7');
  assert.deepEqual(parseLiveEffect('fx:back-wall:7'), { group: 'back-wall', n: 7 });
  assert.equal(parseLiveEffect('fx:back-wall'), null);
  assert.equal(parseLiveEffect('fx:back-wall:x'), null);
  assert.equal(parseLiveEffect('live:back-wall:#123456'), null);
});

test('Save turns a live effect into a hidden "Custom effect" preset, and keeps the stage tempo', () => {
  const { show, song } = withSong();
  const id = liveEffectId('back-wall', 3);
  const stage: Stage = { groups: { 'back-wall': id }, levels: { 'back-wall': 0.5 }, effects: { [id]: wave() }, tempo: 97 };
  const saved = saveItem(show, song, stage);
  const entry = entryOf(saved, song, 'back-wall')!;
  assert.equal(entry.level, 0.5);
  assert.ok(!entry.preset.startsWith('fx:'));
  const made = saved.presets.find((p) => p.id === entry.preset)!;
  assert.deepEqual(made, { id: made.id, name: 'Custom effect', group: 'back-wall', custom: true, layers: [wave()], swatch: '#1f3bff', fade: 3 });
  assert.equal(saved.looks.find((l) => l.id === song)!.tempo, 97);
  assert.deepEqual(checkReferences(saved), []);
  assert.deepEqual(parseShow(JSON.parse(JSON.stringify(saved))).presets.find((p) => p.id === made.id), made);
  // A Save without a tempo leaves the song's own.
  assert.equal(saveItem(saved, song, { groups: {}, levels: {} }).looks.find((l) => l.id === song)!.tempo, 97);
  // A live effect the stage doesn't describe can't be saved.
  assert.throws(() => saveItem(show, song, { groups: { 'back-wall': id }, levels: {} }), { message: `the show has no preset "${id}"` });
  // Nor one of another group.
  const other = liveEffectId('audience', 4);
  assert.throws(() => saveItem(show, song, { groups: { 'back-wall': other }, levels: {}, effects: { [other]: wave() } }), { message: `preset "${other}" belongs to another group` });
});

test('Add song takes the stage tempo too', () => {
  const { show, song } = withSong();
  const { show: out, id } = addSong(show, song, { groups: {}, levels: {}, tempo: 150 });
  assert.equal(out.looks.find((l) => l.id === id)!.tempo, 150);
});

test('setItemGroup keeps an effect as a new hidden "Custom effect" preset', () => {
  const { show, song } = withSong();
  const out = setItemGroup(show, song, { group: 'back-wall', effect: wave(), level: 0.7 });
  assert.equal(out.presets.length, show.presets.length + 1);
  const entry = entryOf(out, song, 'back-wall')!;
  assert.equal(entry.level, 0.7);
  const made = out.presets.find((p) => p.id === entry.preset)!;
  assert.equal(made.custom, true);
  assert.equal(made.name, 'Custom effect');
  assert.deepEqual(made.layers, [wave()]);
  assert.deepEqual(checkReferences(out), []);
});

test('setItemTempo changes the tempo of a song and nothing else', () => {
  const { show, song } = withSong();
  const before = structuredClone(show);
  const out = setItemTempo(show, song, 132);
  assert.equal(out.looks.find((l) => l.id === song)!.tempo, 132);
  assert.deepEqual({ ...out.looks.find((l) => l.id === song)!, tempo: undefined }, { ...before.looks.find((l) => l.id === song)!, tempo: undefined });
  assert.deepEqual(show, before, 'the input show is not changed');
  assert.throws(() => setItemTempo(show, 'walk-in', 100), { message: 'only running-order items can be changed here' });
  assert.throws(() => setItemTempo(show, song, 39), { message: 'the tempo is 40 to 240 beats per minute' });
  assert.throws(() => setItemTempo(show, song, 241), { message: 'the tempo is 40 to 240 beats per minute' });
});
