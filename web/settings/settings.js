// Settings page for the programmer. Talks to the server's /api/settings
// routes; nothing here changes the stage except the Send DMX switch.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let saved = null; // settings as last loaded from the server
let draft = null; // settings with unsaved edits

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login' && path !== '/api/pin') showLogin();
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// ---- Login ----

async function start() {
  const session = await call('GET', '/api/session');
  if (!session.loggedIn) return showLogin();
  $('logout').hidden = !session.pinSet;
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
  $('loginError').textContent = '';
  try {
    await call('POST', '/api/login', { pin: $('pin').value });
    $('pin').value = '';
    $('login').hidden = true;
    $('logout').hidden = false;
    await load();
  } catch (err) {
    $('loginError').textContent = err.message;
    $('pin').select();
  }
});

$('logout').addEventListener('click', async () => {
  await call('POST', '/api/logout');
  showLogin();
});

// ---- Load and render ----

async function load() {
  saved = await call('GET', '/api/settings');
  draft = structuredClone(saved);
  $('main').hidden = false;
  render();
  loadBackups();
}

function render() {
  const s = draft;
  $('outputEnabled').checked = s.outputEnabled;
  $('forcedOff').hidden = !s.forcedOff;
  for (const r of document.querySelectorAll('input[name=kind]')) r.checked = r.value === s.output.kind;
  for (const k of document.querySelectorAll('.kind')) k.classList.toggle('on', k.dataset.kind === s.output.kind);

  if (s.output.kind === 'artnet') $('artnetHost').value = s.output.host ?? '';
  if (s.output.kind === 'sacn') {
    const unicast = Boolean(s.output.host);
    for (const r of document.querySelectorAll('input[name=sacnMode]')) r.checked = r.value === (unicast ? 'unicast' : 'multicast');
    $('sacnHostField').hidden = !unicast;
    $('sacnHost').value = s.output.host ?? '';
    $('sacnPriority').value = s.output.priority ?? 100;
  }
  if (s.output.kind === 'enttec') loadPorts(s.output.port);

  const single = s.universes.length <= 1;
  $('universeField').hidden = !single;
  $('universe').value = s.universe ?? s.universes[0] ?? 0;
  $('universeHint').textContent =
    s.output.kind === 'artnet' ? 'Art-Net port-address the node listens on. "Find nodes" shows it.' :
    s.output.kind === 'sacn' ? 'sACN universes start at 1.' :
    'Used when you switch to Art-Net or sACN.';

  $('manualForOperators').checked = s.manualForOperators;
  const safe = $('safeLook');
  safe.replaceChildren(new Option('Built-in warm white wash', ''));
  for (const l of s.looks) safe.append(new Option(`Look: ${l.name}`, l.id));
  safe.value = s.safeLook ?? '';

  $('frameRate').value = String(s.frameRate);
  $('gamma').value = String(s.gamma);
  $('showName').value = s.showName;
  $('showSummary').textContent = `${s.fixtures} fixtures, ${s.looks.length} looks.`;

  $('pinState').textContent = s.pinSet
    ? 'A PIN is set. Operators can still use the operator page without it.'
    : 'No PIN is set: anyone on the network can open this page. Set one before the first service.';
  $('currentPinField').hidden = !s.pinSet;
  $('removePin').hidden = !s.pinSet;
  $('savePin').textContent = s.pinSet ? 'Change PIN' : 'Set PIN';

  renderStatus(s.outputStatus, s.outputEnabled);
  markDirty();
}

function renderStatus(status, enabled, problem) {
  const pill = $('status');
  const st = !enabled ? 'off' : status ?? 'off';
  pill.className = `pill ${st}`;
  pill.textContent = st === 'ok' ? 'DMX: sending' : st === 'lost' ? 'DMX: output lost' : 'DMX: off';
  pill.title = problem ?? '';
  $('outputProblem').textContent = enabled && problem ? problem : '';
}

// Keep the status pill live.
setInterval(async () => {
  if ($('main').hidden) return;
  try {
    const state = await (await fetch('/api/state')).json();
    if (state && saved) renderStatus(state.output, saved.outputEnabled, state.outputProblem);
  } catch {
    // offline; try again
  }
}, 2000);

// ---- Editing ----

function changedFields() {
  const out = {};
  const keys = ['showName', 'output', 'frameRate', 'gamma', 'manualForOperators', 'safeLook'];
  for (const k of keys) if (JSON.stringify(draft[k]) !== JSON.stringify(saved[k])) out[k] = draft[k];
  if (draft.universe !== undefined && draft.universe !== saved.universes[0]) out.universe = draft.universe;
  return out;
}

function markDirty() {
  $('saveBar').hidden = Object.keys(changedFields()).length === 0;
}

function edit(fn) {
  fn(draft);
  render();
}

for (const r of document.querySelectorAll('input[name=kind]')) {
  r.addEventListener('change', () => edit((s) => {
    const kind = r.value;
    // Keep the address when switching between network outputs.
    const host = s.output.host ?? '';
    s.output = kind === 'artnet' ? { kind, host: host || '255.255.255.255' }
      : kind === 'sacn' ? { kind, host: '', priority: 100 }
      : { kind, port: '' };
  }));
}
$('artnetHost').addEventListener('input', (e) => { draft.output.host = e.target.value.trim(); markDirty(); });
for (const r of document.querySelectorAll('input[name=sacnMode]')) {
  r.addEventListener('change', () => edit((s) => { s.output.host = r.value === 'unicast' ? (s.output.host || '') : ''; $('sacnHostField').hidden = r.value !== 'unicast'; }));
}
$('sacnHost').addEventListener('input', (e) => { draft.output.host = e.target.value.trim(); markDirty(); });
$('sacnPriority').addEventListener('input', (e) => { draft.output.priority = Number(e.target.value); markDirty(); });
$('enttecPort').addEventListener('change', (e) => { draft.output.port = e.target.value; markDirty(); });
$('universe').addEventListener('input', (e) => { draft.universe = Number(e.target.value); markDirty(); });
$('manualForOperators').addEventListener('change', (e) => { draft.manualForOperators = e.target.checked; markDirty(); });
$('safeLook').addEventListener('change', (e) => { draft.safeLook = e.target.value || null; markDirty(); });
$('frameRate').addEventListener('change', (e) => { draft.frameRate = Number(e.target.value); markDirty(); });
$('gamma').addEventListener('input', (e) => { draft.gamma = Number(e.target.value); markDirty(); });
$('showName').addEventListener('input', (e) => { draft.showName = e.target.value; markDirty(); });

