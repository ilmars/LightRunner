import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  anchorOf, checkReferences, copyLookToItem, deleteItem, saveServiceItem, ensureBasicLights, ensurePlanning, ensureRunningOrder, itemKind, loadService, moveItem, newSongLookOf, parseShow, rememberKey,
  serviceRows, toPlannedService, type PlannedService, type ServiceItem, type Show,
} from '../src/index.ts';

const SONG = '4eb2c1d0-1111-4222-8333-944455566677';

test('item kinds are told apart as the planning service stores them', () => {
  assert.equal(itemKind({ cue_type: 'g', cue_name: 'Vārds' }), 'header');
  assert.equal(itemKind({ cue_type: null, cue_foreground: { type: 'text', text: '76660120-d242-4862-b351-11728b463fd3' } }), 'song');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'bible', data: {} }, cue_background: { type: 'media' } }), 'verse');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'slides', presentation: {} } }), 'slides');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: '' }, cue_background: { type: 'media' } }), 'media');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: '' }, cue_background: { type: '' }, displayName: '[blank]' }), 'blank');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'text', text: '' }, displayName: '[blank]' }), 'blank');
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'countdown' } }), 'other');
});

const doc = () => ({
  service: { times: [{ time: '2026-10-25T08:00:00' }] },
  data: {
    cues: [
      { cue_id: 'c1', cue_type: 'g', cue_name: 'Ievads', displayName: '' },
      { cue_id: 'c2', cue_type: null, cue_name: 'Klints', displayName: 'Klints uz mūžiem (Nav tādas klints)', cue_foreground: { type: 'text', text: SONG } },
      { cue_id: 'c3', cue_type: '', cue_name: 'Psalmi 23:3 L1', cue_foreground: { type: 'bible', data: {} } },
    ],
    songMeta: { c2: { key: 'D' } },
  },
});

test('a planned service keeps the order, names, song ids, the service key and the song tempo', () => {
  const songs = new Map<string, unknown>([[SONG, { name: 'Klints', data: { tempo: 141, defaultKey: 'C' } }]]);
  const service = toPlannedService('svc1', doc(), songs, 'Rīga - Svētdienas Dievkalpojums');
  assert.equal(service.id, 'svc1');
  assert.equal(service.title, 'Rīga - Svētdienas Dievkalpojums');
  assert.equal(service.start, '2026-10-25T08:00:00');
  assert.deepEqual(service.items.map((i) => i.kind), ['header', 'song', 'verse']);
  assert.equal(service.items[0].name, 'Ievads');
  assert.deepEqual(service.items[1], { key: 'c2', kind: 'song', name: 'Klints uz mūžiem (Nav tādas klints)', songId: SONG, tempo: 141 });
  assert.equal(service.items[2].name, 'Psalmi 23:3 L1');
});

test('a song tempo outside 40-240 is left out', () => {
  for (const tempo of [300, 10, 0]) {
    const songs = new Map<string, unknown>([[SONG, { name: 'Klints', data: { tempo } }]]);
    const service = toPlannedService('svc1', doc(), songs, 'T');
    assert.equal('tempo' in service.items[1], false);
  }
});

test('a song missing from the library keeps its id and falls back to the cue name', () => {
  const service = toPlannedService('svc1', { data: { cues: [{ cue_id: 'c2', cue_name: ' Klints ', cue_foreground: { type: 'text', text: SONG } }] } }, new Map(), 'T');
  assert.deepEqual(service.items[0], { key: 'c2', kind: 'song', name: 'Klints', songId: SONG });
  assert.equal(service.start, '');
});

test('names are trimmed and cut to 200 characters', () => {
  const long = ` ${'x'.repeat(300)} `;
  const service = toPlannedService('s', { data: { cues: [{ cue_id: 'c1', cue_type: 'g', cue_name: long }] } }, new Map(), 'T');
  assert.equal(service.items[0].name, 'x'.repeat(200));
});

