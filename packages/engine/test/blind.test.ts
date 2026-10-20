// Blind mode in the engine: applyStage sends a whole draft stage to the lights in one change,
// and a draft engine can run its effects on the live stage's clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command, LiveEffectLayer, parseShow, type RuntimeState, type Show, type StageCommand } from '../../shared/src/index.ts';
import { Engine } from '../src/index.ts';
import { FRAME, beyondOwnMotion, close, demoShow, levelsShow, lightOf } from './helpers.ts';

const G = 'back-wall';

const wave = (over: Partial<LiveEffectLayer> = {}): LiveEffectLayer => LiveEffectLayer.parse({
  kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }, { hex: '#0000ff' }], speed: { beats: 4 }, waves: 2, ...over,
});

const effect = (group: string, layer: LiveEffectLayer, fade = 0): StageCommand => ({ type: 'groupEffect', group, effect: layer, fade });

const go = (stage: RuntimeState, fade?: number): StageCommand => ({ type: 'applyStage', stage, fade });

/** Two phases of a two-colour effect (in cycles) show the same pattern: the same, taken round its colours. */
const inStep = (a: number, b: number) => {
  const d = ((a - b) % 2 + 2) % 2;
  return d < 1e-9 || 2 - d < 1e-9;
};

function run(e: Engine, from: number, to: number): void {
  for (let t = from; t <= to + 1e-9; t += FRAME) e.frame(t);
}

/** A draft of the live stage, as the server makes one: the live clock adopted, then the live stage restored. */
function draftOf(live: Engine, show: Show, now: number): Engine {
  const d = new Engine(show, now);
  d.adoptClock(live);
  d.restore(live.runtime(), now);
  return d;
}

/** The demo show with a hazer in a smoke group "Haze". */
function hazeShow(): Show {
  const show = demoShow();
  show.fixtures.push({ id: 'hazer', name: 'Hazer', profile: 'generic-dimmer', universe: 0, address: 60, x: 0.5, y: 0.1 });
  show.groups.push({ id: 'haze', name: 'Haze', kind: 'smoke', fixtures: ['hazer'] });
  show.presets.push({ id: 'haze-on', name: 'On', group: 'haze', layers: [{ kind: 'static', colour: { hex: '#ffffff' }, intensity: 1 }], fade: 3 });
  return parseShow(show);
}

test('applyStage fades every light group to the given stage as one Undo step', () => {
  const show = demoShow();
  const e = new Engine(show);
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  run(e, 0, 1);
  const before = e.liveState(1, 'off');

  const d = draftOf(e, show, 1);
  d.apply({ type: 'look', id: 'word', fade: 0 }, 1);
  d.apply({ type: 'groupLevel', group: 'audience', value: 0.3 }, 1);
  d.apply({ type: 'groupColour', group: 'audience', colour: '#ff8800', white: 0.4 }, 1);
  run(d, 1, 5);
  const stage = d.runtime();

  assert.equal(e.apply(go(stage, 2), 5), null);
  assert.equal(e.recorded, true, 'it is an Undo step');
  const s = e.liveState(5, 'off');
  for (const g of ['front-wash', 'back-wall', 'audience', 'pulpit']) {
    assert.equal(s.groups[g]!.preset, stage.groups[g], g);
    assert.ok(close(s.groups[g]!.level, stage.levels[g]!), `${g} level`);
  }
  assert.equal(s.groups.audience!.preset, 'live:audience:#ff8800:w40');
  // Every group fades over the given time, its level too.
  run(e, 5, 6);
  const mid = e.liveState(6, 'off');
  assert.ok(close(mid.groups['back-wall']!.progress, 0.5, 1e-6), `progress ${mid.groups['back-wall']!.progress}`);
  assert.ok(close(mid.lookProgress, 0.5, 1e-6));
  assert.ok(lightOf(e, 'aud-1').i > lightOf(d, 'aud-1').i + 0.05, 'the audience is still dimming');
  run(e, 6 + FRAME, 8);
  run(d, 5 + FRAME, 8);
  for (const id of e.fixtureIds()) {
    const a = lightOf(e, id), b = lightOf(d, id);
    for (const k of ['r', 'g', 'b', 'w', 'i'] as const) assert.ok(close(a[k], b[k], 1e-6), `${id} ${k}: ${a[k]} vs ${b[k]}`);
  }

  // One Undo takes the whole change back.
  assert.equal(e.apply({ type: 'undo' }, 8), null);
  const back = e.liveState(8, 'off');
  assert.equal(back.look, 'worship');
  for (const g of Object.keys(before.groups)) {
    // A group that had no preset goes dark, as Undo always does.
    assert.equal(back.groups[g]!.preset, before.groups[g]!.preset ?? '__blackout', g);
    assert.equal(back.groups[g]!.level, before.groups[g]!.level, g);
  }
  assert.equal(e.apply({ type: 'undo' }, 9), null, 'the step before is the worship look');
  assert.equal(e.liveState(9, 'off').look, null);

  // Without a fade it takes the operator's fade time, or each look's own fade on Auto.
  const f = new Engine(show);
  f.apply({ type: 'look', id: 'walk-in', fade: 0 }, 0);
  const prayer = draftOf(f, show, 0);
  prayer.apply({ type: 'look', id: 'prayer', fade: 0 }, 0);
  f.apply(go(prayer.runtime()), 1);
  assert.ok(close(f.liveState(4, 'off').groups.audience!.progress, 0.5, 1e-6), 'prayer fades over its own 6 s');
  f.apply({ type: 'fadeTime', value: 1 }, 10);
  const worship = draftOf(f, show, 10);
  worship.apply({ type: 'look', id: 'worship', fade: 0 }, 10);
  f.apply(go(worship.runtime()), 10);
  assert.ok(close(f.liveState(10.5, 'off').groups.audience!.progress, 0.5, 1e-6), 'the operator\'s 1 s');
});

