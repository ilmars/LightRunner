// Patch page: fixtures, groups and the stage plan. Edits a copy of the show
// and saves it whole; the server checks it and keeps a backup of the old one.

import {
  aimBeam, alignFixtures, moveTogether, placeRow, resizeEnd, resizeOutline, resizeThickness, setBarAngle, setShape, shapeOf, spaceEvenly, touches, turnBar,
} from './plan.js';
import {
  JOBS, addChannel, channelRows, compareRows, copyOf, isReadOnly, moveRow, newTypeId, removeRow, repeatLastSegment, segmentCount,
  setJob, setKelvin, setSixteenBit, setValue, summary, validateType,
} from './types.js';
import { PLAN_ASPECT, barAxis, beamCone } from '../shared/stage.js';
import { request, startClock, watchState } from '../shared/appbar.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let show = null; // working copy
let savedJson = ''; // the show as last saved
let profiles = []; // [{ id, name, channels (a count), segments, roles, defs (the channels), readOnly }]
const profileById = new Map();
let builtInIds = new Set(); // the built-in types' ids: read-only, like the Open Fixture Library's

async function call(method, path, body) {
  const res = await request(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') showLogin();
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// ---- Login ----

async function start() {
  const session = await call('GET', '/api/session');
  if (!session.loggedIn) return showLogin();
  await load();
}

function showLogin() {
  $('main').hidden = true;
  $('saveBar').hidden = true;
  $('login').hidden = false;
  $('pin').focus();
}

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await call('POST', '/api/login', { pin: $('pin').value });
    $('pin').value = '';
    $('login').hidden = true;
    await load();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});

async function load() {
  const [loaded, profs] = await Promise.all([call('GET', '/api/show'), call('GET', '/api/profiles')]);
  show = loaded;
  savedJson = JSON.stringify(show);
  profiles = profs;
  profileById.clear();
  for (const p of profiles) profileById.set(p.id, p);
  builtInIds = new Set(profs.filter((p) => p.builtIn).map((p) => p.id));
  closeTypeSheet();
  closeEditor();
  $('main').hidden = false;
  fillAddForm(true);
  renderAll();
  loadOflBrowse();
}

/** Manufacturer list and where the library comes from (downloaded or online). */
async function loadOflBrowse() {
  try {
    const st = await call('GET', '/api/ofl/db');
    $('oflSource').textContent = st.installed
      ? `Downloaded: ${st.fixtures} fixtures, works without internet.`
      : 'Online. Download the database in Settings to use it without internet.';
  } catch {
    $('oflSource').textContent = '';
  }
  try {
    const list = await call('GET', '/api/ofl/manufacturers');
    const sel = $('oflBrowse');
    sel.replaceChildren(new Option('Browse by manufacturer…', ''));
    for (const m of list) sel.append(new Option(`${m.name} (${m.count})`, m.key));
    sel.hidden = false;
  } catch {
    $('oflBrowse').hidden = true;
  }
}

// ---- Helpers ----

const footprint = (f) => profileById.get(f.profile)?.channels ?? 1;

/** Segments in a fixture type: the most times any colour repeats (a bar of 8 pixels has 8). Same rule as the engine. */
function segmentsOf(f) {
  const channels = (show.profiles.find((p) => p.id === f.profile) ?? profileById.get(f.profile))?.channels;
  return Array.isArray(channels) ? segmentsOfChannels(channels) : 1; // a built-in summary has only a channel count: one segment
}
/** The same rule on a channel list. */
function segmentsOfChannels(channels) {
  const seen = new Map();
  for (const c of channels) if (!c.fine && COLOUR_ROLES.includes(c.role)) seen.set(c.role, (seen.get(c.role) ?? 0) + 1);
  return Math.max(1, ...seen.values());
}
const COLOUR_ROLES = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
const groupsOf = (fid) => show.groups.filter((g) => g.fixtures.includes(fid));

