// The channel-list logic behind the fixture types on the Patch page (web/patch/types.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import {
  JOBS, addChannel, channelRows, channelText, compareRows, copyOf, isReadOnly, moveRow, newTypeId, removeRow, repeatLastSegment,
  segmentCount, setJob, setKelvin, setSixteenBit, setValue, summary, validateType,
} from '../../web/patch/types.js';
import type { Channel } from '../../web/patch/types.js';
import { BUILT_IN_PROFILES } from '../../packages/shared/src/profiles.ts';
import { profileSegments } from '../../packages/shared/src/presets.ts';
import type { Profile } from '../../packages/shared/src/schema.ts';

const show = JSON.parse(readFileSync(new URL('../../shows/stage-l1.json', import.meta.url), 'utf8')) as { profiles: Profile[] };
const byId = (id: string): Profile => {
  const p = show.profiles.find((x) => x.id === id);
  assert.ok(p, `${id} is in stage-l1`);
  return p;
};
const as600b = byId('neewer-as600b-cct-8-bit');
const sixbar = byId('elation-sixbar-500-18-ch');
const pulse39 = byId('stairville-sonicpulse-led-bar-10-39-ch');
const pulse23 = byId('stairville-sonicpulse-led-bar-05-23-ch');
const strip = byId('generic-led-strip-rgb-3-ch');
const walimex: Channel[] = [{ role: 'dimmer' }, { role: 'cct', kelvin: { min: 3200, max: 5600 } }];
const roles = (list: Channel[]) => list.map((c) => c.role + (c.fine ? '~' : ''));

test('the jobs, in the order the editor offers them', () => {
  assert.deepEqual(JOBS.map((j) => j.job), ['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'cct', 'strobe', 'other']);
  assert.deepEqual(JOBS.map((j) => j.label), [
    'Dimmer', 'Red', 'Green', 'Blue', 'White', 'Amber', 'UV', 'Colour temperature', 'Strobe', 'Fixed value',
  ]);
});

test('summaries say what a type is in a line', () => {
  assert.equal(summary(walimex), '2 channels · one light · dimmer and colour temperature 3200–5600 K');
  assert.equal(summary(sixbar.channels), '18 channels · 3 segments · each red, green, blue, white, amber and UV');
  assert.equal(
    summary(pulse39.channels),
    '39 channels · 8 segments · each red, green, blue and white · also dimmer, strobe and 5 fixed values',
  );
  assert.equal(summary([{ role: 'dimmer' }]), '1 channel · one light · dimmer');
  assert.equal(summary(strip.channels), '3 channels · one light · red, green and blue');
  assert.equal(summary([{ role: 'other', default: 5 }]), '1 channel · one light · fixed value');
  assert.equal(
    summary([{ role: 'dimmer' }, { role: 'dimmer', fine: true }, { role: 'red' }]),
    '3 channels · one light · dimmer and red',
  );
});

test('segment counts match the engine rule for every type in the show and the built-ins', () => {
  for (const p of [...show.profiles, ...BUILT_IN_PROFILES]) assert.equal(segmentCount(p.channels), profileSegments(p), p.id);
  assert.equal(segmentCount(walimex), 1);
  assert.equal(segmentCount([]), 1);
});

test('the SonicPulse 39 shows its whole-light channels and eight segments', () => {
  const rows = channelRows(pulse39.channels);
  assert.equal(rows.length, 39);
  rows.forEach((r, i) => {
    assert.equal(r.first, i + 1);
    assert.equal(r.last, i + 1);
    assert.equal(r.index, i);
  });
  assert.equal(rows[0].label, 'Dimmer');
  assert.equal(rows[1].label, 'Strobe');
  for (let i = 2; i < 7; i++) assert.equal(rows[i].label, 'Fixed value');
  for (let i = 0; i < 7; i++) assert.equal(rows[i].segment, null, `channel ${i + 1}`);
  for (let i = 7; i < 39; i++) assert.equal(rows[i].segment, Math.floor((i - 7) / 4) + 1, `channel ${i + 1}`);
  assert.equal(rows[7].segment, 1);
  assert.equal(rows[10].segment, 1);
  assert.equal(rows[35].segment, 8);
  assert.equal(rows[38].segment, 8);
  assert.equal(rows[2].name, 'RGBW Color Change');
  assert.equal(rows[2].value, 0);
  assert.equal(rows[1].value, 0);
  assert.equal(rows[0].value, undefined);
});

test('a type with one segment is all the whole light', () => {
  for (const r of channelRows(strip.channels)) assert.equal(r.segment, null);
  for (const r of channelRows(walimex)) assert.equal(r.segment, null);
});

test('only colour channels are in a segment, as the engine drives them', () => {
  const list: Channel[] = [
    { role: 'dimmer' },
    { role: 'red' }, { role: 'green' }, { role: 'other', default: 3 }, { role: 'blue' },
    { role: 'red' }, { role: 'dimmer' }, { role: 'green' }, { role: 'blue' },
    { role: 'strobe', default: 0 },
  ];
  assert.deepEqual(channelRows(list).map((r) => r.segment), [null, 1, 1, null, 1, 2, null, 2, 2, null]);
});

test('a colour that appears once in a type with several segments is the whole light', () => {
  const list: Channel[] = [
    { role: 'red' }, { role: 'green' }, { role: 'blue' }, { role: 'red' }, { role: 'green' }, { role: 'blue' }, { role: 'white' },
  ];
  assert.equal(segmentCount(list), 2);
  assert.deepEqual(channelRows(list).map((r) => r.segment), [1, 1, 1, 2, 2, 2, null]);
  assert.equal(summary(list), '7 channels · 2 segments · each red, green and blue · also white');
  // With one segment everything is the whole light.
  assert.deepEqual(channelRows([{ role: 'red' }, { role: 'white' }]).map((r) => r.segment), [null, null]);
  // A 16-bit colour keeps its segment.
  const fine: Channel[] = [{ role: 'red' }, { role: 'red', fine: true }, { role: 'red' }, { role: 'red', fine: true }];
  assert.deepEqual(channelRows(fine).map((r) => r.segment), [1, 2]);
});

test('a 16-bit channel is one row that spans two channel numbers', () => {
  const list: Channel[] = [
    { role: 'dimmer' }, { role: 'dimmer', fine: true }, { role: 'red' },
    { role: 'cct', kelvin: { min: 2700, max: 6500 } }, { role: 'cct', fine: true },
  ];
  const rows = channelRows(list);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.index, r.first, r.last, r.sixteenBit]), [[0, 1, 2, true], [2, 3, 3, false], [3, 4, 5, true]]);
  assert.deepEqual(rows[2].kelvin, { min: 2700, max: 6500 });
});

