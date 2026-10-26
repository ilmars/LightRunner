// The Timeline page's pure helpers: times, zoom and scroll, the ruler, markers, blocks, new timelines and the
// audio maths around loudness.js. No DOM here, so the tests can check it (server/test/timeline-model.test.ts).

/** The closest zoom, in pixels per second. */
export const MAX_ZOOM = 200;
/** The most waveform bars a recording keeps (the show's schema allows no more). */
export const MAX_BARS = 4000;
/** The shortest stretch the page shows, in seconds. */
const MIN_VIEW = 30;
/** The Whole stage layer's id (STAGE_LAYER in the show's schema). */
const STAGE = '*';

/**
 * Seconds as m:ss.t ("1:23.4"). Tenths are cut, never rounded up, so the time shown is one already reached.
 * @param {number} s
 */
export function formatTime(s) {
  const tenths = Number.isFinite(s) && s > 0 ? Math.floor(s * 10 + 1e-6) : 0;
  const m = Math.floor(tenths / 600);
  const rest = tenths - m * 600;
  return `${m}:${String(Math.floor(rest / 10)).padStart(2, '0')}.${rest % 10}`;
}

/**
 * A length as m:ss ("4:12"), to the nearest second.
 * @param {number} s
 */
export function formatLength(s) {
  const total = Number.isFinite(s) && s > 0 ? Math.round(s) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A typed time: "1:23.4", "0:05" or plain seconds ("83", "2.5"). Null when it isn't one.
 * @param {string} text
 * @returns {number | null}
 */
export function parseTime(text) {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)\s*$/.exec(text);
  if (!m) return null;
  const secs = Number(m[2]);
  if (m[1] !== undefined && secs >= 60) return null;
  const value = (m[1] !== undefined ? Number(m[1]) * 60 : 0) + secs;
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

// ---- Zoom and scroll: a view is { pxPerSec, scroll } (scroll in pixels from the start) ----

/** @param {number} t @param {{ pxPerSec: number, scroll: number }} view */
export function timeToX(t, view) {
  return t * view.pxPerSec - view.scroll;
}

/** The time at x (pixels from the left of the lanes), between 0 and `duration`. */
export function xToTime(x, view, duration) {
  return Math.min(duration, Math.max(0, (x + view.scroll) / view.pxPerSec));
}

/** The zoom at which `duration` (at least 30 s) fills `width`. */
export function fitZoom(duration, width) {
  return width / Math.max(MIN_VIEW, duration);
}

/** A scroll that stays within what there is to see. */
export function clampScroll(scroll, pxPerSec, width, duration) {
  return Math.min(Math.max(0, duration * pxPerSec - width), Math.max(0, scroll));
}

/**
 * The view zoomed by `factor` (2 = in, 0.5 = out), keeping the time under `anchorX` where it is on screen.
 * Never further out than the whole length fits, never closer than MAX_ZOOM.
 */
export function zoomed(view, factor, anchorX, width, duration) {
  const fit = fitZoom(duration, width);
  const pxPerSec = Math.min(MAX_ZOOM, Math.max(fit, view.pxPerSec * factor));
  const t = (anchorX + view.scroll) / view.pxPerSec;
  return { pxPerSec, scroll: clampScroll(t * pxPerSec - anchorX, pxPerSec, width, duration) };
}

/**
 * Where the view should be so the playhead at `t` stays in it while it plays: unchanged while it is in view, else
 * moved on so the playhead is near the left (a page at a time, so the lanes don't crawl under the finger).
 */
export function followScroll(scroll, t, width, pxPerSec, duration) {
  const x = t * pxPerSec - scroll;
  if (x >= 0 && x < width * 0.95) return scroll;
  return clampScroll(t * pxPerSec - width * 0.1, pxPerSec, width, duration);
}

// ---- The ruler ----

const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Seconds between labelled ticks at this zoom: the smallest round step whose labels are at least `minPx` apart. */
export function rulerStep(pxPerSec, minPx = 64) {
  return STEPS.find((s) => s * pxPerSec >= minPx) ?? STEPS[STEPS.length - 1];
}

/**
 * The labelled ticks in view (and one just before it, so a label half out of view still shows): { t, x, label }.
 * Labels are m:ss, or m:ss.t when the ticks are under a second apart.
 */
export function rulerTicks(view, width, duration) {
  const step = rulerStep(view.pxPerSec);
  const from = Math.floor(view.scroll / view.pxPerSec / step) - 1;
  const last = Math.min(duration, (view.scroll + width) / view.pxPerSec);
  const ticks = [];
  for (let k = Math.max(0, from); k * step <= last + 1e-9; k++) {
    const t = Math.round(k * step * 1000) / 1000;
    ticks.push({ t, x: timeToX(t, view), label: step < 1 ? formatTime(t) : formatLength(t) });
  }
  return ticks;
}

// ---- Markers ----

/**
 * Which row (0, 1 or 2) each marker's label goes on, so labels closer than `labelPx` don't overlap; in the order given.
 * @param {{ t: number }[]} markers
 */
export function markerRows(markers, pxPerSec, labelPx = 120) {
  const order = markers.map((m, i) => i).sort((a, b) => markers[a].t - markers[b].t);
  const ends = [];
  const rows = new Array(markers.length).fill(0);
  for (const i of order) {
    const x = markers[i].t * pxPerSec;
    let row = ends.findIndex((end) => end <= x);
    if (row < 0) row = ends.length < 3 ? ends.length : 2;
    ends[row] = x + labelPx;
    rows[i] = row;
  }
  return rows;
}

/** The text of a new marker: "Marker N", numbered on from the markers there are. */
export function nextMarkerText(markers) {
  let n = markers.length;
  for (const m of markers) {
    const k = /^Marker (\d+)$/.exec(m.text);
    if (k) n = Math.max(n, Number(k[1]));
  }
  return `Marker ${n + 1}`;
}

// ---- Blocks and timelines ----

/**
 * The blocks of a layer in time order, each with where it ends: its own end, else the next block's start, else `duration`.
 * @template {{ start: number, end?: number }} B
 * @param {B[]} blocks
 * @returns {{ block: B, start: number, end: number }[]}
 */
export function blockSpans(blocks, duration) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  return sorted.map((block, k) => {
    const end = block.end ?? sorted[k + 1]?.start ?? duration;
    return { block, start: block.start, end: Math.max(block.start, end) };
  });
}

