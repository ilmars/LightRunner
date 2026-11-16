import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  anchorOf, checkReferences, copyLookToItem, addSong, clearService, deleteItem, saveServiceItem, ensureBasicLights, ensureKept, ensurePlanning, ensureRunningOrder, itemKind, keptOf, loadService, moveItem, newSongLookOf, parseShow, placeOf, planLookName, plannedCount, rememberKey, setKept, setItemGroup, setItemTempo, setItemTimeline, saveItem, sectionRememberKey, sectionsOf, sectionLookOf, ensureSectionLook, saveSectionChange,
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
  // A PowerPoint file, as Kuldīga plans one (1 Nov 2026).
  assert.equal(itemKind({ cue_type: '', cue_foreground: { type: 'presentation' }, cue_background: { type: '' }, displayName: 'prezentacija.pptx' }), 'slides');
});

test('a tempo the service sets for its song wins over the song library\'s', () => {
  const songs = new Map<string, unknown>([[SONG, { name: 'Klints', data: { tempo: 141 } }]]);
  const own = doc();
  own.data.songMeta = { c2: { key: 'D', tempo: 88 } } as any;
  assert.equal(toPlannedService('svc1', own, songs, 'T').items[1]!.tempo, 88);
  // Out of range, it is passed over for the library's.
  own.data.songMeta = { c2: { key: 'D', tempo: 400 } } as any;
  assert.equal(toPlannedService('svc1', own, songs, 'T').items[1]!.tempo, 141);
});

test('only the part headers is nothing planned', () => {
  const header = (key: string, name: string): ServiceItem => ({ key, kind: 'header', name });
  assert.equal(plannedCount([header('a', 'Ievads'), header('b', 'Slavēšana'), header('c', 'Vārds'), header('d', 'Beigas')]), 0);
  assert.equal(plannedCount([header('a', 'Ievads'), { key: 'x', kind: 'blank', name: '[blank]' }]), 1);
  assert.equal(plannedCount([]), 0);
});

test('the place is the service type\'s name up to its dash', () => {
  assert.equal(placeOf('Rīga - Svētdienas Dievkalpojums'), 'Rīga');
  assert.equal(placeOf('Liepāja- Svētdienas Dievkalpojums'), 'Liepāja');
  assert.equal(placeOf('Mājasgrupa (Rīga)'), 'Mājasgrupa (Rīga)');
  assert.equal(placeOf('Slavēšanas vakars'), 'Slavēšanas vakars');
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
  assert.deepEqual(service.items[1], { key: 'c2', kind: 'song', name: 'Klints uz mūžiem (Nav tādas klints)', songId: SONG, tempo: 141, songKey: 'D' });
  assert.equal(service.items[2].name, 'Psalmi 23:3 L1');
});

test('a song item carries its sections and facts, and never the lyrics', () => {
  const songs = new Map<string, unknown>([[SONG, {
    name: 'Klints',
    data: {
      defaultKey: 'C', timeSignature: '6/8', text_artist: 'Hillsong',
      slides: [
        { slide_id: 'a', slide_title: 'Verse 1a', slide_content: 'SECRET LYRIC ONE' },
        { slide_id: 'b', slide_title: 'Chorus', slide_content: 'SECRET LYRIC TWO' },
      ],
    },
  }]]);
  const d = doc();
  (d.data.songMeta as any).c2 = { key: 'D', notes: 'Slow start' };
  const item = toPlannedService('svc1', d, songs, 'T').items[1]!;
  assert.deepEqual(item.sections, [{ kind: 'verse', slides: ['a'] }, { kind: 'chorus', slides: ['b'] }]);
  assert.equal(item.songKey, 'D');
  assert.equal(item.timeSignature, '6/8');
  assert.equal(item.artist, 'Hillsong');
  assert.equal(item.notes, 'Slow start');
  assert.equal(JSON.stringify(item).includes('SECRET'), false);
});

