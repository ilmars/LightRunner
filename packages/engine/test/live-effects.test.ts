import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveEffectLayer, ensureRunningOrder, saveItem, type EffectLayer, type StageCommand } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { FRAME, beyondOwnMotion, close, demoShow } from './helpers.ts';

const G = 'back-wall';

const wave = (over: Partial<LiveEffectLayer> = {}): LiveEffectLayer => LiveEffectLayer.parse({
  kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }], speed: { beats: 4 }, waves: 2, ...over,
});

const send = (effect: LiveEffectLayer, more: Partial<Extract<StageCommand, { type: 'groupEffect' }>> = {}): StageCommand =>
  ({ type: 'groupEffect', group: G, effect, fade: 0.2, ...more });

function run(e: Engine, from: number, to: number): void {
  for (let t = from; t <= to + 1e-9; t += FRAME) e.frame(t);
}

test('a live effect runs as fx:<group>:<n>, numbered up, and the state shows it', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  assert.equal(e.apply(send(wave()), 1), null);
  assert.equal(e.recorded, true);
  const first = e.liveState(1, 'off').groups[G]!;
  assert.match(first.preset!, /^fx:back-wall:\d+$/);
  assert.deepEqual(first.effect, wave());
  assert.equal(first.live, null);
  assert.equal(e.liveState(1, 'off').groups.audience!.effect, null);
  e.apply(send(wave({ edge: 'hard' })), 2);
  const second = e.liveState(2, 'off').groups[G]!.preset!;
  assert.notEqual(second, first.preset);
  assert.ok(Number(second.split(':')[2]) > Number(first.preset!.split(':')[2]));
  // The same effect again is the same live preset: nothing changes, and there is no Undo step.
  e.apply(send(wave({ edge: 'hard' })), 3);
  assert.equal(e.recorded, false);
  assert.equal(e.liveState(3, 'off').groups[G]!.preset, second);
});

test('a live effect starts from the stage clock; a drag carries the running phase over', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  run(e, 0, 2.5);
  e.apply(send(wave()), 2.5);
  // 120 bpm for 2.5 s is 5 beats: a cycle and a quarter of a 4-beat wave, taken round its one colour.
  assert.ok(close(e.effectPhase(G)!, 0.25, 1e-6), `phase ${e.effectPhase(G)}`);
  run(e, 2.5 + FRAME, 10);
  const at = e.effectPhase(G)!;
  // A later send of a drag (a new speed) carries on from exactly where the pattern is.
  e.apply(send(wave({ speed: { beats: 3.9 } }), { continues: true }), 10);
  assert.equal(e.effectPhase(G), at);
  assert.equal(e.recorded, false, 'it joins the drag\'s Undo step');
  // A send that doesn't continue starts from the stage clock instead.
  const f = new Engine(demoShow());
  f.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  run(f, 0, 10);
  f.apply(send(wave({ speed: { beats: 3.9 } })), 10);
  const beats = 20; // 10 s at 120 bpm
  assert.ok(close(f.effectPhase(G)!, beats / 3.9 % 1, 1e-6), `phase ${f.effectPhase(G)}`);
});

test('a drag through effect settings never jumps', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  run(e, 0, 1);
  e.apply(send(wave({ size: 0.2 }), { fade: 2 }), 1);
  run(e, 1 + FRAME, 3.5);
  const { worst } = beyondOwnMotion(e, 3.5 + FRAME, 12, (t) => {
    const k = Math.round((t - 1) / FRAME);
    // A send every 0.1 s, slowly changing the size and the speed.
    if (t > 4 && t < 11 && k % 4 === 0) {
      e.apply(send(wave({ size: 0.2 + (t - 4) / 12, speed: { beats: 4 - (t - 4) / 4 } }), { continues: true }), t);
    }
  });
  assert.ok(worst <= 0.05, `step beyond own motion ${worst}`);
});

