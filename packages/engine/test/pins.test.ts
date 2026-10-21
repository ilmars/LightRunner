// A show edit made in Prepare never changes the lights: the groups showing a changed preset carry on as a
// hidden copy of how it was (keepLitPresets), with no fade, and Undo puts them back on the preset the same way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addEffect, editColour, editEffect, ensureRunningOrder, keepLitPresets, parseShow, EffectLayer, type PresetPin, type Show,
} from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { FRAME } from './helpers.ts';

const rig = (): Show => ensureRunningOrder(parseShow(JSON.parse(readFileSync(new URL('../../../shows/stage-l1.json', import.meta.url), 'utf8'))));

/** Every universe's DMX and the picture, for `count` frames from `from`. */
function frames(e: Engine, from: number, count: number): string[] {
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const f = e.frame(from + n * FRAME);
    const dmx = [...f.universes.entries()].map(([u, b]) => `${u}:${Buffer.from(b).toString('hex')}`).join('|');
    out.push(`${dmx}|${Buffer.from(f.visual).toString('hex')}`);
  }
  return out;
}

/** An engine on `show` with the key lights on red and the background running `bg`, settled. */
function lit(show: Show, bg: string): Engine {
  const e = new Engine(show, 0);
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply({ type: 'groupPreset', group: 'key-lights', preset: 'key-lights-sarkans', fade: 0 }, 0);
  e.apply({ type: 'groupPreset', group: 'background', preset: bg, fade: 0 }, 0);
  e.frame(0);
  e.frame(1);
  return e;
}

function pinned(before: Show, edited: Show, bg: string): { e: Engine; show: Show; pins: PresetPin[] } {
  const e = lit(before, bg);
  const { show, pins } = keepLitPresets(before, edited, e.runtime());
  return { e, show, pins };
}

test('a shared colour edit (colour, brightness, White, Amber and UV, every group of that name) pinned by Prepare leaves the lights frame for frame', () => {
  const before = rig();
  const edited = editColour(before, { preset: 'key-lights-sarkans', colour: '#00ff00', white: 0.5, amber: 0.4, uv: 0.3, level: 0.5, shared: true, sameName: true }).show;
  const { e, show, pins } = pinned(before, edited, 'background-sarkans');
  assert.deepEqual(pins.map((p) => p.group).sort(), ['background', 'key-lights']);
  // A second engine that never sees the edit: what the lights would have done.
  const ref = lit(before, 'background-sarkans');
  e.setShow(show, 1, { pins });
  ref.setShow(before, 1);
  assert.deepEqual(frames(e, 1 + FRAME, 200), frames(ref, 1 + FRAME, 200));
  // The groups run the copies (so the look reads as changed), with no fade and no Undo step of their own.
  const s = e.liveState(6, 'ok');
  for (const pin of pins) {
    assert.equal(s.groups[pin.group]!.preset, pin.to);
    assert.equal(s.groups[pin.group]!.changed, true);
    assert.equal(s.groups[pin.group]!.progress, 1);
  }
  assert.equal(s.canUndo, ref.liveState(6, 'ok').canUndo);

  // Without the pins the lights fade to the edit, as a live edit does.
  const live = lit(before, 'background-sarkans');
  live.setShow(edited, 1);
  assert.notEqual(frames(live, 1 + FRAME, 200).at(-1), frames(lit(before, 'background-sarkans'), 1 + FRAME, 200).at(-1));
});

test('Undo of a pinned edit moves the groups back onto the preset, still frame for frame', () => {
  const before = rig();
  const edited = editColour(before, { preset: 'key-lights-sarkans', colour: '#0000ff', level: 0.7, shared: true, sameName: true }).show;
  const { e, show, pins } = pinned(before, edited, 'background-sarkans');
  const ref = lit(before, 'background-sarkans');
  e.setShow(show, 1, { pins });
  ref.setShow(before, 1);
  assert.deepEqual(frames(e, 1 + FRAME, 40), frames(ref, 1 + FRAME, 40));
  // The show goes back (the copies stay, hidden), and each pin runs the other way.
  const copies = show.presets.filter((p) => p.custom && !before.presets.some((q) => q.id === p.id));
  e.setShow({ ...before, presets: [...before.presets, ...copies] }, 2, { pins: pins.map((p) => ({ group: p.group, from: p.to, to: p.from })) });
  ref.setShow(before, 2);
  assert.deepEqual(frames(e, 2 + FRAME, 120), frames(ref, 2 + FRAME, 120));
  const s = e.liveState(6, 'ok');
  assert.equal(s.groups['key-lights']!.preset, 'key-lights-sarkans');
  assert.equal(s.groups.background!.preset, 'background-sarkans');
});

