// How long a change lasts (the new operator page): pinned through Next and song parts, "for a while" in beats, and
// freeze. Everything the operator starts lasts until it is changed or the next cue unless it says otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveEffectLayer, type StageCommand } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { FRAME, demoShow, maxStep } from './helpers.ts';

const G = 'back-wall';
const wave = (): LiveEffectLayer => LiveEffectLayer.parse({
  kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }, { hex: '#0000ff' }], speed: { beats: 4 }, waves: 2,
});
const effect = (more: Partial<Extract<StageCommand, { type: 'groupEffect' }>> = {}): StageCommand =>
  ({ type: 'groupEffect', group: G, effect: wave(), fade: 0.2, ...more });

function run(e: Engine, from: number, to: number): void {
  for (let t = from; t <= to + 1e-9; t += FRAME) e.frame(t);
}

const group = (e: Engine, now: number, g = G) => e.liveState(now, 'off').groups[g]!;

test('an effect started without saying how long is gone at the next cue', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(effect(), 1);
  run(e, 1, 2);
  assert.equal(group(e, 2).pinned, false);
  assert.equal(group(e, 2).beatsLeft, null);
  e.apply({ type: 'look', id: 'response', fade: 0 }, 2);
  assert.equal(group(e, 2).preset, 'back-amber');
});

test('a pinned effect carries on through Next and a song part, and ends when the group is changed by hand', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(effect({ lasts: 'pin' }), 1);
  run(e, 1, 2);
  const fx = group(e, 2).preset;
  assert.match(fx!, /^fx:back-wall:/);
  assert.equal(group(e, 2).pinned, true);
  // Next: the look changes every other group, never the pinned one.
  e.apply({ type: 'look', id: 'response', fade: 1 }, 2);
  run(e, 2, 4);
  const s = e.liveState(4, 'off');
  assert.equal(s.look, 'response');
  assert.equal(s.groups[G]!.preset, fx);
  assert.equal(s.groups['front-wash']!.preset, 'front-warm');
  assert.deepEqual(e.runtime().pinned, [G]);
  // A song's part (a quick look that keeps pins) leaves it too.
  e.apply({ type: 'quickLook', id: 'prayer', fade: 0, keepPinned: true }, 4);
  assert.equal(group(e, 4).preset, fx);
  assert.equal(group(e, 4, 'audience').preset, 'aud-blue');
  // A quick look tapped by hand takes it, and the pin is gone.
  e.apply({ type: 'quickLook', id: 'prayer', fade: 0, only: [G] }, 5);
  assert.equal(group(e, 5).preset, 'back-dim-blue');
  assert.equal(group(e, 5).pinned, false);
  assert.equal(e.runtime().pinned, undefined);
});

test('pin and unpin what a group runs now; Basic lights and Blackout end every pin', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(effect(), 1);
  assert.equal(e.apply({ type: 'pin', group: G, on: true }, 1), null);
  assert.equal(group(e, 1).pinned, true);
  assert.equal(e.apply({ type: 'pin', group: G, on: false }, 1), null);
  e.apply({ type: 'look', id: 'response', fade: 0 }, 2);
  assert.equal(group(e, 2).preset, 'back-amber');
  e.apply(effect({ lasts: 'pin' }), 3);
  e.apply({ type: 'blackout' }, 4);
  assert.equal(group(e, 4).pinned, false);
  e.apply(effect({ lasts: 'pin' }), 5);
  e.apply({ type: 'safe' }, 6);
  assert.equal(group(e, 6).pinned, false);
  assert.equal(e.apply({ type: 'pin', group: 'nope', on: true }, 7), 'unknown group "nope"');
});

test('for a while: the effect runs its beats at the stage tempo, then fades back to the cue with no jump', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply({ type: 'tempo', bpm: 120 }, 0);
  run(e, 0, 1);
  e.apply(effect({ lasts: 8 }), 1);
  run(e, 1, 2);
  // 120 bpm: 2 beats a second, so about 6 of the 8 are left after 1 s.
  const left = group(e, 2).beatsLeft!;
  assert.ok(Math.abs(left - 6) < 0.2, `beats left ${left}`);
  run(e, 2, 4.9);
  assert.match(group(e, 4.9).preset!, /^fx:/);
  // At 5 s the 8 beats are up: back to the look's colour, as smoothly as any fade.
  const step = maxStep(e, 4.9, 8);
  assert.ok(step < 0.05, `largest step ${step}`);
  assert.equal(group(e, 8).preset, 'back-purple');
  assert.equal(group(e, 8).beatsLeft, null);
});