test('Undo takes a live effect back, and an effect Undo would bring back is kept', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(send(wave()), 1);
  const first = e.liveState(1, 'off').groups[G]!.preset!;
  e.apply(send(wave({ effect: 'chase' })), 2);
  // Many other changes in between.
  let steps = 0;
  for (let k = 0; k < 10; k++) {
    e.apply({ type: 'groupPreset', group: 'audience', preset: k % 2 ? 'aud-blue' : 'aud-warm', fade: 0 }, 3 + k);
    if (e.recorded) steps++;
  }
  assert.equal(steps, 10);
  for (let k = 0; k < steps; k++) assert.equal(e.apply({ type: 'undo' }, 20 + k), null);
  assert.equal(e.apply({ type: 'undo' }, 40), null);
  const back = e.liveState(40, 'off').groups[G]!;
  assert.equal(back.preset, first);
  assert.deepEqual(back.effect, wave());
  assert.equal(e.apply({ type: 'undo' }, 50), null);
  assert.equal(e.liveState(50, 'off').groups[G]!.preset, 'back-purple');

  // With no fade, the effect before is gone from the group's mix at once; only the Undo step names it.
  e.apply(send(wave({ effect: 'fill' }), { fade: 0 }), 60);
  const fill = e.liveState(60, 'off').groups[G]!.preset;
  e.apply(send(wave({ effect: 'yoyo' }), { fade: 0 }), 61);
  e.apply({ type: 'undo' }, 62);
  assert.equal(e.liveState(62, 'off').groups[G]!.preset, fill);
  assert.equal(e.liveState(62, 'off').groups[G]!.effect?.effect, 'fill');
});

test('smoke groups refuse effects', () => {
  const show = demoShow();
  show.groups.find((g) => g.id === 'pulpit')!.kind = 'smoke';
  const e = new Engine(show);
  assert.equal(e.apply({ type: 'groupEffect', group: 'pulpit', effect: wave() }, 0), '"pulpit" is a smoke machine: use its slider or Puff');
  assert.equal(e.apply({ type: 'groupEffect', group: 'nope', effect: wave() }, 0), 'unknown group "nope"');
});

test('the runtime state keeps the live effects the stage names, also through Blackout, and restore brings them back', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(send(wave({ edge: 'hard' })), 1);
  e.apply(send(wave()), 2);
  const id = e.liveState(2, 'off').groups[G]!.preset!;
  assert.deepEqual(e.runtime().effects, { [id]: wave() });
  e.apply({ type: 'blackout' }, 3);
  const rt = e.runtime();
  assert.deepEqual(rt.effects, { [id]: wave() }, 'Blackout remembers it for the next look');

  const f = new Engine(demoShow());
  f.restore(JSON.parse(JSON.stringify(rt)), 0);
  f.apply({ type: 'look', id: 'walk-in', fade: 0 }, 1);
  assert.equal(f.liveState(1, 'off').groups[G]!.preset, 'back-deep-blue');
  // Blackout restored, then a look that leaves the back wall alone brings the effect back.
  const show = demoShow();
  show.looks.push({ id: 'pulpit-only', name: 'Pulpit only', groups: [{ group: 'pulpit', preset: 'pulpit-on' }] });
  const h = new Engine(show);
  h.restore(JSON.parse(JSON.stringify(rt)), 0);
  h.apply({ type: 'look', id: 'pulpit-only', fade: 0 }, 1);
  assert.equal(h.liveState(1, 'off').groups[G]!.preset, id);
  assert.deepEqual(h.liveState(1, 'off').groups[G]!.effect, wave());
  // A new live effect after the restart gets a new number.
  h.apply(send(wave({ effect: 'meteor' })), 2);
  assert.notEqual(h.liveState(2, 'off').groups[G]!.preset, id);
});