function slug(text) {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function uniqueId(base, taken) {
  let id = slug(base), n = 2;
  while (taken.has(id)) id = `${slug(base)}-${n++}`;
  return id;
}

/** Fixture id → problem text, for overlaps and addresses past 512. */
function addressProblems() {
  const problems = new Map();
  const used = new Map();
  for (const f of show.fixtures) {
    const n = footprint(f);
    if (f.address + n - 1 > 512) problems.set(f.id, `runs past channel 512`);
    for (let ch = f.address; ch < f.address + n && ch <= 512; ch++) {
      const key = `${f.universe}:${ch}`;
      const other = used.get(key);
      if (other && other !== f.id) {
        const o = show.fixtures.find((x) => x.id === other);
        problems.set(f.id, `overlaps ${o?.name ?? other} at ${ch}`);
        if (!problems.has(other)) problems.set(other, `overlaps ${f.name} at ${ch}`);
        break;
      }
      used.set(key, f.id);
    }
  }
  return problems;
}

/** Address for `n` new channels: after the last patched fixture if they fit, else the first gap. */
function nextFree(universe, n) {
  const taken = new Uint8Array(513);
  let end = 0;
  for (const f of show.fixtures) {
    if (f.universe !== universe) continue;
    for (let ch = f.address; ch < f.address + footprint(f) && ch <= 512; ch++) taken[ch] = 1;
    end = Math.max(end, f.address + footprint(f) - 1);
  }
  if (end + n <= 512) return end + 1;
  for (let a = 1; a + n - 1 <= 512; a++) {
    let free = true;
    for (let ch = a; ch < a + n; ch++) if (taken[ch]) { free = false; break; }
    if (free) return a;
  }
  return null;
}

function changed() {
  renderAll();
}

// ---- Rendering ----

function renderAll() {
  renderMap();
  renderLibrary();
  renderFixtures();
  renderGroups();
  renderStage();
  updateAddHint();
  refreshTypeSheet();
  if (editor) { renderTicks(); refreshEditor(); }
  const dirty = JSON.stringify(show) !== savedJson;
  $('saveBar').hidden = !dirty;
}

function renderFixtures() {
  const problems = addressProblems();
  $('fixtureCount').textContent = `(${show.fixtures.length})`;
  $('overlapSummary').textContent = problems.size ? `${problems.size} fixtures have address problems` : '';
  const savedIds = new Set(JSON.parse(savedJson).fixtures.map((f) => f.id));
  const body = $('fixtureRows');
  body.replaceChildren();
  for (const f of show.fixtures) {
    const tr = el('tr', [problems.has(f.id) ? 'bad' : '', f.id === selectedId ? 'sel' : ''].join(' ').trim() || null);
    tr.dataset.id = f.id;
    tr.addEventListener('pointerdown', () => { if (selectedId !== f.id) selectFixture(f.id, false); });

    const name = el('input', 'ds-field');
    name.type = 'text';
    name.value = f.name;
    name.addEventListener('change', () => { f.name = name.value.trim() || f.name; changed(); });

    const type = el('select', 'ds-field');
    for (const p of profiles) type.append(new Option(`${p.name}`, p.id));
    type.value = f.profile;
    type.addEventListener('change', () => { f.profile = type.value; changed(); });
    const typeCell = el('div', 'type-cell');
    const seeChannels = el('button', 'ds-btn ds-btn--quiet type-open', '›');
    seeChannels.type = 'button';
    seeChannels.title = "See this type's channels";
    seeChannels.setAttribute('aria-label', `Channels of ${f.name}'s type`);
    seeChannels.addEventListener('click', () => openTypeSheet(f.profile));
    typeCell.append(type, seeChannels);

    const uni = el('input', 'ds-field');
    uni.type = 'number'; uni.min = '0'; uni.max = '32767'; uni.value = String(f.universe);
    uni.addEventListener('change', () => { f.universe = clampInt(uni.value, 0, 32767, f.universe); changed(); });

    const addr = el('input', 'ds-field');
    addr.type = 'number'; addr.min = '1'; addr.max = '512'; addr.value = String(f.address);
    addr.addEventListener('change', () => { f.address = clampInt(addr.value, 1, 512, f.address); changed(); });

    const n = footprint(f);
    const range = el('div', 'range', problems.get(f.id) ?? `${f.address}–${f.address + n - 1} (${n} ch)`);
    const segs = segmentsOf(f);
    range.append(el('div', 'segments', segs === 1 ? '1 segment' : `${segs} segments`));

    // Hung the other way round: its first segment is at the other end of the bar.
    const rev = el('label', 'ds-switch');
    const revInput = el('input');
    revInput.type = 'checkbox';
    revInput.checked = !!f.reversed;
    revInput.setAttribute('aria-label', `${f.name} reversed`);
    revInput.addEventListener('change', () => {
      if (revInput.checked) f.reversed = true;
      else delete f.reversed;
      changed();
    });
    rev.append(revInput, el('span', 'ds-switch-track'));

    const chips = el('div', 'chips');
    for (const g of groupsOf(f.id)) chips.append(el('span', 'chip', g.name));

    const actions = el('div', 'actions');
    const identify = el('button', 'ds-btn ds-btn--quiet', 'Identify');
    identify.type = 'button';
    identify.disabled = !savedIds.has(f.id);
    identify.title = identify.disabled ? 'Save the patch first' : 'Flash this fixture white for 3 seconds';
    identify.addEventListener('click', async () => {
      try {
        await call('POST', '/api/identify', { fixture: f.id });
        toast(`${f.name} is flashing white`);
      } catch (err) {
        toast(err.message, true);
      }
    });
    const del = el('button', 'ds-btn ds-btn--quiet del', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => {
      const inGroups = groupsOf(f.id).map((g) => g.name);
      const msg = inGroups.length ? `Delete ${f.name}? It is also removed from ${inGroups.join(', ')}.` : `Delete ${f.name}?`;
      if (!confirm(msg)) return;
      show.fixtures = show.fixtures.filter((x) => x !== f);
      for (const g of show.groups) g.fixtures = g.fixtures.filter((id) => id !== f.id);
      changed();
    });
    actions.append(identify, del);

    for (const c of [name, typeCell, uni, addr, range, rev, chips, actions]) {
      const td = el('td');
      if (c === uni || c === addr) td.className = 'num';
      td.append(c);
      tr.append(td);
    }
    body.append(tr);
  }
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// ---- Adding fixtures ----

// Two forms add fixtures: "Add fixtures" under the table, and "Add fixtures here" on the stage plan.
// Their fields share names after the prefix: addProfile and planAddProfile, and so on.
const ADD_FORMS = ['add', 'planAdd'];

function fillAddForm(first) {
  for (const form of ADD_FORMS) {
    const sel = $(`${form}Profile`);
    const keep = sel.value;
    sel.replaceChildren();
    for (const p of profiles) sel.append(new Option(`${p.name}`, p.id));
    if (keep) sel.value = keep;
  }
  if (first) {
    // Default to the universe most of the rig is on.
    const counts = new Map();
    for (const f of show.fixtures) counts.set(f.universe, (counts.get(f.universe) ?? 0) + 1);
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
    $('addUniverse').value = String(common);
    suggestAddress();
  }
}

function suggestAddress(form = 'add') {
  const p = profileById.get($(`${form}Profile`).value);
  const n = (p?.channels ?? 1) * Math.max(1, Number($(`${form}Count`).value) || 1);
  const a = nextFree(Number($(`${form}Universe`).value) || 0, n);
  if (a) $(`${form}Address`).value = String(a);
  updateAddHint(form);
}

function updateAddHint(form = 'add') {
  const p = profileById.get($(`${form}Profile`).value);
  if (!p) return;
  const count = Math.max(1, Number($(`${form}Count`).value) || 1);
  const start = Number($(`${form}Address`).value) || 1;
  const end = start + p.channels * count - 1;
  $(`${form}Hint`).textContent = `${count} × ${p.channels} channels: ${start}–${end}${end > 512 ? ' (past 512!)' : ''} on universe ${$(`${form}Universe`).value}.`;
}

for (const form of ADD_FORMS) {
  for (const field of ['Profile', 'Count', 'Universe']) $(`${form}${field}`).addEventListener('change', () => suggestAddress(form));
  $(`${form}Address`).addEventListener('input', () => updateAddHint(form));
  $(`${form}Count`).addEventListener('input', () => updateAddHint(form));
}

/** The fields of an add form, checked; null when the type or name is missing. */
function addFormValues(form) {
  const p = profileById.get($(`${form}Profile`).value);
  const prefix = $(`${form}Name`).value.trim();
  if (!p || !prefix) return null;
  return {
    p, prefix,
    count: clampInt($(`${form}Count`).value, 1, 64, 1),
    universe: clampInt($(`${form}Universe`).value, 0, 32767, 0),
    start: clampInt($(`${form}Address`).value, 1, 512, 1),
  };
}

$('addForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = addFormValues('add');
  if (!v) return;
  if (addFixtures(v.p, v.prefix, v.count, v.universe, v.start)) {
    toast(`Added ${v.count} ${v.count === 1 ? 'fixture' : 'fixtures'}. Put them in a group and on the stage plan, then save.`);
    suggestAddress();
  }
});

/**
 * Patch `count` fixtures of type `p` from `start`. Returns the first new fixture, or null.
 * With a `spot` on the stage plan they go in a row from there; a type with several segments arrives as a bar.
 */
function addFixtures(p, prefix, count, universe, start, spot = null) {
  if (start + p.channels * count - 1 > 512) {
    toast('Those fixtures run past channel 512. Use a lower start address or another universe.', true);
    return null;
  }
  const taken = new Set(show.fixtures.map((f) => f.id));
  // Number new fixtures after any that already use this name ("Bar 3", "Bar 4"...).
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = show.fixtures.map((f) => f.name.match(new RegExp(`^${escaped} (\\d+)$`))).filter(Boolean).map((m) => Number(m[1]));
  const plain = show.fixtures.some((f) => f.name === prefix);
  let n = existing.length ? Math.max(...existing) + 1 : plain ? 2 : 1;
  const shape = (p.segments ?? 1) > 1 ? 'bar' : 'dot';
  const spots = spot ? placeRow(spot, count, shape) : null;
  let first = null;
  for (let k = 0; k < count; k++) {
    const name = count === 1 && !existing.length && !plain ? prefix : `${prefix} ${n++}`;
    const id = uniqueId(name, taken);
    taken.add(id);
    const f = {
      id, name, profile: p.id, universe, address: start + k * p.channels,
      x: spots ? spots[k].x : count === 1 ? 0.5 : Math.round((0.1 + (0.8 * k) / (count - 1)) * 1000) / 1000,
      y: spots ? spots[k].y : 0.5,
    };
    if (shape === 'bar') setShape(f, 'bar');
    show.fixtures.push(f);
    first ??= f;
  }
  selectedId = first.id;
  viewUniverse = universe;
  changed();
  return first;
}

// ---- Graphical patch: the universe map ----

/** Channels to a row of the map: 32, or 16 when the map is narrow (a phone). */
let COLS = 32;
let selectedId = null;
let viewUniverse = null;

/** One colour per fixture type, so fixtures of the same kind look alike (as in Lightkey). */
function typeColour(profileId, alt = false) {
  let h = 7;
  for (const c of profileId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 48% ${alt ? 28 : 38}%)`;
}

const shortName = (f) => {
  const first = f.name.split(' ')[0];
  return /^[A-Za-z]{1,3}\d{1,3}$/.test(first) ? first : f.name;
};

function universeList() {
  const set = new Set(show.fixtures.map((f) => f.universe));
  if (viewUniverse !== null) set.add(viewUniverse);
  if (!set.size) set.add(1);
  return [...set].sort((a, b) => a - b);
}

/** Select a fixture in the table, the DMX map and the stage plan; `several` selects more on the plan (Shift or a box). */
function selectFixture(id, scroll, several = null) {
  selectedId = id;
  planSelection = several ?? new Set(id ? [id] : []);
  const f = show.fixtures.find((x) => x.id === id);
  if (f) viewUniverse = f.universe;
  if (id) planSpot = null;
  renderMap();
  renderStage();
  for (const tr of $('fixtureRows').children) tr.classList.toggle('sel', tr.dataset.id === id);
  if (scroll) document.querySelector(`#fixtureRows tr[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** DMX channel under a pointer position, or null when outside the map. */
function channelAt(x, y) {
  const r = $('dmxMap').getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  const col = Math.min(COLS - 1, Math.floor(((x - r.left) / r.width) * COLS));
  const row = Math.min(512 / COLS - 1, Math.floor(((y - r.top) / r.height) * (512 / COLS)));
  return row * COLS + col + 1;
}

function renderMap() {
  const universes = universeList();
  if (viewUniverse === null || !universes.includes(viewUniverse)) viewUniverse = universes[0];
  const tabs = $('universeTabs');
  tabs.replaceChildren();
  for (const u of universes) {
    const used = show.fixtures.filter((f) => f.universe === u).reduce((n, f) => n + footprint(f), 0);
    const b = el('button', u === viewUniverse ? 'utab on' : 'utab', `Universe ${u}`);
    b.title = `${used} of 512 channels used`;
    b.addEventListener('click', () => { viewUniverse = u; renderMap(); });
    tabs.append(b);
  }
  const more = el('button', 'utab utab-add', '＋');
  more.title = 'Add a universe';
  more.addEventListener('click', () => { viewUniverse = Math.max(...universes) + 1; renderMap(); });
  tabs.append(more);

  const grid = $('dmxMap');
  COLS = mapColumns();
  grid.style.gridTemplateColumns = `repeat(${COLS}, minmax(0, 1fr))`;
  grid.replaceChildren();
  for (let ch = 1; ch <= 512; ch++) {
    const cell = el('div', 'cell', String(ch));
    cell.dataset.ch = String(ch);
    cell.style.gridRow = String(Math.floor((ch - 1) / COLS) + 1);
    cell.style.gridColumn = String(((ch - 1) % COLS) + 1);
    // Tap a free channel to add fixtures there.
    cell.addEventListener('click', () => {
      $('addUniverse').value = String(viewUniverse);
      $('addAddress').value = String(ch);
      updateAddHint();
      $('addForm').scrollIntoView({ block: 'center', behavior: 'smooth' });
      $('addName').focus({ preventScroll: true });
    });
    grid.append(cell);
  }
  const problems = addressProblems();
  let used = 0;
  // Neighbours of the same type alternate shade, so back-to-back bars stay distinguishable.
  const inUniverse = show.fixtures.filter((f) => f.universe === viewUniverse).sort((a, b) => a.address - b.address);
  const alt = new Map();
  inUniverse.forEach((f, k) => {
    const prev = inUniverse[k - 1];
    alt.set(f.id, prev && prev.profile === f.profile ? !alt.get(prev.id) : false);
  });
  for (const f of inUniverse) {
    const n = footprint(f);
    used += n;
    let start = f.address, left = n, first = true;
    while (left > 0 && start <= 512) {
      const col = (start - 1) % COLS;
      const span = Math.min(left, COLS - col);
      const cls = ['block', first ? '' : 'cont', problems.has(f.id) ? 'bad' : '', f.id === selectedId ? 'sel' : ''].filter(Boolean).join(' ');
      const block = el('div', cls);
      block.style.gridRow = String(Math.floor((start - 1) / COLS) + 1);
      block.style.gridColumn = `${col + 1} / span ${span}`;
      block.style.background = typeColour(f.profile, alt.get(f.id));
      if (first) {
        block.append(el('span', null, shortName(f)));
        if (span >= 4) block.append(el('small', null, `${f.address}–${f.address + n - 1}`));
      } else if (span >= 3) {
        block.append(el('small', null, `${shortName(f)} …`));
      }
      block.title = `${f.name}\n${profileById.get(f.profile)?.name ?? f.profile}\nChannels ${f.address}–${f.address + n - 1}${problems.has(f.id) ? `\n${problems.get(f.id)}` : ''}`;
      block.addEventListener('pointerdown', (ev) => startBlockDrag(ev, f));
      grid.append(block);
      start += span;
      left -= span;
      first = false;
    }
  }
  $('mapInfo').textContent = `Universe ${viewUniverse}: ${used} of 512 channels used. Drag a fixture to move it; tap a free channel to add fixtures there.`;
}

function mapColumns() {
  const w = $('dmxMap').clientWidth;
  return w && w < 560 ? 16 : 32;
}
// Draw the map again when it gets narrow or wide enough to change its rows.
window.addEventListener('resize', () => { if (show && !$('main').hidden && mapColumns() !== COLS) renderMap(); });

/** Drag a fixture block to a new start address. A tap without moving just selects it. */
function startBlockDrag(ev, f) {
  ev.preventDefault();
  ev.stopPropagation();
  const grab = (channelAt(ev.clientX, ev.clientY) ?? f.address) - f.address;
  const n = footprint(f);
  const startAddress = f.address;
  let moved = false;
  selectFixture(f.id, true);
  const move = (e) => {
    const ch = channelAt(e.clientX, e.clientY);
    if (ch === null) return;
    const next = Math.min(512 - n + 1, Math.max(1, ch - grab));
    if (next !== f.address) {
      f.address = next;
      moved = true;
      renderMap();
      for (const b of document.querySelectorAll('.block.sel')) b.classList.add('dragging');
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (moved && f.address !== startAddress) changed();
    else renderMap();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// ---- Fixture library ----

// The type's name without its mode in brackets, even one with brackets of its own ("AS600B (CCT (8 Bit))").
const typeLabel = (p) => p.name.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '');

function renderLibrary() {
  const q = $('libSearch').value.trim().toLowerCase();
  const list = $('libList');
  list.replaceChildren();
  for (const p of profiles) {
    if (q && !p.name.toLowerCase().includes(q)) continue;
    const item = el('div', $('addProfile').value === p.id ? 'lib-item picked' : 'lib-item');
    const swatch = el('i');
    swatch.style.background = typeColour(p.id);
    item.append(swatch, el('span', null, typeLabel(p)), el('small', null, `${p.channels} ch`));
    item.title = p.name;
    item.addEventListener('pointerdown', (ev) => startLibraryDrag(ev, p, item));
    list.append(item);
  }
  // The picked type (the one "Add fixtures" has) can show its channels.
  const picked = profileById.get($('addProfile').value);
  $('libPickedName').textContent = picked ? typeLabel(picked) : '';
  $('libChannels').disabled = !picked;
}
$('libSearch').addEventListener('input', renderLibrary);
$('libChannels').addEventListener('click', () => openTypeSheet($('addProfile').value));

/** Drag a fixture type from the library onto the map to patch one there. */
function startLibraryDrag(ev, p, item) {
  ev.preventDefault();
  const ghost = el('div', 'drag-ghost', `${typeLabel(p)} · ${p.channels} ch`);
  ghost.style.background = typeColour(p.id);
  let dragging = false;
  const x0 = ev.clientX, y0 = ev.clientY;
  let target = null;
  const clearDrop = () => { for (const c of document.querySelectorAll('.cell.drop, .cell.drop-bad')) c.classList.remove('drop', 'drop-bad'); };
  const move = (e) => {
    if (!dragging && Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
    if (!dragging) { dragging = true; document.body.append(ghost); }
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
    clearDrop();
    target = channelAt(e.clientX, e.clientY);
    if (target === null) return;
    // Show where it would land, red where it would overlap or run past 512.
    const busy = new Set();
    for (const f of show.fixtures) if (f.universe === viewUniverse) for (let c = f.address; c < f.address + footprint(f); c++) busy.add(c);
    const bad = target + p.channels - 1 > 512 || [...Array(p.channels).keys()].some((k) => busy.has(target + k));
    for (let k = 0; k < p.channels && target + k <= 512; k++) {
      document.querySelector(`.cell[data-ch="${target + k}"]`)?.classList.add(bad ? 'drop-bad' : 'drop');
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    ghost.remove();
    clearDrop();
    if (!dragging) {
      // A tap picks the type for "Add fixtures".
      $('addProfile').value = p.id;
      if (!$('addName').value) $('addName').value = typeLabel(p);
      suggestAddress();
      renderLibrary();
      return;
    }
    if (target === null) return;
    const f = addFixtures(p, typeLabel(p), 1, viewUniverse, target);
    if (f) {
      toast(`Patched ${f.name} at ${f.address}. Rename it in the table, add it to a group, then save.`);
      const input = document.querySelector(`#fixtureRows tr[data-id="${CSS.escape(f.id)}"] input`);
      input?.focus({ preventScroll: true });
      input?.select();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// ---- A fixture type's channels, and two types side by side ----

/** What the sheet shows: the type, and whether it is being compared with `withId`. Null while the sheet is closed. */
let typeView = null; // { id, comparing, withId }

function openTypeSheet(id) {
  if (!profileById.has(id)) return;
  typeView = { id, comparing: false, withId: null };
  renderTypeSheet();
  const sheet = $('typeSheet');
  sheet.scrollIntoView({ block: 'start', behavior: 'smooth' });
  sheet.focus({ preventScroll: true });
}

function closeTypeSheet() {
  typeView = null;
  $('typeSheet').hidden = true;
}

/** One channel row in words: "Colour temperature 3200–5600 K, 16-bit", "Fixed value 255". */
function rowText(row) {
  let text = row.label;
  if (row.kelvin) text += ` ${row.kelvin.min}–${row.kelvin.max} K`;
  if (row.value !== undefined) text += ` ${row.value}`;
  if (row.sixteenBit) text += ', 16-bit';
  return text;
}

/** A channel's own name from the light's manual, unless it only says the job again ("Red" on a red channel). */
const ownName = (row) => (row.name && row.name.toLowerCase() !== row.label.toLowerCase() ? row.name : '');

function renderTypeSheet() {
  const p = typeView && profileById.get(typeView.id);
  if (!p) return closeTypeSheet();
  $('typeSheet').hidden = false;
  $('typeName').textContent = p.name;
  refreshTypeSheet();

  // Compare with…: pick the second type, then the two lists run side by side.
  const other = typeView.comparing && typeView.withId ? profileById.get(typeView.withId) : null;
  $('typeCompare').textContent = typeView.comparing ? 'Stop comparing' : 'Compare with…';
  $('typeCompareBar').hidden = !typeView.comparing;
  if (typeView.comparing) {
    const pick = $('typeCompareWith');
    pick.replaceChildren(new Option('Choose a type…', ''));
    for (const q of profiles) if (q.id !== p.id) pick.append(new Option(q.name, q.id));
    pick.value = other ? other.id : '';
  }
  const body = $('typeBody');
  if (other) {
    const rows = compareRows(p.defs, other.defs);
    const differing = rows.filter((r) => !r.same).length;
    $('typeCompareNote').textContent = differing
      ? `${differing} of ${rows.length} channels differ. They are tinted.`
      : 'These two types have the same channels.';
    body.replaceChildren(compareTable(p, other, rows));
  } else {
    $('typeCompareNote').textContent = typeView.comparing ? 'Pick the type to put beside this one.' : '';
    body.replaceChildren(channelTable(p));
  }
}

/**
 * The parts of the open view that follow the rest of the page: the summary and the "Used by" note. renderAll() calls
 * this on every change. It never touches the rows or the compare menu, so what is being typed there keeps its focus.
 */
function refreshTypeSheet() {
  const p = typeView && profileById.get(typeView.id);
  if (!p) return;
  $('typeSummary').textContent = summary(p.defs);
  $('typeEdit').hidden = p.readOnly; // library and built-in types: Copy and edit only
  const users = show.fixtures.filter((f) => f.profile === p.id).length;
  const note = [users ? `Used by ${users} ${users === 1 ? 'fixture' : 'fixtures'}.` : 'No fixture uses this type.'];
  if (p.readOnly) {
    const own = show.profiles.find((x) => x.id === p.id);
    if (own?.source?.ofl || !builtInIds.has(p.id)) note.push("From the Open Fixture Library or a fixture file, so it can't be changed.");
    else if (own) note.push("Shares its name with a built-in type, so it can't be changed here. Copy and edit makes your own.");
    else note.push("A built-in type, so it can't be changed.");
  }
  $('typeNote').textContent = note.join(' ');
}

/** A table with a header row of these titles. */
function tableWith(cls, titles) {
  const table = el('table', cls);
  const head = el('tr');
  for (const text of titles) head.append(el('th', null, text));
  table.append(el('thead'));
  table.firstChild.append(head);
  return table;
}

/** The channels in order: number, what each does, and its own name when it has one. Several segments get headings. */
function channelTable(p) {
  const rows = channelRows(p.defs);
  const withNames = rows.some((r) => ownName(r));
  const table = tableWith('type-table', withNames ? ['Channel', 'Does', 'Name'] : ['Channel', 'Does']);
  const bodyEl = el('tbody');
  const several = segmentCount(p.defs) > 1;
  let run; // the segment of the rows being listed; a heading starts each run
  rows.forEach((row, k) => {
    if (several && (k === 0 || row.segment !== run)) {
      const th = el('th', 'seg-head', row.segment === null ? 'Whole light' : `Segment ${row.segment}`);
      th.colSpan = withNames ? 3 : 2;
      th.scope = 'colgroup';
      const headRow = el('tr', 'seg-row');
      headRow.append(th);
      bodyEl.append(headRow);
    }
    run = row.segment;
    const tr = el('tr');
    tr.append(el('td', 'num', row.last > row.first ? `${row.first}–${row.last}` : String(row.first)), el('td', null, rowText(row)));
    if (withNames) tr.append(el('td', 'muted', ownName(row)));
    bodyEl.append(tr);
  });
  table.append(bodyEl);
  return table;
}

/** Two types channel by channel; a row where they differ (or only one has the channel) is tinted. */
function compareTable(a, b, rows) {
  const table = tableWith('type-table type-compare', ['Channel', a.name, b.name]);
  const bodyEl = el('tbody');
  for (const r of rows) {
    const tr = el('tr', r.same ? null : 'differs');
    const n = el('td', 'num', String(r.n));
    if (!r.same) n.append(el('span', 'sr-only', ' (differs)'));
    tr.append(n, el('td', r.left === null ? 'muted' : null, r.left ?? '—'), el('td', r.right === null ? 'muted' : null, r.right ?? '—'));
    bodyEl.append(tr);
  }
  table.append(bodyEl);
  return table;
}

$('typeClose').addEventListener('click', closeTypeSheet);
$('typeCompare').addEventListener('click', () => {
  if (!typeView) return;
  typeView.comparing = !typeView.comparing;
  if (!typeView.comparing) typeView.withId = null;
  renderTypeSheet();
  if (typeView.comparing) $('typeCompareWith').focus({ preventScroll: true });
});
$('typeCompareWith').addEventListener('change', (ev) => {
  if (!typeView) return;
  typeView.withId = ev.target.value || null;
  renderTypeSheet();
});

// ---- Making, copying and changing your own fixture types ----

/** The jobs that take a level, so can be 16-bit. */
const TAKES_LEVEL = new Set(['dimmer', ...COLOUR_ROLES, 'cct']);

/**
 * The type being made or changed, as a working copy; nothing reaches the show before Save type, and the lights
 * before Save patch. Null while the editor is closed.
 * { id: null for a new type, else the type's id (fixed), name, channels, extra: what else the type has (gamma...),
 *   from: the type a copy came from, ticks: ids of the fixtures ticked to use it, armed: Delete type's timer }
 */
let editor = null;

/** The ids a new type's id must not take: the show's types and the built-in ones. */
const takenTypeIds = () => new Set([...show.profiles.map((p) => p.id), ...builtInIds]);

/** The editor, opened on a draft; the type's own view (if open) gives way to it. */
function openEditor(draft) {
  closeTypeSheet();
  disarmDelete();
  editor = { extra: {}, from: null, ticks: [], armed: 0, ...draft };
  editor.ticks = new Set(editor.ticks);
  const own = editor.id !== null;
  $('teTitle').textContent = own ? 'Fixture type' : 'New fixture type';
  const source = editor.from && profileById.get(editor.from);
  $('teNote').textContent = own
    ? 'A change here changes every fixture that uses this type.'
    : source ? `Starts as a copy of ${source.name}. The original stays as it is.` : "Name it, then add its channels in the order the light's manual lists them.";
  $('teName').value = editor.name;
  renderEditorRows();
  renderTicks();
  refreshEditor();
  const panel = $('typeEditor');
  panel.hidden = false;
  panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (own) panel.focus({ preventScroll: true });
  else {
    $('teName').focus({ preventScroll: true });
    $('teName').select();
  }
}

function closeEditor() {
  disarmDelete();
  editor = null;
  $('typeEditor').hidden = true;
}

/** A number typed in a field: nothing, or whatever was typed read as a number (NaN when it isn't one; the check says so). */
const typedNumber = (text) => (text.trim() === '' ? undefined : Number(text));
const shownNumber = (n) => (Number.isFinite(n) ? String(n) : '');

/** Replace the channels, and draw the rows again. `focus`: selectors to try for what should keep the focus. */
function editChannels(next, focus = []) {
  editor.channels = next;
  renderEditorRows(focus);
  refreshEditor();
}

/** One input of a row: edits the working copy as it is typed, and leaves the rows alone so it keeps its focus. */
function numberField(label, value, onType, ariaLabel) {
  const wrap = el('label', 'te-num');
  const input = el('input', 'ds-field');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.value = shownNumber(value);
  input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('input', () => { onType(typedNumber(input.value)); refreshEditor(); });
  wrap.append(el('span', null, label), input);
  return wrap;
}

function editorRow(row, k, count) {
  const div = el('div', 'te-row');
  div.dataset.row = String(k);
  const at = (part) => `[data-row="${k}"] ${part}`;
  const channel = row.last > row.first ? `${row.first}–${row.last}` : String(row.first);

  const job = el('select', 'ds-field te-job');
  job.setAttribute('aria-label', `Channel ${channel}: what it does`);
  for (const j of JOBS) job.append(new Option(j.label, j.job));
  job.value = row.job;
  job.addEventListener('change', () => editChannels(setJob(editor.channels, k, job.value), [at('.te-job')]));

  div.append(el('span', 'te-n', channel), job);

  // 16-bit: the channel takes the next one as its fine byte.
  if (TAKES_LEVEL.has(row.job)) {
    const sw = el('label', 'ds-switch te-16');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = row.sixteenBit;
    box.setAttribute('aria-label', `Channel ${channel}: 16-bit`);
    box.addEventListener('change', () => editChannels(setSixteenBit(editor.channels, k, box.checked), [at('.te-16 input')]));
    sw.append(box, el('span', 'ds-switch-track'), el('span', null, '16-bit'));
    div.append(sw);
  } else {
    div.append(el('span', 'te-16'));
  }

  const extra = el('div', 'te-extra');
  if (row.job === 'cct') {
    // `row` is the row as drawn: read the other end from the working copy, which keeps changing as it is typed.
    const current = () => channelRows(editor.channels)[k].kelvin ?? {};
    extra.append(
      numberField('Warm end', row.kelvin?.min, (min) => { editor.channels = setKelvin(editor.channels, k, { min, max: current().max }); }, `Channel ${channel}: warm end in K`),
      numberField('Cool end', row.kelvin?.max, (max) => { editor.channels = setKelvin(editor.channels, k, { min: current().min, max }); }, `Channel ${channel}: cool end in K`),
      el('span', 'te-unit', 'K'),
    );
  } else if (row.job === 'strobe' || row.job === 'other') {
    extra.append(numberField('Value', row.value, (value) => { editor.channels = setValue(editor.channels, k, value); }, `Channel ${channel}: value from 0 to 255`));
  }
  // The channel's own name from the light's manual (Lightkey, a fixture file): shown, not edited.
  const own = ownName(row);
  if (own) {
    const name = el('span', 'te-own', own);
    name.title = "This channel's own name, kept as it is";
    extra.append(name);
  }
  div.append(extra);

  const buttons = el('div', 'te-btns');
  const button = (cls, text, label, onClick, disabled = false) => {
    const b = el('button', `ds-btn ds-btn--quiet ${cls}`, text);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  };
  buttons.append(
    button('te-up', '↑', `Move channel ${channel} up`, () => editChannels(moveRow(editor.channels, k, -1), [`[data-row="${k - 1}"] .te-up`, `[data-row="${k - 1}"] .te-down`]), k === 0),
    button('te-down', '↓', `Move channel ${channel} down`, () => editChannels(moveRow(editor.channels, k, 1), [`[data-row="${k + 1}"] .te-down`, `[data-row="${k + 1}"] .te-up`]), k === count - 1),
    button('te-remove', '×', `Remove channel ${channel}`, () => editChannels(removeRow(editor.channels, k))),
  );
  div.append(buttons);
  return div;
}

/** The channel rows, grouped by segment as in the type's view. Only structure changes come here; typing does not. */
function renderEditorRows(focus = []) {
  const rows = channelRows(editor.channels);
  const several = segmentCount(editor.channels) > 1;
  const box = $('teRows');
  box.replaceChildren();
  let run; // the segment of the rows being listed; a heading starts each run
  rows.forEach((row, k) => {
    if (several && (k === 0 || row.segment !== run)) box.append(el('div', 'te-seg', row.segment === null ? 'Whole light' : `Segment ${row.segment}`));
    run = row.segment;
    box.append(editorRow(row, k, rows.length));
  });
  if (!rows.length) box.append(el('p', 'hint', 'No channels yet. Add the first one below.'));
  for (const sel of focus) {
    const target = box.querySelector(sel);
    if (target && !target.disabled) { target.focus({ preventScroll: true }); break; }
  }
}

/** Everything in the editor that follows the working copy, except the rows and the ticks (so typing keeps its focus). */
function refreshEditor() {
  if (!editor) return;
  const { channels } = editor;
  $('teSummary').textContent = summary(channels);
  const colours = channels.some((c) => !c.fine && COLOUR_ROLES.includes(c.role));
  $('teRepeat').hidden = !colours;
  const segments = segmentCount(channels);
  $('teRepeatHint').textContent = colours ? `${segments} ${segments === 1 ? 'segment' : 'segments'} now. Each tap adds one.` : '';
  const users = editor.id ? show.fixtures.filter((f) => f.profile === editor.id).length : 0;
  $('teUsedBy').textContent = editor.id
    ? (users ? `Used by ${users} ${users === 1 ? 'fixture' : 'fixtures'}. They follow every change.` : 'No fixture uses this type yet.')
    : '';
  // Delete only an own type that no fixture uses.
  const canDelete = editor.id !== null && users === 0;
  $('teDelete').hidden = !canDelete;
  if (!canDelete) disarmDelete();
  const problem = validateType(editor.name, channels);
  $('teMessage').textContent = problem ?? '';
  $('teSave').disabled = problem !== null;
}

/** "Use it for": a tick for every fixture in the show. The ones using the type being changed come first, and stay ticked. */
function renderTicks() {
  if (!editor) return;
  const box = $('teTicks');
  const firstId = editor.id ?? editor.from;
  const follows = new Set(editor.id ? show.fixtures.filter((f) => f.profile === editor.id).map((f) => f.id) : []);
  editor.ticks = new Set([...editor.ticks].filter((id) => show.fixtures.some((f) => f.id === id)));
  const ordered = firstId
    ? [...show.fixtures.filter((f) => f.profile === firstId), ...show.fixtures.filter((f) => f.profile !== firstId)]
    : show.fixtures;
  box.replaceChildren();
  if (!ordered.length) box.append(el('p', 'hint', 'There are no fixtures in the show yet.'));
  for (const f of ordered) {
    const locked = follows.has(f.id);
    const input = el('input');
    input.type = 'checkbox';
    input.checked = locked || editor.ticks.has(f.id);
    input.disabled = locked;
    const chip = el('label', 'te-tick');
    chip.classList.toggle('on', input.checked);
    chip.classList.toggle('locked', locked);
    input.addEventListener('change', () => {
      if (input.checked) editor.ticks.add(f.id);
      else editor.ticks.delete(f.id);
      chip.classList.toggle('on', input.checked);
    });
    chip.append(input, el('span', 'te-tick-mark', '✓'), el('span', null, f.name));
    const type = profileById.get(f.profile);
    if (type && !locked) chip.append(el('small', null, typeLabel(type)));
    if (locked) chip.title = 'Uses this type already';
    box.append(chip);
  }
}

/** Save type: the type goes in the working show, the ticked fixtures switch to it, and the page follows. */
function saveEditorType() {
  if (!editor || validateType(editor.name, editor.channels) !== null) return;
  const name = editor.name.trim();
  const id = editor.id ?? newTypeId(name, takenTypeIds()); // fixed from here on; a rename changes only the name
  const wasNew = editor.id === null;
  putProfile({ ...editor.extra, id, name, channels: structuredClone(editor.channels) });
  for (const f of show.fixtures) if (editor.ticks.has(f.id)) f.profile = id;
  fillAddForm(false);
  if (wasNew) $('addProfile').value = id;
  suggestAddress();
  closeEditor();
  changed();
  toast(`${name} is saved in the patch. Save patch to keep it.`);
  openTypeSheet(id);
}

/** Delete type: first tap asks again, the second removes it. It asks again after a few seconds. */
function disarmDelete() {
  if (!editor?.armed) return;
  clearTimeout(editor.armed);
  editor.armed = 0;
  $('teDelete').textContent = 'Delete type';
}

function deleteEditorType() {
  if (!editor || editor.id === null || show.fixtures.some((f) => f.profile === editor.id)) return;
  if (!editor.armed) {
    editor.armed = setTimeout(disarmDelete, 4000);
    $('teDelete').textContent = 'Tap again to delete';
    return;
  }
  const { id } = editor;
  const name = profileById.get(id)?.name ?? id;
  show.profiles = show.profiles.filter((p) => p.id !== id);
  profiles = profiles.filter((p) => p.id !== id);
  profileById.delete(id);
  fillAddForm(false);
  for (const form of ADD_FORMS) {
    const sel = $(`${form}Profile`);
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  }
  suggestAddress();
  closeEditor();
  changed();
  toast(`${name} is deleted from the patch.`);
}

/** A draft that starts as a copy of a type, for Copy and edit. */
function copyDraft(p) {
  const own = show.profiles.find((x) => x.id === p.id); // the whole type (gamma...) when the show has it
  const copy = copyOf(own ?? { id: p.id, name: p.name, channels: p.defs }, takenTypeIds());
  const { id: _id, name, channels, ...extra } = copy;
  return { id: null, name, channels, extra, from: p.id };
}

$('libNew').addEventListener('click', () => openEditor({ id: null, name: '', channels: [] }));
$('typeCopy').addEventListener('click', () => {
  const p = typeView && profileById.get(typeView.id);
  if (p) openEditor(copyDraft(p));
});
$('typeEdit').addEventListener('click', () => {
  const p = typeView && profileById.get(typeView.id);
  const own = p && !p.readOnly && show.profiles.find((x) => x.id === p.id);
  if (!own) return;
  const { id, name, channels, ...extra } = structuredClone(own);
  openEditor({ id, name, channels, extra });
});

$('teName').addEventListener('input', () => {
  if (!editor) return;
  editor.name = $('teName').value;
  refreshEditor();
});
$('teAdd').replaceChildren(new Option('＋ Add channel…', ''), ...JOBS.map((j) => new Option(j.label, j.job)));
$('teAdd').addEventListener('change', () => {
  const job = $('teAdd').value;
  $('teAdd').value = '';
  if (editor && job) editChannels(addChannel(editor.channels, job));
});
$('teRepeat').addEventListener('click', () => { if (editor) editChannels(repeatLastSegment(editor.channels)); });
$('teSave').addEventListener('click', saveEditorType);
$('teDelete').addEventListener('click', deleteEditorType);
$('teCancel').addEventListener('click', closeEditor);

// ---- Open Fixture Library ----

let oflSearchToken = 0;

$('oflForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = $('oflQuery').value.trim();
  const box = $('oflResults');
  if (q.length < 2) return;
  const token = ++oflSearchToken;
  box.replaceChildren(el('p', 'hint', 'Searching…'));
  try {
    const { hits, offline } = await call('GET', `/api/ofl/search?q=${encodeURIComponent(q)}`);
    if (token !== oflSearchToken) return;
    $('oflBrowse').value = '';
    showHits(hits, offline ? 'No internet: showing fixtures downloaded before.' : null, 'Nothing found. Try the model name without the brand, e.g. "SixBar".');
  } catch (err) {
    box.replaceChildren(el('p', 'warn', err.message));
  }
});

let lastHits = null;
function showHits(hits, note, empty) {
  lastHits = { hits, note, empty };
  const box = $('oflResults');
  box.replaceChildren();
  if (note) box.append(el('p', 'warn', note));
  if (!hits.length) box.append(el('p', 'hint', empty));
  for (const h of hits) {
    const b = el('button', 'ofl-hit');
    b.type = 'button';
    b.append(el('span', null, h.name), el('small', null, [h.manufacturer, ...(h.categories ?? []).slice(0, 2)].join(' · ')));
    b.addEventListener('click', () => showOflModes(() => call('GET', `/api/ofl/fixture?key=${encodeURIComponent(h.key)}`), (mode) => call('POST', '/api/ofl/profile', { key: h.key, mode })));
    box.append(b);
  }
}

$('oflBrowse').addEventListener('change', async () => {
  const man = $('oflBrowse').value;
  if (!man) return;
  $('oflResults').replaceChildren(el('p', 'hint', 'Loading…'));
  try {
    showHits(await call('GET', `/api/ofl/manufacturer?key=${encodeURIComponent(man)}`), null, 'No fixtures.');
  } catch (err) {
    $('oflResults').replaceChildren(el('p', 'warn', err.message));
  }
});

/** Show a fixture's modes; picking one adds it to the library as a fixture type. */
async function showOflModes(loadInfo, makeProfile) {
  const box = $('oflResults');
  box.replaceChildren(el('p', 'hint', 'Loading modes…'));
  try {
    const info = await loadInfo();
    const wrap = el('div', 'ofl-modes');
    const back = el('button', 'ds-btn ds-btn--quiet back-link', '‹ Back to results');
    back.type = 'button';
    back.addEventListener('click', () => (lastHits ? showHits(lastHits.hits, lastHits.note, lastHits.empty) : $('oflForm').requestSubmit()));
    wrap.append(back, el('h4', null, `${info.manufacturer} ${info.name}`.trim()), el('p', 'hint', 'Pick the DMX mode the fixture is set to:'));
    for (const m of info.modes) {
      const b = el('button', 'ofl-mode');
      b.type = 'button';
      b.append(el('span', null, `${m.name} · ${m.channels} ch`), el('br'), el('small', null, m.roles.length ? m.roles.join(', ') : 'no colour or dimmer channels'));
      b.addEventListener('click', async () => {
        try {
          addProfile(await makeProfile(m.index), info.manufacturer);
        } catch (err) {
          toast(err.message, true);
        }
      });
      wrap.append(b);
    }
    box.replaceChildren(wrap);
  } catch (err) {
    box.replaceChildren(el('p', 'warn', err.message));
  }
}

/** What `profiles` keeps of a type in the show: the server's summary of it (GET /api/profiles). */
function profileSummary(profile) {
  return {
    id: profile.id, name: profile.name, channels: profile.channels.length, segments: segmentsOfChannels(profile.channels),
    roles: [...new Set(profile.channels.map((c) => c.role))], defs: profile.channels, readOnly: isReadOnly(profile, builtInIds),
  };
}

/** Put a fixture type in the working show and in the lists (a new one first); returns its summary. */
function putProfile(profile) {
  const k = show.profiles.findIndex((p) => p.id === profile.id);
  if (k >= 0) show.profiles[k] = profile;
  else show.profiles.push(profile);
  const entry = profileSummary(profile);
  const j = profiles.findIndex((p) => p.id === profile.id);
  if (j >= 0) profiles[j] = entry;
  else profiles.unshift(entry);
  profileById.set(profile.id, entry);
  return entry;
}

/** Add (or update) a fixture type in this show; it is stored when the patch is saved. The fixture's suggested name
 * is the type's without its maker. */
function addProfile(profile, manufacturer = '') {
  const entry = putProfile(profile);
  fillAddForm(false);
  $('addProfile').value = profile.id;
  renderTypeSheet();
  const label = typeLabel(entry);
  $('addName').value = manufacturer && label.startsWith(`${manufacturer} `) ? label.slice(manufacturer.length + 1) : label;
  suggestAddress();
  changed();
  toast(`${profile.name} is in the library. Drag it onto the map, then save.`);
}

$('oflFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const fixture = JSON.parse(await file.text());
    const key = file.name.replace(/\.json$/i, '');
    await showOflModes(
      () => call('POST', '/api/ofl/file', { fixture, key }),
      (mode) => call('POST', '/api/ofl/file', { fixture, key, mode }),
    );
  } catch (err) {
    toast(`That file isn't an Open Fixture Library fixture: ${err.message}`, true);
  }
});

// ---- Groups ----

function renderGroups() {
  const root = $('groupList');
  root.replaceChildren();
  for (const g of show.groups) {
    const card = el('div', 'group-card');
    const head = el('div', 'head');
    const name = el('input', 'ds-field');
    name.type = 'text';
    name.value = g.name;
    name.setAttribute('aria-label', 'Group name');
    name.addEventListener('change', () => { g.name = name.value.trim() || g.name; changed(); });
    const presets = show.presets.filter((p) => p.group === g.id).length;
    const del = el('button', 'ds-btn ds-btn--quiet del', 'Delete group');
    del.type = 'button';
    del.addEventListener('click', () => {
      const looks = show.looks.filter((l) => l.groups.some((e) => e.group === g.id)).length;
      if (!confirm(`Delete the group "${g.name}"? Its ${presets} presets go too, and ${looks} looks stop changing it. The fixtures stay patched.`)) return;
      show.groups = show.groups.filter((x) => x !== g);
      show.presets = show.presets.filter((p) => p.group !== g.id);
      for (const l of show.looks) l.groups = l.groups.filter((e) => e.group !== g.id);
      show.operator.groups = show.operator.groups.filter((id) => id !== g.id);
      changed();
    });
    head.append(name, el('span', 'note', `${presets} presets`), del);

    // A smoke or haze machine: only its own slider and Puff on the operator page turn it on.
    const kind = el('div', 'group-kind');
    const sw = el('label', 'ds-switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = g.kind === 'smoke';
    box.addEventListener('change', () => { g.kind = box.checked ? 'smoke' : 'light'; changed(); });
    sw.append(box, el('span', 'ds-switch-track'), el('span', 'switch-label', 'Smoke or haze machine'));
    kind.append(sw);
    if (g.kind === 'smoke') {
      kind.append(el('span', 'note', 'Looks, Basic lights and Flash leave it alone. It runs only from its own slider and Puff, and is off after a restart. Turning this off lets Basic lights and looks drive the machine.'));
    }
    for (const text of smokeWarnings(g)) kind.append(el('p', 'warn', text));

    const members = el('div', 'members');
    g.fixtures.forEach((fid, k) => {
      const f = show.fixtures.find((x) => x.id === fid);
      const chip = el('span', 'member');
      chip.append(el('span', 'pos', String(k + 1)), el('span', null, f?.name ?? fid));
      const left = el('button', null, '‹');
      left.title = 'Move earlier';
      left.disabled = k === 0;
      left.addEventListener('click', () => { [g.fixtures[k - 1], g.fixtures[k]] = [g.fixtures[k], g.fixtures[k - 1]]; changed(); });
      const right = el('button', null, '›');
      right.title = 'Move later';
      right.disabled = k === g.fixtures.length - 1;
      right.addEventListener('click', () => { [g.fixtures[k + 1], g.fixtures[k]] = [g.fixtures[k], g.fixtures[k + 1]]; changed(); });
      const remove = el('button', null, '×');
      remove.title = 'Remove from group';
      remove.addEventListener('click', () => { g.fixtures.splice(k, 1); changed(); });
      chip.append(left, right, remove);
      members.append(chip);
    });
    const add = el('select', 'ds-field member-add');
    add.setAttribute('aria-label', `Add a fixture to ${g.name}`);
    add.append(new Option('＋ Add fixture…', ''));
    for (const f of show.fixtures) if (!g.fixtures.includes(f.id)) add.append(new Option(f.name, f.id));
    add.addEventListener('change', () => { if (add.value) { g.fixtures.push(add.value); changed(); } });
    if (add.options.length > 1) members.append(add);
    if (!g.fixtures.length) members.prepend(el('span', 'note', 'No fixtures yet.'));
    card.append(head, kind, members);
    root.append(card);
  }
}

const SMOKE_NAME = /\b(fog|fogger|haze|hazer|smoke)\b/i;

/**
 * Problems with smoke machines in a group. A smoke group drives a fixture's dimmer channel
 * (or its only channel), so a multi-channel type without one is never driven. A light group
 * holding something that looks like a smoke machine would let Basic lights and looks run it.
 */
function smokeWarnings(g) {
  const out = [];
  for (const fid of g.fixtures) {
    const f = show.fixtures.find((x) => x.id === fid);
    const type = f && profileById.get(f.profile);
    if (!f || !type) continue;
    if (g.kind === 'smoke') {
      if (type.channels > 1 && !type.roles?.includes('dimmer')) {
        out.push(`${f.name}: This fixture type has no dimmer channel, so Light Runner can't run it as a smoke machine. Choose a fixture type for it that has a dimmer channel (for example Generic dimmer), or take it out of this group.`);
      }
    } else {
      const own = show.profiles.find((p) => p.id === f.profile);
      const looksLikeSmoke = SMOKE_NAME.test(f.name) || SMOKE_NAME.test(type.name) || !!own?.channels.some((c) => c.role === 'dimmer' && SMOKE_NAME.test(c.name ?? ''));
      if (looksLikeSmoke) out.push(`${f.name} looks like a smoke or haze machine. Mark this group as one, or Basic lights and looks will turn it on.`);
    }
  }
  return out;
}

$('newGroupForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $('newGroupName').value.trim();
  if (!name) return;
  const id = uniqueId(name, new Set(show.groups.map((g) => g.id)));
  show.groups.push({ id, name, kind: 'light', fixtures: [] });
  // Show it on the operator page too.
  if (show.operator.groups.length) show.operator.groups.push(id);
  $('newGroupName').value = '';
  changed();
});

// ---- Stage plan ----

/** Where "Add fixture here" was asked for, as fractions of the plan; null when not shown. */
let planSpot = null;
/** The fixtures selected on the stage plan: several with Shift-click or a box, else just the selected one. */
let planSelection = new Set();
/** The selected fixtures, in show order. */
const chosenFixtures = () => show.fixtures.filter((f) => planSelection.has(f.id));

/** A pointer position as fractions of the plan, kept on it. */
function planPoint(e, rect) {
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
}

const inSmokeGroup = (f) => show.groups.some((g) => g.kind === 'smoke' && g.fixtures.includes(f.id));
const pct = (v) => `${v * 100}%`;

/** A resize cursor that follows a handle's direction on screen (degrees, 0 = across). */
function resizeCursor(angle) {
  const a = ((Math.round(angle / 45) % 4) + 4) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][a];
}

/** Follow a pointer from `ev` until it lets go: `move` gets each position on the plan and the event, `done` whether it moved. */
function followPointer(ev, target, move, done) {
  ev.preventDefault();
  ev.stopPropagation();
  try { target.setPointerCapture(ev.pointerId); } catch { /* pointer gone */ }
  const rect = $('stage').getBoundingClientRect();
  const x0 = ev.clientX, y0 = ev.clientY;
  let moved = false;
  const onMove = (e) => {
    // A click that shifts a pixel or two is still a click.
    if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
    moved = true;
    move(planPoint(e, rect), e);
  };
  const onUp = () => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onUp);
    done(moved);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onUp);
}

/** A handle that follows the pointer; `move` changes the fixture, then the fixture is drawn again where it is. */
function handle(cls, title, cursor, f, move) {
  const h = el('div', `plan-handle ${cls}`);
  h.title = title;
  if (cursor) h.style.cursor = cursor;
  h.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    followPointer(ev, h, (p, e) => {
      move(p, e);
      placeFixture(f);
    }, (moved) => { if (moved) changed(); });
  });
  return h;
}

/** The elements drawn for each fixture, so a drag can move them without drawing the whole plan again. */
const planParts = new Map();

/** Put a fixture's elements where it is now: its mark, its label, and a beam's cone and tip. */
function placeFixture(f) {
  const parts = planParts.get(f.id);
  if (!parts) return;
  const { body, tag, cone, tip, shape } = parts;
  body.style.left = pct(f.x);
  body.style.top = pct(f.y);
  // How far the mark reaches below its middle, as a fraction of the plan's height, for the label.
  let below = 0;
  if (shape === 'bar') {
    const { length, thickness, angle } = barAxis(f);
    body.style.width = `max(10px, ${pct(length)})`;
    body.style.height = `max(6px, ${pct(thickness)})`;
    body.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
    const r = (angle * Math.PI) / 180;
    below = Math.abs(Math.sin(r)) * (length / 2) * PLAN_ASPECT + Math.abs(Math.cos(r)) * (thickness / 2);
  } else if (shape === 'outline') {
    body.style.width = pct(f.w ?? 0.1);
    body.style.height = pct(f.h ?? 0.1);
    below = (f.h ?? 0.1) / 2;
  }
  tag.style.left = pct(f.x);
  tag.style.top = shape === 'bar' || shape === 'outline' ? `calc(${pct(f.y + below)} + 3px)` : `calc(${pct(f.y)} + 13px)`;
  if (cone) {
    const c = beamCone(f);
    cone.setAttribute('points', [c.lamp, c.left, c.right].map((p) => `${p.x * 100},${p.y * 100}`).join(' '));
    if (tip) {
      tip.style.left = pct(c.tip.x);
      tip.style.top = pct(c.tip.y);
    }
  }
}

/** A small cloud, for a smoke or haze machine. */
const CLOUD = '<svg viewBox="0 0 28 18" width="28" height="18" aria-hidden="true"><path d="M7 17a6 6 0 0 1-.7-11.96A7.5 7.5 0 0 1 20.4 4.3 6.4 6.4 0 1 1 21.5 17Z"/></svg>';

function renderStage() {
  const root = $('stage');
  root.replaceChildren();
  planParts.clear();
  // Beams' cones go underneath everything, in one drawing the size of the plan (its units are percent).
  const cones = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cones.setAttribute('class', 'plan-cones');
  cones.setAttribute('viewBox', '0 0 100 100');
  cones.setAttribute('preserveAspectRatio', 'none');
  root.append(cones);
  planSelection = new Set(chosenFixtures().map((f) => f.id));
  // Handles only when one fixture is selected.
  const one = planSelection.size === 1;
  for (const f of show.fixtures) {
    const shape = shapeOf(f, inSmokeGroup(f));
    const selected = planSelection.has(f.id);
    const body = el('div', ['plan-item', shape, selected && 'sel'].filter(Boolean).join(' '));
    if (shape === 'smoke') body.innerHTML = CLOUD;
    else body.append(el('div', 'shape'));
    body.title = f.name;
    // Long names ("B6 SonicPulse LED Bar 10") show their short code on the plan; hover shows all.
    const first = f.name.split(' ')[0];
    const tag = el('span', 'plan-tag', /^[A-Za-z]{1,3}\d{1,3}$/.test(first) ? first : f.name.length > 12 ? `${f.name.slice(0, 11)}…` : f.name);
    const parts = { body, tag, shape, cone: null, tip: null };
    if (shape === 'beam') {
      parts.cone = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      parts.cone.setAttribute('class', selected ? 'plan-cone sel' : 'plan-cone');
      cones.append(parts.cone);
    }
    planParts.set(f.id, parts);
    body.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.shiftKey) {
        // Shift-click adds the fixture to the selection, or takes it out.
        ev.preventDefault();
        const next = new Set(planSelection);
        if (next.has(f.id)) next.delete(f.id);
        else next.add(f.id);
        selectFixture(next.has(f.id) ? f.id : [...next].at(-1) ?? null, false, next);
        return;
      }
      // Dragging one of several selected moves them all; any other fixture moves on its own.
      // Each keeps where it was grabbed under the pointer, so a bar doesn't jump to centre on it.
      const group = planSelection.has(f.id) && planSelection.size > 1 ? chosenFixtures() : [f];
      const starts = group.map((x) => ({ x: x.x, y: x.y }));
      const grab = planPoint(ev, root.getBoundingClientRect());
      for (const x of group) planParts.get(x.id)?.body.classList.add('dragging');
      followPointer(ev, body, (p) => {
        moveTogether(group, starts, p.x - grab.x, p.y - grab.y);
        for (const x of group) placeFixture(x);
      }, (moved) => {
        for (const x of group) planParts.get(x.id)?.body.classList.remove('dragging');
        // A click picks just this one; a drag keeps what was selected.
        if (!moved || group.length === 1) selectFixture(f.id, false);
        if (moved) changed();
      });
    });
    if (one && selected && shape === 'bar') {
      // One handle at each end for the length, one on a long side for the thickness, and one past the end to turn it.
      const angle = barAxis(f).angle;
      body.append(
        handle('start', 'Drag to make it longer or shorter', resizeCursor(angle), f, (p) => resizeEnd(f, 'start', p)),
        handle('end', 'Drag to make it longer or shorter', resizeCursor(angle), f, (p) => resizeEnd(f, 'end', p)),
        handle('thick', 'Drag to make it thicker or thinner', resizeCursor(angle + 90), f, (p) => resizeThickness(f, p)),
        handle('turn', 'Drag to turn it (hold Shift to turn freely)', 'grab', f, (p, e) => turnBar(f, p, e.shiftKey)),
      );
    }
    if (one && selected && shape === 'outline') {
      body.append(handle('corner', 'Drag to change its size', 'nwse-resize', f, (p) => resizeOutline(f, p)));
    }
    if (one && selected && shape === 'beam') {
      parts.tip = handle('tip', 'Drag to aim it and set how far it reaches (hold Shift to aim freely)', 'grab', f, (p, e) => aimBeam(f, p, e.shiftKey));
      root.append(parts.tip);
    }
    root.append(body, tag);
    placeFixture(f);
  }
  if (planSpot) {
    const add = el('button', 'plan-add', '＋ Add fixture here');
    add.type = 'button';
    add.style.left = pct(planSpot.x);
    add.style.top = pct(planSpot.y);
    add.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    add.addEventListener('click', openPlanAdd);
    root.append(add);
  }
  renderPlanTools();
}

