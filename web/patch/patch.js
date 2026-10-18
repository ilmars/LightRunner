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
    const tr = el('tr', problems.has(f.id) ? 'bad' : null);

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
  if (start + p.channels * count - 1 > 512) return toast('Those fixtures run past channel 512. Use a lower start address or another universe.', true);
  const taken = new Set(show.fixtures.map((f) => f.id));
  // Number new fixtures after any that already use this name ("Bar 3", "Bar 4"...).
  const existing = show.fixtures.map((f) => f.name.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`))).filter(Boolean).map((m) => Number(m[1]));
  let n = existing.length ? Math.max(...existing) + 1 : 1;
  for (let k = 0; k < count; k++) {
    const name = count === 1 && !existing.length ? prefix : `${prefix} ${n++}`;
    const id = uniqueId(name, taken);
    taken.add(id);
    show.fixtures.push({
      id, name, profile: p.id, universe, address: start + k * p.channels,
      x: count === 1 ? 0.5 : Math.round((0.1 + (0.8 * k) / (count - 1)) * 1000) / 1000, y: 0.5,
    });
  }
  toast(`Added ${count} ${count === 1 ? 'fixture' : 'fixtures'}. Put them in a group and on the stage plan, then save.`);
  changed();
  suggestAddress();
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
    card.append(head, members);
    root.append(card);
  }
}

$('newGroupForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $('newGroupName').value.trim();
  if (!name) return;
  const id = uniqueId(name, new Set(show.groups.map((g) => g.id)));
  show.groups.push({ id, name, fixtures: [] });
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

$('discard').addEventListener('click', () => {
  show = JSON.parse(savedJson);
  renderAll();
});

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
