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
  const { show, pins } = keepLitPresets(before, edited, e.runtime().groups);
  return { e, show, pins };
}

test('a shared colour edit (colour, brightness, White, Amber and UV, every group of that name) pinned by Prepare leaves the lights frame for frame', () => {
  const before = rig();
  const edited = editColour(before, { preset: 'key-lights-sarkans', colour: '#00ff00', white: 0.5, amber: 0.4, uv: 0.3, level: 0.5, shared: true, sameName: true }).show;
  const { e, show, pins } = pinned(before, edited, 'background-sarkans');
  assert.deepEqual(pins.map((p) => p.group).sort(), ['background', 'key-lights']);
  // A second engine that never sees the edit: what the lights would have done.
  const ref = lit(before, 'background-sarkans');
  e.setShow(show, 1, pins);
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
  e.setShow(show, 1, pins);
  ref.setShow(before, 1);
  assert.deepEqual(frames(e, 1 + FRAME, 40), frames(ref, 1 + FRAME, 40));
  // The show goes back (the copies stay, hidden), and each pin runs the other way.
  const copies = show.presets.filter((p) => p.custom && !before.presets.some((q) => q.id === p.id));
  e.setShow({ ...before, presets: [...before.presets, ...copies] }, 2, pins.map((p) => ({ group: p.group, from: p.to, to: p.from })));
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
  e.setShow(show, 1, pins);
  ref.setShow(before, 1);
  assert.deepEqual(frames(e, 1 + FRAME, 200), frames(ref, 1 + FRAME, 200));
});

test('a pin is skipped when the group has moved on, or when the copy is another light', () => {
  const before = rig();
  const edited = editColour(before, { preset: 'key-lights-sarkans', colour: '#00ff00', sameName: false }).show;
  const { e, show, pins } = pinned(before, edited, 'background-sarkans');
  // Another desk took the key lights elsewhere before the edit arrived.
  e.apply({ type: 'groupPreset', group: 'key-lights', preset: 'key-lights-zils', fade: 0 }, 1);
  e.setShow(show, 1, pins);
  assert.equal(e.runtime().groups['key-lights'], 'key-lights-zils');
  // A pin onto a preset that makes another light does nothing: the group takes the edit as usual.
  const e2 = lit(before, 'background-sarkans');
  e2.setShow(edited, 1, [{ group: 'key-lights', from: 'key-lights-sarkans', to: 'key-lights-zils' }]);
  assert.equal(e2.runtime().groups['key-lights'], 'key-lights-sarkans');
});
