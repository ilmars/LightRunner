import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemKind, rememberKey, toPlannedService } from '../src/index.ts';

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
