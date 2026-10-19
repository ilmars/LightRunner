import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/index.ts';
import { FRAME, close, demoShow } from './helpers.ts';

const G = 'back-wall';

/** The demo show with a tempo on "worship" and "word"; "walk-in" has none. */
function tempoShow() {
  const show = demoShow();
  show.looks.find((l) => l.id === 'worship')!.tempo = 90;
  show.looks.find((l) => l.id === 'word')!.tempo = 150;
  return show;
}

/** Run frames from `from` to `to` (inclusive), 25 ms apart. */
function run(e: Engine, from: number, to: number): void {
  for (let t = from; t <= to + 1e-9; t += FRAME) e.frame(t);
}

test('beats advance with the tempo and the speed', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  run(e, 0, 1);
  // 120 bpm: 2 beats a second.
  assert.ok(close(e.beatPhase(G)!, 2, 1e-6), `beats ${e.beatPhase(G)}`);
  e.apply({ type: 'speed', value: 2 }, 1);
  run(e, 1 + FRAME, 3);
  const before = e.beatPhase(G)!;
  run(e, 3 + FRAME, 4);
  // Speed 2 at 120 bpm: 4 beats a second once the dial has settled.
  assert.ok(close(e.beatPhase(G)! - before, 4, 1e-6), `added ${e.beatPhase(G)! - before}`);
});

test('a look sets its own tempo, or 120; quick looks, Basic lights and Blackout leave it', () => {
  const show = tempoShow();
  show.looks.push({ id: 'pulse', name: 'Pulse', tempo: 200, groups: [{ group: 'pulpit', preset: 'pulpit-on' }] });
  const e = new Engine(show);
  assert.equal(e.liveState(0, 'off').tempo, 120);
  e.apply({ type: 'look', id: 'worship' }, 0);
  assert.equal(e.liveState(0, 'off').tempo, 90);
  e.apply({ type: 'quickLook', id: 'pulse' }, 1);
  assert.equal(e.liveState(1, 'off').tempo, 90);
  e.apply({ type: 'groupPreset', group: 'pulpit', preset: 'pulpit-on' }, 1);
  assert.equal(e.liveState(1, 'off').tempo, 90);
  e.apply({ type: 'blackout' }, 2);
  assert.equal(e.liveState(2, 'off').tempo, 90);
  e.apply({ type: 'backToLook' }, 3);
  assert.equal(e.liveState(3, 'off').tempo, 90);
  e.apply({ type: 'safe' }, 4);
  assert.equal(e.liveState(4, 'off').tempo, 90);
  e.apply({ type: 'look', id: 'word' }, 5);
  assert.equal(e.liveState(5, 'off').tempo, 150);
  // A look with no tempo goes back to 120.
  e.apply({ type: 'look', id: 'walk-in' }, 6);
  assert.equal(e.liveState(6, 'off').tempo, 120);
});

test('the tempo command is undoable and survives a restart', () => {
  const show = tempoShow();
  const e = new Engine(show);
  e.apply({ type: 'look', id: 'worship' }, 0);
  assert.equal(e.apply({ type: 'tempo', bpm: 132 }, 1), null);
  assert.equal(e.recorded, true);
  assert.equal(e.liveState(1, 'off').tempo, 132);
  assert.equal(e.runtime().tempo, 132);

  const b = new Engine(show);
  b.restore(e.runtime(), 100);
  assert.equal(b.liveState(100, 'off').tempo, 132);

  assert.equal(e.apply({ type: 'undo' }, 2), null);
  assert.equal(e.liveState(2, 'off').tempo, 90);
  // Setting the tempo it already has changes nothing, so adds no step.
  e.apply({ type: 'tempo', bpm: 90 }, 3);
  assert.equal(e.recorded, false);
});

test('changing tempo never moves the phase back or jumps it', () => {
  const e = new Engine(demoShow());
  e.apply({ type: 'look', id: 'walk-in' }, 0);
  e.apply({ type: 'tempo', bpm: 60 }, 0);
  run(e, 0, 2);
  let prev = e.beatPhase(G)!;
  let worst = 0;
  let least = Infinity;
  for (let t = 2 + FRAME; t <= 4; t += FRAME) {
    if (Math.abs(t - 3) < 1e-9) e.apply({ type: 'tempo', bpm: 180 }, t);
    e.frame(t);
    const now = e.beatPhase(G)!;
    worst = Math.max(worst, now - prev);
    least = Math.min(least, now - prev);
    prev = now;
  }
  assert.ok(least >= 0, `went back by ${least}`);
  assert.ok(worst <= (180 / 60) * FRAME + 1e-9, `stepped ${worst}`);
});
