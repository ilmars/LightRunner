// Presses on the operator page that must never leave the lights wrong: Flash (hold = on, release = off) and the
// two-column dimmer's "is this a sideways drag?" test. Plain JS with no DOM, so node:test can drive it
// (server/test/press.test.ts); the page gives it timers, a clock, the command sender and the button look.

/** A finger waits this long (ms) on a Flash button that sits in a scrolling row, so a swipe never flashes. */
export const SWIPE_WAIT = 70;
/** In that time a finger that moves further than this (px) is swiping the row. */
export const SWIPE_SLOP = 8;
/** A flash that went on stays on at least this long (ms), so a quick tap is seen. */
export const MIN_HOLD = 100;
/** A press on a two-column Groups cell is a dimmer drag only once it moved more than this (px) sideways. */
export const SIDEWAYS_SLOP = 6;

/** True when a move of (dx, dy) from the press is clearly sideways: past the slop and more across than up or down. */
export function isSideways(dx, dy) {
  return Math.abs(dx) > SIDEWAYS_SLOP && Math.abs(dx) > Math.abs(dy);
}

/**
 * Keeps track of every finger (or mouse press) on the Flash and Puff buttons.
 *
 * - A press sends "on" at once, or after SWIPE_WAIT when `wait` is set (the button is in a row that scrolls): a move
 *   over SWIPE_SLOP in that time drops it, and nothing is sent.
 * - A release puts it out, but never sooner than MIN_HOLD after it went on. A tap shorter than SWIPE_WAIT still
 *   lights (on, MIN_HOLD, off). A cancel (the browser took the finger for scrolling), `allOff` and `reset` end it now.
 * - Several fingers can hold one button, and several buttons can cover one group: a group goes out only when the
 *   last press covering it ends, and a button looks pressed while any finger is on it.
 * - `allOff` also drops presses still waiting, so a timer from a button the page has rebuilt can never switch a
 *   flash on that nothing will end. `canFlash(key)` is asked again when the wait is over (button still on the page,
 *   page still in view).
 *
 * `key` is whatever stands for the button (the element). `send(cmd)` returns null when it could not send.
 */
export class FlashPresses {
  constructor({ send, setDown, canFlash = () => true, now, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
    this.send = send;
    this.setDown = setDown;
    this.canFlash = canFlash;
    this.now = now ?? (() => performance.now());
    // Called as methods of this object, so the browser's own timer functions must be wrapped (or they throw "Illegal invocation").
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** pointer id -> { key, groups, onAt, offTimer } */
    this.held = new Map();
    /** pointer id -> { key, groups, x, y, timer } */
    this.waiting = new Map();
  }

  /** A press begins. `wait`: hold it back for SWIPE_WAIT (a finger on a button in a scrolling row). */
  press(id, key, groups, { wait = false, x = 0, y = 0 } = {}) {
    const old = this.held.get(id);
    if (old) {
      // The mouse reuses one id: a second click while the first one's minimum hold is running ends that one first.
      if (!old.offTimer) return;
      this.#off(id);
    }
    this.#drop(id);
    if (!wait) {
      this.#on(id, key, groups);
      return;
    }
    const w = {
      key, groups, x, y,
      timer: this.setTimer(() => {
        this.waiting.delete(id);
        this.#on(id, key, groups);
      }, SWIPE_WAIT),
    };
    this.waiting.set(id, w);
  }

  /** The finger moved. Further than SWIPE_SLOP while waiting means a swipe: no flash. */
  move(id, x, y) {
    const w = this.waiting.get(id);
    if (w && Math.hypot(x - w.x, y - w.y) > SWIPE_SLOP) this.#drop(id);
  }

  /** The finger lifted (or the mouse button). */
  release(id) {
    const w = this.waiting.get(id);
    if (w) {
      // A tap shorter than the wait: it still lights, for the minimum time.
      this.#drop(id);
      this.#on(id, w.key, w.groups);
    }
    const h = this.held.get(id);
    if (!h) return;
    const left = h.onAt + MIN_HOLD - this.now();
    if (left <= 0) this.#off(id);
    else if (!h.offTimer) h.offTimer = this.setTimer(() => this.#off(id), left);
  }

  /** The press was lost (the browser took the finger to scroll, the pointer left or was lost): end it now. */
  cancel(id) {
    this.#drop(id);
    this.#off(id);
  }

  /** Every press ends now, including the ones still waiting (blur, the page hidden, the Flash row rebuilt). */
  allOff() {
    for (const id of [...this.waiting.keys()]) this.#drop(id);
    for (const id of [...this.held.keys()]) this.#off(id);
  }

  /** Forget everything without sending (the server already put the flashes out when it lost us). */
  reset() {
    for (const id of [...this.waiting.keys()]) this.#drop(id);
    const keys = new Set();
    for (const h of this.held.values()) {
      if (h.offTimer) this.clearTimer(h.offTimer);
      keys.add(h.key);
    }
    this.held.clear();
    for (const k of keys) this.setDown(k, false);
  }

  #drop(id) {
    const w = this.waiting.get(id);
    if (!w) return;
    this.clearTimer(w.timer);
    this.waiting.delete(id);
  }

  #on(id, key, groups) {
    if (this.held.has(id) || !this.canFlash(key)) return;
    if (this.send({ type: 'flash', groups, on: true }) === null) return;
    this.held.set(id, { key, groups, onAt: this.now(), offTimer: 0 });
    this.setDown(key, true);
  }

  #off(id) {
    const h = this.held.get(id);
    if (!h) return;
    if (h.offTimer) this.clearTimer(h.offTimer);
    this.held.delete(id);
    const others = [...this.held.values()];
    if (!others.some((o) => o.key === h.key)) this.setDown(h.key, false);
    const still = new Set(others.flatMap((o) => o.groups));
    const groups = h.groups.filter((g) => !still.has(g));
    if (groups.length) this.send({ type: 'flash', groups, on: false });
  }
}
