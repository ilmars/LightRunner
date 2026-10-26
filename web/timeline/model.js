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

/**
 * A new timeline named `name`: Dark at 0:00 on Whole stage, so it starts dark unless that block is removed, and an
 * empty layer for each of `groupIds` (the show's light groups).
 */
export function newTimeline(name, takenIds, groupIds = []) {
  const timeline = { id: slugId(name, takenIds), name, layers: [{ group: STAGE, blocks: [] }], markers: [], offsetMs: 0 };
  timeline.layers[0].blocks.push({ id: newBlockId(timeline), start: 0, rise: 0, what: { kind: 'dark' } });
  for (const group of groupIds) timeline.layers.push({ group, blocks: [] });
  return timeline;
}

/**
 * The layers the page shows: Whole stage (always), then the timeline's own group layers in the show's group order, then
 * any whose group is gone from the show (`missing`: its blocks are skipped). A removed layer isn't there.
 * @param {{ layers: { group: string }[] }} timeline
 * @param {{ id: string }[]} groups the show's groups, in order
 * @returns {{ group: string, missing: boolean }[]}
 */
export function shownLayers(timeline, groups) {
  const has = new Set(timeline.layers.map((l) => l.group));
  const rows = [{ group: STAGE, missing: false }];
  for (const g of groups) if (has.has(g.id)) rows.push({ group: g.id, missing: false });
  for (const l of timeline.layers) {
    if (l.group !== STAGE && !groups.some((g) => g.id === l.group)) rows.push({ group: l.group, missing: true });
  }
  return rows;
}

/** The light groups ＋ Layer can add: those without a layer (one added to the show later too). Never a smoke group. */
export function addableGroups(timeline, groups) {
  const has = new Set(timeline.layers.map((l) => l.group));
  return groups.filter((g) => g.kind !== 'smoke' && !has.has(g.id)).map((g) => g.id);
}

/**
 * Whether a press that moved (dx, dy) pixels is a drag of a block: a finger only once it went 10 px and more sideways
 * than up or down (otherwise it is the page scrolling: 'scroll'); a mouse after 5 px sideways. Null: not yet.
 */
export function dragIntent(dx, dy, finger) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (!finger) return ax >= 5 ? 'drag' : null;
  if (Math.max(ax, ay) < 10) return null;
  return ax > ay ? 'drag' : 'scroll';
}

// ---- Editing blocks ----

/** The runner fades every change over at least this long (seconds), so the page never shows a shorter rise. */
export const MIN_RISE = 1.5;
/** The shortest a block can be dragged or typed to (seconds). */
export const MIN_BLOCK = 0.5;
/** A dragged time snaps to a marker (or the playhead, or another block's edge) this close, in pixels. */
export const SNAP_PX = 12;

const round6 = (t) => Math.round(t * 1e6) / 1e6;
const tenth = (t) => Math.round(t * 10) / 10;

/** The rise the lights really take: the block's own, but never under MIN_RISE. */
export function shownRise(rise) {
  return Math.max(MIN_RISE, rise || 0);
}

/** A rise as the page shows it: "20 s", "1.5 s". */
export function formatRise(rise) {
  return `${tenth(shownRise(rise))} s`;
}

/**
 * A dragged time, snapped: to the closest of `targets` (markers, the playhead, other blocks' edges) within `snapPx`
 * pixels at this zoom, else to a tenth of a second. Never before 0. `to` is the target it snapped to, or null.
 * @param {number} t
 * @param {number[]} targets
 * @param {number} pxPerSec
 * @returns {{ t: number, to: number | null }}
 */
export function snapTime(t, targets, pxPerSec, snapPx = SNAP_PX) {
  let best = null;
  let bestD = snapPx / pxPerSec;
  for (const target of targets) {
    const d = Math.abs(target - t);
    if (d <= bestD) {
      best = target;
      bestD = d;
    }
  }
  if (best !== null && best >= 0) return { t: best, to: best };
  return { t: Math.max(0, tenth(t)), to: null };
}

/** A layer's blocks in time order, and where the one with `id` is among them. */
function placeOf(blocks, id) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const k = sorted.findIndex((b) => b.id === id);
  return { sorted, k, block: sorted[k], prev: sorted[k - 1] ?? null, next: sorted[k + 1] ?? null };
}