test('the comparison shows two types channel by channel', () => {
  assert.deepEqual(compareRows(as600b.channels, walimex), [
    { n: 1, left: 'Dimmer', right: 'Dimmer', same: true },
    { n: 2, left: 'Colour temperature 2500–10000 K', right: 'Colour temperature 3200–5600 K', same: false },
  ]);
  const longer = compareRows(strip.channels, as600b.channels);
  assert.equal(longer.length, 3);
  assert.deepEqual(longer[2], { n: 3, left: 'Blue', right: null, same: false });
  assert.deepEqual(compareRows([], [{ role: 'dimmer' }]), [{ n: 1, left: null, right: 'Dimmer', same: false }]);
});

test('channel texts', () => {
  assert.equal(channelText({ role: 'dimmer' }), 'Dimmer');
  assert.equal(channelText({ role: 'dimmer', fine: true }), 'Dimmer (16-bit, 2nd channel)');
  assert.equal(channelText({ role: 'strobe', default: 0 }), 'Strobe 0');
  assert.equal(channelText({ role: 'strobe' }), 'Strobe 0');
  assert.equal(channelText({ role: 'other', default: 255 }), 'Fixed value 255');
  assert.equal(channelText({ role: 'red' }), 'Red');
  assert.equal(channelText({ role: 'uv' }), 'UV');
  assert.equal(channelText({ role: 'cct', kelvin: { min: 3200, max: 5600 } }), 'Colour temperature 3200–5600 K');
  assert.equal(channelText({ role: 'other', default: 0, name: 'RGBW Color Change' }), 'Fixed value 0 — RGBW Color Change');
  assert.equal(channelText({ role: 'red', name: 'Red' }), 'Red', 'a name that repeats the job adds nothing');
  assert.equal(channelText({ role: 'white', name: 'CoolWhite' }), 'White — CoolWhite');
});

