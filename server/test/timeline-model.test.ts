// The Timeline page's pure helpers (web/timeline/model.js): times, zoom and scroll, the ruler, markers, blocks, new timelines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, STAGE_LAYER } from '../../packages/shared/src/index.ts';
import {
  MAX_BARS, MAX_ZOOM, MIN_BLOCK, MIN_RISE, barsFor, blockMissing, blockSpans, clampEnd, clampScroll, dragBlock, fitZoom, followScroll,
  formatLength, formatRise, formatTime, hitTest, lookFade, markerRows, mixToMono, moveBlock, newBlockId, newBlockStart, newTimeline,
  nextMarkerText, normalisePeaks, parseTime, riseAfterLookChange, rulerStep, rulerTicks, shownRise, slugId, snapTime, timeToX, viewLength,
  addableGroups, dragIntent, shownLayers, xToTime, zoomed,
} from '../../web/timeline/model.js';

const near = (a: number, b: number, tol = 1e-9, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not ${b}`);

test('times are shown as m:ss.t, lengths as m:ss, and typed times are read back', () => {
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(83.46), '1:23.4');
  assert.equal(formatTime(59.99), '0:59.9', 'never rounded up to a time not reached yet');
  assert.equal(formatTime(600), '10:00.0');
  assert.equal(formatTime(-3), '0:00.0');
  assert.equal(formatTime(Number.NaN), '0:00.0');
  assert.equal(formatLength(252.4), '4:12');
  assert.equal(formatLength(59.6), '1:00');
  assert.equal(formatLength(0), '0:00');
  assert.equal(parseTime('1:23.4'), 83.4);
  assert.equal(parseTime(' 83 '), 83);
  assert.equal(parseTime('0:05'), 5);
  assert.equal(parseTime('2.5'), 2.5);
  for (const bad of ['', 'abc', '1:75', '-1', '1:2:3', ':']) assert.equal(parseTime(bad), null, bad);
});

test('x and time: zoom is pixels per second, scroll is pixels from the start', () => {
  const view = { pxPerSec: 10, scroll: 100 };
  assert.equal(timeToX(15, view), 50);
  assert.equal(xToTime(50, view, 60), 15);
  assert.equal(xToTime(-500, view, 60), 0, 'never before the start');
  assert.equal(xToTime(5000, view, 60), 60, 'never past the end');
  // The whole length fits the width at the fit zoom.
  near(fitZoom(250, 1000), 4);
  assert.equal(fitZoom(0, 1000), 1000 / 30, 'an empty timeline shows 30 s');
  // Scroll stays within what there is to see.
  assert.equal(clampScroll(-20, 10, 500, 100), 0);
  assert.equal(clampScroll(900, 10, 500, 100), 500);
  assert.equal(clampScroll(900, 4, 500, 100), 0, 'it all fits: no scroll');
});

test('zoom keeps the time under the anchor where it is, between fit and the closest zoom', () => {
  const width = 1000, duration = 250;
  const fit = { pxPerSec: fitZoom(duration, width), scroll: 0 };
  const inView = zoomed(fit, 2, 500, width, duration);
  near(inView.pxPerSec, 8);
  // The time under x = 500 (125 s) is still under x = 500.
  near(xToTime(500, inView, duration), 125, 1e-9);
  // Out past fit stays at fit, scrolled to the start.
  const out = zoomed(inView, 1 / 8, 500, width, duration);
  near(out.pxPerSec, 4);
  assert.equal(out.scroll, 0);
  // In past the closest zoom stops there.
  let v = fit;
  for (let i = 0; i < 20; i++) v = zoomed(v, 2, 0, width, duration);
  assert.equal(v.pxPerSec, MAX_ZOOM);
  near(xToTime(0, v, duration), 0, 1e-9);
});

test('the ruler: labels at least 64 px apart, on round times', () => {
  assert.equal(rulerStep(200), 0.5);
  assert.equal(rulerStep(64), 1);
  assert.equal(rulerStep(10), 10);
  assert.equal(rulerStep(4), 30);
  assert.equal(rulerStep(0.2), 600);
  const ticks = rulerTicks({ pxPerSec: 4, scroll: 0 }, 1000, 252);
  assert.deepEqual(ticks.map((t) => t.label), ['0:00', '0:30', '1:00', '1:30', '2:00', '2:30', '3:00', '3:30', '4:00']);
  assert.deepEqual(ticks.map((t) => t.x).slice(0, 3), [0, 120, 240]);
  // Scrolled: only the ticks in view (and one just before, so a label half out of view still shows).
  const mid = rulerTicks({ pxPerSec: 100, scroll: 1000 }, 300, 60);
  assert.equal(rulerStep(100), 1);
  assert.deepEqual(mid.map((t) => t.t), [9, 10, 11, 12, 13]);
  assert.equal(mid[1]!.x, 0);
  // Under a second apart: tenths in the labels.
  assert.deepEqual(rulerTicks({ pxPerSec: 200, scroll: 0 }, 300, 60).map((t) => t.label), ['0:00.0', '0:00.5', '0:01.0', '0:01.5']);
});

test('markers: labels that would overlap go on the next row; new ones are numbered', () => {
  const markers = [{ t: 10, text: 'a' }, { t: 11, text: 'b' }, { t: 30, text: 'c' }, { t: 12, text: 'd' }];
  // 10 px a second, labels 120 px: 10 and 11 and 12 overlap, 30 doesn't.
  assert.deepEqual(markerRows(markers, 10, 120), [0, 1, 0, 2]);
  assert.deepEqual(markerRows(markers, 1000, 120), [0, 0, 0, 0]);
  assert.deepEqual(markerRows([], 10), []);
  // Never more than three rows: a fourth overlapping one shares the last.
  assert.deepEqual(markerRows([0, 1, 2, 3].map((t) => ({ t, text: '' })), 10, 120), [0, 1, 2, 2]);
  assert.equal(nextMarkerText([]), 'Marker 1');
  assert.equal(nextMarkerText([{ t: 0, text: 'Marker 1' }, { t: 1, text: 'In the beginning' }]), 'Marker 3');
  assert.equal(nextMarkerText([{ t: 0, text: 'Marker 7' }]), 'Marker 8');
});

test('blocks: each lasts to its own end, else to the next block on its layer, else to the end', () => {
  const blocks = [
    { id: 'c', start: 30, rise: 0, what: { kind: 'full' } },
    { id: 'a', start: 0, rise: 0, what: { kind: 'dark' } },
    { id: 'b', start: 10, end: 20, rise: 2, what: { kind: 'dark' } },
  ];
  assert.deepEqual(blockSpans(blocks, 100).map((s) => [s.block.id, s.start, s.end]), [['a', 0, 10], ['b', 10, 20], ['c', 30, 100]]);
  // A block past the end still has a little width.
  assert.deepEqual(blockSpans([{ id: 'x', start: 50, rise: 0, what: { kind: 'dark' } }], 40).map((s) => [s.start, s.end]), [[50, 50]]);
});

test('a new timeline: a valid show timeline, Dark at 0:00 on Whole stage, with ids that are free', () => {
  const t = newTimeline('Ziemassvētku ievads', ['ziemassvetku-ievads']);
  assert.equal(t.id, 'ziemassvetku-ievads-2');
  assert.equal(t.name, 'Ziemassvētku ievads');
  assert.deepEqual(t.layers.map((l) => l.group), [STAGE_LAYER]);
  assert.deepEqual(t.layers[0]!.blocks.map((b) => [b.start, b.what.kind]), [[0, 'dark']]);
  assert.deepEqual(t.markers, []);
  assert.equal(t.offsetMs, 0);
  Timeline.parse(t);
  assert.equal(slugId('!!!', []), 'timeline');
  assert.equal(slugId('', ['timeline', 'timeline-2']), 'timeline-3');
  assert.equal(slugId('Ā b  C', []), 'a-b-c');
  // Block ids are unique across all the layers (the show refuses a timeline with two the same).
  const withBlocks = { ...t, layers: [...t.layers, { group: 'front', blocks: [{ id: 'b2', start: 1, rise: 0, what: { kind: 'dark' } }] }] };
  const taken = new Set(withBlocks.layers.flatMap((l) => l.blocks.map((b) => b.id)));
  const fresh = newBlockId(withBlocks);
  assert.ok(!taken.has(fresh));
  assert.match(fresh, /^[a-z0-9][a-z0-9-]*$/);
});

test('the view is the recording, or the blocks, and never shorter than 30 s', () => {
  assert.equal(viewLength({ layers: [], markers: [] }), 30);
  assert.equal(viewLength({ layers: [], markers: [], recording: { duration: 252 } }), 252);
  assert.equal(viewLength({ layers: [{ blocks: [{ start: 100, end: 300 }] }], markers: [{ t: 310 }], recording: { duration: 252 } }), 310);
});

test('the playhead stays in view while it plays: the view pages on when it reaches the right edge', () => {
  const width = 1000;
  assert.equal(followScroll(0, 50, width, 10, 400), 0, 'in view: no change');
  assert.equal(followScroll(120, 50, width, 10, 400), 120, 'in view, scrolled: no change');
  // At 95 s (x = 950, past the last 5 %) at 10 px/s: the view moves so it is near the left.
  assert.equal(followScroll(0, 95, width, 10, 400), 850);
  // Before the view (after a seek back): it comes into view too.
  assert.equal(followScroll(2000, 50, width, 10, 400), 400);
  // Never past the end.
  assert.equal(followScroll(0, 395, width, 10, 400), 3000);
});

test('audio: channels are mixed to mono, peaks scaled to the loudest, at most 4000 bars', () => {
  const left = Float32Array.from([1, 0, -1, 0.5]);
  const right = Float32Array.from([0, 0, -1, 0.5]);
  assert.deepEqual([...mixToMono([left, right])], [0.5, 0, -1, 0.5]);
  assert.equal(mixToMono([left]), left, 'mono stays as it is');
  assert.deepEqual(mixToMono([]).length, 0);
  assert.deepEqual(normalisePeaks([0.1, 0.25, 0.5]), [0.2, 0.5, 1]);
  assert.deepEqual(normalisePeaks([0, 0]), [0, 0]);
  assert.equal(barsFor(10), 200);
  assert.equal(barsFor(15 * 60), MAX_BARS);
  assert.equal(barsFor(0), 1);
});

// ---- Editing blocks ----

const blk = (id: string, start: number, end?: number) => ({ id, start, ...(end !== undefined ? { end } : {}), rise: 0, what: { kind: 'dark' as const } });

test('snapping: to a target (a marker, the playhead, another block) within 12 px, else to a tenth of a second', () => {
  // 10 px a second: 12 px is 1.2 s.
  assert.deepEqual(snapTime(12.34, [], 10), { t: 12.3, to: null });
  assert.deepEqual(snapTime(12.34, [13], 10), { t: 13, to: 13 });
  assert.deepEqual(snapTime(12.34, [14], 10), { t: 12.3, to: null }, '1.66 s away is 16.6 px: too far');
  assert.deepEqual(snapTime(12.34, [11.5, 12.9], 10), { t: 12.9, to: 12.9 }, 'the closest one');
  // Zoomed in (200 px a second) a marker 0.1 s away is 20 px: no snap, the tenth.
  assert.deepEqual(snapTime(12.34, [12.44], 200), { t: 12.3, to: null });
  assert.equal(snapTime(-3, [], 10).t, 0, 'never before 0');
  assert.equal(snapTime(0.04, [], 10).t, 0);
});

test('dragging a block moves it whole, snapped, never before 0 nor past the end', () => {
  const blocks = [blk('a', 0), blk('b', 10, 20), blk('c', 40)];
  const ctx = { targets: [], pxPerSec: 10, length: 100 };
  assert.deepEqual(dragBlock(blocks, 'b', 'move', 2.04, ctx), { start: 12, end: 22 }, 'its length is kept');
  assert.deepEqual(dragBlock(blocks, 'b', 'move', -50, ctx), { start: 0.1, end: 10.1 }, 'never before 0, never on another block\'s start');
  assert.deepEqual(dragBlock(blocks, 'c', 'move', 3.33, ctx), { start: 43.3 }, '"until the next block" stays so');
  // The end lands near a marker: the block moves so its end is on it.
  assert.deepEqual(dragBlock(blocks, 'b', 'move', 4.5, { ...ctx, targets: [25] }), { start: 15, end: 25 });
  // The start is nearer a marker than the end is: the start goes there.
  assert.deepEqual(dragBlock(blocks, 'b', 'move', 4.5, { ...ctx, targets: [14.8, 25.5] }), { start: 14.8, end: 24.8 });
  assert.deepEqual(dragBlock(blocks, 'c', 'move', 500, ctx), { start: 100 - MIN_BLOCK });
});

test('dragging the left edge changes the start only, between the block before and the block\'s end', () => {
  const blocks = [blk('a', 0), blk('b', 10, 20), blk('c', 40)];
  const ctx = { targets: [], pxPerSec: 10, length: 100 };
  assert.deepEqual(dragBlock(blocks, 'b', 'start', 3.06, ctx), { start: 13.1, end: 20 });
  assert.deepEqual(dragBlock(blocks, 'b', 'start', 30, ctx), { start: 20 - MIN_BLOCK, end: 20 }, 'at least MIN_BLOCK long');
  assert.deepEqual(dragBlock(blocks, 'b', 'start', -30, ctx), { start: MIN_BLOCK, end: 20 }, 'never over the block before');
  assert.deepEqual(dragBlock(blocks, 'a', 'start', -5, ctx), { start: 0 }, 'never before 0');
  assert.deepEqual(dragBlock(blocks, 'a', 'start', 30, ctx), { start: 10 - MIN_BLOCK }, 'until the next block: up to MIN_BLOCK before it');
  assert.deepEqual(dragBlock(blocks, 'b', 'start', 1.1, { ...ctx, targets: [11] }), { start: 11, end: 20 }, 'snaps to a marker');
});

test('dragging the right edge gives the block its own end; onto the next block it is "until the next block" again', () => {
  const blocks = [blk('a', 0), blk('b', 10, 20), blk('c', 40)];
  const ctx = { targets: [], pxPerSec: 10, length: 100 };
  assert.deepEqual(dragBlock(blocks, 'a', 'end', -3.04, ctx), { start: 0, end: 7 }, 'from where the next block starts (10) back');
  assert.deepEqual(dragBlock(blocks, 'b', 'end', 5.02, ctx), { start: 10, end: 25 });
  assert.deepEqual(dragBlock(blocks, 'b', 'end', -50, ctx), { start: 10, end: 10 + MIN_BLOCK }, 'at least MIN_BLOCK long');
  assert.deepEqual(dragBlock(blocks, 'b', 'end', 25, ctx), { start: 10 }, 'on or past the next block: until the next block');
  assert.deepEqual(dragBlock(blocks, 'c', 'end', -20.01, ctx), { start: 40, end: 80 }, 'the last block: from the end of the timeline');
  assert.deepEqual(dragBlock(blocks, 'c', 'end', 5, ctx), { start: 40 }, 'to the end: until the end');
  assert.deepEqual(dragBlock(blocks, 'b', 'end', 2.9, { ...ctx, targets: [23] }), { start: 10, end: 23 }, 'snaps to a marker');
  // A typed end: the same rule, but past the end of the recording is allowed.
  assert.equal(clampEnd(blocks, 'b', 30), 30);
  assert.equal(clampEnd(blocks, 'b', 45), undefined);
  assert.equal(clampEnd(blocks, 'b', 3), 10 + MIN_BLOCK);
  assert.equal(clampEnd(blocks, 'c', 120), 120);
});

test('moving a block to a time (typed, or the play position) keeps its length and never lands on another block\'s start', () => {
  const blocks = [blk('a', 0), blk('b', 10, 20), blk('c', 40)];
  assert.deepEqual(moveBlock(blocks, 'b', 25), { start: 25, end: 35 });
  assert.deepEqual(moveBlock(blocks, 'c', 12.34), { start: 12.3 });
  assert.deepEqual(moveBlock(blocks, 'c', -4), { start: 0.1 }, 'block a starts at 0: the next tenth');
  assert.deepEqual(moveBlock(blocks, 'b', 40), { start: 40.1, end: 50.1 });
});

test('hit-testing: a block\'s edges, its body, or empty space', () => {
  // 10 px a second: b is 100 to 200 px, c 400 to 1000 px.
  const spans = [{ id: 'b', start: 10, end: 20, endEdge: true }, { id: 'c', start: 40, end: 100, endEdge: true }];
  const mouse = { selected: null, handlePx: 12, selectedHandlePx: 44 };
  assert.deepEqual(hitTest(spans, 150, 10, mouse), { id: 'b', part: 'move' });
  assert.deepEqual(hitTest(spans, 103, 10, mouse), { id: 'b', part: 'start' });
  assert.deepEqual(hitTest(spans, 95, 10, mouse), { id: 'b', part: 'start' }, 'a little outside counts too');
  assert.deepEqual(hitTest(spans, 198, 10, mouse), { id: 'b', part: 'end' });
  assert.equal(hitTest(spans, 300, 10, mouse), null, 'empty space');
  assert.equal(hitTest(spans, 80, 10, mouse), null);
  // Selected: 44 px handles, 22 px each side of the edge.
  assert.deepEqual(hitTest(spans, 80, 10, { ...mouse, selected: 'b' }), { id: 'b', part: 'start' });
  assert.deepEqual(hitTest(spans, 220, 10, { ...mouse, selected: 'b' }), { id: 'b', part: 'end' });
  // A narrow block keeps a body to grab: the handles reach at most a third of the way in.
  const narrow = [{ id: 'n', start: 10, end: 13, endEdge: true }];
  assert.deepEqual(hitTest(narrow, 115, 10, { ...mouse, selected: 'n' }), { id: 'n', part: 'move' });
  assert.deepEqual(hitTest(narrow, 108, 10, { ...mouse, selected: 'n' }), { id: 'n', part: 'start' });
  // A finger grabs only the selected block's edges (elsewhere a drag scrolls the lanes).
  assert.deepEqual(hitTest(spans, 103, 10, { ...mouse, handlePx: 0 }), { id: 'b', part: 'move' });
  // An end that is only where the next block starts has no handle: the next block's start is there.
  const joined = [{ id: 'a', start: 0, end: 10, endEdge: false }, { id: 'b', start: 10, end: 20, endEdge: true }];
  assert.deepEqual(hitTest(joined, 99, 10, mouse), { id: 'b', part: 'start' });
  // Two edges in reach: the closer one.
  const close = [{ id: 'a', start: 0, end: 9.9, endEdge: true }, { id: 'b', start: 10, end: 20, endEdge: true }];
  assert.deepEqual(hitTest(close, 98, 10, mouse), { id: 'a', part: 'end' });
  assert.deepEqual(hitTest(close, 100.5, 10, mouse), { id: 'b', part: 'start' });
});

test('a new block goes where it was asked for, snapped, but not on a block that starts there', () => {
  const blocks = [blk('a', 0), blk('b', 10, 20)];
  assert.equal(newBlockStart(blocks, 31.27, [], 10), 31.3);
  assert.equal(newBlockStart(blocks, 31.27, [32], 10), 32);
  assert.equal(newBlockStart(blocks, 10.2, [], 10), null, 'b starts there');
  assert.equal(newBlockStart(blocks, 9.4, [], 10), 9.4, 'MIN_BLOCK before b is fine');
  assert.equal(newBlockStart([], 0, [], 10), 0);
});

test('rise: at least 1.5 s is shown (the runner never fades faster); a look block rises over the look\'s own fade', () => {
  assert.equal(MIN_RISE, 1.5);
  assert.equal(shownRise(0), 1.5);
  assert.equal(shownRise(20), 20);
  assert.equal(formatRise(0), '1.5 s');
  assert.equal(formatRise(20), '20 s');
  assert.equal(formatRise(2.25), '2.3 s');
  const presets = [{ id: 'warm', fade: 3 }, { id: 'blue', fade: 8 }];
  assert.equal(lookFade({ groups: [{ group: 'a', preset: 'warm' }, { group: 'b', preset: 'blue' }] }, presets), 8, 'the slowest of its groups');
  assert.equal(lookFade({ groups: [{ group: 'a', preset: 'warm', fade: 12 }] }, presets), 12, 'the look\'s own fade for a group wins');
  assert.equal(lookFade({ groups: [{ group: 'a', preset: 'gone' }] }, presets), 3, 'nothing to go by: 3 s');
  assert.equal(lookFade(undefined, presets), 3);
  // Another look: the rise follows unless it was set by hand.
  assert.equal(riseAfterLookChange(8, 8, 3), 3);
  assert.equal(riseAfterLookChange(20, 8, 3), 20);
});

test('missing references: a deleted colour, effect, look or group, or a block that does not fit its layer', () => {
  const show = {
    groups: [{ id: 'front' }, { id: 'key' }],
    presets: [{ id: 'warm', group: 'front' }, { id: 'blue', group: 'key' }],
    looks: [{ id: 'worship' }],
  };
  const ok: [string, unknown][] = [
    ['front', { kind: 'colour', preset: 'warm', level: 1 }],
    ['front', { kind: 'level', level: 0.5 }],
    ['front', { kind: 'effect', preset: 'warm' }],
    ['front', { kind: 'follow', low: 0.1, high: 1 }],
    ['front', { kind: 'follow', low: 0.1, high: 1, preset: 'warm' }],
    [STAGE_LAYER, { kind: 'look', look: 'worship' }],
    [STAGE_LAYER, { kind: 'dark' }],
    [STAGE_LAYER, { kind: 'full' }],
  ];
  for (const [g, what] of ok) assert.equal(blockMissing(g, what as never, show), false, JSON.stringify(what));
  const bad: [string, unknown][] = [
    ['front', { kind: 'colour', preset: 'gone', level: 1 }],
    ['front', { kind: 'colour', preset: 'blue', level: 1 }],
    ['front', { kind: 'effect', preset: 'gone' }],
    ['front', { kind: 'follow', low: 0, high: 1, preset: 'gone' }],
    [STAGE_LAYER, { kind: 'look', look: 'gone' }],
    [STAGE_LAYER, { kind: 'colour', preset: 'warm', level: 1 }],
    ['front', { kind: 'look', look: 'worship' }],
    ['gone', { kind: 'dark' }],
  ];
  for (const [g, what] of bad) assert.equal(blockMissing(g, what as never, show), true, `${g} ${JSON.stringify(what)}`);
});

test('layers: made once with a new timeline; then only its own are shown, in the show\'s order; ＋ Layer offers the rest', () => {
  const t = newTimeline('Intro', [], ['front', 'key']);
  assert.deepEqual(t.layers.map((l) => l.group), [STAGE_LAYER, 'front', 'key']);
  Timeline.parse(t);
  const groups = [{ id: 'front' }, { id: 'key' }, { id: 'back' }, { id: 'smoke', kind: 'smoke' }];
  // Its own layers in the show's order (whatever order they were added in), Whole stage first, a gone group's last.
  const tl = { layers: [{ group: 'key', blocks: [] }, { group: 'gone', blocks: [] }, { group: STAGE_LAYER, blocks: [] }, { group: 'front', blocks: [] }] };
  assert.deepEqual(shownLayers(tl, groups), [
    { group: STAGE_LAYER, missing: false }, { group: 'front', missing: false }, { group: 'key', missing: false }, { group: 'gone', missing: true },
  ]);
  // Whole stage is always there, even before it has a layer of its own; a removed layer stays removed.
  assert.deepEqual(shownLayers({ layers: [{ group: 'key' }] }, groups).map((r) => r.group), [STAGE_LAYER, 'key']);
  // ＋ Layer: the light groups without a layer (one added to the show later too), never a smoke group.
  assert.deepEqual(addableGroups(tl, groups), ['back']);
  assert.deepEqual(addableGroups({ layers: [] }, groups), ['front', 'key', 'back']);
});

test('a finger drags a block only when it moves sideways; up or down it scrolls the page', () => {
  assert.equal(dragIntent(4, 1, true), null, 'not far enough yet');
  assert.equal(dragIntent(12, 3, true), 'drag');
  assert.equal(dragIntent(-12, 5, true), 'drag');
  assert.equal(dragIntent(6, 14, true), 'scroll');
  assert.equal(dragIntent(10, 10, true), 'scroll', 'diagonal: the page');
  assert.equal(dragIntent(6, 0, false), 'drag', 'a mouse drags after 5 px');
  assert.equal(dragIntent(0, 30, false), null, 'a mouse moving straight down does not drag');
});

test('a block moved so its own end runs past the next block\'s start lasts until the next block', () => {
  const blocks = [blk('a', 0), blk('b', 10, 20), blk('c', 40)];
  const ctx = { targets: [], pxPerSec: 10, length: 100 };
  assert.deepEqual(dragBlock(blocks, 'b', 'move', 25, ctx), { start: 35 }, 'its end (45) was past c (40)');
  assert.deepEqual(dragBlock(blocks, 'b', 'move', 15, ctx), { start: 25, end: 35 }, 'still before c: kept');
  assert.deepEqual(moveBlock(blocks, 'b', 35), { start: 35 });
  assert.deepEqual(moveBlock(blocks, 'a', 41), { start: 41 });
});