// A click on an empty spot clears the selection and offers to add a fixture there;
// a drag from an empty spot draws a box and selects every fixture it touches (with Shift, adds them).
$('stage').addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || !(ev.target === $('stage') || ev.target.closest('.plan-cones'))) return;
  const root = $('stage');
  const spot = planPoint(ev, root.getBoundingClientRect());
  const adding = ev.shiftKey;
  let box = null, area = null;
  followPointer(ev, root, (p) => {
    area = { left: Math.min(spot.x, p.x), right: Math.max(spot.x, p.x), top: Math.min(spot.y, p.y), bottom: Math.max(spot.y, p.y) };
    if (!box) root.append((box = el('div', 'plan-box')));
    Object.assign(box.style, { left: pct(area.left), top: pct(area.top), width: pct(area.right - area.left), height: pct(area.bottom - area.top) });
  }, (moved) => {
    if (moved) {
      const touched = show.fixtures.filter((f) => touches(f, area, inSmokeGroup(f))).map((f) => f.id);
      const next = new Set(adding ? [...planSelection, ...touched] : touched);
      planSpot = null;
      selectFixture(touched.at(-1) ?? [...next].at(-1) ?? null, false, next);
      return;
    }
    planSpot = { x: Math.round(spot.x * 1000) / 1000, y: Math.round(spot.y * 1000) / 1000 };
    if (!$('planAdd').hidden) {
      // The form is open: it now adds at the new spot.
      renderStage();
      return;
    }
    selectFixture(null, false);
  });
});