test('validation says the first problem in plain words, and never lets a number through that is not one', () => {
  const ok: Channel[] = [{ role: 'dimmer' }];
  assert.equal(validateType('Walimex', walimex), null);
  assert.equal(validateType('Whole show', pulse39.channels), null);
  assert.equal(validateType('', ok), 'Give the type a name.');
  assert.equal(validateType('   ', ok), 'Give the type a name.');
  assert.equal(validateType('X', []), 'Add at least one channel.');
  assert.equal(
    validateType('X', Array.from({ length: 513 }, () => ({ role: 'dimmer' as const }))),
    'A fixture type has at most 512 channels.',
  );
  assert.equal(validateType('X', Array.from({ length: 512 }, () => ({ role: 'dimmer' as const }))), null);
  const cct = (kelvin: unknown): Channel[] => [{ role: 'dimmer' }, { role: 'cct', kelvin } as Channel];
  const range = 'Channel 2: colour temperatures are whole numbers from 1000 to 20000 K.';
  assert.equal(validateType('X', cct({ min: NaN, max: 5600 })), range);
  assert.equal(validateType('X', cct({ min: 3200.5, max: 5600 })), range);
  const typed = 'Channel 2: type the warm end and the cool end in K.';
  assert.equal(validateType('X', cct({ min: 3200 })), typed);
  assert.equal(validateType('X', cct({ min: 3200, max: null })), typed);
  assert.equal(validateType('X', cct({ min: undefined, max: 5600 })), typed);
  assert.equal(validateType('X', cct(undefined)), typed);
  assert.equal(validateType('X', cct({ min: 999, max: 5600 })), range);
  assert.equal(validateType('X', cct({ min: 3200, max: 20001 })), range);
  assert.equal(validateType('X', cct({ min: 3200, max: Infinity })), range);
  assert.equal(validateType('X', cct({ min: 5600, max: 3200 })), 'Channel 2: the warm end must be below the cool end.');
  assert.equal(validateType('X', cct({ min: 3200, max: 3200 })), 'Channel 2: the warm end must be below the cool end.');
  assert.equal(validateType('X', cct({ min: 1000, max: 20000 })), null);
  const value = 'Channel 1: a value is a whole number from 0 to 255.';
  assert.equal(validateType('X', [{ role: 'other', default: 256 }]), value);
  assert.equal(validateType('X', [{ role: 'other', default: -1 }]), value);
  // No value counts as 0, as the engine has it; a value that is there must be right.
  assert.equal(validateType('X', [{ role: 'other', default: undefined }]), null);
  assert.equal(validateType('X', [{ role: 'strobe' }]), null);
  assert.equal(validateType('X', [{ role: 'other', default: null as unknown as number }]), value);
  assert.equal(validateType('X', [{ role: 'other', default: '5' as unknown as number }]), value);
  assert.equal(validateType('X', [{ role: 'strobe', default: 1.5 }]), value);
  assert.equal(validateType('X', [{ role: 'strobe', default: Number.NaN }]), value);
  assert.equal(validateType('X', [{ role: 'strobe', default: 255 }, { role: 'other', default: 0 }]), null);
  // The editor keeps text that is not a whole number as typed; it counts as not typed yet.
  assert.equal(validateType('X', cct({ min: 'abc', max: 5600 })), typed);
  assert.equal(validateType('X', cct({ min: 3200, max: '1e3' })), typed);
  assert.equal(validateType('X', [{ role: 'other', default: 'abc' as unknown as number }]), value);
  // The summary leaves a range out while it is not a good one.
  assert.equal(summary(cct({ min: 6000, max: 5600 })), '2 channels · one light · dimmer and colour temperature');
  assert.equal(summary(cct({ min: 'abc', max: 5600 })), '2 channels · one light · dimmer and colour temperature');
  assert.equal(summary(cct({ min: 3200, max: 5600 })), '2 channels · one light · dimmer and colour temperature 3200–5600 K');
  // The message names the channel number, which counts fine bytes.
  assert.equal(
    validateType('X', [{ role: 'dimmer' }, { role: 'dimmer', fine: true }, { role: 'other', default: 300 }]),
    'Channel 3: a value is a whole number from 0 to 255.',
  );
});

