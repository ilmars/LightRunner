// Patch page: fixtures, groups and the stage plan. Edits a copy of the show
// and saves it whole; the server checks it and keeps a backup of the old one.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let show = null; // working copy
let savedJson = ''; // the show as last saved
let profiles = []; // [{ id, name, channels }]
const profileById = new Map();

async function call(method, path, body) {
  const res = await fetch(path, {
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

    const name = el('input');
    name.type = 'text';
    name.value = f.name;
    name.addEventListener('change', () => { f.name = name.value.trim() || f.name; changed(); });

    const type = el('select');
    for (const p of profiles) type.append(new Option(`${p.name}`, p.id));
    type.value = f.profile;
    type.addEventListener('change', () => { f.profile = type.value; changed(); });

    const uni = el('input');
    uni.type = 'number'; uni.min = '0'; uni.max = '32767'; uni.value = String(f.universe);
    uni.addEventListener('change', () => { f.universe = clampInt(uni.value, 0, 32767, f.universe); changed(); });

    const addr = el('input');
    addr.type = 'number'; addr.min = '1'; addr.max = '512'; addr.value = String(f.address);
    addr.addEventListener('change', () => { f.address = clampInt(addr.value, 1, 512, f.address); changed(); });

    const n = footprint(f);
    const range = el('span', 'range', problems.get(f.id) ?? `${f.address}–${f.address + n - 1} (${n} ch)`);

    const chips = el('div', 'chips');
    for (const g of groupsOf(f.id)) chips.append(el('span', 'chip', g.name));

    const actions = el('div', 'actions');
    const identify = el('button', 'ghost small', 'Identify');
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
    const del = el('button', 'ghost small danger', 'Delete');
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

    for (const c of [name, type, uni, addr, range, chips, actions]) {
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

function fillAddForm(first) {
  const sel = $('addProfile');
  const keep = sel.value;
  sel.replaceChildren();
  for (const p of profiles) sel.append(new Option(`${p.name}`, p.id));
  if (keep) sel.value = keep;
  if (first) {
    // Default to the universe most of the rig is on.
    const counts = new Map();
    for (const f of show.fixtures) counts.set(f.universe, (counts.get(f.universe) ?? 0) + 1);
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
    $('addUniverse').value = String(common);
    suggestAddress();
  }
}

function suggestAddress() {
  const p = profileById.get($('addProfile').value);
  const n = (p?.channels ?? 1) * Math.max(1, Number($('addCount').value) || 1);
  const a = nextFree(Number($('addUniverse').value) || 0, n);
  if (a) $('addAddress').value = String(a);
  updateAddHint();
}

function updateAddHint() {
  const p = profileById.get($('addProfile').value);
  if (!p) return;
  const count = Math.max(1, Number($('addCount').value) || 1);
  const start = Number($('addAddress').value) || 1;
  const end = start + p.channels * count - 1;
  $('addHint').textContent = `${count} × ${p.channels} channels: ${start}–${end}${end > 512 ? ' (past 512!)' : ''} on universe ${$('addUniverse').value}.`;
}

for (const id of ['addProfile', 'addCount', 'addUniverse']) $(id).addEventListener('change', suggestAddress);
$('addAddress').addEventListener('input', updateAddHint);
$('addCount').addEventListener('input', updateAddHint);

$('addForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const p = profileById.get($('addProfile').value);
  const prefix = $('addName').value.trim();
  const count = clampInt($('addCount').value, 1, 64, 1);
  const universe = clampInt($('addUniverse').value, 0, 32767, 0);
  const start = clampInt($('addAddress').value, 1, 512, 1);
  if (!p || !prefix) return;
  if (addFixtures(p, prefix, count, universe, start)) {
    toast(`Added ${count} ${count === 1 ? 'fixture' : 'fixtures'}. Put them in a group and on the stage plan, then save.`);
    suggestAddress();
  }
});

/** Patch `count` fixtures of type `p` from `start`. Returns the first new fixture, or null. */
function addFixtures(p, prefix, count, universe, start) {
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
  let first = null;
  for (let k = 0; k < count; k++) {
    const name = count === 1 && !existing.length && !plain ? prefix : `${prefix} ${n++}`;
    const id = uniqueId(name, taken);
    taken.add(id);
    const f = {
      id, name, profile: p.id, universe, address: start + k * p.channels,
      x: count === 1 ? 0.5 : Math.round((0.1 + (0.8 * k) / (count - 1)) * 1000) / 1000, y: 0.5,
    };
    show.fixtures.push(f);
    first ??= f;
  }
  selectedId = first.id;
  viewUniverse = universe;
  changed();
  return first;
}

// ---- Graphical patch: the universe map ----

const COLS = 32;
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

function selectFixture(id, scroll) {
  selectedId = id;
  const f = show.fixtures.find((x) => x.id === id);
  if (f) viewUniverse = f.universe;
  renderMap();
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
  const more = el('button', 'utab', '+');
  more.title = 'Add a universe';
  more.addEventListener('click', () => { viewUniverse = Math.max(...universes) + 1; renderMap(); });
  tabs.append(more);

  const grid = $('dmxMap');
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

const typeLabel = (p) => p.name.replace(/\s*\([^)]*\)\s*$/, '');

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
}
$('libSearch').addEventListener('input', renderLibrary);

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
    const back = el('button', 'back-link', '‹ Back to results');
    back.type = 'button';
    back.addEventListener('click', () => (lastHits ? showHits(lastHits.hits, lastHits.note, lastHits.empty) : $('oflForm').requestSubmit()));
    wrap.append(back, el('h4', null, `${info.manufacturer} ${info.name}`.trim()), el('p', 'hint', 'Pick the DMX mode the fixture is set to:'));
    for (const m of info.modes) {
      const b = el('button', 'ofl-mode');
      b.type = 'button';
      b.append(el('span', null, `${m.name} · ${m.channels} ch`), el('br'), el('small', null, m.roles.length ? m.roles.join(', ') : 'no colour or dimmer channels'));
      b.addEventListener('click', async () => {
        try {
          addProfile(await makeProfile(m.index));
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

/** Add (or update) a fixture type in this show; it is stored when the patch is saved. */
function addProfile(profile) {
  const k = show.profiles.findIndex((p) => p.id === profile.id);
  if (k >= 0) show.profiles[k] = profile;
  else show.profiles.push(profile);
  const summary = { id: profile.id, name: profile.name, channels: profile.channels.length, roles: [...new Set(profile.channels.map((c) => c.role))] };
  const j = profiles.findIndex((p) => p.id === profile.id);
  if (j >= 0) profiles[j] = summary;
  else profiles.unshift(summary);
  profileById.set(profile.id, summary);
  fillAddForm(false);
  $('addProfile').value = profile.id;
  $('addName').value = typeLabel(summary).replace(/^\S+\s+/, '');
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
    const name = el('input');
    name.type = 'text';
    name.value = g.name;
    name.addEventListener('change', () => { g.name = name.value.trim() || g.name; changed(); });
    const presets = show.presets.filter((p) => p.group === g.id).length;
    const del = el('button', 'ghost small danger', 'Delete group');
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
    const kind = el('div', 'kind');
    const sw = el('label', 'switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = g.kind === 'smoke';
    box.addEventListener('change', () => { g.kind = box.checked ? 'smoke' : 'light'; changed(); });
    const track = el('span', 'track');
    track.append(el('span', 'knob'));
    sw.append(box, track, el('span', 'switch-label', 'Smoke or haze machine'));
    kind.append(sw);
    if (g.kind === 'smoke') {
      kind.append(el('span', 'note', 'Looks, Basic lights and Flash leave it alone. It runs only from its own slider and Puff, and is off after a restart.'));
    }

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
    const add = el('select');
    add.append(new Option('+ Add fixture…', ''));
    for (const f of show.fixtures) if (!g.fixtures.includes(f.id)) add.append(new Option(f.name, f.id));
    add.addEventListener('change', () => { if (add.value) { g.fixtures.push(add.value); changed(); } });
    if (add.options.length > 1) members.append(add);
    if (!g.fixtures.length) members.prepend(el('span', 'note', 'No fixtures yet.'));
    card.append(head, kind, members);
    root.append(card);
  }
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

function renderStage() {
  const root = $('stage');
  root.replaceChildren();
  for (const f of show.fixtures) {
    const bar = Boolean(f.w || f.h);
    const item = el('div', bar ? 'plan-item bar' : 'plan-item');
    item.style.left = `${f.x * 100}%`;
    item.style.top = `${f.y * 100}%`;
    if (bar) {
      item.style.width = `max(10px, ${(f.w ?? 0) * 100}%)`;
      item.style.height = `max(6px, ${(f.h ?? 0) * 100}%)`;
    }
    // Long names ("B6 SonicPulse LED Bar 10") show their short code on the plan; hover shows all.
    const first = f.name.split(' ')[0];
    const tag = /^[A-Za-z]{1,3}\d{1,3}$/.test(first) ? first : f.name.length > 12 ? `${f.name.slice(0, 11)}…` : f.name;
    item.append(el('div', 'shape'), el('span', 'tag', tag));
    item.title = f.name;
    item.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      try { item.setPointerCapture(ev.pointerId); } catch { /* pointer gone */ }
      item.classList.add('dragging');
      const rect = root.getBoundingClientRect();
      const move = (e) => {
        f.x = Math.round(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * 1000) / 1000;
        f.y = Math.round(Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) * 1000) / 1000;
        item.style.left = `${f.x * 100}%`;
        item.style.top = `${f.y * 100}%`;
      };
      const up = () => {
        item.classList.remove('dragging');
        item.removeEventListener('pointermove', move);
        item.removeEventListener('pointerup', up);
        item.removeEventListener('pointercancel', up);
        changed();
      };
      item.addEventListener('pointermove', move);
      item.addEventListener('pointerup', up);
      item.addEventListener('pointercancel', up);
    });
    root.append(item);
  }
}

// ---- Save ----

// Reload from the server, so fixture types added since the last save go too.
$('discard').addEventListener('click', () => load().catch((err) => toast(err.message, true)));

$('save').addEventListener('click', async () => {
  const problems = addressProblems();
  if (problems.size && !confirm(`${problems.size} fixtures have address problems. Save anyway?`)) return;
  try {
    await call('PUT', '/api/show?source=patch', show);
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
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

start().catch((err) => toast(err.message, true));