/** How long the page shows a timeline: its recording, its blocks and markers, at least 30 s. */
export function viewLength(timeline) {
  let end = Math.max(MIN_VIEW, timeline.recording?.duration ?? 0);
  for (const layer of timeline.layers) for (const b of layer.blocks) end = Math.max(end, b.end ?? b.start);
  for (const m of timeline.markers ?? []) end = Math.max(end, m.t);
  return end;
}

/** An id from a name (lowercase letters, digits and dashes), not one of `taken`. */
export function slugId(name, taken, fallback = 'timeline') {
  const base = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A block id no block of the timeline has (ids are unique across all its layers). */
export function newBlockId(timeline) {
  const used = new Set(timeline.layers.flatMap((l) => l.blocks.map((b) => b.id)));
  for (let n = 1; ; n++) if (!used.has(`b${n}`)) return `b${n}`;
}

/** A new timeline named `name`: Dark at 0:00 on Whole stage, so it starts dark unless that block is removed. */
export function newTimeline(name, takenIds) {
  const timeline = { id: slugId(name, takenIds), name, layers: [{ group: STAGE, blocks: [] }], markers: [], offsetMs: 0 };
  timeline.layers[0].blocks.push({ id: newBlockId(timeline), start: 0, rise: 0, what: { kind: 'dark' } });
  return timeline;
}

// ---- The recording ----

/**
 * The channels of a decoded recording mixed to one (their average).
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  if (!channels.length) return new Float32Array(0);
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i];
  for (let i = 0; i < out.length; i++) out[i] /= channels.length;
  return out;
}

/** Waveform peaks scaled so the loudest is 1 (a quiet file still fills the waveform). */
export function normalisePeaks(values) {
  const top = values.reduce((m, v) => (v > m ? v : m), 0);
  return top > 0 ? values.map((v) => v / top) : values.map(() => 0);
}

/** How many waveform bars a recording of `duration` seconds keeps: 20 a second, at most MAX_BARS. */
export function barsFor(duration) {
  return Math.min(MAX_BARS, Math.max(1, Math.ceil(duration * 20)));
}