test('a 16-bit second channel needs its first channel just before it', () => {
  const lone = 'Channel 1: the second channel of a 16-bit pair needs its first channel just before it.';
  assert.equal(validateType('X', [{ role: 'red', fine: true }]), lone);
  // A fine red right after a green is not that green's pair.
  assert.equal(
    validateType('X', [{ role: 'red' }, { role: 'green' }, { role: 'red', fine: true }]),
    'Channel 3: the second channel of a 16-bit pair needs its first channel just before it.',
  );
  // A third channel of the same job does not make a pair of three.
  assert.equal(
    validateType('X', [{ role: 'dimmer' }, { role: 'dimmer', fine: true }, { role: 'dimmer', fine: true }]),
    'Channel 3: the second channel of a 16-bit pair needs its first channel just before it.',
  );
  assert.equal(validateType('X', [{ role: 'red' }, { role: 'red', fine: true }, { role: 'green' }]), null);
});

test('adding a channel gives it its starting values', () => {
  const start: Channel[] = [{ role: 'dimmer' }];
  const frozen = structuredClone(start);
  const a = addChannel(start, 'cct');
  assert.deepEqual(start, frozen, 'the input is untouched');
  assert.deepEqual(a, [{ role: 'dimmer' }, { role: 'cct', kelvin: { min: 2700, max: 6500 } }]);
  assert.deepEqual(addChannel(start, 'strobe')[1], { role: 'strobe', default: 0 });
  assert.deepEqual(addChannel(start, 'other')[1], { role: 'other', default: 0 });
  assert.deepEqual(addChannel(start, 'red')[1], { role: 'red' });
  assert.equal(validateType('X', addChannel(addChannel(start, 'cct'), 'other')), null);
});

test('changing a job keeps what still fits and drops what does not', () => {
  const list: Channel[] = [
    { role: 'dimmer', name: 'Master' }, { role: 'dimmer', fine: true },
    { role: 'cct', kelvin: { min: 3200, max: 5600 } },
    { role: 'strobe', default: 7 },
  ];
  const frozen = structuredClone(list);
  const toRed = setJob(list, 0, 'red');
  assert.deepEqual(list, frozen, 'the input is untouched');
  assert.deepEqual(toRed.slice(0, 2), [{ role: 'red', name: 'Master' }, { role: 'red', fine: true }]);
  assert.deepEqual(toRed.slice(2), list.slice(2));
  // To a job that takes no level: the fine byte goes, a starting value arrives.
  assert.deepEqual(setJob(list, 0, 'other').slice(0, 2), [{ role: 'other', name: 'Master', default: 0 }, { role: 'cct', kelvin: { min: 3200, max: 5600 } }]);
  // From a colour temperature to a colour: the range goes.
  assert.deepEqual(setJob(list, 1, 'blue')[2], { role: 'blue' });
  assert.deepEqual(setJob(list, 1, 'cct')[2], { role: 'cct', kelvin: { min: 3200, max: 5600 } }, 'same job: untouched');
  // From a strobe to a dimmer: the value goes. From a dimmer to a colour temperature: the range arrives.
  assert.deepEqual(setJob(list, 2, 'dimmer')[3], { role: 'dimmer' });
  assert.deepEqual(setJob(list, 0, 'cct')[0], { role: 'cct', name: 'Master', kelvin: { min: 2700, max: 6500 } });
  // A name that only repeated the old job goes; one that says more stays.
  assert.deepEqual(
    setJob([{ role: 'red', name: 'Red' }, { role: 'green', name: 'Left eye' }], 0, 'blue'),
    [{ role: 'blue' }, { role: 'green', name: 'Left eye' }],
  );
  assert.deepEqual(setJob([{ role: 'red', name: 'red' }], 0, 'blue'), [{ role: 'blue' }]);
  assert.deepEqual(setJob([{ role: 'green', name: 'Left eye' }], 0, 'blue'), [{ role: 'blue', name: 'Left eye' }]);
  // From a fixed value to a strobe keeps the value.
  assert.deepEqual(setJob([{ role: 'other', default: 9 }], 0, 'strobe'), [{ role: 'strobe', default: 9 }]);
});

