// The operator page's Flash presses (web/shared/press.js): a swipe never flashes, a tap still lights, a rebuilt row
// can't leave a flash on, and two fingers or two buttons never put out what another still holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlashPresses, MIN_HOLD, SWIPE_SLOP, SWIPE_WAIT, isSideways } from '../../web/shared/press.js';

type Cmd = { type: 'flash'; groups: string[]; on: boolean };

/** A press tracker on a fake clock and fake timers. */
function rig(canFlash: (k: string) => boolean = () => true) {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: Cmd[] = [];
  const down = new Map<string, boolean>();
  const presses = new FlashPresses<string>({
    send: (cmd) => { sent.push(cmd); return cmd; },
    setDown: (k, d) => down.set(k, d),
    canFlash,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  /** Moves the clock on, running timers that come due in order. */
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    t = end;
  };
  return { presses, sent, down, advance, timers, now: () => t };
}

test('a mouse or a button that fits presses at once, and a long hold goes out when released', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a']);
  assert.deepEqual(r.sent, [{ type: 'flash', groups: ['a'], on: true }]);
  assert.equal(r.down.get('front'), true);
  r.advance(500);
  r.presses.release(1);
  assert.deepEqual(r.sent.at(-1), { type: 'flash', groups: ['a'], on: false });
  assert.equal(r.down.get('front'), false);
});

test('a quick tap still lights: on, held for the minimum time, then off', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a']);
  r.advance(20);
  r.presses.release(1);
  assert.equal(r.sent.length, 1, 'not out yet');
  assert.equal(r.down.get('front'), true);
  r.advance(MIN_HOLD - 20 - 1);
  assert.equal(r.sent.length, 1);
  r.advance(1);
  assert.deepEqual(r.sent.at(-1), { type: 'flash', groups: ['a'], on: false });
});

test('in a scrolling row a finger waits, and a tap shorter than the wait still lights for the minimum time', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a'], { wait: true, x: 10, y: 10 });
  assert.equal(r.sent.length, 0);
  r.advance(30);
  r.presses.release(1);
  assert.deepEqual(r.sent, [{ type: 'flash', groups: ['a'], on: true }]);
  r.advance(MIN_HOLD);
  assert.deepEqual(r.sent.at(-1), { type: 'flash', groups: ['a'], on: false });
  assert.equal(r.sent.length, 2);
});

test('in a scrolling row a finger that holds past the wait flashes, and goes out on release', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a'], { wait: true });
  r.advance(SWIPE_WAIT);
  assert.deepEqual(r.sent, [{ type: 'flash', groups: ['a'], on: true }]);
  r.advance(300);
  r.presses.release(1);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1]!.on, false);
});

test('a swipe (a move past the slop while waiting) never flashes', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a'], { wait: true, x: 10, y: 10 });
  r.presses.move(1, 10 + SWIPE_SLOP + 1, 10);
  r.advance(500);
  r.presses.cancel(1);
  r.presses.release(1);
  assert.deepEqual(r.sent, []);
  assert.equal(r.timers.size, 0);
});

test('a small drift while waiting is not a swipe', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a'], { wait: true, x: 10, y: 10 });
  r.presses.move(1, 14, 12);
  r.advance(SWIPE_WAIT);
  assert.equal(r.sent.length, 1);
});

test('the browser taking the finger for a scroll puts a held flash out at once', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a']);
  r.advance(10);
  r.presses.cancel(1);
  assert.deepEqual(r.sent.at(-1), { type: 'flash', groups: ['a'], on: false });
  assert.equal(r.down.get('front'), false);
  assert.equal(r.timers.size, 0);
});

test('a waiting press that the row rebuild or a blur drops never flashes later', () => {
  const r = rig();
  r.presses.press(1, 'old', ['a'], { wait: true });
  r.presses.allOff();
  r.advance(1000);
  assert.deepEqual(r.sent, []);
  assert.equal(r.timers.size, 0);
});