test('an effect edit pinned by Prepare leaves the moving lights frame for frame', () => {
  const s = rig();
  const effect = EffectLayer.parse({ kind: 'effect', effect: 'chase', colours: [{ palette: 'lightkey', index: 2 }, { hex: '#0000ff' }], speed: { beats: 2 } });
  const { show: before, id } = addEffect(s, { group: 'background', name: 'Chase', effect });
  const edited = editEffect(before, { preset: id, effect: EffectLayer.parse({ ...effect, colours: [{ hex: '#00ff00' }, { hex: '#ffffff' }], edge: 'hard' }) });
  const { e, show, pins } = pinned(before, edited, id);
  assert.equal(pins.length, 1);
  const ref = lit(before, id);
  e.setShow(show, 1, { pins });
  ref.setShow(before, 1);
  assert.deepEqual(frames(e, 1 + FRAME, 200), frames(ref, 1 + FRAME, 200));
});

test('a pin is skipped when the group has moved on, or when the copy is another light', () => {
  const before = rig();
  const edited = editColour(before, { preset: 'key-lights-sarkans', colour: '#00ff00', sameName: false }).show;
  const { e, show, pins } = pinned(before, edited, 'background-sarkans');
  // Another desk took the key lights elsewhere before the edit arrived.
  e.apply({ type: 'groupPreset', group: 'key-lights', preset: 'key-lights-zils', fade: 0 }, 1);
  e.setShow(show, 1, { pins });
  assert.equal(e.runtime().groups['key-lights'], 'key-lights-zils');
  // A pin onto a preset that makes another light does nothing: the group takes the edit as usual.
  const e2 = lit(before, 'background-sarkans');
  e2.setShow(edited, 1, { pins: [{ group: 'key-lights', from: 'key-lights-sarkans', to: 'key-lights-zils' }] });
  assert.equal(e2.runtime().groups['key-lights'], 'key-lights-sarkans');
});

/** Every universe's DMX and the picture, frame by frame from `from`, on two engines at once (they must match). */
function sameFrames(e: Engine, ref: Engine, from: number, count: number, what: string): void {
  for (let n = 0; n < count; n++) {
    const t = from + n * FRAME;
    assert.deepEqual(frames(e, t, 1), frames(ref, t, 1), `${what}: frame ${n} (${t.toFixed(3)} s)`);
  }
}

test('an edit in Prepare made while the colour is fading out leaves the lights frame for frame, and a later tap takes the edit', () => {
  const before = rig();
  const edited = editColour(before, { preset: 'key-lights-sarkans', colour: '#00ff00', sameName: false }).show;
  const start = (show: Show) => {
    const e = lit(show, 'background-sarkans');
    // Red fading out, blue fading in, over 3 s; the edit lands a second in.
    e.apply({ type: 'groupPreset', group: 'key-lights', preset: 'key-lights-zils', fade: 3 }, 1);
    for (let t = 1; t <= 2; t += FRAME) e.frame(t);
    return e;
  };
  const e = start(before), ref = start(before);
  const { show, pins } = keepLitPresets(before, edited, e.runtime());
  assert.deepEqual(pins, [], 'red is not what the key lights settle on, so nothing is pinned');
  e.setShow(show, 2, { pins });
  ref.setShow(before, 2);
  sameFrames(e, ref, 2 + FRAME, 120, 'through the fade');
  // The stage taking red again takes the edited red (green), not the one that faded out.
  e.apply({ type: 'groupPreset', group: 'key-lights', preset: 'key-lights-sarkans', fade: 0 }, 5);
  e.frame(5);
  const fresh = new Engine(edited, 0);
  fresh.apply({ type: 'groupPreset', group: 'key-lights', preset: 'key-lights-sarkans', fade: 0 }, 0);
  fresh.frame(0);
  const at = (x: Engine) => x.lights()[x.fixtureIds().indexOf('b1')]!;
  assert.ok(at(e).g > 0.9 && at(e).r < 0.1, `green after the tap: ${JSON.stringify(at(e))}`);
  assert.deepEqual(at(e), at(fresh));
});