test('16-bit adds or removes exactly one channel right after, and nothing else moves', () => {
  const list: Channel[] = [{ role: 'dimmer' }, { role: 'red' }, { role: 'green' }, { role: 'blue' }];
  const frozen = structuredClone(list);
  const on = setSixteenBit(list, 1, true);
  assert.deepEqual(list, frozen, 'the input is untouched');
  assert.deepEqual(on, [{ role: 'dimmer' }, { role: 'red' }, { role: 'red', fine: true }, { role: 'green' }, { role: 'blue' }]);
  assert.deepEqual(setSixteenBit(on, 1, true), on, 'already on: no second fine byte');
  assert.deepEqual(setSixteenBit(on, 1, false), list);
  assert.deepEqual(setSixteenBit(list, 1, false), list, 'already off: nothing to take out');
  // Row numbers count rows, not channels.
  const later = setSixteenBit(on, 2, true);
  assert.deepEqual(roles(later), ['dimmer', 'red', 'red~', 'green', 'green~', 'blue']);
  assert.deepEqual(roles(setSixteenBit(later, 0, true)), ['dimmer', 'dimmer~', 'red', 'red~', 'green', 'green~', 'blue']);
  // Only jobs that take a level.
  const fixed: Channel[] = [{ role: 'strobe', default: 0 }, { role: 'other', default: 0 }];
  assert.deepEqual(setSixteenBit(fixed, 0, true), fixed);
  assert.deepEqual(setSixteenBit(fixed, 1, true), fixed);
  const cct = setSixteenBit(walimex, 1, true);
  assert.deepEqual(cct[2], { role: 'cct', fine: true });
  assert.deepEqual(setSixteenBit(cct, 1, false), walimex);
});

test('range and value edits change one row and nothing else', () => {
  const list: Channel[] = [...structuredClone(walimex), { role: 'other', default: 1, name: 'Mode' }];
  const frozen = structuredClone(list);
  const k = setKelvin(list, 1, { min: 2200, max: 6000 });
  assert.deepEqual(list, frozen);
  assert.deepEqual(k[1], { role: 'cct', kelvin: { min: 2200, max: 6000 } });
  assert.deepEqual(k[0], list[0]);
  const v = setValue(list, 2, 99);
  assert.deepEqual(v[2], { role: 'other', default: 99, name: 'Mode' });
  assert.deepEqual(list, frozen);
});

test('a row moves with its fine byte, past the neighbouring row', () => {
  // Rows: dimmer (16-bit), red, green (16-bit), blue.
  const list: Channel[] = [
    { role: 'dimmer' }, { role: 'dimmer', fine: true }, { role: 'red' },
    { role: 'green' }, { role: 'green', fine: true }, { role: 'blue' },
  ];
  const frozen = structuredClone(list);
  assert.deepEqual(roles(moveRow(list, 0, 1)), ['red', 'dimmer', 'dimmer~', 'green', 'green~', 'blue']);
  assert.deepEqual(roles(moveRow(list, 2, -1)), ['dimmer', 'dimmer~', 'green', 'green~', 'red', 'blue']);
  assert.deepEqual(roles(moveRow(list, 1, 1)), ['dimmer', 'dimmer~', 'green', 'green~', 'red', 'blue']);
  assert.deepEqual(roles(moveRow(list, 3, -1)), ['dimmer', 'dimmer~', 'red', 'blue', 'green', 'green~']);
  assert.deepEqual(moveRow(list, 0, -1), list, 'the first row cannot go up');
  assert.deepEqual(moveRow(list, 3, 1), list, 'the last row cannot go down');
  assert.deepEqual(list, frozen);
});

test('removing a row takes its fine byte too', () => {
  const list: Channel[] = [{ role: 'dimmer' }, { role: 'dimmer', fine: true }, { role: 'red' }];
  assert.deepEqual(removeRow(list, 0), [{ role: 'red' }]);
  assert.deepEqual(removeRow(list, 1), [{ role: 'dimmer' }, { role: 'dimmer', fine: true }]);
  assert.equal(list.length, 3);
});

