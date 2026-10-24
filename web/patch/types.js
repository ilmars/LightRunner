// Fixture types' channels on the Patch page: rows, segments, summaries, the side-by-side comparison,
// checks and edits. Pure and DOM-free, so the tests can run it (server/test/fixture-types.test.ts).
// A channel is the show's { role, fine?, default?, kelvin?, name? }. The page says "job" and "fixed value"
// where the show file says role and default. Nothing here changes the lists it is given; edits return new ones.

/** The jobs a channel can have, in the order the editor offers them. */
export const JOBS = [
  { job: 'dimmer', label: 'Dimmer' },
  { job: 'red', label: 'Red' },
  { job: 'green', label: 'Green' },
  { job: 'blue', label: 'Blue' },
  { job: 'white', label: 'White' },
  { job: 'amber', label: 'Amber' },
  { job: 'uv', label: 'UV' },
  { job: 'cct', label: 'Colour temperature' },
  { job: 'strobe', label: 'Strobe' },
  { job: 'other', label: 'Fixed value' },
];

/** The colours: each repeats once per segment. */
const COLOURS = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
/** The jobs that take a level, so can be 16-bit. */
const TAKES_LEVEL = new Set(['dimmer', ...COLOURS, 'cct']);
/** The jobs that send one fixed value. */
const FIXED = new Set(['strobe', 'other']);

const labelOf = (job) => JOBS.find((j) => j.job === job)?.label ?? job;
const clone = (value) => structuredClone(value);
const isWhole = (n) => typeof n === 'number' && Number.isInteger(n);

/** A new channel with the job's starting values. */
function starting(job) {
  if (job === 'cct') return { role: job, kelvin: { min: 2700, max: 6500 } };
  if (FIXED.has(job)) return { role: job, default: 0 };
  return { role: job };
}

/** One row per channel, its fine byte folded in (a fine byte with no coarse channel before it stays a row of its own). */
function groupRows(channels) {
  const rows = [];
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const next = channels[i + 1];
    const paired = !ch.fine && next !== undefined && next.fine === true && next.role === ch.role;
    const row = {
      index: i,
      first: i + 1,
      last: i + 1 + (paired ? 1 : 0),
      job: ch.role,
      label: labelOf(ch.role),
      sixteenBit: paired,
      segment: null,
    };
    if (ch.kelvin) row.kelvin = { ...ch.kelvin };
    if (FIXED.has(ch.role)) row.value = ch.default ?? 0;
    if (ch.name !== undefined) row.name = ch.name;
    rows.push(row);
    if (paired) i++;
  }
  return rows;
}

/**
 * Where the segments are, as the engine drives them (planChannels in packages/engine/src/output.ts): a colour channel
 * is in segment n when it is its colour's n-th (a fine byte goes with its coarse channel). In a type with several
 * segments a colour that appears only once is the whole light, and so is every channel that is not a colour.
 * `ranges[n]` is the span of channel positions from segment n's first colour channel to its last (fine byte included).
 */
function segmentsOf(channels, rows) {
  const totals = new Map();
  const colourRows = rows.filter((row) => COLOURS.includes(row.job) && !channels[row.index].fine);
  for (const row of colourRows) totals.set(row.job, (totals.get(row.job) ?? 0) + 1);
  const count = Math.max(1, ...totals.values());
  const own = new Map();
  const ranges = [];
  const seen = new Map();
  for (const row of colourRows) {
    const n = (seen.get(row.job) ?? 0) + 1;
    seen.set(row.job, n);
    if (count > 1 && totals.get(row.job) === 1) continue;
    if (count > 1) own.set(row, n);
    const range = ranges[n] ?? (ranges[n] = { lo: row.index, hi: row.index });
    range.lo = Math.min(range.lo, row.index);
    range.hi = Math.max(range.hi, row.last - 1);
  }
  return { count, own, ranges };
}

/** How many segments a type has: the most times any colour repeats, at least 1. The engine counts the same way. */
export function segmentCount(channels) {
  return segmentsOf(channels, groupRows(channels)).count;
}

/**
 * One row per channel, with its 1-based channel numbers, its job, and the segment it is in (null: the whole light,
 * which is everything in a type with one segment, and in one with several every channel that is not a colour
 * that repeats).
 */
export function channelRows(channels) {
  const rows = groupRows(channels);
  const { own } = segmentsOf(channels, rows);
  for (const row of rows) row.segment = own.get(row) ?? null;
  return rows;
}