test('the wait ending after the button left the page, or the page was hidden, sends nothing', () => {
  let connected = true;
  const r = rig(() => connected);
  r.presses.press(1, 'old', ['a'], { wait: true });
  connected = false;
  r.advance(SWIPE_WAIT);
  assert.deepEqual(r.sent, []);
  // Nothing left to end either.
  r.presses.release(1);
  assert.deepEqual(r.sent, []);
});

test('allOff puts out every flash now, even one in its minimum hold', () => {
  const r = rig();
  r.presses.press(1, 'a', ['g1']);
  r.presses.press(2, 'b', ['g2']);
  r.presses.release(2);
  r.presses.allOff();
  assert.deepEqual(r.sent.filter((c) => !c.on).map((c) => c.groups[0]).sort(), ['g1', 'g2']);
  r.advance(1000);
  assert.equal(r.sent.length, 4, 'the delayed off does not go out a second time');
});

test('two fingers on one button: lifting one keeps the flash and the look; lifting the last puts it out', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a']);
  r.presses.press(2, 'front', ['a']);
  r.advance(500);
  r.presses.release(1);
  assert.equal(r.sent.filter((c) => !c.on).length, 0, 'the second finger still holds it');
  assert.equal(r.down.get('front'), true);
  r.presses.release(2);
  assert.deepEqual(r.sent.at(-1), { type: 'flash', groups: ['a'], on: false });
  assert.equal(r.down.get('front'), false);
});

test('a second finger arriving while the first is waiting does not cancel the first', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a'], { wait: true });
  r.presses.press(2, 'front', ['a'], { wait: true });
  r.advance(SWIPE_WAIT);
  assert.equal(r.sent.filter((c) => c.on).length, 2);
});

test('two buttons over one group: the group goes out when the last one lets go', () => {
  const r = rig();
  r.presses.press(1, 'all', ['a', 'b']);
  r.presses.press(2, 'front', ['a']);
  r.advance(500);
  r.presses.release(2);
  assert.equal(r.sent.filter((c) => !c.on).length, 0, 'a is still covered by All');
  r.presses.release(1);
  assert.deepEqual(r.sent.at(-1), { type: 'flash', groups: ['a', 'b'], on: false });
});

test('the mouse reuses one pointer id: a second click inside the minimum hold works', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a']);
  r.presses.release(1);
  r.advance(10);
  r.presses.press(1, 'front', ['a']);
  assert.deepEqual(r.sent.map((c) => c.on), [true, false, true]);
  r.advance(500);
  r.presses.release(1);
  assert.equal(r.sent.at(-1)!.on, false);
});

test('a connection loss forgets every press without sending', () => {
  const r = rig();
  r.presses.press(1, 'front', ['a']);
  r.presses.press(2, 'key', ['b'], { wait: true });
  r.presses.reset();
  r.advance(1000);
  assert.deepEqual(r.sent.map((c) => c.on), [true]);
  assert.equal(r.down.get('front'), false);
});

test('a refused send leaves nothing held', () => {
  const sent: unknown[] = [];
  const p = new FlashPresses<string>({ send: (c) => { sent.push(c); return null; }, setDown: () => {} });
  p.press(1, 'x', ['a']);
  p.release(1);
  assert.equal(sent.length, 1, 'only the attempt to switch on');
});

test('a Groups cell press is a dimmer drag only when clearly sideways', () => {
  assert.equal(isSideways(7, 0), true);
  assert.equal(isSideways(-12, 5), true);
  assert.equal(isSideways(5, 0), false, 'inside the slop');
  assert.equal(isSideways(8, 30), false, 'mostly vertical: the panel scrolls');
  assert.equal(isSideways(10, 10), false);
});

test('the default timers work when called as methods (a browser throws "Illegal invocation" otherwise)', async () => {
  const sent: Cmd[] = [];
  const p = new FlashPresses<string>({ send: (c) => { sent.push(c); return c; }, setDown: () => {} });
  p.press(1, 'x', ['a'], { wait: true });
  await new Promise((r) => setTimeout(r, SWIPE_WAIT + 40));
  assert.equal(sent.length, 1);
  p.release(1);
  await new Promise((r) => setTimeout(r, MIN_HOLD + 40));
  assert.deepEqual(sent.map((c) => c.on), [true, false]);
});