const SHAPE_HINTS = {
  dot: '',
  beam: 'Drag the round handle at the tip to aim it and set how far it reaches.',
  bar: 'Drag the handles to change its length and thickness, or the one past its end to turn it.',
  outline: 'For a strip round something. Drag the corner handle to change its size.',
  smoke: 'For a smoke or haze machine.',
};

/** The rows under the plan: the shape of what is selected, and with several, Align and Space evenly. */
function renderPlanTools() {
  const chosen = chosenFixtures();
  $('planTools').hidden = !chosen.length;
  $('planHelp').hidden = chosen.length > 0;
  $('planArrange').hidden = chosen.length < 2;
  if (!chosen.length) return;
  const shapes = new Set(chosen.map((f) => shapeOf(f, inSmokeGroup(f))));
  // A shape is marked only when every selected fixture has it.
  const shape = shapes.size === 1 ? [...shapes][0] : null;
  $('planName').textContent = chosen.length === 1 ? chosen[0].name : `${chosen.length} fixtures`;
  for (const b of $('planShape').children) b.setAttribute('aria-checked', String(b.dataset.shape === shape));
  const angles = new Set(shape === 'bar' ? chosen.map((f) => Math.round(barAxis(f).angle)) : []);
  $('planTurn').hidden = shape !== 'bar';
  $('planAngle').textContent = angles.size === 1 ? `${[...angles][0]}°` : '';
  $('planToolsHint').textContent = chosen.length === 1 ? SHAPE_HINTS[shape] : '';
  for (const b of $('planSpace').children) {
    b.disabled = chosen.length < 3;
    b.title = b.disabled ? 'Select three or more to space them evenly' : '';
  }
}