test('an edit in Prepare during Blackout keeps what Blackout brings back: its fade-out, Undo of the Blackout and the next look', () => {
  const before = rig();
  const edited = editColour(before, { preset: 'key-lights-sarkans', colour: '#00ff00', level: 0.5, shared: true, sameName: true }).show;
  const start = (show: Show) => {
    const e = lit(show, 'background-sarkans');
    e.apply({ type: 'blackout' }, 1);
    for (let t = 1; t <= 1.4; t += FRAME) e.frame(t);
    return e;
  };
  const e = start(before), ref = start(before);
  const { show, pins } = keepLitPresets(before, edited, e.runtime());
  assert.deepEqual(pins.map((p) => [p.group, p.from]).sort(), [['background', 'background-sarkans'], ['key-lights', 'key-lights-sarkans']]);
  e.setShow(show, 1.4, { pins });
  ref.setShow(before, 1.4);
  sameFrames(e, ref, 1.4 + FRAME, 60, "through Blackout's fade-out");
  const pinned = Object.fromEntries(pins.map((p) => [p.group, p.to]));
  assert.equal(e.runtime().beforeBlackout?.['key-lights'], pinned['key-lights'], "Blackout's memory names the copy");
  // Undo of the Blackout brings back exactly what was lit.
  e.apply({ type: 'undo' }, 3);
  ref.apply({ type: 'undo' }, 3);
  sameFrames(e, ref, 3, 120, 'Undo of the Blackout');
  assert.equal(e.runtime().groups['key-lights'], pinned['key-lights']);

  // The same Blackout left by a song that leaves the key lights alone: they come back from Blackout's memory, as they were.
  const withLook = (show: Show): Show => ({ ...show, looks: [...show.looks, { id: 'bg-only', name: 'Background only', groups: [{ group: 'background', preset: 'background-zils' }] }] });
  const before2 = withLook(before);
  const kept2 = keepLitPresets(before2, withLook(edited), start(before2).runtime());
  const e2 = start(before2), ref2 = start(before2);
  e2.setShow(kept2.show, 1.4, { pins: kept2.pins });
  ref2.setShow(before2, 1.4);
  for (const x of [e2, ref2]) x.apply({ type: 'look', id: 'bg-only', fade: 1 }, 3);
  sameFrames(e2, ref2, 3, 120, 'out of Blackout by a song that leaves the key lights alone');
  assert.equal(e2.runtime().groups['key-lights'], kept2.pins.find((p) => p.group === 'key-lights')!.to);
});

test("Undo of an edit made in Prepare during Blackout puts Blackout's memory back on the colour itself", () => {
  const before = rig();
  const edited = editColour(before, { preset: 'key-lights-sarkans', colour: '#0000ff', sameName: false }).show;
  const e = lit(before, 'background-sarkans');
  e.apply({ type: 'blackout' }, 1);
  for (let t = 1; t <= 3; t += FRAME) e.frame(t);
  const { show, pins } = keepLitPresets(before, edited, e.runtime());
  e.setShow(show, 3, { pins });
  const copies = show.presets.filter((p) => p.custom && !before.presets.some((q) => q.id === p.id));
  e.setShow({ ...before, presets: [...before.presets, ...copies] }, 4, { pins: pins.map((p) => ({ group: p.group, from: p.to, to: p.from })) });
  assert.equal(e.runtime().beforeBlackout?.['key-lights'], 'key-lights-sarkans');
});
