import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FADE_STEPS, Command, assignKey, clearKey, commandFor, controllerOf, deleteItem, deleteQuickLook, deviceName, editQuickLook, ensureRunningOrder,
  TapTempo, fadeStepAt, fadeStepIndex, isApcMini, isOperatorKeyTarget, keepControllerKeys, keyOf, moveItem, parseShow, pruneKeys, resetApcKeys, targetName,
  type ControlKey, type DeviceLayout, type Show,
} from '../src/index.ts';

const raw = () => JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8'));
const ready = (): Show => ensureRunningOrder(parseShow(raw()));
const pad = (number: number, device = 'APC mini mk2'): ControlKey => ({ device, type: 'note', channel: 1, number });
const knob = (number: number, device = 'nanoKONTROL2'): ControlKey => ({ device, type: 'cc', channel: 1, number });
const song = (s: Show, k: number) => ({ kind: 'song' as const, id: s.operator.runningOrder[k]! });

test('an old show without keys loads and saves unchanged', () => {
  const file = raw();
  assert.equal(file.operator.controller, undefined);
  const show = parseShow(file);
  assert.equal(show.operator.controller, undefined);
  assert.deepEqual(controllerOf(show), { keys: [], apcLayout: true, ignored: [] });
  assert.deepEqual(pruneKeys(show), show);
});

test('keys go round the show file', () => {
  const s = ready();
  const { show } = assignKey(assignKey(s, pad(56), song(s, 1)).show, knob(5), { kind: 'master' });
  const again = parseShow(JSON.parse(JSON.stringify(show)));
  assert.deepEqual(again.operator.controller, show.operator.controller);
  assert.deepEqual(keyOf(again, song(s, 1)), pad(56));
  assert.deepEqual(keyOf(again, { kind: 'master' }), knob(5));
  // A broken key is refused like any other bad field.
  const bad = structuredClone(JSON.parse(JSON.stringify(show)));
  bad.operator.controller.keys[0].key.channel = 17;
  assert.throws(() => parseShow(bad));
});

test('one key, one job: a key that is used moves, and a thing has one key', () => {
  const s = ready();
  const a = song(s, 1), b = song(s, 2);
  let r = assignKey(s, pad(56), a);
  assert.equal(r.moved, null);
  r = assignKey(r.show, pad(56), b);
  assert.deepEqual(r.moved, a);
  assert.equal(keyOf(r.show, a), null);
  assert.deepEqual(keyOf(r.show, b), pad(56));
  // Assigning another key to the same song replaces its key.
  r = assignKey(r.show, pad(57), b);
  assert.equal(r.moved, null);
  assert.deepEqual(keyOf(r.show, b), pad(57));
  assert.equal(controllerOf(r.show).keys.length, 1);
  // The same key again changes nothing.
  assert.equal(assignKey(r.show, pad(57), b).moved, null);
});

test('levels need a fader or a knob; buttons take either', () => {
  const s = ready();
  assert.throws(() => assignKey(s, pad(10), { kind: 'master' }), /Master needs a fader or a knob/);
  assert.throws(() => assignKey(s, pad(10), { kind: 'fadeKnob' }), /needs a fader or a knob/);
  assert.doesNotThrow(() => assignKey(s, knob(40), { kind: 'next' }));
  assert.throws(() => assignKey(s, pad(10), { kind: 'song', id: 'not-there' }), /no longer in the running order/);
  assert.throws(() => assignKey(s, pad(10), { kind: 'flash', group: 'not-there' }), /no longer in the show/);
});

test('a song keeps its key when it moves in the running order', () => {
  const s = ready();
  const target = song(s, 3);
  const keyed = assignKey(s, pad(58), target).show;
  const moved = moveItem(keyed, target.id, 1);
  assert.equal(moved.operator.runningOrder[1], target.id);
  assert.deepEqual(keyOf(pruneKeys(moved), target), pad(58));
});

test('a song or quick look that is deleted frees its key; so does a group that is gone', () => {
  const s = ready();
  const target = song(s, 2);
  let show = assignKey(s, pad(57), target).show;
  const quick = s.operator.quickLooks[0]!.look;
  show = assignKey(show, pad(40), { kind: 'quickLook', id: quick }).show;
  const group = s.operator.groups[0]!;
  show = assignKey(show, knob(1), { kind: 'groupLevel', group }).show;
  show = pruneKeys(deleteQuickLook(deleteItem(show, target.id), quick));
  assert.equal(keyOf(show, target), null);
  assert.equal(keyOf(show, { kind: 'quickLook', id: quick }), null);
  assert.deepEqual(keyOf(show, { kind: 'groupLevel', group }), knob(1));
  const noGroup = { ...show, groups: show.groups.filter((g) => g.id !== group) };
  assert.equal(keyOf(pruneKeys(noGroup), { kind: 'groupLevel', group }), null);
  // Nothing to free: the same show comes back.
  assert.equal(pruneKeys(show), show);
});