$('planShape').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-shape]');
  const chosen = chosenFixtures();
  if (!b || !chosen.length) return;
  for (const f of chosen) setShape(f, b.dataset.shape, inSmokeGroup(f));
  changed();
});

$('planTurn').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-angle]');
  const chosen = chosenFixtures();
  if (!b || !chosen.length) return;
  for (const f of chosen) setBarAngle(f, Number(b.dataset.angle));
  changed();
});

$('planAlign').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-align]');
  if (!b) return;
  alignFixtures(chosenFixtures(), b.dataset.align, inSmokeGroup);
  changed();
});

$('planSpace').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-space]');
  if (!b || b.disabled) return;
  spaceEvenly(chosenFixtures(), b.dataset.space);
  changed();
});

// Escape lets go of what is selected on the plan (and the "+ Add fixture here" offer), unless typing.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || ev.target.closest?.('input, select, textarea, form')) return;
  if (!planSelection.size && !planSpot) return;
  planSpot = null;
  selectFixture(null, false);
});

function openPlanAdd() {
  // Start from what the Add fixtures form has, so a type picked in the library is used here too.
  for (const field of ['Profile', 'Count', 'Universe']) $(`planAdd${field}`).value = $(`add${field}`).value;
  const p = profileById.get($('planAddProfile').value);
  $('planAddName').value = $('addName').value || (p ? typeLabel(p) : '');
  suggestAddress('planAdd');
  $('planAdd').hidden = false;
  $('planAddName').focus();
  $('planAddName').select();
}