test('remember keys: songs by id, headers and slides by name, verses and blanks never', () => {
  assert.equal(rememberKey({ key: 'a', kind: 'song', name: 'X', songId: 's1' }), 'song:s1');
  assert.equal(rememberKey({ key: 'b', kind: 'header', name: 'Vārds' }), 'header:Vārds');
  assert.equal(rememberKey({ key: 'c', kind: 'slides', name: 'Draudzes Nedēļas Aktivitātes' }), 'item:Draudzes Nedēļas Aktivitātes');
  assert.equal(rememberKey({ key: 'd', kind: 'verse', name: 'Psalmi 23:3 L1' }), null);
  assert.equal(rememberKey({ key: 'e', kind: 'blank', name: '[blank]' }), null);
});

// ---- Loading a service into the show ----

const rig = (): Show => ensureBasicLights(ensureRunningOrder(parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')))));

const song = (key: string, name: string, tempo?: number): ServiceItem => ({
  key: `cue-${key}-${name}`, kind: 'song', name, songId: `song-${key}`, ...(tempo === undefined ? {} : { tempo }),
});
const header = (name: string): ServiceItem => ({ key: `cue-h-${name}`, kind: 'header', name });
const verse = (name: string): ServiceItem => ({ key: `cue-v-${name}`, kind: 'verse', name });
const blank = (): ServiceItem => ({ key: 'cue-b', kind: 'blank', name: '[blank]' });
const planned = (items: ServiceItem[], id = 'svc1'): PlannedService => ({ id, title: 'Sunday', start: '2026-10-25T08:00:00', items });

const lookOf = (s: Show, id: string) => s.looks.find((l) => l.id === id)!;
const safeOf = (s: Show) => s.operator.safeLook!;

test('loading puts Basic lights first, then the service\'s looks in order', () => {
  const show = rig();
  const out = loadService(show, planned([header('Ievads'), song('a', 'A'), verse('Psalmi 23:3'), header('Vārds'), blank(), song('b', 'B')]));
  const [first, a, b, ...more] = out.operator.runningOrder;
  assert.equal(first, safeOf(show));
  assert.equal(more.length, 0);
  assert.equal(out.operator.service!.items[0]!.look, undefined);
  assert.equal(out.operator.service!.items[1]!.look, a);
  assert.equal(out.operator.service!.items[5]!.look, b);
  assert.equal(out.operator.remembered!['song:song-a'], a);
  assert.equal(out.operator.remembered!['song:song-b'], b);
  assert.equal(lookOf(out, a!).name, 'A');
  assert.equal(lookOf(out, b!).name, 'B');
  assert.deepEqual(checkReferences(out), []);
  parseShow(out);
});

test('a new song gets a copy of the first quick look, named and with the song\'s tempo', () => {
  const show = rig();
  const quick = show.operator.quickLooks.find((q) => q.tab === 'plain') ?? show.operator.quickLooks[0]!;
  const expected = newSongLookOf(show)!;
  assert.equal(expected, quick.look);
  const out = loadService(show, planned([song('a', 'Klints', 141)]));
  const id = out.operator.runningOrder[1]!;
  const made = lookOf(out, id);
  assert.notEqual(id, expected);
  assert.deepEqual(made.groups, lookOf(show, expected).groups);
  assert.notEqual(made.groups, lookOf(out, expected).groups);
  assert.equal(made.name, 'Klints');
  assert.equal(made.tempo, 141);
  // The quick look itself is untouched.
  assert.deepEqual(lookOf(out, expected), lookOf(show, expected));
});

test('a new song without a tempo has none, and a long name is cut to a look name', () => {
  const out = loadService(rig(), planned([song('a', `  ${'x'.repeat(100)}  `)]));
  const made = lookOf(out, out.operator.runningOrder[1]!);
  assert.equal(made.tempo, undefined);
  assert.equal(made.name, 'x'.repeat(40));
});

test('a show with no quick look gives a new song an empty look', () => {
  const show = rig();
  show.operator.quickLooks = [];
  assert.equal(newSongLookOf(show), undefined);
  const out = loadService(show, planned([song('a', 'A')]));
  assert.deepEqual(lookOf(out, out.operator.runningOrder[1]!).groups, []);
});

test('a remembered song gets its own look back, renamed to the planned name', () => {
  const first = loadService(rig(), planned([song('a', 'Old name', 100)]));
  const id = first.operator.runningOrder[1]!;
  const edited = structuredClone(first);
  lookOf(edited, id).groups = [];
  const out = loadService(edited, planned([song('a', 'New name', 150)], 'svc2'));
  assert.deepEqual(out.operator.runningOrder, [safeOf(first), id]);
  assert.equal(lookOf(out, id).name, 'New name');
  assert.deepEqual(lookOf(out, id).groups, []);
  assert.equal(out.operator.service!.id, 'svc2');
});

test('Basic lights is never touched by a load', () => {
  const show = rig();
  const before = structuredClone(lookOf(show, safeOf(show)));
  const out = loadService(show, planned([song('a', 'Basic lights'), song('b', 'B')]));
  assert.equal(out.operator.runningOrder[0], safeOf(show));
  assert.equal(out.operator.safeLook, safeOf(show));
  assert.deepEqual(lookOf(out, safeOf(show)), before);
  const own = out.operator.service!.items[0]!.look!;
  assert.notEqual(own, safeOf(show));
  assert.equal(lookOf(out, own).name, 'Basic lights');
  assert.equal(out.operator.runningOrder.filter((id) => id === safeOf(show)).length, 1);
  // Loading again, with the song gone, still leaves it alone.
  const again = loadService(out, planned([]));
  assert.deepEqual(lookOf(again, safeOf(show)), before);
  assert.deepEqual(again.operator.runningOrder, [safeOf(show)]);
});

test('a remembered entry that points at Basic lights is not used', () => {
  const show = rig();
  show.operator.remembered = { 'song:song-a': safeOf(show) };
  const out = loadService(show, planned([song('a', 'A')]));
  assert.notEqual(out.operator.service!.items[0]!.look, safeOf(show));
  assert.equal(lookOf(out, safeOf(show)).name, lookOf(show, safeOf(show)).name);
});

test('old songs that nothing remembers are removed; quick looks and remembered looks stay', () => {
  const show = rig();
  const oldSongs = show.operator.runningOrder.filter((id) => id !== safeOf(show));
  assert.ok(oldSongs.length > 3);
  const quickIds = show.operator.quickLooks.map((q) => q.look);
  const first = loadService(show, planned([song('a', 'A'), song('b', 'B')]));
  for (const id of oldSongs) assert.equal(first.looks.some((l) => l.id === id), false, id);
  for (const id of quickIds) assert.equal(first.looks.some((l) => l.id === id), true, id);
  const a = first.operator.service!.items[0]!.look!;
  // A is not in the next service: its look stays, hidden, because it is remembered.
  const second = loadService(first, planned([song('b', 'B')], 'svc2'));
  assert.equal(second.operator.runningOrder.includes(a), false);
  assert.equal(second.looks.some((l) => l.id === a), true);
  assert.equal(second.operator.remembered!['song:song-a'], a);
});

test('a look on the order that is also a quick look stays when the service no longer lists it', () => {
  const show = rig();
  const quick = show.operator.quickLooks[0]!.look;
  show.operator.runningOrder.push(quick);
  const out = loadService(show, planned([song('a', 'A')]));
  assert.equal(out.looks.some((l) => l.id === quick), true);
  assert.equal(out.operator.runningOrder.includes(quick), false);
});

test('a song planned twice has its look once in the running order', () => {
  const out = loadService(rig(), planned([song('a', 'A'), song('b', 'B'), song('a', 'A')]));
  const items = out.operator.service!.items;
  assert.equal(items[0]!.look, items[2]!.look);
  assert.ok(items[0]!.look);
  assert.deepEqual(out.operator.runningOrder, [safeOf(out), items[0]!.look, items[1]!.look]);
});

test('two different songs with the same name get two looks', () => {
  const out = loadService(rig(), planned([song('a', 'Same'), song('b', 'Same')]));
  const [x, y] = out.operator.service!.items.map((i) => i.look);
  assert.notEqual(x, y);
  assert.equal(new Set(out.looks.map((l) => l.id)).size, out.looks.length);
});

test('loading again keeps remembered looks', () => {
  const s1 = planned([song('a', 'A'), song('b', 'B'), song('c', 'C')]);
  const first = loadService(rig(), s1);
  const ids = Object.fromEntries(first.operator.service!.items.map((i) => [i.songId!, i.look!]));
  const s2 = planned([song('c', 'C'), song('b', 'B'), song('d', 'D')], 'svc2');
  const second = loadService(first, s2);
  const items = second.operator.service!.items;
  assert.equal(items[0]!.look, ids['song-c']);
  assert.equal(items[1]!.look, ids['song-b']);
  assert.notEqual(items[2]!.look, ids['song-a']);
  assert.deepEqual(second.operator.runningOrder, [safeOf(second), ids['song-c'], ids['song-b'], items[2]!.look]);
  assert.equal(second.operator.remembered!['song:song-a'], ids['song-a']);
  parseShow(second);
});

test('headers and slides that were given a look come back with it; with none they get no look', () => {
  const show = rig();
  const own = show.operator.quickLooks[0]!.look;
  show.operator.remembered = { 'header:Vārds': own };
  const slides: ServiceItem = { key: 's1', kind: 'slides', name: 'Notikumi' };
  const out = loadService(show, planned([header('Vārds'), header('Ievads'), slides]));
  const items = out.operator.service!.items;
  assert.equal(items[0]!.look, own);
  assert.equal(items[1]!.look, undefined);
  assert.equal(items[2]!.look, undefined);
  assert.deepEqual(out.operator.runningOrder, [safeOf(out), own]);
  assert.equal(lookOf(out, own).name, 'Vārds');
});

test('deleting a song\'s look forgets it', () => {
  const loaded = loadService(rig(), planned([song('a', 'A'), song('b', 'B')]));
  const a = loaded.operator.service!.items[0]!.look!;
  const b = loaded.operator.service!.items[1]!.look!;
  const out = deleteItem(loaded, a);
  assert.equal(out.operator.remembered!['song:song-a'], undefined);
  assert.equal(out.operator.service!.items[0]!.look, undefined);
  assert.equal(out.operator.remembered!['song:song-b'], b);
  assert.equal(out.operator.service!.items[1]!.look, b);
  parseShow(ensurePlanning(out));
});

test('ensurePlanning drops what points at a look that is gone', () => {
  const loaded = loadService(rig(), planned([song('a', 'A'), song('b', 'B')]));
  const a = loaded.operator.service!.items[0]!.look!;
  const stale = structuredClone(loaded);
  stale.looks = stale.looks.filter((l) => l.id !== a);
  stale.operator.runningOrder = stale.operator.runningOrder.filter((id) => id !== a);
  stale.settings.planning = { enabled: true, newSongLook: a };
  const out = parseShow(ensurePlanning(stale));
  assert.equal(out.operator.remembered!['song:song-a'], undefined);
  assert.equal(out.operator.service!.items[0]!.look, undefined);
  assert.equal(out.operator.service!.items[0]!.name, 'A');
  assert.equal(out.settings.planning!.newSongLook, undefined);
  assert.equal(out.settings.planning!.enabled, true);
  assert.equal(out.operator.remembered!['song:song-b'], stale.operator.remembered!['song:song-b']);
});

test('ensurePlanning leaves a show with no planning alone', () => {
  const show = rig();
  assert.deepEqual(ensurePlanning(show), show);
});

test('the chosen look for new songs is used when it exists, the first quick look otherwise', () => {
  const show = rig();
  const quick = show.operator.quickLooks;
  assert.ok(quick.length > 2);
  const chosen = quick[quick.length - 1]!.look;
  const withChoice = structuredClone(show);
  withChoice.settings.planning = { enabled: true, newSongLook: chosen };
  assert.equal(newSongLookOf(withChoice), chosen);
  const out = loadService(withChoice, planned([song('a', 'A')]));
  assert.deepEqual(lookOf(out, out.operator.service!.items[0]!.look!).groups, lookOf(show, chosen).groups);

  const gone = structuredClone(show);
  gone.settings.planning = { enabled: true, newSongLook: 'no-such-look' };
  assert.equal(newSongLookOf(gone), newSongLookOf(show));
});

test('the first quick look is taken tab by tab: plain, colours, then effects', () => {
  const show = rig();
  const [a, b] = show.operator.quickLooks;
  show.operator.quickLooks = [{ look: a!.look, tab: 'effects' }, { look: b!.look, tab: 'colours' }];
  assert.equal(newSongLookOf(show), b!.look);
  show.operator.quickLooks = [{ look: a!.look, tab: 'effects' }];
  assert.equal(newSongLookOf(show), a!.look);
});

test('the look chosen for new songs stays when it is on the order and not remembered', () => {
  const show = rig();
  const inOrder = show.operator.runningOrder[1]!;
  show.operator.quickLooks = [];
  show.settings.planning = { enabled: true, newSongLook: inOrder };
  const out = loadService(show, planned([song('a', 'A')]));
  assert.equal(out.looks.some((l) => l.id === inOrder), true);
  assert.deepEqual(lookOf(out, out.operator.service!.items[0]!.look!).groups, lookOf(show, inOrder).groups);
});

test('a service with no songs leaves Basic lights alone in the order', () => {
  const out = loadService(rig(), planned([header('Ievads'), verse('Psalmi 23:3'), blank()]));
  assert.deepEqual(out.operator.runningOrder, [safeOf(out)]);
  assert.equal(out.operator.service!.items.length, 3);
  assert.equal(out.operator.service!.items.every((i) => i.look === undefined), true);
});

test('loading never changes the show it was given', () => {
  const show = rig();
  const copy = structuredClone(show);
  loadService(show, planned([song('a', 'A')]));
  assert.deepEqual(show, copy);
});

// ---- The rows the running order shows ----

const label = (r: ReturnType<typeof serviceRows>[number]) => (r.kind === 'look' ? r.look : r.kind);

/** A service like 18 Oct: two headers (Slavēšana has a look of its own), songs, a blank and 18 verses. */
function october(): { show: Show; a: string; b: string; slav: string } {
  const rigged = rig();
  rigged.operator.remembered = { 'header:Slavēšana': rigged.operator.quickLooks[0]!.look };
  const verses = Array.from({ length: 18 }, (_, n) => verse(`Psalmi ${n + 1}`));
  const show = loadService(rigged, planned([header('Ievads'), header('Slavēšana'), song('a', 'A'), blank(), song('b', 'B'), ...verses, header('Vārds')]));
  const [, slav, a, b] = show.operator.runningOrder;
  return { show, slav: slav!, a: a!, b: b! };
}

test('without a service the rows are the running order', () => {
  const show = rig();
  assert.equal(show.operator.service, undefined);
  assert.deepEqual(serviceRows(show), show.operator.runningOrder.map((look) => ({ kind: 'look', look, header: false })));
});

test('the 18 Oct service gives labels, songs, muted items and one folded verse row', () => {
  const { show, slav, a, b } = october();
  const rows = serviceRows(show);
  assert.deepEqual(rows.map(label), [safeOf(show), 'header', slav, a, 'item', b, 'verses', 'header']);
  assert.deepEqual(rows[0], { kind: 'look', look: safeOf(show), header: false });
  assert.deepEqual(rows[1], { kind: 'header', key: 'cue-h-Ievads', name: 'Ievads' });
  assert.deepEqual(rows[2], { kind: 'look', look: slav, header: true });
  assert.deepEqual(rows[3], { kind: 'look', look: a, header: false });
  assert.deepEqual(rows[4], { kind: 'item', key: 'cue-b', name: '[blank]', itemKind: 'blank' });
  const verses = rows[6]!;
  assert.equal(verses.kind === 'verses' && verses.keys.length, 18);
  assert.equal(verses.kind === 'verses' && verses.names.length, 18);
  assert.equal(verses.kind === 'verses' && verses.names[0], 'Psalmi 1');
  assert.deepEqual(rows[7], { kind: 'header', key: 'cue-h-Vārds', name: 'Vārds' });
});

test('verses split by another item make separate runs', () => {
  const show = loadService(rig(), planned([verse('V1'), verse('V2'), blank(), verse('V3')]));
  const rows = serviceRows(show);
  assert.deepEqual(rows.map(label), [safeOf(show), 'verses', 'item', 'verses']);
  assert.deepEqual(rows[1], { kind: 'verses', keys: ['cue-v-V1', 'cue-v-V2'], names: ['V1', 'V2'] });
});

test('rows keep every look once and in running-order order after Edit list moves', () => {
  const { show, slav, a, b } = october();
  const moved = moveItem(show, b, 1);
  assert.deepEqual(moved.operator.runningOrder, [safeOf(show), b, slav, a]);
  const rows = serviceRows(moved);
  assert.deepEqual(rows.filter((r) => r.kind === 'look').map(label), moved.operator.runningOrder);
  // The verses and Vārds follow B, the blank follows A, Ievads stays after Basic lights.
  assert.deepEqual(rows.map(label), [safeOf(show), 'header', b, 'verses', 'header', slav, a, 'item']);
});

test('a deleted anchor moves its muted items up to the next look above', () => {
  const { show, slav, a, b } = october();
  const out = deleteItem(show, a);
  const rows = serviceRows(out);
  // A is gone: its song item has no look now, and it and the blank follow Slavēšana.
  assert.deepEqual(rows.map(label), [safeOf(show), 'header', slav, 'item', 'item', b, 'verses', 'header']);
  assert.deepEqual(rows[3], { kind: 'item', key: 'cue-a-A', name: 'A', itemKind: 'song' });
  assert.equal(anchorOf(out, 'cue-b'), slav);
});

test('a repeated song is an item row with its look', () => {
  const again: ServiceItem = { key: 'cue-again', kind: 'song', name: 'A', songId: 'song-a' };
  const show = loadService(rig(), planned([song('a', 'A'), header('Vārds'), again]));
  const a = show.operator.runningOrder[1]!;
  const rows = serviceRows(show);
  assert.deepEqual(rows.map(label), [safeOf(show), a, 'header', 'item']);
  assert.deepEqual(rows[3], { kind: 'item', key: 'cue-again', name: 'A', itemKind: 'song', look: a });
  // The look keeps its one row.
  assert.equal(rows.filter((r) => r.kind === 'look').length, 2);
});

test('looks added by hand stay where the running order has them', () => {
  const { show, slav } = october();
  const quick = show.operator.quickLooks.find((q) => q.look !== slav)!.look;
  show.operator.runningOrder.splice(3, 0, quick);
  const rows = serviceRows(show);
  assert.deepEqual(rows.filter((r) => r.kind === 'look').map(label), show.operator.runningOrder);
  assert.deepEqual(rows.find((r) => r.kind === 'look' && r.look === quick), { kind: 'look', look: quick, header: false });
});

test('anchorOf gives the nearest look above in the order, else Basic lights', () => {
  const { show, slav, a, b } = october();
  assert.equal(anchorOf(show, 'cue-h-Ievads'), safeOf(show));
  assert.equal(anchorOf(show, 'cue-b'), a);
  assert.equal(anchorOf(show, 'cue-v-Psalmi 18'), b);
  assert.equal(anchorOf(show, 'cue-h-Vārds'), b);
  // A key the service does not have sits after Basic lights.
  assert.equal(anchorOf(show, 'nope'), safeOf(show));
  // With A out of the order, the blank follows Slavēšana; with Slavēšana out too, Basic lights.
  const noA = structuredClone(show);
  noA.operator.runningOrder = noA.operator.runningOrder.filter((x) => x !== a);
  assert.equal(anchorOf(noA, 'cue-b'), slav);
  const noSlav = structuredClone(noA);
  noSlav.operator.runningOrder = noSlav.operator.runningOrder.filter((x) => x !== slav);
  assert.equal(anchorOf(noSlav, 'cue-b'), safeOf(show));
  // Without a service everything sits after Basic lights.
  assert.equal(anchorOf(rig(), 'cue-b'), safeOf(show));
});

// ---- Saving to items that have no look, and another look for a song ----

/** A stage showing a look's groups, as the engine would report it. */
const stageOf = (show: Show, id: string, tempo?: number) => {
  const groups = lookOf(show, id).groups;
  return {
    groups: Object.fromEntries(groups.map((e) => [e.group, e.preset])),
    levels: Object.fromEntries(groups.map((e) => [e.group, e.level ?? 1])),
    ...(tempo === undefined ? {} : { tempo }),
  };
};

test('saveServiceItem gives slides a look after their anchor, remembered for the next load', () => {
  const show = rig();
  const slides: ServiceItem = { key: 's1', kind: 'slides', name: 'Welcome slides' };
  const service = planned([header('Ievads'), song('a', 'A'), slides, song('b', 'B')]);
  const loaded = loadService(show, service);
  const [, a, b] = loaded.operator.runningOrder;
  assert.equal(anchorOf(loaded, 's1'), a);
  const quick = show.operator.quickLooks[1]!.look;
  const copy = structuredClone(loaded);

  const out = saveServiceItem(loaded, 's1', stageOf(loaded, quick, 120));
  assert.deepEqual(loaded, copy, 'the show it was given is untouched');
  const made = out.operator.service!.items[2]!.look!;
  assert.ok(made);
  assert.deepEqual(out.operator.runningOrder, [safeOf(out), a, made, b], 'right after its anchor');
  assert.equal(lookOf(out, made).name, 'Welcome slides');
  assert.equal(lookOf(out, made).tempo, 120);
  assert.deepEqual(lookOf(out, made).groups, lookOf(loaded, quick).groups.map((e) => ({ ...e, level: e.level ?? 1 })));
  assert.equal(out.operator.remembered!['item:Welcome slides'], made);
  assert.deepEqual(checkReferences(out), []);
  parseShow(out);
  // The slides own their row now, and what follows them sits after it.
  assert.deepEqual(serviceRows(out).filter((r) => r.kind === 'look').map(label), [safeOf(out), a, made, b]);

  // Next Sunday's load gives the slides that look back; the other items are as before.
  const next = loadService(out, planned([song('a', 'A'), slides], 'svc2'));
  assert.equal(next.operator.service!.items[1]!.look, made);
  assert.deepEqual(next.operator.runningOrder, [safeOf(next), a, made]);
});

test('saveServiceItem puts a header look after the look above it, Basic lights first of all', () => {
  const loaded = loadService(rig(), planned([header('Ievads'), song('a', 'A'), header('Vārds')]));
  const a = loaded.operator.runningOrder[1]!;
  const quick = loaded.operator.quickLooks[0]!.look;
  const first = saveServiceItem(loaded, 'cue-h-Ievads', stageOf(loaded, quick));
  assert.deepEqual(first.operator.runningOrder, [safeOf(first), first.operator.service!.items[0]!.look, a]);
  assert.equal(first.operator.remembered!['header:Ievads'], first.operator.service!.items[0]!.look);
  const both = saveServiceItem(first, 'cue-h-Vārds', stageOf(first, quick));
  assert.equal(both.operator.runningOrder.at(-1), both.operator.service!.items[2]!.look);
  assert.equal(both.operator.runningOrder.length, 4);
});

test('saveServiceItem refuses verses, blanks and items that have a look', () => {
  const loaded = loadService(rig(), planned([song('a', 'A'), header('Vārds'), verse('Psalmi 23:3'), blank()]));
  const stage = stageOf(loaded, loaded.operator.quickLooks[0]!.look);
  assert.throws(() => saveServiceItem(loaded, 'cue-v-Psalmi 23:3', stage), { message: "Verses don't change the lights." });
  assert.throws(() => saveServiceItem(loaded, 'cue-b', stage), { message: "Blanks use their part's look." });
  assert.throws(() => saveServiceItem(loaded, 'cue-a-A', stage), { message: 'A already has a look: use Save to A.' });
  assert.throws(() => saveServiceItem(loaded, 'nope', stage), { message: "That item isn't in the loaded service." });
  assert.throws(() => saveServiceItem(rig(), 'cue-b', stage), { message: "That item isn't in the loaded service." });
  // A header that has its look is refused the same way.
  const given = saveServiceItem(loaded, 'cue-h-Vārds', stage);
  assert.throws(() => saveServiceItem(given, 'cue-h-Vārds', stage), { message: 'Vārds already has a look: use Save to Vārds.' });
  // A bad stage is refused like Save refuses it.
  assert.throws(() => saveServiceItem(loaded, 'cue-h-Vārds', { groups: { nowhere: 'x' }, levels: {} }), /no group/);
});

test('copyLookToItem gives an item another look\'s groups and tempo, and keeps its name, id and remembered key', () => {
  const loaded = loadService(rig(), planned([song('a', 'A', 100), song('b', 'B')]));
  const [, a, b] = loaded.operator.runningOrder as [string, string, string];
  const quick = loaded.operator.quickLooks[1]!.look;
  loaded.looks.find((l) => l.id === quick)!.tempo = 77;
  const copy = structuredClone(loaded);

  const out = copyLookToItem(loaded, a, quick);
  assert.deepEqual(loaded, copy);
  assert.deepEqual(lookOf(out, a).groups, lookOf(loaded, quick).groups);
  assert.notEqual(lookOf(out, a).groups, lookOf(out, quick).groups, 'a copy, not shared');
  assert.equal(lookOf(out, a).tempo, 77);
  assert.equal(lookOf(out, a).name, 'A');
  assert.equal(out.operator.remembered!['song:song-a'], a);
  assert.equal(out.operator.service!.items[0]!.look, a);
  // A look without a tempo leaves the item's own.
  const keeps = copyLookToItem(loaded, a, b);
  assert.equal(lookOf(keeps, a).tempo, 100);
  parseShow(out);
});

test('copyLookToItem refuses Basic lights, an unknown look and an item outside the order', () => {
  const loaded = loadService(rig(), planned([song('a', 'A')]));
  const a = loaded.operator.runningOrder[1]!;
  assert.throws(() => copyLookToItem(loaded, safeOf(loaded), a), { message: 'Basic lights is set by Save.' });
  assert.throws(() => copyLookToItem(loaded, a, safeOf(loaded)), { message: "Basic lights can't be copied: use a quick look." });
  assert.throws(() => copyLookToItem(loaded, a, 'nope'), { message: '"nope" isn\'t in the show' });
  assert.throws(() => copyLookToItem(loaded, loaded.operator.quickLooks[0]!.look, a), /only running-order items/);
});
