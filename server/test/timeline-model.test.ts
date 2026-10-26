// The Timeline page's pure helpers (web/timeline/model.js): times, zoom and scroll, the ruler, markers, blocks, new timelines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, STAGE_LAYER } from '../../packages/shared/src/index.ts';
import {
  MAX_BARS, MAX_ZOOM, barsFor, blockSpans, clampScroll, fitZoom, followScroll, formatLength, formatTime, markerRows, mixToMono,
  newBlockId, newTimeline, nextMarkerText, normalisePeaks, parseTime, rulerStep, rulerTicks, slugId, timeToX, viewLength, xToTime, zoomed,
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