/** One channel in a word or two, for the side-by-side comparison. */
export function channelText(ch) {
  let text = labelOf(ch.role);
  if (ch.fine) text += ', fine';
  if (ch.kelvin) text += ` ${ch.kelvin.min}–${ch.kelvin.max} K`;
  if (FIXED.has(ch.role)) text += ` ${ch.default ?? 0}`;
  // A name that only repeats the job ("Red" on a red channel) adds nothing.
  if (ch.name && ch.name.toLowerCase() !== labelOf(ch.role).toLowerCase()) text += ` — ${ch.name}`;
  return text;
}

/** "a", "a and b", "a, b and c". */
function listed(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A colour temperature range that can be saved: whole numbers from 1000 to 20000 K, warm below cool. */
const inKelvinRange = (n) => isWhole(n) && n >= 1000 && n <= 20000;
function rangeIsValid(k) {
  return Boolean(k) && inKelvinRange(k.min) && inKelvinRange(k.max) && k.min < k.max;
}

/** The jobs of some rows in words: "dimmer, strobe and 5 fixed values". */
function jobsInWords(rows) {
  const fixed = rows.filter((r) => r.job === 'other').length;
  const items = [];
  let fixedDone = false;
  for (const row of rows) {
    if (row.job === 'other') {
      if (fixedDone) continue;
      fixedDone = true;
      items.push(fixed === 1 ? 'fixed value' : `${fixed} fixed values`);
    } else if (row.job === 'cct') {
      // While the range is being typed and is not right yet, the summary leaves it out.
      items.push(rangeIsValid(row.kelvin) ? `colour temperature ${row.kelvin.min}–${row.kelvin.max} K` : 'colour temperature');
    } else if (row.job === 'uv') {
      items.push('UV');
    } else {
      items.push(row.label.toLowerCase());
    }
  }
  return listed(items);
}

/** What a type is, in a line: "39 channels · 8 segments · each red, green, blue and white · also dimmer, ...". */
export function summary(channels) {
  const total = `${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}`;
  if (channels.length === 0) return total;
  const rows = channelRows(channels);
  const segments = segmentCount(channels);
  if (segments < 2) return `${total} · one light · ${jobsInWords(rows)}`;
  const each = rows.filter((r) => r.segment === 1 && COLOURS.includes(r.job));
  const whole = rows.filter((r) => r.segment === null);
  let text = `${total} · ${segments} segments · each ${jobsInWords(each)}`;
  if (whole.length) text += ` · also ${jobsInWords(whole)}`;
  return text;
}

/** Two types channel by channel: n is the channel number, left and right are null past a type's end. */
export function compareRows(a, b) {
  const rows = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = i < a.length ? channelText(a[i]) : null;
    const right = i < b.length ? channelText(b[i]) : null;
    rows.push({ n: i + 1, left, right, same: left === right });
  }
  return rows;
}

/** The first thing wrong with a type, in plain words, or null when it can be saved. */
export function validateType(name, channels) {
  if (typeof name !== 'string' || name.trim() === '') return 'Give the type a name.';
  if (channels.length === 0) return 'Add at least one channel.';
  if (channels.length > 512) return 'A fixture type has at most 512 channels.';
  for (const row of groupRows(channels)) {
    const ch = channels[row.index];
    if (row.job === 'cct') {
      const k = ch.kelvin;
      // Text that is not a whole number (the editor keeps what was typed) counts as not typed yet.
      if (!k || k.min == null || k.max == null || typeof k.min === 'string' || typeof k.max === 'string') return `Channel ${row.first}: type the warm end and the cool end in K.`;
      if (!inKelvinRange(k.min) || !inKelvinRange(k.max)) return `Channel ${row.first}: colour temperatures are whole numbers from 1000 to 20000 K.`;
      if (k.min >= k.max) return `Channel ${row.first}: the warm end must be below the cool end.`;
    } else if (FIXED.has(row.job)) {
      // No value is 0, as the engine has it; a value that is there must be right.
      if (ch.default !== undefined && (!isWhole(ch.default) || ch.default < 0 || ch.default > 255)) return `Channel ${row.first}: a value is a whole number from 0 to 255.`;
    }
  }
  return null;
}

// ---- Edits: each returns a new list. A rowIndex counts rows (a 16-bit channel is one), not channels. ----