test('for a while counts beats, so a faster tempo ends it sooner', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply({ type: 'tempo', bpm: 60 }, 0);
  run(e, 0, 1);
  e.apply(effect({ lasts: 4 }), 1);
  run(e, 1, 2);
  e.apply({ type: 'tempo', bpm: 240 }, 2);
  // 1 beat gone at 60 bpm; the other 3 take 0.75 s at 240 bpm.
  run(e, 2, 3);
  assert.equal(group(e, 3).preset, 'back-purple');
});

test('pinning a "for a while" keeps it; a new change by hand ends the while', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  run(e, 0, 1);
  e.apply(effect({ lasts: 4 }), 1);
  e.apply({ type: 'pin', group: G, on: true }, 1);
  run(e, 1, 6);
  assert.match(group(e, 6).preset!, /^fx:/);
  e.apply(effect({ lasts: 4 }), 6);
  e.apply({ type: 'groupPreset', group: G, preset: 'back-amber', fade: 0 }, 6.5);
  run(e, 6.5, 10);
  assert.equal(group(e, 10).preset, 'back-amber');
});

test('freeze holds the effect still, and it carries on from there', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(effect({ fade: 0 }), 0);
  run(e, 0, 1);
  assert.equal(e.apply({ type: 'freeze', group: G, on: true }, 1), null);
  assert.equal(group(e, 1).frozen, true);
  e.frame(1 + FRAME);
  const colours = () => JSON.stringify(e.lights());
  const held = colours();
  run(e, 1 + FRAME, 3);
  assert.equal(colours(), held);
  e.apply({ type: 'freeze', group: G, on: false }, 3);
  run(e, 3, 3.5);
  assert.notEqual(colours(), held);
  // Freeze is not an Undo step; a new colour ends it.
  e.apply({ type: 'freeze', group: G, on: true }, 4);
  e.apply({ type: 'groupPreset', group: G, preset: 'back-amber', fade: 0 }, 4);
  assert.equal(group(e, 4).frozen, false);
});

test('a restart keeps pins', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(effect({ lasts: 'pin' }), 1);
  const saved = e.runtime();
  const again = new Engine(demoShow());
  again.restore(saved, 0);
  assert.equal(group(again, 0).pinned, true);
  again.apply({ type: 'look', id: 'response', fade: 0 }, 1);
  assert.equal(group(again, 1).preset, saved.groups[G]);
});

test('a pin made in a Prepare draft goes live with Go, and Next then leaves that group alone', () => {
  const live = new Engine(demoShow());
  live.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  // The draft: a copy of the stage, where the effect is started pinned.
  const draft = new Engine(demoShow());
  draft.restore(live.runtime(), 0);
  draft.apply(effect({ lasts: 'pin' }), 1);
  const stage = draft.runtime();
  assert.deepEqual(stage.pinned, [G]);
  // Go.
  assert.equal(live.apply({ type: 'applyStage', stage, fade: 0 }, 2), null);
  assert.equal(group(live, 2).pinned, true);
  const fx = group(live, 2).preset;
  live.apply({ type: 'look', id: 'response', fade: 0 }, 3);
  assert.equal(group(live, 3).preset, fx);
  // A draft without pins takes a live pin away with Go: the stage becomes the draft.
  const plain = new Engine(demoShow());
  plain.restore(live.runtime(), 0);
  plain.apply({ type: 'pin', group: G, on: false }, 0);
  // (Go always sends the draft's pins, none included.)
  live.apply({ type: 'applyStage', stage: { ...plain.runtime(), pinned: plain.runtime().pinned ?? [] }, fade: 0 }, 4);
  assert.equal(group(live, 4).pinned, false);
});