test('applyStage registers live colours and effects and leaves smoke alone', () => {
  const show = hazeShow();
  const e = new Engine(show);
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply({ type: 'groupLevel', group: 'haze', value: 0.6 }, 0);
  e.apply(effect(G, wave({ effect: 'chase' })), 0);
  run(e, 0, 1);

  const d = draftOf(e, show, 1);
  d.apply(effect(G, wave()), 1);
  d.apply({ type: 'groupColour', group: 'audience', colour: '#00ff00', white: 0.4 }, 1);
  d.apply({ type: 'groupLevel', group: 'haze', value: 0 }, 1);
  // Meanwhile the live stage gets its own effect, under the same id the draft gave its one.
  e.apply(effect(G, wave({ effect: 'sparkle' })), 2);
  const sparkle = e.liveState(2, 'off').groups[G]!.preset!;
  const stage = d.runtime();
  assert.equal(stage.groups[G], sparkle, 'the two engines numbered their effects the same');
  stage.groups.haze = 'haze-on';
  // A runtime state is a valid command as it is (the server parses every command).
  assert.deepEqual(Command.parse(go(stage, 1)), { type: 'applyStage', stage: { look: stage.look, groups: stage.groups, levels: stage.levels, tempo: stage.tempo, effects: stage.effects, lastLook: stage.lastLook }, fade: 1 });

  assert.equal(e.apply(go(stage, 1), 3), null);
  const s = e.liveState(3, 'off');
  assert.match(s.groups[G]!.preset!, /^fx:back-wall:\d+$/);
  assert.deepEqual(s.groups[G]!.effect, wave(), 'the draft\'s effect, not the live one with the same id');
  assert.equal(s.groups.audience!.preset, 'live:audience:#00ff00:w40');
  assert.equal(s.groups.audience!.live?.colour, '#00ff00');
  assert.equal(s.groups.audience!.live?.white, 0.4);
  assert.equal(s.groups.haze!.preset, null, 'smoke runs no preset');
  assert.equal(s.groups.haze!.level, 0.6, 'smoke keeps its slider');
  run(e, 1 + FRAME, 6);
  assert.ok(close(lightOf(e, 'hazer').i, 0.6), 'and its output');
  // The runtime state names the effect, and Undo brings the live one back.
  assert.deepEqual(e.runtime().effects?.[s.groups[G]!.preset!], wave());
  e.apply({ type: 'undo' }, 6);
  assert.equal(e.liveState(6, 'off').groups[G]!.preset, sparkle);
  assert.equal(e.liveState(6, 'off').groups[G]!.effect?.effect, 'sparkle');

  // The same effect the stage already runs carries on: no restart, and no change at all.
  const f = new Engine(show);
  f.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  f.apply(effect(G, wave()), 0);
  run(f, 0, 3);
  const same = draftOf(f, show, 3).runtime();
  const phase = f.effectPhase(G);
  f.apply(go(same, 2), 3);
  assert.equal(f.recorded, false, 'nothing changed, so no Undo step');
  assert.equal(f.effectPhase(G), phase);

  // A broken effect, or one for another group, leaves that group as it is.
  const g = new Engine(show);
  g.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  const broken: RuntimeState = { ...g.runtime(), groups: { [G]: 'fx:back-wall:9', audience: 'fx:pulpit:3' }, effects: { 'fx:pulpit:3': wave() } };
  assert.equal(g.apply(go(broken), 1), null);
  assert.equal(g.liveState(1, 'off').groups[G]!.preset, 'back-purple');
  assert.equal(g.liveState(1, 'off').groups.audience!.preset, 'aud-low');
});