/** The channels a row owns: its channel and its fine byte. */
const rowChannels = (channels, row) => channels.slice(row.index, row.last);

export function addChannel(channels, job) {
  return [...clone(channels), starting(job)];
}

export function setJob(channels, rowIndex, job) {
  const row = groupRows(channels)[rowIndex];
  if (!row || row.job === job) return clone(channels);
  const old = channels[row.index];
  const next = starting(job);
  // A name that only repeated the old job ("Red" on a red channel) is not worth keeping on another job.
  const echoes = (name) => name.toLowerCase() === labelOf(old.role).toLowerCase();
  if (old.name !== undefined && !echoes(old.name)) next.name = old.name;
  if (job === 'cct' && old.kelvin) next.kelvin = clone(old.kelvin);
  if (FIXED.has(job) && FIXED.has(old.role) && old.default !== undefined) next.default = old.default;
  const replacement = [next];
  if (row.sixteenBit && TAKES_LEVEL.has(job)) {
    const fine = { ...clone(channels[row.index + 1]), role: job };
    if (fine.name !== undefined && echoes(fine.name)) delete fine.name;
    replacement.push(fine);
  }
  return [...clone(channels.slice(0, row.index)), ...replacement, ...clone(channels.slice(row.last))];
}

export function setSixteenBit(channels, rowIndex, on) {
  const row = groupRows(channels)[rowIndex];
  const out = clone(channels);
  if (!row || !TAKES_LEVEL.has(row.job)) return out;
  if (on && !row.sixteenBit) out.splice(row.index + 1, 0, { role: row.job, fine: true });
  else if (!on && row.sixteenBit) out.splice(row.index + 1, 1);
  return out;
}

export function setKelvin(channels, rowIndex, kelvin) {
  const row = groupRows(channels)[rowIndex];
  const out = clone(channels);
  if (row && row.job === 'cct') out[row.index].kelvin = { min: kelvin.min, max: kelvin.max };
  return out;
}

export function setValue(channels, rowIndex, value) {
  const row = groupRows(channels)[rowIndex];
  const out = clone(channels);
  if (row && FIXED.has(row.job)) {
    if (value === undefined) delete out[row.index].default;
    else out[row.index].default = value;
  }
  return out;
}

export function moveRow(channels, rowIndex, direction) {
  const rows = groupRows(channels);
  const to = rowIndex + direction;
  if (!rows[rowIndex] || !rows[to]) return clone(channels);
  const groups = rows.map((row) => rowChannels(channels, row));
  [groups[rowIndex], groups[to]] = [groups[to], groups[rowIndex]];
  return clone(groups.flat());
}

export function removeRow(channels, rowIndex) {
  const row = groupRows(channels)[rowIndex];
  if (!row) return clone(channels);
  return clone([...channels.slice(0, row.index), ...channels.slice(row.last)]);
}

/**
 * Add another segment: a copy of the last one (names and values too) right after it, before any channels that belong
 * to the whole light. A type with one segment copies its colour channels. With no colour channels nothing changes.
 */
export function repeatLastSegment(channels) {
  const rows = groupRows(channels);
  const { count, ranges } = segmentsOf(channels, rows);
  const last = ranges[count];
  if (!last) return clone(channels);
  return clone([
    ...channels.slice(0, last.hi + 1),
    ...channels.slice(last.lo, last.hi + 1),
    ...channels.slice(last.hi + 1),
  ]);
}

// ---- Types as a whole ----

/** A short id from a name: lower case letters and digits with "-" between, made unique among the ids taken. */
export function newTypeId(name, takenIds) {
  const slug = String(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'type';
  let id = slug;
  for (let n = 2; takenIds.has(id); n++) id = `${slug}-${n}`;
  return id;
}

/** A copy to edit: everything the type has (channels as they are, gamma ...), a new id and name, and no library source. */
export function copyOf(profile, takenIds) {
  const { id: _id, name: _name, source: _source, ...rest } = clone(profile);
  const name = `Copy of ${profile.name}`;
  return { ...rest, id: newTypeId(name, takenIds), name };
}

/** Library types (from the fixture library or a fixture file) and the built-in ones can't be changed; copy them. */
export function isReadOnly(profile, builtInIds) {
  return Boolean(profile.source && profile.source.ofl) || builtInIds.has(profile.id);
}