test("a quick look that takes its own copy of a song's look keeps its key", () => {
  const s = ready();
  // A quick look sharing a song's look (old data, or a merge).
  const shared = s.operator.runningOrder[2]!;
  const show = structuredClone(s);
  show.operator.quickLooks.push({ look: shared, tab: 'plain' });
  const keyed = assignKey(assignKey(show, pad(41), { kind: 'quickLook', id: shared }).show, pad(57), { kind: 'song', id: shared }).show;
  const edited = editQuickLook(keyed, { look: shared, name: 'Mine' });
  const copy = edited.operator.quickLooks.at(-1)!.look;
  assert.notEqual(copy, shared);
  assert.deepEqual(keyOf(edited, { kind: 'quickLook', id: copy }), pad(41));
  assert.deepEqual(keyOf(edited, { kind: 'song', id: shared }), pad(57));
});

test('Reset to the APC mini layout clears keys on APC minis only and turns the layout on', () => {
  const s = ready();
  let show = assignKey(s, pad(56), song(s, 1)).show;
  show = assignKey(show, pad(60, 'APC MINI'), song(s, 2)).show;
  show = assignKey(show, knob(3), { kind: 'master' }).show;
  show.operator.controller!.apcLayout = false;
  const reset = resetApcKeys(show);
  assert.deepEqual(controllerOf(reset).keys.map((k) => k.key.device), ['nanoKONTROL2']);
  assert.equal(controllerOf(reset).apcLayout, true);
});

test('clearing a key', () => {
  const s = ready();
  const show = clearKey(assignKey(s, pad(56), song(s, 1)).show, song(s, 1));
  assert.equal(keyOf(show, song(s, 1)), null);
  assert.throws(() => clearKey(show, song(s, 1)), /has no key/);
});

test('a device is known again after a re-plug, whatever number the computer gives its port', () => {
  assert.equal(deviceName('APC mini mk2'), 'APC mini mk2');
  assert.equal(deviceName('2- nanoKONTROL2'), 'nanoKONTROL2');
  assert.equal(deviceName('nanoKONTROL2:nanoKONTROL2 MIDI 1 20:0'), deviceName('nanoKONTROL2:nanoKONTROL2 MIDI 1 24:0'));
  assert.equal(deviceName('  Launch Control XL  '), 'Launch Control XL');
  assert.ok(isApcMini('APC MINI'));
  assert.ok(isApcMini('APC mini mk2'));
  assert.ok(!isApcMini('APC40 mkII'));
});

test('the fade knob sweeps Auto, Instant, 1, 2, 3, 5 and 10 s', () => {
  assert.deepEqual(FADE_STEPS, [null, 0, 1, 2, 3, 5, 10]);
  assert.equal(fadeStepAt(0), null);
  assert.equal(fadeStepAt(1), 10);
  assert.equal(fadeStepAt(1 / 6), 0);
  assert.equal(fadeStepAt(0.5), 2);
  assert.equal(fadeStepIndex(null), 0);
  assert.equal(fadeStepIndex(3), 4);
  // A fade set elsewhere that isn't on the knob counts as the nearest step.
  assert.equal(fadeStepIndex(4), 4);
  assert.equal(fadeStepIndex(60), 6);
});

test('what a key does, in plain words', () => {
  const s = ready();
  const group = s.operator.groups[1]!;
  const groupName = s.groups.find((g) => g.id === group)!.name;
  assert.equal(targetName(s, song(s, 0)), 'Basic lights');
  assert.equal(targetName(s, { kind: 'flash', group }), `Flash ${groupName}`);
  assert.equal(targetName(s, { kind: 'groupLevel', group }), `${groupName} level`);
  assert.equal(targetName(s, { kind: 'fadeTime', value: null }), 'Fade Auto');
  assert.equal(targetName(s, { kind: 'fadeTime', value: 0 }), 'Fade Instant');
  assert.equal(targetName(s, { kind: 'fadeTime', value: 2 }), 'Fade 2 s');
  assert.equal(targetName(s, { kind: 'tempoStep', times: 0.5 }), 'Tempo ÷2');
});

// ---- What a key asks for ----

const layout: DeviceLayout = {
  basicLights: 'basic',
  runningOrder: [{ id: 'basic' }, { id: 'one' }, { id: 'two' }],
  quickLooks: [{ id: 'blue' }],
  groups: [
    { id: 'front', kind: 'light', presets: [] },
    { id: 'haze', kind: 'smoke', presets: [] },
    { id: 'back', kind: 'light', presets: [] },
  ],
};
const st = { look: null, lastLook: null, master: 1, tempo: 120 };

