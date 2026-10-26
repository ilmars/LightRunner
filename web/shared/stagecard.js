// The stage view's own controls, shared by the operator page and the Timeline page: the From above / From the audience
// switch on the picture, and the grip that makes the picture bigger or smaller. Each browser keeps its own choice and
// size (localStorage, wrapped so a browser without storage still works); the numbers are in stageview.js.

import { stageSizeFrom, stageSizeWith, stageViewFrom } from './stageview.js';

const VIEW_KEY = 'lr-stage-view';
/** Two small arrows, shown after the view's name when the switch is one button (a small picture). */
const SWAP = '<svg class="sv-swap" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 3.5h7M6.5 1.5l2 2-2 2M8.5 6.5h-7M3.5 4.5l-2 2 2 2"/></svg>';
const SIZE_KEY = 'lr-stage-size';

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // no storage here
  }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // not kept: fine
  }
}

/** The view this browser shows: 'above' (the default) or 'front'. */
export const storedStageView = () => stageViewFrom(read(VIEW_KEY));

/** The stage view's size this browser keeps for `page` ({ w, h }, null when not kept). */
export const storedStageSize = (page) => stageSizeFrom(read(SIZE_KEY), page);
/** Keeps `size` ({ w?, h? }) for `page`, or forgets it when null. */
export const keepStageSize = (page, size) => write(SIZE_KEY, stageSizeWith(read(SIZE_KEY), page, size));

/**
 * Puts the From above / From the audience switch on the picture in `wrap` (the box the canvas sits in), and calls
 * `onChange(view)` when it is tapped. The choice is kept for this browser. On a small picture it is one button with
 * the view's short name that switches to the other (so it covers little of the picture); on a bigger one both
 * choices with their whole words (the styles choose).
 */
export function stageViewSwitch(wrap, onChange) {
  const seg = document.createElement('div');
  seg.className = 'ds-stage-switch';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Stage view');
  const choices = [
    ['above', 'Above', 'From above', 'The stage plan from above'],
    ['front', 'Audience', 'From the audience', 'The stage as the audience sees it'],
  ];
  const buttons = choices.map(([view, short, long, title]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.view = view;
    b.dataset.long = long;
    b.dataset.title = title;
    b.innerHTML = `<span class="sv-short">${short}</span><span class="sv-long">${long}</span>${SWAP}`;
    b.addEventListener('click', () => {
      // On a small picture only the current view's button shows (the other is hidden): it switches to the other.
      const other = buttons.find((o) => o !== b);
      const next = current !== view ? view : getComputedStyle(other).display === 'none' ? other.dataset.view : view;
      if (next === current) return;
      current = next;
      write(VIEW_KEY, current);
      paint();
      onChange(current);
    });
    seg.append(b);
    return b;
  });
  let current = storedStageView();
  // The styles show the chosen one (data-on). As one button (a small picture) it is named for what a tap does
  // ("Switch to from the audience"); as two, each is named for its view and the chosen one is pressed.
  const paint = () => {
    for (const b of buttons) b.dataset.on = String(b.dataset.view === current);
    const off = buttons.find((b) => b.dataset.view !== current);
    const compact = getComputedStyle(off).display === 'none';
    for (const b of buttons) {
      const other = buttons.find((o) => o !== b);
      if (compact) {
        b.removeAttribute('aria-pressed');
        b.setAttribute('aria-label', `Switch to ${other.dataset.long.toLowerCase()}`);
        b.title = `${b.dataset.title}. Tap for ${other.dataset.long.toLowerCase()}`;
      } else {
        b.setAttribute('aria-pressed', String(b.dataset.view === current));
        b.setAttribute('aria-label', b.dataset.long);
        b.title = b.dataset.title;
      }
    }
  };
  wrap.append(seg);
  paint();
  // One button or two follows the picture's width: the names follow too.
  new ResizeObserver(paint).observe(wrap);
  // Another tab of this browser changed it: follow.
  window.addEventListener('storage', (ev) => {
    if (ev.key !== VIEW_KEY) return;
    const next = storedStageView();
    if (next === current) return;
    current = next;
    paint();
    onChange(next);
  });
  return { get view() { return current; } };
}

/**
 * Makes `grip` (a button) resize the stage view by dragging: with a finger or a mouse (pointer capture; the grip
 * alone takes the touch, so the page still scrolls elsewhere), or with the arrow keys. `start()` gives the size when a
 * drag starts ({ w, h } in CSS px); `apply(size)` sets a wanted size (it keeps it within its limits); `done()` is
 * called when a drag or key press ends, to keep the size; a double tap or double click calls `reset()`.
 * `axes` is 'y' (taller or shorter) or 'xy' (the corner: wider and taller too).
 */
export function stageGrip(grip, { axes = 'y', start, apply, done, reset }) {
  let drag = null;
  let lastTap = { at: 0, x: 0, y: 0 };
  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const now = performance.now();
    if (now - lastTap.at < 350 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 24) {
      lastTap = { at: 0, x: 0, y: 0 };
      reset();
      return;
    }
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, size: start(), moved: false };
    try {
      grip.setPointerCapture(ev.pointerId);
    } catch {
      // the pointer is already gone
    }
    grip.classList.add('dragging');
  });
  grip.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = axes === 'xy' ? ev.clientX - drag.x : 0, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    apply({ w: drag.size.w + dx, h: drag.size.h + dy });
  });
  const end = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    grip.classList.remove('dragging');
    if (moved) {
      lastTap = { at: 0, x: 0, y: 0 };
      done();
    } else if (ev.type === 'pointerup') lastTap = { at: performance.now(), x: ev.clientX, y: ev.clientY };
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('lostpointercapture', end);
  grip.addEventListener('click', (ev) => ev.preventDefault());
  grip.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 40 : 10;
    const by = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[ev.key];
    if (!by || (axes === 'y' && by[0])) return;
    ev.preventDefault();
    const size = start();
    apply({ w: size.w + by[0], h: size.h + by[1] });
    done();
  });
}