test('repeating the last segment', () => {
  const six = repeatLastSegment(sixbar.channels);
  assert.equal(six.length, 24);
  assert.equal(segmentCount(six), 4);
  assert.deepEqual(six.slice(18), sixbar.channels.slice(12));
  assert.equal(sixbar.channels.length, 18, 'the input is untouched');

  const p = repeatLastSegment(pulse39.channels);
  assert.equal(p.length, 43);
  assert.equal(segmentCount(p), 9);
  assert.deepEqual(p.slice(0, 7), pulse39.channels.slice(0, 7), 'the whole-light channels stay first');
  assert.deepEqual(p.slice(39), pulse39.channels.slice(35));

  // A lone colour is the whole light, not part of segment 1, and stays after the copy.
  const lone = repeatLastSegment([
    { role: 'red' }, { role: 'green' }, { role: 'blue' }, { role: 'red' }, { role: 'green' }, { role: 'blue' }, { role: 'white' },
  ]);
  assert.deepEqual(roles(lone), ['red', 'green', 'blue', 'red', 'green', 'blue', 'red', 'green', 'blue', 'white']);
  // Whatever is between the segment's first and last colour comes with it.
  const between = repeatLastSegment([
    { role: 'red' }, { role: 'other', default: 5 }, { role: 'green' }, { role: 'red' }, { role: 'dimmer' }, { role: 'green' }, { role: 'strobe' },
  ]);
  assert.deepEqual(roles(between), ['red', 'other', 'green', 'red', 'dimmer', 'green', 'red', 'dimmer', 'green', 'strobe']);
  // A type with one segment copies its colour channels as segment 2, before any trailing whole-light channels.
  const one = repeatLastSegment([{ role: 'dimmer' }, { role: 'red', name: 'R' }, { role: 'green' }, { role: 'blue' }, { role: 'strobe', default: 4 }]);
  assert.deepEqual(roles(one), ['dimmer', 'red', 'green', 'blue', 'red', 'green', 'blue', 'strobe']);
  assert.equal(one[4].name, 'R');
  assert.equal(segmentCount(one), 2);
  // A copy is a copy: editing it does not touch the original.
  const k = repeatLastSegment(sixbar.channels);
  k[18].name = 'changed';
  assert.equal(sixbar.channels[12].name, 'Red');
  // 16-bit colours come with their fine bytes.
  const fine = repeatLastSegment([{ role: 'red' }, { role: 'red', fine: true }, { role: 'green' }]);
  assert.deepEqual(roles(fine), ['red', 'red~', 'green', 'red', 'red~', 'green']);
  // Nothing to repeat without colours.
  assert.deepEqual(repeatLastSegment(walimex), walimex);
});

test('a copy keeps every channel and is a separate type', () => {
  const taken = new Set(['stairville-sonicpulse-led-bar-10-39-ch', 'generic-rgb']);
  const copy = copyOf(pulse39, taken);
  assert.equal(copy.name, `Copy of ${pulse39.name}`);
  assert.ok(!taken.has(copy.id), 'a new id');
  assert.match(copy.id, /^[a-z0-9][a-z0-9-]*$/);
  assert.deepEqual(copy.channels, pulse39.channels);
  assert.notEqual(copy.channels, pulse39.channels);
  assert.notEqual(copy.channels[2], pulse39.channels[2]);
  assert.equal('source' in copy, false);
  copy.channels.forEach((c, i) => {
    assert.equal(c.name, pulse39.channels[i].name);
    assert.equal(c.default, pulse39.channels[i].default);
    assert.equal(c.fine, pulse39.channels[i].fine);
  });
  // Fine bytes and ranges survive too, and a library type loses its source.
  const withFine: Profile = {
    id: 'a', name: 'A', source: { ofl: 'x/y', mode: 'm' },
    channels: [{ role: 'dimmer' }, { role: 'dimmer', fine: true }, { role: 'cct', kelvin: { min: 1000, max: 2000 } }],
  };
  const fineCopy = copyOf(withFine, new Set());
  assert.equal(fineCopy.channels[1].fine, true);
  assert.deepEqual(fineCopy.channels[2].kelvin, { min: 1000, max: 2000 });
  assert.equal('source' in fineCopy, false);
  assert.equal(copyOf(as600b, new Set()).channels[1].kelvin?.max, 10000);
  // Everything else the type has comes along, except where it came from.
  const gamma = copyOf({ ...withFine, gamma: 2.2 }, new Set());
  assert.equal(gamma.gamma, 2.2);
  assert.equal('gamma' in copyOf(withFine, new Set()), false);
});

test('ids are slugs, made unique', () => {
  const none = new Set<string>();
  assert.equal(newTypeId('Walimex 3200–5600 K', none), 'walimex-3200-5600-k');
  assert.equal(newTypeId('  Šķīvis  LED!! ', none), 'skivis-led');
  assert.equal(newTypeId('Copy of Neewer AS600B (CCT (8 Bit))', none), 'copy-of-neewer-as600b-cct-8-bit');
  assert.equal(newTypeId('Walimex', new Set(['walimex'])), 'walimex-2');
  assert.equal(newTypeId('Walimex', new Set(['walimex', 'walimex-2'])), 'walimex-3');
  assert.equal(newTypeId('Generic rgb', new Set(['generic-rgb'])), 'generic-rgb-2');
  assert.match(newTypeId('!!!', none), /^[a-z0-9][a-z0-9-]*$/);
  assert.match(newTypeId('', none), /^[a-z0-9][a-z0-9-]*$/);
  assert.notEqual(newTypeId('', new Set([newTypeId('', none)])), newTypeId('', none));
});