test('applyStage sets the tempo and the current look, so Next and changed follow it', () => {
  const show = demoShow();
  const e = new Engine(show);
  e.apply({ type: 'look', id: 'word', fade: 0 }, 0);
  e.apply({ type: 'tempo', bpm: 140 }, 0);
  e.apply({ type: 'blackout' }, 1);
  assert.ok(e.runtime().beforeBlackout);

  const d = draftOf(e, show, 2);
  d.apply({ type: 'look', id: 'worship', fade: 0 }, 2);
  d.apply({ type: 'tempo', bpm: 90 }, 2);
  d.apply({ type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 }, 2);
  const stage = { ...d.runtime(), beforeBlackout: { pulpit: 'pulpit-on' }, master: 0.1, speed: 2, fadeTime: 9 };
  e.apply({ type: 'master', value: 0.5 }, 2);

  assert.equal(e.apply(go(stage, 1), 3), null);
  const s = e.liveState(3, 'off');
  assert.equal(s.look, 'worship');
  assert.equal(s.lastLook, 'worship', 'Next goes on from the draft\'s song');
  assert.equal(s.tempo, 90);
  assert.equal(s.lookChanged, true);
  assert.equal(s.groups.audience!.changed, true);
  assert.equal(s.groups['front-wash']!.changed, false);
  // Pulpit came back from Blackout in the draft, so it comes back here.
  assert.equal(s.groups.pulpit!.preset, 'pulpit-on');
  // Master, speed and fade time are the live stage's own; Blackout's memory is gone.
  assert.equal(s.master, 0.5);
  assert.equal(s.speed, 1);
  assert.equal(s.fadeTime, null);
  assert.equal(e.runtime().beforeBlackout, undefined);
  e.apply({ type: 'look', id: 'prayer', fade: 0 }, 4);
  assert.equal(e.liveState(4, 'off').groups.pulpit!.preset, 'pulpit-on', 'prayer leaves the pulpit alone');

  // A stage without a tempo keeps the live one; a stage in Blackout is refused.
  const f = new Engine(show);
  f.apply({ type: 'tempo', bpm: 100 }, 0);
  const noTempo = d.runtime();
  delete noTempo.tempo;
  f.apply(go(noTempo), 1);
  assert.equal(f.liveState(1, 'off').tempo, 100);
  assert.equal(f.liveState(1, 'off').look, 'worship');
  assert.equal(f.apply(go({ ...d.runtime(), look: 'blackout' }), 2), 'The stage to send is in Blackout.');
  assert.equal(f.recorded, false);
});

test('a draft engine that adopted the clock runs effects in step with the live engine', () => {
  const show = demoShow();
  const e = new Engine(show);
  // Frames at whole frame counts, so both engines see exactly the same times.
  const at = (n: number) => n * FRAME;
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  for (let n = 0; n <= 200; n++) {
    if (n === 20) e.apply(effect('audience', wave({ speed: { beats: 3 } })), at(n));
    e.frame(at(n));
  }
  const start = at(200);

  // The live effect restored in the draft is where the live one is.
  const d = draftOf(e, show, start);
  d.frame(start);
  assert.ok(inStep(d.effectPhase('audience')!, e.effectPhase('audience')!), `${d.effectPhase('audience')} vs ${e.effectPhase('audience')}`);
  // An effect started in the draft starts where the same one would start on the live stage.
  d.apply(effect(G, wave()), start);
  const twin = draftOf(e, show, start);
  twin.apply(effect(G, wave()), start);
  assert.ok(inStep(d.effectPhase(G)!, twin.effectPhase(G)!));
  // Without adopting the clock it would not be in step.
  const stray = new Engine(show, start);
  stray.restore(e.runtime(), start);
  stray.apply(effect(G, wave()), start);
  assert.ok(!inStep(stray.effectPhase(G)!, d.effectPhase(G)!));

  for (let n = 201; n <= 400; n++) {
    e.frame(at(n));
    d.frame(at(n));
  }
  assert.ok(inStep(d.effectPhase('audience')!, e.effectPhase('audience')!));
  // Go: the live stage fades to the draft's effect, which starts where the draft's pattern is.
  e.apply(go(d.runtime(), 2), at(400));
  assert.ok(inStep(e.effectPhase(G)!, d.effectPhase(G)!), `${e.effectPhase(G)} vs ${d.effectPhase(G)}`);
  assert.ok(inStep(e.effectPhase('audience')!, d.effectPhase('audience')!), 'the effect both run carries on');
  for (let n = 401; n <= 520; n++) {
    e.frame(at(n));
    d.frame(at(n));
  }
  const ev = e.visibleLevels(), dv = d.visibleLevels();
  for (let k = 0; k < ev.length; k++) assert.ok(close(ev[k]!, dv[k]!, 1e-9), `segment ${k}: ${ev[k]} vs ${dv[k]}`);
});

