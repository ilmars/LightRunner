import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ensureBasicLights, ensureRunningOrder, ensureSectionLook, followDecision, loadService, parseShow, parseSlideId,
  type FollowPlace, type LiveSlide, type OnStage, type PlannedService, type ServiceItem, type Show,
} from '../src/index.ts';

const rigShow = (): Show => {
  const show = ensureBasicLights(ensureRunningOrder(parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8')))));
  show.operator.kept = [];
  return show;
};

const C = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-000000000000`;
const SLIDE = (n: number) => `1111111${n}-aaaa-4bbb-8ccc-000000000000`;
const songA = (key: string): ServiceItem => ({
  key, kind: 'song', name: 'Uz Krustu', songId: 'song-a',
  sections: [{ kind: 'verse', slides: [SLIDE(1), SLIDE(2)] }, { kind: 'chorus', slides: [SLIDE(3), SLIDE(4)] }],
});
const items: ServiceItem[] = [
  { key: C(1), kind: 'header', name: 'Slavēšana' },
  songA(C(2)),
  { key: C(3), kind: 'blank', name: '[blank]' },
  songA(C(4)),
  { key: C(5), kind: 'header', name: 'Vārds' },
  { key: C(6), kind: 'blank', name: '[blank]' },
  { key: C(7), kind: 'verse', name: 'Psalmi 23:3' },
  { key: C(8), kind: 'verse', name: 'Psalmi 23:4' },
];
const planned: PlannedService = { id: 'svc1', title: 'Sunday', start: '2026-11-15T10:00:00', items };

/** The loaded service, the chorus of song A with its own look, and the Vārds header with a look. */
const built = () => {
  let show = loadService(rigShow(), planned);
  const a = show.operator.service!.items[1]!.look!;
  show = ensureSectionLook(show, { song: a, kind: 'chorus' }).show;
  const sermon = show.looks.find((l) => l.name === 'Sermon')!.id;
  show.operator.service!.items[4]!.look = sermon;
  return { show, a, chorus: show.operator.service!.items[1]!.sections![1]!.look!, sermon };
};

const live = (cue: string, slide: string | null, service = 'svc1'): LiveSlide => ({ service, cue, slide, name: 'x' });
const nothing: OnStage = { look: null, section: null };

test('a new item with a look of its own starts it', () => {
  const { show, a } = built();
  const d = followDecision(show, live(C(2), null), null, nothing);
  assert.deepEqual(d.start, { kind: 'item', look: a });
  assert.deepEqual(d.place, { cue: C(2), part: C(1) });
  assert.deepEqual(d.note, { item: 'Uz Krustu', section: null, kind: 'look' });
});

test("a song's Blank slide starts the song's look", () => {
  const { show, a, chorus } = built();
  const d = followDecision(show, live(C(2), null), { cue: C(2), part: C(1) }, { look: chorus, section: { song: a, kind: 'chorus' } });
  assert.deepEqual(d.start, { kind: 'item', look: a });
});

test('a section slide starts its look when that section is not on stage, and nothing when it is', () => {
  const { show, a, chorus } = built();
  const last: FollowPlace = { cue: C(2), part: C(1) };
  const onSong: OnStage = { look: a, section: null };
  const d = followDecision(show, live(C(2), SLIDE(3)), last, onSong);
  assert.deepEqual(d.start, { kind: 'section', ref: { song: a, kind: 'chorus' }, look: chorus });
  assert.deepEqual(d.note, { item: 'Uz Krustu', section: 'chorus', kind: 'look' });
  const onChorus: OnStage = { look: chorus, section: { song: a, kind: 'chorus' } };
  const again = followDecision(show, live(C(2), SLIDE(4)), last, onChorus);
  assert.equal(again.start, null);
  assert.deepEqual(again.note, { item: 'Uz Krustu', section: 'chorus', kind: 'nothing' });
});

test("a section with no look of its own plays the song's", () => {
  const { show, a, chorus } = built();
  const d = followDecision(show, live(C(2), SLIDE(1)), { cue: C(2), part: C(1) }, { look: chorus, section: { song: a, kind: 'chorus' } });
  assert.deepEqual(d.start, { kind: 'section', ref: { song: a, kind: 'verse' }, look: a });
});

test('a slide of no section changes nothing', () => {
  const { show, a } = built();
  const d = followDecision(show, live(C(2), SLIDE(9)), { cue: C(2), part: C(1) }, { look: a, section: null });
  assert.equal(d.start, null);
  assert.equal(d.note.kind, 'nothing');
});

test('the first item in a new part starts the part look; a verse inside it changes nothing', () => {
  const { show, a, sermon } = built();
  const last: FollowPlace = { cue: C(4), part: C(1) };
  const d = followDecision(show, live(C(6), null), last, { look: a, section: null });
  assert.deepEqual(d.start, { kind: 'item', look: sermon });
  assert.deepEqual(d.place, { cue: C(6), part: C(5) });
  const v = followDecision(show, live(C(7), null), d.place, { look: sermon, section: null });
  assert.equal(v.start, null);
  assert.deepEqual(v.note, { item: 'Psalmi 23:3', section: null, kind: 'verse' });
  assert.deepEqual(v.place, { cue: C(7), part: C(5) });
});

test('a part without a look starts nothing for its blank', () => {
  const { show } = built();
  const d = followDecision(show, live(C(3), null), { cue: C(2), part: C(1) }, nothing);
  assert.equal(d.start, null);
  assert.equal(d.note.kind, 'nothing');
  assert.deepEqual(d.place, { cue: C(3), part: C(1) });
});

test('the second item of the same song starts the song look again', () => {
  const { show, a, chorus } = built();
  const d = followDecision(show, live(C(4), null), { cue: C(3), part: C(1) }, { look: a, section: { song: a, kind: 'chorus' } });
  assert.deepEqual(d.start, { kind: 'item', look: a });
  assert.equal(d.place.cue, C(4));
  assert.notEqual(chorus, a);
});

test('an item that is not in the service, or another service, changes nothing', () => {
  const { show } = built();
  const last: FollowPlace = { cue: C(2), part: C(1) };
  for (const l of [live(C(9), null), live(C(2), null, 'other')]) {
    const d = followDecision(show, l, last, nothing);
    assert.equal(d.start, null);
    assert.equal(d.note.kind, 'not-in-order');
    assert.deepEqual(d.place, last);
  }
  assert.deepEqual(followDecision(show, live(C(9), null), null, nothing).place, { cue: C(9), part: null });
  assert.equal(followDecision(rigShow(), live(C(2), null), null, nothing).note.kind, 'not-in-order');
});

test('a song whose row was deleted starts nothing', () => {
  const { show } = built();
  delete show.operator.service!.items[1]!.look;
  const d = followDecision(show, live(C(2), SLIDE(3)), null, nothing);
  assert.equal(d.start, null);
  assert.equal(followDecision(show, live(C(2), null), null, nothing).start, null);
});

test('the same message twice starts nothing the second time', () => {
  const { show, a, chorus } = built();
  const first = followDecision(show, live(C(2), SLIDE(3)), null, nothing);
  const on: OnStage = { look: chorus, section: { song: a, kind: 'chorus' } };
  const second = followDecision(show, live(C(2), SLIDE(3)), first.place, on);
  assert.equal(second.start, null);
  const blank = followDecision(show, live(C(2), null), null, nothing);
  assert.equal(followDecision(show, live(C(2), null), blank.place, { look: a, section: null }).start, null);
});

test('slide ids are read for a song slide and a blank, and junk is null', () => {
  const cue = '0e9f6e0c-1c34-4f10-9f5e-aaaaaaaaaaaa';
  const slide = '5d2f6e0c-1c34-4f10-9f5e-bbbbbbbbbbbb';
  assert.deepEqual(parseSlideId(`${cue}-${slide}-slide-3`), { cue, slide });
  assert.deepEqual(parseSlideId(`${cue}-blank-x7Qk-slide-1`), { cue, slide: null });
  assert.equal(parseSlideId('junk'), null);
  assert.equal(parseSlideId(`${cue}-${slide}-slide-x`), null);
  assert.equal(parseSlideId(`${cue}-notauuid-slide-1`), null);
});