test("library and built-in types are read-only; the show's own are not", () => {
  const builtIn = new Set(BUILT_IN_PROFILES.map((p) => p.id));
  assert.equal(isReadOnly({ id: 'x', name: 'X', channels: [{ role: 'dimmer' }], source: { ofl: 'a/b', mode: 'm' } }, builtIn), true);
  assert.equal(isReadOnly(BUILT_IN_PROFILES.find((p) => p.id === 'generic-rgb')!, builtIn), true);
  assert.equal(isReadOnly(as600b, builtIn), false);
  assert.equal(isReadOnly(sixbar, builtIn), false);
  assert.equal(isReadOnly(pulse23, builtIn), false);
});

// ---- GET /api/profiles: the channels and whether a type can be changed ----

test('GET /api/profiles gives each type its channels, and says which are read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-types-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath: join(root, 'server/seed/demo-show.json'), webDir: join(root, 'web'), log: () => {} });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    await app.start();
    await call('PUT', '/api/settings', { output: { kind: 'none' } });
    const current = (await call('GET', '/api/show')).body;
    const fromLibrary = { id: 'ofl-bar', name: 'Library bar', channels: [{ role: 'dimmer' }, { role: 'red' }], source: { ofl: 'maker/bar', mode: '2ch' } };
    const withTypes = { ...current, profiles: [...current.profiles, as600b, pulse39, fromLibrary] };
    assert.equal((await call('PUT', '/api/show?source=patch', withTypes)).status, 200);

    const list = (await call('GET', '/api/profiles')).body as { id: string; channels: number; segments: number; defs: Channel[]; readOnly: boolean; builtIn: boolean }[];
    const typeOf = (id: string) => {
      const found = list.find((p) => p.id === id);
      assert.ok(found, `${id} is listed`);
      return found;
    };
    // The show's own types: the channels as stored, and editable unless they came from the library.
    assert.deepEqual(typeOf(as600b.id).defs, as600b.channels);
    assert.equal(typeOf(as600b.id).readOnly, false);
    assert.deepEqual(typeOf(pulse39.id).defs, pulse39.channels);
    assert.equal(typeOf(pulse39.id).defs.length, typeOf(pulse39.id).channels);
    assert.equal(typeOf('ofl-bar').readOnly, true);
    // Built-in types: their channels too, never editable.
    const builtIn = BUILT_IN_PROFILES.find((p) => p.id === 'generic-rgbw');
    assert.ok(builtIn);
    assert.deepEqual(typeOf('generic-rgbw').defs, builtIn.channels);
    assert.equal(typeOf('generic-rgbw').readOnly, true);
    for (const p of BUILT_IN_PROFILES) assert.equal(typeOf(p.id).readOnly, true, p.id);
    // `builtIn` marks the real built-in ids only.
    for (const p of BUILT_IN_PROFILES) assert.equal(list.find((x) => x.id === p.id)?.builtIn, true, p.id);
    assert.equal(typeOf(as600b.id).builtIn, false);
    assert.equal(typeOf('ofl-bar').builtIn, false);

    // A type of the show's that reuses a built-in's id wins in the list (its own channels), and stays read-only.
    const sameId = { id: 'generic-rgbw', name: 'My RGBW', channels: [{ role: 'dimmer' }, { role: 'red' }] };
    const current2 = (await call('GET', '/api/show')).body;
    assert.equal((await call('PUT', '/api/show?source=patch', { ...current2, profiles: [...current2.profiles, sameId] })).status, 200);
    const again = (await call('GET', '/api/profiles')).body as { id: string; name: string; defs: Channel[]; readOnly: boolean; builtIn: boolean }[];
    const mine = again.filter((p) => p.id === 'generic-rgbw');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, 'My RGBW');
    assert.deepEqual(mine[0].defs, sameId.channels);
    assert.equal(mine[0].readOnly, true);
    assert.equal(mine[0].builtIn, true);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Cutting a type down while its fixtures are running (Review focus 3) ----