test('a live effect over a base colour is its own live effect, shown in the state and kept through a restart', () => {
  const base = { colour: { hex: '#ffb46b', white: 0.3 }, level: 0.5 };
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(send(wave(), { fade: 0 }), 1);
  const plain = e.liveState(1, 'off').groups[G]!.preset;
  e.apply(send(wave({ base }), { fade: 0 }), 2);
  const over = e.liveState(2, 'off').groups[G]!;
  assert.notEqual(over.preset, plain, 'the base makes it another effect');
  assert.deepEqual(over.effect, wave({ base }));
  e.apply(send(wave({ base: { ...base, level: 0.2 } }), { fade: 0 }), 3);
  assert.notEqual(e.liveState(3, 'off').groups[G]!.preset, over.preset, 'so does its level');
  e.apply(send(wave({ base }), { fade: 0 }), 4);
  run(e, 4, 6);
  const f = new Engine(demoShow());
  f.restore(JSON.parse(JSON.stringify(e.runtime())), 0);
  run(f, 0, 0);
  assert.deepEqual(f.liveState(0, 'off').groups[G]!.effect, wave({ base }));
  // Over-the-wire colours are plain: a palette base is refused.
  assert.equal(LiveEffectLayer.safeParse({ ...wave(), base: { colour: { palette: 'x', index: 0 }, level: 0.5 } }).success, false);
});

test('fading between an effect over a base and a plain colour or another effect never jumps', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(send(wave({ effect: 'chase', edge: 'hard', base: { colour: { hex: '#0000ff' }, level: 0.6 } }), { fade: 3 }), 0);
  e.frame(0);
  assert.ok(beyondOwnMotion(e, FRAME, 4).worst <= 0.05, 'into the base effect');
  e.apply(send(wave({ effect: 'sparkle', colours: [{ hex: '#ff0000' }, { hex: '#00ff00' }] }), { fade: 2 }), 4 + FRAME);
  assert.ok(beyondOwnMotion(e, 4 + FRAME, 7).worst <= 0.05, 'to another effect');
  e.apply({ type: 'look', id: 'walk-in', fade: 2 }, 7 + FRAME);
  assert.ok(beyondOwnMotion(e, 7 + FRAME, 10).worst <= 0.05, 'to a look');
});

test('a restart while a live effect runs shows the same effect', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(send(wave(), { fade: 0 }), 1);
  run(e, 1, 3);
  const f = new Engine(demoShow());
  f.restore(JSON.parse(JSON.stringify(e.runtime())), 0);
  run(f, 0, 0);
  const state = f.liveState(0, 'off').groups[G]!;
  assert.equal(state.preset, e.liveState(3, 'off').groups[G]!.preset);
  assert.deepEqual(state.effect, wave());
  assert.equal(state.progress, 1);
  // A broken entry in an old runtime file is left out rather than run.
  const g = new Engine(demoShow());
  g.restore({ ...e.runtime(), effects: { [state.preset!]: { kind: 'effect', effect: 'nope' } as unknown as EffectLayer } }, 0);
  assert.equal(g.liveState(0, 'off').groups[G]!.preset, null);
});

test('Save on Basic lights with an effect running leaves that group as Basic lights had it, and the look no longer reads as changed', () => {
  const show = ensureRunningOrder(demoShow());
  const basic = show.operator.safeLook!;
  show.looks.find((l) => l.id === basic)!.groups = [{ group: G, preset: 'back-amber' }];
  const e = new Engine(show, 0);
  e.apply({ type: 'safe' }, 0);
  run(e, 0, 4);
  assert.equal(e.liveState(4, 'off').lookChanged, false);
  e.apply(send(wave()), 4);
  e.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 }, 4);
  run(e, 4, 5);
  assert.equal(e.liveState(5, 'off').lookChanged, true, 'the audience colour is a change');
  const saved = saveItem(show, basic, e.runtime());
  assert.deepEqual(saved.looks.find((l) => l.id === basic)!.groups.find((x) => x.group === G), { group: G, preset: 'back-amber', level: 1 });
  e.setShow(saved, 5);
  const state = e.liveState(5, 'off');
  assert.equal(state.lookChanged, false);
  assert.match(state.groups[G]!.preset!, /^fx:/, 'the effect keeps running until something else is picked');
  // Basic lights again puts the back wall back on its own colour.
  e.apply({ type: 'safe' }, 6);
  assert.equal(e.liveState(6, 'off').groups[G]!.preset, 'back-amber');
});