/** `start`, moved on by tenths until no other block of the layer starts there (two blocks never start together). */
function freeStart(blocks, id, start) {
  let s = start;
  while (blocks.some((b) => b.id !== id && Math.abs(b.start - s) < 0.05)) s = round6(s + 0.1);
  return s;
}

/** A moved block's own end, or undefined (until the next block) when it now runs onto the next block's start. */
function endAfterMove(blocks, id, start, end) {
  if (end === undefined) return undefined;
  const next = blocks.filter((b) => b.id !== id && b.start > start).sort((a, b) => a.start - b.start)[0];
  return next && end >= next.start - 1e-6 ? undefined : end;
}

/** The block as `{ start, end? }` with a start and maybe an end. */
const timesOf = (start, end) => (end === undefined ? { start: round6(start) } : { start: round6(start), end: round6(end) });

/**
 * A typed end for the block `id`, kept sensible: at least MIN_BLOCK after its start; on or past the next block's start it
 * is "until the next block" (undefined). Past the recording's end is allowed (the timeline grows).
 */
export function clampEnd(blocks, id, end) {
  const { block, next } = placeOf(blocks, id);
  if (!block) return end;
  if (next && end >= next.start - 1e-6) return undefined;
  return round6(Math.max(block.start + MIN_BLOCK, end));
}

/**
 * The block `id` dragged by `dt` seconds: `part` 'move' moves it whole (its length kept; the start, or the end if that is
 * nearer, snaps), 'start' moves its start (between the block before and its end), 'end' gives it its own end (back on the
 * next block's start, or the end of the timeline, it is "until the next block" again). Never before 0, never past
 * `length` (the timeline's end), never shorter than MIN_BLOCK, never starting where another block starts.
 * @param {{ id: string, start: number, end?: number }[]} blocks the layer's blocks
 * @param {string} id
 * @param {'move' | 'start' | 'end'} part
 * @param {number} dt
 * @param {{ targets: number[], pxPerSec: number, length: number }} ctx
 * @returns {{ start: number, end?: number }}
 */
export function dragBlock(blocks, id, part, dt, ctx) {
  const { block, prev, next } = placeOf(blocks, id);
  const spanEnd = block.end ?? next?.start ?? ctx.length;
  const snap = (t) => snapTime(t, ctx.targets, ctx.pxPerSec);
  if (part === 'move') {
    const len = block.end !== undefined ? block.end - block.start : null;
    const s = snap(block.start + dt);
    let start = s.t;
    if (len !== null) {
      // The end snaps instead when it is nearer a target than the start is.
      const e = snap(block.end + dt);
      if (e.to !== null && (s.to === null || Math.abs(e.to - (block.end + dt)) < Math.abs(s.to - (block.start + dt)))) start = e.t - len;
    }
    start = Math.min(Math.max(0, start), Math.max(0, ctx.length - MIN_BLOCK));
    start = freeStart(blocks, id, round6(start));
    return timesOf(start, endAfterMove(blocks, id, start, len === null ? undefined : start + len));
  }
  if (part === 'start') {
    const low = prev ? prev.start + MIN_BLOCK : 0;
    const high = spanEnd - MIN_BLOCK;
    const start = Math.min(high, Math.max(low, snap(block.start + dt).t));
    return timesOf(start, block.end);
  }
  const end = Math.max(block.start + MIN_BLOCK, snap(spanEnd + dt).t);
  if ((next && end >= next.start - 1e-6) || (!next && end >= ctx.length - 1e-6)) return timesOf(block.start);
  return timesOf(block.start, end);
}

/** The block `id` moved to start at `t` (typed, or the play position): to the tenth, its length kept, never before 0. */
export function moveBlock(blocks, id, t) {
  const { block } = placeOf(blocks, id);
  const start = freeStart(blocks, id, Math.max(0, tenth(t)));
  return timesOf(start, endAfterMove(blocks, id, start, block.end === undefined ? undefined : start + (block.end - block.start)));
}