test('a type with fewer segments saves, and the engine carries on with its fixtures in a running group', async () => {
  const logged: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-types-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath: join(root, 'server/seed/demo-show.json'), webDir: join(root, 'web'), output: { kind: 'none' }, log: (line: string) => logged.push(line) });
  const base = () => `http://127.0.0.1:${app.port}`;
  const put = async (body: unknown) => {
    const res = await fetch(`${base()}/api/show?source=patch`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const wait = async <T>(get: () => T | null | undefined | false, what: string): Promise<T> => {
    for (const until = Date.now() + 3000; ;) {
      const value = get();
      if (value) return value;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  let ws: WebSocket | undefined;
  try {
    await app.start();
    const stage = JSON.parse(readFileSync(join(root, 'shows/stage-l1.json'), 'utf8'));
    stage.operator.manualForOperators = true;
    assert.equal((await put(stage)).status, 200);

    ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const seen: any[] = [];
    ws.on('message', (data, isBinary) => { if (!isBinary) seen.push(JSON.parse(String(data))); });
    await new Promise((r) => ws!.once('open', r));
    const latest = (type: string) => seen.findLast((m) => m.type === type)?.[type];
    let ref = 0;
    const send = async (cmd: unknown): Promise<string | null> => {
      const mine = ++ref;
      ws!.send(JSON.stringify({ type: 'command', ref: mine, cmd }));
      return (await wait(() => seen.find((m) => m.type === 'result' && m.ref === mine), `the reply to ${JSON.stringify(cmd)}`)).error;
    };
    await wait(() => latest('layout') && latest('state'), 'the first layout and state');

    // The two SixBars run an effect as a group, and the third segment of one of them is held by hand.
    const wave = {
      kind: 'effect', effect: 'wave', colours: [{ hex: '#12ab34' }, { hex: '#3456cd', white: 0.2 }], speed: { beats: 4 },
      direction: 'ltr', waves: 3, size: 0.5, edge: 'soft', intensity: 1,
    };
    assert.equal(await send({ type: 'groupEffect', group: 'key-lights', effect: wave, fade: 0 }), null);
    assert.equal(await send({ type: 'manual', target: { fixture: 'b1', segment: 2 }, colour: '#ff0000', intensity: 1 }), null);
    assert.equal(await send({ type: 'manual', target: { fixture: 'b2', segment: 0 }, colour: '#00ff00', intensity: 1 }), null);
    await wait(() => latest('state').held?.length === 2, 'both held segments');
    // The effect is running on the key lights, so the cut hits a group that is playing something.
    await wait(() => latest('state').groups['key-lights'].effect, 'the effect running on the key lights');

    // Cut the SixBar 500 to two segments (12 channels): the show is accepted.
    const current = (await (await fetch(`${base()}/api/show`)).json()) as any;
    const cut = { ...current, profiles: current.profiles.map((p: any) => (p.id === sixbar.id ? { ...p, channels: p.channels.slice(0, 12) } : p)) };
    assert.equal(cut.profiles.find((p: any) => p.id === sixbar.id).channels.length, 12);
    assert.equal(segmentCount(cut.profiles.find((p: any) => p.id === sixbar.id).channels), 2);
    assert.equal((await put(cut)).status, 200);
    // The hold on a segment the type no longer has is let go; the one that still exists stays, and the effect carries on.
    await wait(() => latest('state').held?.length === 1, 'a segment that is gone to be let go');
    assert.deepEqual(latest('state').held.map((h: any) => [h.fixture, h.segment]), [['b2', 0]]);
    assert.equal(latest('state').groups['key-lights'].effect?.effect, 'wave');

    // The state is still published, and the engine still answers: a look, then Blackout.
    const framesBefore = seen.filter((m) => m.type === 'state').length;
    assert.equal(await send({ type: 'look', id: 'worship', fade: 0 }), null);
    await wait(() => latest('state').look === 'worship', 'worship on stage');
    assert.ok(seen.filter((m) => m.type === 'state').length > framesBefore, 'state keeps coming');
    assert.equal(await send({ type: 'blackout' }), null);
    await wait(() => latest('state').look === 'blackout', 'blackout');
    // A crashed worker is only restarted after 200 ms, so look at the log as well: nothing may have gone wrong.
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(logged.filter((line) => /Engine worker (error|stopped)/.test(line)), []);
    const profiles = (await (await fetch(`${base()}/api/profiles`)).json()) as any[];
    assert.equal(profiles.find((p) => p.id === sixbar.id).channels, 12);
    assert.equal(profiles.find((p) => p.id === sixbar.id).segments, 2);
  } finally {
    ws?.close();
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