$('discard').addEventListener('click', () => { draft = structuredClone(saved); render(); });
$('save').addEventListener('click', async () => {
  try {
    saved = await call('PUT', '/api/settings', changedFields());
    draft = structuredClone(saved);
    render();
    toast('Saved');
    loadBackups();
  } catch (err) {
    toast(err.message, true);
  }
});

// Send DMX applies at once: it is how you hand the lights over to or from another desk.
$('outputEnabled').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    const next = await call('PUT', '/api/settings', { outputEnabled: on });
    saved.outputEnabled = next.outputEnabled;
    draft.outputEnabled = next.outputEnabled;
    renderStatus(next.outputStatus, next.outputEnabled);
    toast(on ? 'Sending DMX' : 'DMX output off');
  } catch (err) {
    e.target.checked = !on;
    toast(err.message, true);
  }
});

// ---- Art-Net node finder ----

$('findNodes').addEventListener('click', async () => {
  const box = $('nodes');
  const btn = $('findNodes');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  box.replaceChildren();
  try {
    const nodes = await call('GET', '/api/artnet/nodes');
    if (!nodes.length) box.append(el('p', 'hint', 'No Art-Net nodes answered. Check the node is powered and on this network.'));
    for (const n of nodes) {
      const row = el('div', 'node');
      const meta = el('div', 'meta');
      meta.append(el('b', null, n.longName || n.shortName || n.ip));
      meta.append(el('span', null, `${n.ip} · ${n.universes.length ? `universe ${n.universes.join(', ')}` : 'no DMX outputs'}${n.thisMachine ? ' · software on this computer, not a node box' : ''}`));
      const use = el('button', 'ghost small', n.thisMachine ? 'Use anyway' : 'Use');
      use.type = 'button';
      use.addEventListener('click', () => {
        if (n.thisMachine && !confirm(`${n.longName || n.shortName} is software on this computer, not the node box. It only reaches the lights while that program runs. Use it anyway?`)) return;
        useNode(n);
      });
      const useNode = (n) => edit((s) => {
        s.output = { kind: 'artnet', host: n.ip };
        if (n.universes.length) s.universe = n.universes[0];
      });
      row.append(meta, use);
      box.append(row);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find nodes';
  }
});

// ---- ENTTEC ports ----

async function loadPorts(current) {
  const sel = $('enttecPort');
  let ports = [];
  try {
    ports = await call('GET', '/api/serial-ports');
  } catch {
    // ignore
  }
  sel.replaceChildren(new Option(ports.length ? 'Choose a port' : 'No USB DMX interface found', ''));
  for (const p of ports) sel.append(new Option(`${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}`, p.path));
  if (current && !ports.some((p) => p.path === current)) sel.append(new Option(`${current} (not connected)`, current));
  sel.value = current ?? '';
}
$('refreshPorts').addEventListener('click', () => loadPorts(draft.output.port));

// ---- Show file and backups ----

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm(`Replace the current show with "${file.name}"? The current show is kept as a backup.`)) return;
  try {
    const show = JSON.parse(await file.text());
    await call('PUT', '/api/show', show);
    toast('Show imported');
    await load();
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadBackups() {
  const list = $('backupList');
  const backups = await call('GET', '/api/backups').catch(() => []);
  $('backupCount').textContent = `(${backups.length})`;
  list.replaceChildren();
  for (const b of backups) {
    const li = el('li');
    li.append(el('span', null, new Date(b.savedAt).toLocaleString()));
    const restore = el('button', 'ghost small', 'Restore');
    restore.addEventListener('click', async () => {
      if (!confirm(`Restore the show saved ${new Date(b.savedAt).toLocaleString()}? The current show is kept as a backup.`)) return;
      try {
        await call('POST', '/api/backups/restore', { name: b.name });
        toast('Backup restored');
        await load();
      } catch (err) {
        toast(err.message, true);
      }
    });
    li.append(restore);
    list.append(li);
  }
}

// ---- PIN ----

$('pinForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await call('POST', '/api/pin', { current: $('currentPin').value || undefined, next: $('newPin').value });
    $('currentPin').value = '';
    $('newPin').value = '';
    toast('PIN saved');
    $('logout').hidden = false;
    await load();
  } catch (err) {
    toast(err.message, true);
  }
});

$('removePin').addEventListener('click', async () => {
  if (!confirm('Remove the PIN? Anyone on the network could then change settings.')) return;
  try {
    await call('POST', '/api/pin', { current: $('currentPin').value, next: null });
    $('currentPin').value = '';
    toast('PIN removed');
    $('logout').hidden = true;
    await load();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- Toast ----

let toastTimer = 0;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

window.addEventListener('beforeunload', (e) => {
  if (saved && Object.keys(changedFields()).length) e.preventDefault();
});

start().catch((err) => toast(err.message, true));