test('applyStage of a Basic-lights stage acts like Basic lights', () => {
  const show = levelsShow(true);
  const e = new Engine(show);
  e.apply({ type: 'look', id: 'song-3', fade: 0 }, 0);
  e.apply({ type: 'master', value: 0.5 }, 0);
  e.apply({ type: 'groupPreset', group: 'pulpit', preset: 'pulpit-on', fade: 0 }, 0);

  const d = draftOf(e, show, 1);
  d.apply({ type: 'safe' }, 1);
  const stage = d.runtime();
  assert.equal(stage.look, 'safe');
  // Groups without an entry go to the safe light, as Basic lights puts them.
  delete stage.groups[G];
  stage.groups.pulpit = null;
  delete stage.levels.pulpit;

  assert.equal(e.apply(go(stage, 1), 2), null);
  const s = e.liveState(2, 'off');
  assert.equal(s.look, 'safe');
  assert.equal(s.groups['front-wash']!.preset, 'front-dim');
  assert.equal(s.groups.audience!.preset, 'aud-low');
  assert.equal(s.groups[G]!.preset, '__safe');
  assert.equal(s.groups.pulpit!.preset, '__safe');
  for (const g of Object.values(s.groups)) assert.equal(g.level, 1);
  assert.equal(s.master, 0.5, 'Master stays the live stage\'s');
  assert.equal(s.lastLook, 'song-3');
  run(e, 2, 4);
  assert.equal(e.liveState(4, 'off').lookChanged, false);
});

test('applying a stage with another effect on the back wall stays within its own motion + 5 %', () => {
  const show = demoShow();
  const e = new Engine(show);
  e.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
  e.apply(effect(G, wave({ effect: 'chase', colours: [{ hex: '#ffffff' }, { hex: '#000000' }], speed: { beats: 1 } })), 0);
  run(e, 0, 2);
  const d = draftOf(e, show, 2);
  d.apply({ type: 'look', id: 'word', fade: 0 }, 2);
  d.apply(effect(G, wave({ effect: 'sparkle', colours: [{ hex: '#00ff00' }] })), 2);
  d.apply({ type: 'groupLevel', group: 'front-wash', value: 0.2 }, 2);
  for (const fade of [1, 3]) {
    const f = new Engine(show);
    f.apply({ type: 'look', id: 'worship', fade: 0 }, 0);
    f.apply(effect(G, wave({ effect: 'chase', colours: [{ hex: '#ffffff' }, { hex: '#000000' }], speed: { beats: 1 } })), 0);
    run(f, 0, 2);
    f.apply(go(d.runtime(), fade), 2 + FRAME / 2);
    const { worst } = beyondOwnMotion(f, 2 + FRAME, 2 + fade + 1);
    assert.ok(worst <= 0.05, `fade ${fade}: step beyond own motion ${worst}`);
  }
  // Interrupted mid-fade by another stage, and by Undo.
  e.apply(go(d.runtime(), 2), 2);
  const { worst } = beyondOwnMotion(e, 2 + FRAME, 8, (t) => {
    if (Math.abs(t - 3) < FRAME / 2) {
      const back = draftOf(e, show, t);
      back.apply({ type: 'look', id: 'prayer', fade: 0 }, t);
      e.apply(go(back.runtime(), 2), t);
    }
    if (Math.abs(t - 4) < FRAME / 2) e.apply({ type: 'undo' }, t);
  });
  assert.ok(worst <= 0.05, `step beyond own motion ${worst}`);
});