function closePlanAdd() {
  $('planAdd').hidden = true;
  planSpot = null;
  renderStage();
}

// A name that came from the type follows a change of type.
$('planAddProfile').addEventListener('change', (ev) => {
  const fromType = profiles.some((p) => typeLabel(p) === $('planAddName').value);
  const p = profileById.get(ev.target.value);
  if (p && (fromType || !$('planAddName').value)) $('planAddName').value = typeLabel(p);
});

$('planAddCancel').addEventListener('click', closePlanAdd);
$('planAdd').addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePlanAdd(); });

$('planAdd').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = addFormValues('planAdd');
  if (!v || !planSpot) return;
  const spot = planSpot;
  $('planAdd').hidden = true;
  planSpot = null;
  if (addFixtures(v.p, v.prefix, v.count, v.universe, v.start, spot)) {
    toast(`Added ${v.count} ${v.count === 1 ? 'fixture. Put it' : 'fixtures. Put them'} in a group, then save.`);
    suggestAddress();
  } else {
    // Nothing was added (past channel 512): keep the sheet open to fix it.
    planSpot = spot;
    $('planAdd').hidden = false;
    renderStage();
  }
});

// ---- Save ----

// Reload from the server, so fixture types added since the last save go too.
$('discard').addEventListener('click', () => load().catch((err) => toast(err.message, true)));

$('save').addEventListener('click', async () => {
  const problems = addressProblems();
  if (problems.size && !confirm(`${problems.size} fixtures have address problems. Save anyway?`)) return;
  try {
    await call('PUT', '/api/show?source=patch', show);
    // The server adds a few things on the way in (a new group's starter colours): carry on from what it stored.
    show = await call('GET', '/api/show');
    savedJson = JSON.stringify(show);
    renderAll();
    toast('Patch saved');
  } catch (err) {
    toast(err.message, true);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (show && JSON.stringify(show) !== savedJson) e.preventDefault();
});

let toastTimer = 0;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = bad ? 'ds-toast ds-toast--bad' : 'ds-toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// The top bar: the clock, and the pill while something is wrong with the lights.
startClock($('clock'));
watchState({
  pill: $('status'),
  offline: $('offline'),
  // The page couldn't load while the server was down: load it now.
  onBack: () => { if (!show) start().catch((err) => toast(err.message, true)); },
});

start().catch((err) => toast(err.message, true));
