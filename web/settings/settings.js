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
  loadOfl();
}

// ---- Fixture database (Open Fixture Library) ----

let oflTimer = 0;

async function loadOfl() {
  clearTimeout(oflTimer);
  let st;
  try {
    st = await call('GET', '/api/ofl/db');
  } catch {
    return;
  }
  const pill = $('oflPill');
  pill.className = `pill ${st.installed ? 'ok' : 'off'}`;
  pill.textContent = st.downloading ? 'Downloading…' : st.installed ? 'On this computer' : 'Not downloaded';
  const when = st.downloadedAt ? new Date(st.downloadedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  $('oflState').textContent = st.installed
    ? `${st.fixtures} fixtures from ${st.manufacturers} manufacturers, downloaded ${when}${st.sha ? ` (version ${st.sha.slice(0, 7)})` : ''}.${st.upToDate ? ' Up to date.' : ''}`
    : 'Not downloaded yet. Patch can still search the library online.';
  const btn = $('oflDownload');
  btn.textContent = st.downloading ? 'Downloading…' : st.installed ? 'Check for updates' : 'Download database (about 3 MB)';
  btn.disabled = st.downloading;
  $('oflError').textContent = st.error ?? '';

  const u = st.update;
  $('oflUpdate').hidden = !u;
  if (u) {
    const used = u.changed.filter((c) => c.usedInShow).length;
    $('oflUpdateSummary').textContent = `Update available: ${u.added.length} new, ${u.changed.length} changed${used ? ` (${used} used in your show)` : ''}, ${u.removed.length} removed.`;
    const fill = (id, title, items, mark) => {
      const d = $(id);
      d.hidden = !items.length;
      d.querySelector('summary').textContent = `${title} (${items.length})`;
      const ul = d.querySelector('ul');
      ul.replaceChildren();
      for (const c of items) {
        const li = el('li', null, `${c.manufacturer} ${c.name}`);
        if (mark && c.usedInShow) li.append(el('span', 'used', 'in your show'));
        ul.append(li);
      }
      d.open = id === 'oflChanged' && used > 0;
    };
    fill('oflAdded', 'New fixtures', u.added, false);
    fill('oflChanged', 'Changed', u.changed, true);
    fill('oflRemoved', 'Removed', u.removed, false);
  }
  // Keep the card live while a download runs.
  if (st.downloading) oflTimer = setTimeout(loadOfl, 1000);
}

$('oflDownload').addEventListener('click', async () => {
  try {
    await call('POST', '/api/ofl/db/download');
  } catch (err) {
    toast(err.message, true);
  }
  loadOfl();
});
$('oflInstall').addEventListener('click', async () => {
  try {
    await call('POST', '/api/ofl/db/install');
    toast('Fixture database updated');
  } catch (err) {
    toast(err.message, true);
  }
  loadOfl();
});
$('oflDiscard').addEventListener('click', async () => {
  await call('POST', '/api/ofl/db/discard').catch(() => {});
  loadOfl();
});

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

// ---- Import with comparison ----

let comparison = null; // { token, items }
const KIND_TITLES = { profile: 'Fixture types', fixture: 'Fixtures', group: 'Groups', preset: 'Presets', look: 'Looks' };
const CHANGE_LABEL = { added: 'New', changed: 'Changed', removed: 'Removed' };

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const lightkey = /\.lightkeyproj$/i.test(file.name);
    const res = await fetch(`/api/import/preview?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': lightkey ? 'application/octet-stream' : 'application/json' },
      body: lightkey ? file : await file.text(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    comparison = data;
    showComparison(file.name);
  } catch (err) {
    toast(err.message, true);
  }
});

function showComparison(fileName) {
  const { items, scope } = comparison;
  $('compareName').textContent = fileName;
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const i of items) counts[i.change]++;
  $('compareSummary').textContent = items.length
    ? `${counts.added} new, ${counts.changed} changed, ${counts.removed} not in the file.${scope === 'patch' ? ' A Lightkey project only has the patch, so fixture types and fixtures are compared.' : ''} New and changed items are ticked; removals are not.`
    : 'Nothing differs: the file matches this show.';
  const list = $('compareList');
  list.replaceChildren();
  for (const kind of Object.keys(KIND_TITLES)) {
    const rows = items.filter((i) => i.kind === kind);
    if (!rows.length) continue;
    const section = el('div');
    section.append(el('h3', null, `${KIND_TITLES[kind]} (${rows.length})`));
    for (const item of rows) {
      const row = el('label', 'diff-row');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = item.change !== 'removed';
      box.dataset.kind = item.kind;
      box.dataset.id = item.id;
      box.dataset.change = item.change;
      const what = el('div', 'what');
      what.append(el('b', null, item.name));
      const detail = item.change === 'removed' ? 'In this show but not in the file. Ticking removes it (and what depends on it).' : item.details.join(' · ');
      if (detail) what.append(el('span', null, detail));
      row.append(box, el('span', `tag ${item.change}`, CHANGE_LABEL[item.change]), what);
      section.append(row);
    }
    list.append(section);
  }
  $('compareApply').hidden = !items.length;
  $('compareError').textContent = '';
  $('comparePanel').hidden = false;
  $('comparePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const compareBoxes = () => [...$('compareList').querySelectorAll('input[type=checkbox]')];
$('compareAll').addEventListener('click', () => compareBoxes().forEach((b) => (b.checked = true)));
$('compareNone').addEventListener('click', () => compareBoxes().forEach((b) => (b.checked = false)));
$('compareCancel').addEventListener('click', () => { comparison = null; $('comparePanel').hidden = true; });

$('compareApply').addEventListener('click', async () => {
  const picks = compareBoxes().filter((b) => b.checked).map((b) => ({ kind: b.dataset.kind, id: b.dataset.id, change: b.dataset.change }));
  if (!picks.length) return toast('Tick at least one change', true);
  const removals = picks.filter((p) => p.change === 'removed').length;
  if (removals && !confirm(`Remove ${removals} ${removals === 1 ? 'item' : 'items'} from the show? The current show is kept as a backup.`)) return;
  try {
    await call('POST', '/api/import/apply', { token: comparison.token, picks });
    comparison = null;
    $('comparePanel').hidden = true;
    toast(`Applied ${picks.length} ${picks.length === 1 ? 'change' : 'changes'}`);
    await load();
  } catch (err) {
    $('compareError').textContent = err.message;
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