/**
 * What a press at `x` (pixels from the start of the timeline) is on: a block's left edge ('start'), right edge ('end'),
 * its body ('move'), or nothing (null). Each edge has a handle `handlePx` wide (the selected block's `selectedHandlePx`),
 * half outside the block and reaching at most a third of the way in; 0 means no handles (a finger on a block that isn't
 * selected: the lanes scroll). The closest edge wins; an edge before any body. A span's end has a handle only when
 * `endEdge` (its own end, or the last block's): where it only meets the next block, the next block's start is there.
 * @param {{ id: string, start: number, end: number, endEdge: boolean }[]} spans
 * @param {number} x
 * @param {number} pxPerSec
 * @param {{ selected: string | null, handlePx: number, selectedHandlePx: number }} opts
 * @returns {{ id: string, part: 'start' | 'end' | 'move' } | null}
 */
export function hitTest(spans, x, pxPerSec, opts) {
  let edge = null;
  let edgeD = Infinity;
  let body = null;
  for (const s of spans) {
    const left = s.start * pxPerSec, right = s.end * pxPerSec;
    const selected = s.id === opts.selected;
    const half = (selected ? opts.selectedHandlePx : opts.handlePx) / 2;
    if (half > 0) {
      const inner = Math.min(half, (right - left) / 3);
      const consider = (part, at, from, to) => {
        if (x < from || x > to) return;
        const d = Math.abs(x - at);
        // Closer wins; on a tie the selected block, then a start.
        if (d < edgeD - 1e-9 || (Math.abs(d - edgeD) <= 1e-9 && (selected || part === 'start'))) {
          edge = { id: s.id, part };
          edgeD = d;
        }
      };
      consider('start', left, left - half, left + inner);
      if (s.endEdge) consider('end', right, right - inner, right + half);
    }
    if (x >= left && x <= right && (!body || selected || body.id !== opts.selected)) body = { id: s.id, part: 'move' };
  }
  return edge ?? body;
}

/**
 * Where a block asked for at `t` goes on a layer: snapped (as a drag is), or null when a block of the layer starts within
 * MIN_BLOCK of there (that block is meant).
 */
export function newBlockStart(blocks, t, targets, pxPerSec) {
  const start = snapTime(t, targets, pxPerSec).t;
  if (blocks.some((b) => Math.abs(b.start - start) < MIN_BLOCK - 1e-9)) return null;
  return start;
}

/**
 * How long a look takes to come in when an operator taps it: the slowest of its groups (each group's own fade in the
 * look, else its colour's), or 3 s when there is nothing to go by. A look block's rise starts as this.
 * @param {{ groups: { preset: string, fade?: number }[] } | undefined} look
 * @param {{ id: string, fade?: number }[]} presets
 */
export function lookFade(look, presets) {
  let longest = null;
  for (const entry of look?.groups ?? []) {
    const preset = presets.find((p) => p.id === entry.preset);
    if (!preset) continue;
    const fade = entry.fade ?? preset.fade ?? 3;
    longest = Math.max(longest ?? 0, fade);
  }
  return longest ?? 3;
}

/** The rise when a block's look changes: the new look's fade, unless the rise was set by hand (not the old look's fade). */
export function riseAfterLookChange(rise, oldFade, newFade) {
  return Math.abs(rise - oldFade) < 1e-9 ? newFade : rise;
}

/**
 * True when a block on the layer of `group` (a group id, or the Whole stage's) points at something the show no longer
 * has (a colour, an effect, a look, its group) or doesn't fit its layer (a look on a group, a colour on Whole stage).
 * The runner skips such a block; the page shows it as missing.
 * @param {string} group
 * @param {{ kind: string, preset?: string, look?: string }} what
 * @param {{ groups: { id: string }[], presets: { id: string, group: string }[], looks: { id: string }[] }} show
 */
export function blockMissing(group, what, show) {
  const onStage = group === STAGE;
  if (!onStage && !show.groups.some((g) => g.id === group)) return true;
  const ofGroup = (id) => show.presets.some((p) => p.id === id && p.group === group);
  switch (what.kind) {
    case 'dark':
    case 'full': return false;
    case 'look': return !onStage || !show.looks.some((l) => l.id === what.look);
    case 'level': return onStage;
    case 'colour':
    case 'effect': return onStage || !ofGroup(what.preset);
    case 'follow': return onStage || (what.preset !== undefined && !ofGroup(what.preset));
    default: return true;
  }
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
