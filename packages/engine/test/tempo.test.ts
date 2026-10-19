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

test('tempo commands within 3 s of each other are one Undo step', () => {
  const e = new Engine(tempoShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  const recorded: boolean[] = [];
  // Tapping along: five tempo commands 0.4 s apart.
  [100, 104, 108, 112, 116].forEach((bpm, k) => {
    assert.equal(e.apply({ type: 'tempo', bpm }, 1 + k * 0.4), null);
    recorded.push(e.recorded);
  });
  assert.deepEqual(recorded, [true, false, false, false, false]);
  assert.equal(e.liveState(3, 'off').tempo, 116);
  // One Undo puts back the tempo from before the whole run, and leaves the look.
  assert.equal(e.apply({ type: 'undo' }, 4), null);
  assert.equal(e.liveState(4, 'off').tempo, 90);
  assert.equal(e.liveState(4, 'off').look, 'worship');

  // A tempo command more than 3 s after the last is its own step, and the run goes on from it.
  e.apply({ type: 'tempo', bpm: 100 }, 10);
  e.apply({ type: 'tempo', bpm: 110 }, 11);
  e.apply({ type: 'tempo', bpm: 120 }, 15);
  assert.equal(e.recorded, true);
  e.apply({ type: 'tempo', bpm: 125 }, 16);
  assert.equal(e.recorded, false);
  e.apply({ type: 'undo' }, 17);
  assert.equal(e.liveState(17, 'off').tempo, 110);
  e.apply({ type: 'undo' }, 18);
  assert.equal(e.liveState(18, 'off').tempo, 90);
});

test('another step between tempo commands ends the run', () => {
  const e = new Engine(tempoShow());
  e.apply({ type: 'look', id: 'worship' }, 0);
  e.apply({ type: 'tempo', bpm: 100 }, 1);
  e.apply({ type: 'groupPreset', group: 'pulpit', preset: 'pulpit-on' }, 1.5);
  assert.equal(e.recorded, true);
  e.apply({ type: 'tempo', bpm: 110 }, 2);
  assert.equal(e.recorded, true, 'a tempo command after another step starts a new run');
  e.apply({ type: 'undo' }, 3);
  assert.equal(e.liveState(3, 'off').tempo, 100);
  // After an Undo a tempo command starts a new run too.
  e.apply({ type: 'tempo', bpm: 130 }, 3.5);
  assert.equal(e.recorded, true);
  // A look in the middle does as well, and takes its own tempo.
  e.apply({ type: 'look', id: 'word' }, 4);
  e.apply({ type: 'tempo', bpm: 140 }, 4.5);
  assert.equal(e.recorded, true);
  e.apply({ type: 'undo' }, 5);
  assert.equal(e.liveState(5, 'off').tempo, 150);
});