test('keys for songs and quick looks become the same commands as the iPad', () => {
  assert.deepEqual(commandFor({ kind: 'song', id: 'two' }, layout, st), { type: 'look', id: 'two' });
  assert.deepEqual(commandFor({ kind: 'song', id: 'basic' }, layout, st), { type: 'safe' });
  assert.deepEqual(commandFor({ kind: 'song', id: 'gone' }, layout, st), { error: 'That song is no longer in the running order.' });
  assert.deepEqual(commandFor({ kind: 'quickLook', id: 'blue' }, layout, st), { type: 'quickLook', id: 'blue' });
  assert.deepEqual(commandFor({ kind: 'quickLook', id: 'gone' }, layout, st), { error: 'That quick look is no longer there.' });
});

test('groups by id, fade times and tempo steps', () => {
  assert.deepEqual(commandFor({ kind: 'flash', group: 'back', on: true }, layout, st), { type: 'flash', groups: ['back'], on: true });
  assert.deepEqual(commandFor({ kind: 'groupLevel', group: 'back', value: 0.5 }, layout, st), { type: 'groupLevel', group: 'back', value: 0.5 });
  assert.deepEqual(commandFor({ kind: 'groupLevel', group: 'haze', value: 0.5 }, layout, st), { error: 'That group is no longer in the show.' });
  assert.deepEqual(commandFor({ kind: 'fadeTime', value: null }, layout, st), { type: 'fadeTime', value: null });
  assert.deepEqual(commandFor({ kind: 'fadeTime', value: 3 }, layout, st), { type: 'fadeTime', value: 3 });
  assert.deepEqual(commandFor({ kind: 'tempoStep', times: 2 }, layout, st), { type: 'tempo', bpm: 240 });
  assert.deepEqual(commandFor({ kind: 'tempoStep', times: 2 }, layout, { ...st, tempo: 150 }), { type: 'tempo', bpm: 240 });
  assert.deepEqual(commandFor({ kind: 'tempoStep', times: 0.5 }, layout, { ...st, tempo: 61 }), { type: 'tempo', bpm: 40 });
  assert.deepEqual(commandFor({ kind: 'tempo', bpm: 97.4 }, layout, st), { type: 'tempo', bpm: 97 });
  // Every command a key makes is one the server takes.
  for (const c of [commandFor({ kind: 'tempoStep', times: 2 }, layout, st), commandFor({ kind: 'fadeTime', value: 5 }, layout, st)]) {
    assert.ok(Command.safeParse(c).success);
  }
});

test('tap tempo: the average of the last gaps, starting over after 2 s', () => {
  const t = new TapTempo();
  assert.equal(t.tap(0), null);
  assert.equal(t.tap(500), 120);
  assert.equal(t.tap(1000), 120);
  assert.equal(t.tap(4000), null, 'a long gap starts over');
  assert.equal(t.tap(4250), 240);
});

test("Undo goes back to a show with the programmer's keys and switches as they are now", () => {
  const s = ready();
  const before = assignKey(s, pad(56), song(s, 1)).show;
  let now = assignKey(before, pad(57), song(s, 2)).show;
  now = assignKey(now, pad(112), { kind: 'next' }).show;
  now.operator.controller!.apcLayout = false;
  const back = keepControllerKeys(before, now);
  assert.deepEqual(keyOf(back, song(s, 1)), pad(56));
  assert.equal(keyOf(back, song(s, 2)), null);
  assert.deepEqual(keyOf(back, { kind: 'next' }), pad(112));
  assert.equal(controllerOf(back).apcLayout, false);
  // A song key that the programmer's key has taken since stays with the programmer's.
  const taken = assignKey(now, pad(56), { kind: 'undo' }).show;
  assert.equal(keyOf(keepControllerKeys(before, taken), song(s, 1)), null);
  assert.ok(isOperatorKeyTarget(song(s, 1)) && !isOperatorKeyTarget({ kind: 'master' }));
});

test("Undo keeps a song key the programmer moved onto a fixed key's place since (it was no Undo step)", () => {
  const s = ready();
  // Before an operator edit: pad 112 is Next, and song 2 has pad 50.
  const before = assignKey(assignKey(s, pad(112), { kind: 'next' }).show, pad(50), song(s, 2)).show;
  // The operator's edit (a song key elsewhere), then the programmer gives Next's pad to song 2.
  const edited = assignKey(before, pad(51), song(s, 1)).show;
  const now = assignKey(edited, pad(112), song(s, 2)).show;
  assert.equal(keyOf(now, { kind: 'next' }), null);
  // Undo of the operator's edit: song 1's key goes, song 2 keeps the pad the programmer gave it.
  const back = keepControllerKeys(before, now);
  assert.equal(keyOf(back, song(s, 1)), null);
  assert.deepEqual(keyOf(back, song(s, 2)), pad(112));
  assert.equal(keyOf(back, { kind: 'next' }), null);
  assert.equal(controllerOf(back).keys.filter((b) => b.does.kind === 'song' && b.does.id === song(s, 2).id).length, 1, 'one key for the song');
});