test('a song with a very long slide id or 250 chorus slides does not stop the service loading', () => {
  const OTHER = '5fc3d2e1-2222-4333-8444-a55566677788';
  const songs = new Map<string, unknown>([
    [SONG, { name: 'Klints', data: { slides: [{ slide_id: 'y'.repeat(70), slide_title: 'Verse 1' }, { slide_id: 'b', slide_title: 'Chorus' }] } }],
    [OTHER, { name: 'Long', data: { slides: Array.from({ length: 250 }, (_, i) => ({ slide_id: `c${i}`, slide_title: 'Chorus' })) } }],
  ]);
  const d = doc();
  d.data.cues.push({ cue_id: 'c4', cue_type: null, cue_name: 'Long', displayName: '', cue_foreground: { type: 'text', text: OTHER } } as any);
  const service = toPlannedService('svc1', d, songs, 'T');
  assert.deepEqual(service.items[1]!.sections, [{ kind: 'chorus', slides: ['b'] }]);
  assert.equal(service.items[3]!.sections![0]!.slides.length, 200);
});

test('the song library\'s key is used when the service sets none; no sections leaves the field out', () => {
  const songs = new Map<string, unknown>([[SONG, { name: 'Klints', data: { defaultKey: 'C' } }]]);
  const d = doc();
  d.data.songMeta = {} as any;
  const item = toPlannedService('svc1', d, songs, 'T').items[1]!;
  assert.equal(item.songKey, 'C');
  assert.equal('sections' in item, false);
  assert.equal('notes' in item, false);
  assert.equal('artist' in item, false);
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

/** The church show with its first running order, and its Sermon and Midweek calm kept. */
const keptRig = (): Show => ensureBasicLights(ensureRunningOrder(parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')))));
/** The same with no kept rows: only Basic lights stays through a load. */
const rig = (): Show => {
  const show = keptRig();
  show.operator.kept = [];
  return show;
};

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

test('a long song name loses its second title in brackets, else is cut at a word', () => {
  // Real names from the church's services (Nov 2026).
  assert.equal(planLookName('Tad, Kad Jūra Krāc (Vēlos, Kungs, zem Taviem spārniem būt)', 'Song'), 'Tad, Kad Jūra Krāc');
  assert.equal(planLookName('Jēzu, Tavs Vārds liek tumsai drebēt (Miers, Tevī valda miers)', 'Song'), 'Jēzu, Tavs Vārds liek tumsai drebēt');
  assert.equal(planLookName('Visas slavas cienīgs Tu (Worthy of it all)', 'Song'), 'Visas slavas cienīgs Tu');
  assert.equal(planLookName('Es dziedu - Jēzus (Es pasludināt vēlos)', 'Song'), 'Es dziedu - Jēzus (Es pasludināt vēlos)');
  assert.equal(planLookName('Pāvila  pirmā vēstule Korintiešiem un vēl kaut kas garš', 'Item'), 'Pāvila pirmā vēstule Korintiešiem un…');
  assert.equal(planLookName('   ', 'Song'), 'Song');
  for (const name of ['Tad, Kad Jūra Krāc (Vēlos, Kungs, zem Taviem spārniem būt)', 'a'.repeat(80), 'word '.repeat(20)]) assert.ok(planLookName(name, 'Song').length <= 40, name);
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
  // The song leaves the service too: no greyed-out row stays behind.
  assert.deepEqual(out.operator.service!.items.map((i) => i.name), ['B']);
  assert.equal(out.operator.remembered!['song:song-b'], b);
  assert.equal(out.operator.service!.items[0]!.look, b);
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
  // A is gone with its song item: the blank follows Slavēšana.
  assert.deepEqual(rows.map(label), [safeOf(show), 'header', slav, 'item', b, 'verses', 'header']);
  assert.equal(rows.some((r) => r.kind === 'item' && r.name === 'A'), false);
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
  assert.throws(() => saveServiceItem(loaded, 'cue-b', stage), { message: "Blanks don't change the lights." });
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

// ---- Kept rows ----

const named = (s: Show, name: string) => s.operator.runningOrder.find((id) => lookOf(s, id).name === name)!;

test('the first running order keeps its Sermon and Midweek calm', () => {
  const show = keptRig();
  assert.deepEqual(show.operator.kept, [named(show, 'Sermon'), named(show, 'Midweek calm')]);
  assert.deepEqual(keptOf(show), show.operator.kept);
  parseShow(show);
});

test('ensureKept gives an older show its Sermon and Midweek calm, once', () => {
  const show = keptRig();
  delete show.operator.kept;
  const out = ensureKept(show);
  assert.deepEqual(out.operator.kept, [named(show, 'Sermon'), named(show, 'Midweek calm')]);
  // A show that has its own choice (even none) keeps it.
  assert.deepEqual(ensureKept(rig()).operator.kept, []);
});

test('a load keeps the kept rows after Basic lights, untouched, and the service below them', () => {
  const show = keptRig();
  const sermon = named(show, 'Sermon');
  const midweek = named(show, 'Midweek calm');
  const before = [structuredClone(lookOf(show, sermon)), structuredClone(lookOf(show, midweek))];
  const out = loadService(show, planned([header('Ievads'), song('a', 'A'), song('b', 'B')]));
  const [, a, b] = out.operator.service!.items.map((i) => i.look);
  assert.deepEqual(out.operator.runningOrder, [safeOf(show), sermon, midweek, a, b]);
  assert.deepEqual([lookOf(out, sermon), lookOf(out, midweek)], before);
  assert.deepEqual(out.operator.kept, [sermon, midweek]);
  // Song 1 to 5 were not kept, so they went.
  assert.equal(out.looks.some((l) => l.name === 'Song 1'), false);
  // A header with no look sits under the kept rows, not between them.
  assert.deepEqual(serviceRows(out).map(label), [safeOf(show), sermon, midweek, 'header', a, b]);
  assert.equal(anchorOf(out, 'cue-h-Ievads'), midweek);
  // And they stay through the next load.
  const again = loadService(out, planned([song('b', 'B')], 'svc2'));
  assert.deepEqual(again.operator.runningOrder.slice(0, 3), [safeOf(show), sermon, midweek]);
  assert.deepEqual(checkReferences(again), []);
});

test('a new Vārds gets its own copy of the kept Sermon, and keeps it in later services', () => {
  const show = keptRig();
  const sermon = named(show, 'Sermon');
  lookOf(show, sermon).tempo = 70;
  const out = loadService(show, planned([song('a', 'A'), header('VĀRDS'), song('b', 'B')]));
  const word = out.operator.service!.items[1]!.look!;
  assert.ok(word && word !== sermon);
  assert.equal(lookOf(out, word).name, 'VĀRDS');
  assert.deepEqual(lookOf(out, word).groups, lookOf(out, sermon).groups);
  assert.notEqual(lookOf(out, word).groups, lookOf(out, sermon).groups, 'a copy, not shared');
  assert.equal(lookOf(out, word).tempo, 70);
  assert.equal(out.operator.remembered!['header:VĀRDS'], word);
  assert.deepEqual(serviceRows(out).filter((r) => r.kind === 'look').map(label), out.operator.runningOrder);
  // Changed on its own, it comes back as it is; Sermon is left alone.
  const edited = structuredClone(out);
  lookOf(edited, word).groups = [];
  const next = loadService(edited, planned([header('VĀRDS')], 'svc2'));
  assert.equal(next.operator.service!.items[0]!.look, word);
  assert.deepEqual(lookOf(next, word).groups, []);
  assert.deepEqual(lookOf(next, sermon), lookOf(out, sermon));
});

test('Vārds is found without capitals or the long ā, and needs a kept Sermon', () => {
  for (const name of ['Vārds', 'vards', ' VARDS ']) {
    const out = loadService(keptRig(), planned([{ key: 'cue-w', kind: 'header', name }]));
    assert.notEqual(out.operator.service!.items[0]!.look, undefined, name);
  }
  // Slides called Vārds are found too; a verse never is.
  const slides = loadService(keptRig(), planned([{ key: 'cue-w', kind: 'slides', name: 'Vārds' }]));
  assert.notEqual(slides.operator.service!.items[0]!.look, undefined);
  const verse = loadService(keptRig(), planned([{ key: 'cue-w', kind: 'verse', name: 'Vārds' }]));
  assert.equal(verse.operator.service!.items[0]!.look, undefined);
  // No kept Sermon: Vārds has no look, like other parts.
  const out = loadService(rig(), planned([header('Vārds')]));
  assert.equal(out.operator.service!.items[0]!.look, undefined);
  assert.deepEqual(out.operator.runningOrder, [safeOf(out)]);
});

test('setKept marks and unmarks a row; Basic lights and rows of the plan are refused', () => {
  const show = keptRig();
  const song1 = named(show, 'Song 1');
  const kept = setKept(show, song1, true);
  assert.deepEqual(keptOf(kept), [song1, named(show, 'Sermon'), named(show, 'Midweek calm')]);
  const out = loadService(kept, planned([song('a', 'A')]));
  assert.deepEqual(out.operator.runningOrder.slice(0, 4), [safeOf(show), song1, named(show, 'Sermon'), named(show, 'Midweek calm')]);
  const unkept = setKept(kept, named(show, 'Sermon'), false);
  assert.deepEqual(keptOf(unkept), [song1, named(show, 'Midweek calm')]);
  assert.throws(() => setKept(show, safeOf(show), false), { message: 'Basic lights always stays.' });
  const a = out.operator.service!.items[0]!.look!;
  assert.throws(() => setKept(out, a, true), /comes from the planned service/);
  assert.doesNotThrow(() => setKept(out, a, false));
  assert.throws(() => setKept(show, 'nope', true), /isn't in the running order/);
});

test('deleting a kept row forgets it', () => {
  const show = keptRig();
  const out = deleteItem(show, named(show, 'Sermon'));
  assert.deepEqual(out.operator.kept, [named(show, 'Midweek calm')]);
  assert.deepEqual(checkReferences(out), []);
});

// ---- Section looks ----

const withSections = (): ServiceItem => ({ ...song('a', 'A'), sections: [{ kind: 'verse', slides: ['s1'] }, { kind: 'chorus', slides: ['s2'] }] });

test("a loaded song's sections have no looks of their own", () => {
  const out = loadService(rig(), planned([withSections()]));
  const a = out.operator.service!.items[0]!.look!;
  assert.deepEqual(sectionsOf(out, a), [{ kind: 'verse', look: null }, { kind: 'chorus', look: null }]);
  assert.equal(sectionLookOf(out, { song: a, kind: 'chorus' }), a);
  assert.ok(!out.looks.some((l) => l.name.includes('·')), 'a load makes no section looks');
  assert.deepEqual(sectionsOf(out, safeOf(out)), []);
  assert.throws(() => sectionLookOf(out, { song: safeOf(out), kind: 'chorus' }));
});

test("a section's own look comes back next week", () => {
  const loaded = loadService(rig(), planned([withSections()]));
  const a = loaded.operator.service!.items[0]!.look!;
  const before = structuredClone(loaded);
  const { show, id } = ensureSectionLook(loaded, { song: a, kind: 'chorus' });
  assert.deepEqual(loaded, before, 'the input is never changed');
  const own = lookOf(show, id);
  assert.equal(own.name, 'A · Chorus');
  assert.ok(!show.operator.runningOrder.includes(id));
  assert.deepEqual(own.groups, lookOf(show, a).groups);
  assert.equal(own.tempo, undefined);
  assert.equal(own.timeline, undefined);
  assert.equal(sectionRememberKey('song-a', 'chorus'), 'song:song-a#chorus');
  assert.equal(show.operator.remembered![sectionRememberKey('song-a', 'chorus')], id);
  assert.equal(sectionLookOf(show, { song: a, kind: 'chorus' }), id);
  assert.equal(sectionLookOf(show, { song: a, kind: 'verse' }), a);
  assert.equal(ensureSectionLook(show, { song: a, kind: 'chorus' }).id, id, 'asking again makes no second look');
  assert.throws(() => ensureSectionLook(show, { song: a, kind: 'bridge' }));

  const again = loadService(show, planned([withSections()], 'svc2'));
  const a2 = again.operator.service!.items[0]!.look!;
  assert.deepEqual(sectionsOf(again, a2), [{ kind: 'verse', look: null }, { kind: 'chorus', look: id }]);
  assert.ok(again.looks.some((l) => l.id === id));
  parseShow(again);
});

test("a long song name is shortened in its section looks' names, never the section", () => {
  let show = loadService(rig(), planned([withSections()]));
  const a = show.operator.service!.items[0]!.look!;
  lookOf(show, a).name = 'Jēzu, Tavs Vārds liek tumsai drebēt';
  const names: string[] = [];
  for (const kind of ['verse', 'chorus'] as const) {
    const made = ensureSectionLook(show, { song: a, kind });
    show = made.show;
    names.push(lookOf(show, made.id).name);
  }
  assert.ok(names[0]!.endsWith(' · Verse'), names[0]);
  assert.ok(names[1]!.endsWith(' · Chorus'), names[1]);
  for (const name of names) assert.ok(name.length <= 40 && name.startsWith('Jēzu, Tavs Vārds'), name);
  parseShow(show);
});

test('deleting the song deletes its section looks', () => {
  const loaded = loadService(rig(), planned([withSections(), song('b', 'B')]));
  const [a, b] = loaded.operator.service!.items.map((i) => i.look!) as [string, string];
  const { show, id } = ensureSectionLook(loaded, { song: a, kind: 'chorus' });
  const out = deleteItem(show, a);
  assert.ok(!out.looks.some((l) => l.id === id));
  assert.equal(out.operator.remembered![sectionRememberKey('song-a', 'chorus')], undefined);
  assert.equal(out.operator.remembered!['song:song-b'], b);
  parseShow(out);
});

test("itemGroup and saveItem take a section's own look", () => {
  const loaded = loadService(rig(), planned([withSections()]));
  const a = loaded.operator.service!.items[0]!.look!;
  const { show, id } = ensureSectionLook(loaded, { song: a, kind: 'chorus' });
  const group = show.groups.find((g) => g.kind !== 'smoke')!.id;
  const preset = show.presets.find((p) => p.group === group && !p.custom)!.id;
  const edited = setItemGroup(show, id, { group, preset, level: 0.5 });
  assert.equal(lookOf(edited, id).groups.find((e) => e.group === group)!.level, 0.5);
  const saved = saveItem(show, id, { groups: { [group]: preset }, levels: { [group]: 0.25 }, tempo: 120 });
  assert.equal(lookOf(saved, id).tempo, undefined, 'a section keeps no tempo');
  assert.equal(lookOf(saveItem(show, a, { groups: { [group]: preset }, levels: {}, tempo: 120 }), a).tempo, 120, 'the song does');
  assert.throws(() => setItemTempo(show, id, 120), /no tempo or timeline/);
  assert.throws(() => setItemTimeline(show, id, null), /no tempo or timeline/);
  assert.throws(() => copyLookToItem(show, id, a), /only running-order items/);
  assert.equal(lookOf(saved, id).groups.find((e) => e.group === group)!.level, 0.25);
  assert.deepEqual(lookOf(saved, a).groups, lookOf(show, a).groups, "the song's look is untouched");
  // A look outside the order that is no section's still can't be changed.
  const other = rig();
  assert.throws(() => setItemGroup(other, other.operator.quickLooks[0]!.look, { group, preset }), /only running-order items can be changed here/);
});

// ---- Saving a change for a section ----

function changeRig() {
  const loaded = loadService(rig(), planned([withSections()]));
  const a = loaded.operator.service!.items[0]!.look!;
  const entries = lookOf(loaded, a).groups;
  const stage = { groups: {} as Record<string, string | null>, levels: {} as Record<string, number> };
  for (const e of entries) {
    stage.groups[e.group] = e.preset;
    stage.levels[e.group] = e.level ?? 1;
  }
  const [front, back] = entries.filter((e) => loaded.presets.filter((p) => p.group === e.group).length >= 2);
  assert.ok(front && back, 'the rig has two groups with a choice of presets');
  const other = loaded.presets.find((p) => p.group === back!.group && p.id !== back!.preset)!.id;
  const changed = { groups: { ...stage.groups, [back!.group]: other }, levels: { ...stage.levels, [front!.group]: 0.4 } };
  return { loaded, a, stage, changed, front: front!.group, back: back!.group, other };
}
const entryOf = (s: Show, look: string, group: string) => lookOf(s, look).groups.find((e) => e.group === group);

test("saving a change for the section gives the chorus its own look; the song's look stays", () => {
  const { loaded, a, changed, front, back, other } = changeRig();
  const ref = { song: a, kind: 'chorus' as const };
  const out = saveSectionChange(loaded, changed, ref, 'section');
  const own = sectionLookOf(out, ref);
  assert.notEqual(own, a);
  assert.equal(entryOf(out, own, front)!.level, 0.4);
  assert.equal(entryOf(out, own, back)!.preset, other);
  assert.deepEqual(lookOf(out, own).groups.map((e) => e.group), lookOf(loaded, a).groups.map((e) => e.group), "the song's other groups come with it");
  assert.deepEqual(lookOf(out, a).groups, lookOf(loaded, a).groups, "the song's look is unchanged");
  assert.equal(sectionLookOf(out, { song: a, kind: 'verse' }), a);
  assert.equal(lookOf(out, own).tempo, undefined);
  parseShow(out);
});

test('saving a change for the whole song writes the song and every section look it has, not the sections that follow it', () => {
  const { loaded, a, changed, front, back, other } = changeRig();
  const ref = { song: a, kind: 'chorus' as const };
  // The chorus has its own look; the verse has none.
  const withOwn = ensureSectionLook(loaded, ref);
  const out = saveSectionChange(withOwn.show, changed, ref, 'song');
  for (const id of [a, withOwn.id]) {
    assert.equal(entryOf(out, id, front)!.level, 0.4, id);
    assert.equal(entryOf(out, id, back)!.preset, other, id);
  }
  assert.equal(sectionsOf(out, a).find((s) => s.kind === 'verse')!.look, null, 'the verse has no look of its own, and still has none');
  // With no own look at all, only the song's look changes.
  const plain = saveSectionChange(loaded, changed, ref, 'song');
  assert.equal(entryOf(plain, a, front)!.level, 0.4);
  assert.equal(sectionLookOf(plain, ref), a);
  parseShow(out);
});

test("saving a change that matches the section's look writes nothing", () => {
  const { loaded, a, stage } = changeRig();
  const ref = { song: a, kind: 'chorus' as const };
  for (const scope of ['section', 'song'] as const) assert.deepEqual(saveSectionChange(loaded, stage, ref, scope), loaded);
  const own = ensureSectionLook(loaded, ref);
  assert.deepEqual(saveSectionChange(own.show, stage, ref, 'section'), own.show);
});

test('only the groups that differ from the sections look are written', () => {
  const { loaded, a, changed, front, back } = changeRig();
  const ref = { song: a, kind: 'chorus' as const };
  const own = ensureSectionLook(loaded, ref);
  // The chorus already has the front lights at 0.4, as the stage has them: only the other group is written.
  const edited = setItemGroup(own.show, own.id, { group: front, level: 0.4 });
  const out = saveSectionChange(edited, changed, ref, 'song');
  assert.equal(entryOf(out, a, front)!.level ?? 1, 1, 'the song does not get a group the chorus already had as on stage');
  assert.notEqual(entryOf(out, a, back)!.preset, entryOf(loaded, a, back)!.preset);
});

// ---- Deleting a song, and clearing the planned service ----

test('a deleted song leaves the service: every item with its look, a part header with its row', () => {
  const { show, a, slav } = october();
  const again: ServiceItem = { key: 'cue-again', kind: 'song', name: 'A', songId: 'song-a' };
  const twice = loadService(show, planned([song('a', 'A'), song('b', 'B'), again]));
  const a2 = twice.operator.service!.items[0]!.look!;
  const out = deleteItem(twice, a2);
  assert.deepEqual(out.operator.service!.items.map((i) => i.name), ['B']);
  assert.equal(serviceRows(out).some((r) => r.kind === 'item'), false);
  assert.equal(out.operator.remembered!['song:song-a'], undefined);
  // A header with a look goes with its row.
  const head = deleteItem(show, show.operator.runningOrder[1]!);
  assert.equal(head.operator.service!.items.some((i) => i.name === 'Slavēšana'), false);
  assert.ok(head.operator.service!.items.some((i) => i.look === a));
  assert.equal(show.operator.runningOrder[1], slav);
  parseShow(head);
  // A song loaded again comes back as a new song.
  const back = loadService(out, planned([song('a', 'A')]));
  assert.equal(lookOf(back, back.operator.service!.items[0]!.look!).name, 'A');
  assert.equal(back.operator.remembered!['song:song-a'], back.operator.service!.items[0]!.look);
  void a2;
});

test('clearing keeps Basic lights, the kept rows and rows added by hand, in order; the plan leaves', () => {
  const base = keptRig();
  const sermon = named(base, 'Sermon');
  const midweek = named(base, 'Midweek calm');
  base.operator.remembered = { 'header:Slavēšana': base.operator.quickLooks[0]!.look };
  const loaded = loadService(base, planned([header('Ievads'), header('Slavēšana'), song('a', 'A'), blank(), song('b', 'B'), verse('Psalmi 1')]));
  const a = loaded.operator.service!.items[2]!.look!;
  // A row added by hand sits between the songs.
  const hand = addSong(loaded, a, stageOf(loaded, a));
  const out = clearService(hand.show);
  assert.deepEqual(out.operator.runningOrder, [safeOf(base), sermon, midweek, hand.id]);
  assert.equal(out.operator.service, undefined);
  assert.deepEqual(keptOf(out), [sermon, midweek]);
  assert.deepEqual(serviceRows(out).map(label), out.operator.runningOrder);
  assert.deepEqual(checkReferences(out), []);
  parseShow(out);
});

test('clearing keeps remembered looks (song, part header, section) in the show, and drops one nothing remembers', () => {
  const rigged = rig();
  rigged.operator.remembered = { 'header:Slavēšana': rigged.operator.quickLooks[0]!.look };
  const first = loadService(rigged, planned([header('Slavēšana'), withSections(), song('b', 'B')]));
  const [, , a, b] = first.operator.runningOrder as [string, string, string, string];
  const made = ensureSectionLook(first, { song: a, kind: 'chorus' });
  const loaded = made.show;
  // A look a plan item has that nothing remembers.
  delete loaded.operator.remembered!['song:song-b'];
  const out = clearService(loaded);
  assert.equal(out.operator.service, undefined);
  for (const id of [a, made.id, loaded.operator.quickLooks[0]!.look]) assert.ok(out.looks.some((l) => l.id === id), id);
  assert.ok(!out.operator.runningOrder.includes(a));
  assert.ok(!out.looks.some((l) => l.id === b), 'an unremembered plan look goes with its row');
  assert.ok(!out.operator.looks.includes(b));
  assert.deepEqual(checkReferences(out), []);
  parseShow(out);
  // A later load of the same service gives the old looks back.
  const again = loadService(out, planned([header('Slavēšana'), withSections()]));
  assert.equal(again.operator.service!.items[1]!.look, a);
  assert.deepEqual(sectionsOf(again, a), [{ kind: 'verse', look: null }, { kind: 'chorus', look: made.id }]);
});

test('clearing a show with no loaded service changes nothing', () => {
  const show = rig();
  assert.deepEqual(clearService(show), show);
});
