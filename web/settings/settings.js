// Settings page for the programmer. Talks to the server's /api/settings
// routes; nothing here changes the stage except the Send DMX switch.

import { NOT_ANSWERING, getJson, request, showProblem, startClock, watchState } from '../shared/appbar.js';

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
  const res = await request(path, {
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
  loadKeys();
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
  pill.className = 'ds-pill';
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
  renderRoutes();

  $('manualForOperators').checked = s.manualForOperators;
  $('contactName').value = s.contact.name;
  $('contactPhone').value = s.contact.phone;

  $('oscEnabled').checked = s.osc.enabled;
  $('oscPort').value = String(s.osc.port);
  $('oscPortField').hidden = !s.osc.enabled;
  $('oscProblem').textContent = s.osc.enabled ? s.oscProblem ?? '' : '';

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

  renderStatus();
  markDirty();
}

/** The live state as last read (null while the server doesn't answer). */
let lastState = null;

/**
 * The top bar's pill (only while something is wrong with the lights) and the DMX output card's problem line,
 * from the last live state; Send DMX off as saved here shows at once, without waiting for the next read.
 */
function renderStatus() {
  if (!lastState) return; // "Not connected" is showing instead
  const enabled = saved?.outputEnabled;
  showProblem($('status'), enabled === false ? { ...lastState, output: 'off' } : lastState);
  const problem = enabled && lastState.outputProblem ? lastState.outputProblem : '';
  if ($('outputProblem').textContent !== problem) $('outputProblem').textContent = problem;
}

// ---- Controller keys ----
// The server lists the devices and every fixed action with its key. Assign a key asks the server to take the next
// key pressed on a controller (it waits up to 10 s); one page at a time. Changes apply at once, like Send DMX.

/** The view from GET /api/controller, as last shown (its JSON, to redraw only on a change). */
let keysView = null;
let keysShown = '';
/** The action waiting for its key: what it does, its name, the request, when it gives up, the countdown. */
const keyLearn = { does: null, label: '', ctl: null, until: 0, timer: 0 };
const sameDoes = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

async function loadKeys() {
  try {
    showKeys(await call('GET', '/api/controller'));
  } catch {
    // the next read tries again
  }
}

/** Draw the card when the view changed (never in the middle of a learn, which keeps its own row up to date). */
function showKeys(view) {
  keysView = view;
  const text = JSON.stringify(view);
  if (text === keysShown) return;
  keysShown = text;
  renderKeys();
}

const MODEL_NAMES = { mk2: 'mk2', mk1: 'older model' };

function renderKeys() {
  const v = keysView;
  if (!v) return;
  $('keysNoMidi').hidden = v.midi;
  $('keysTop').hidden = !v.midi;
  $('keysList').hidden = !v.midi;
  $('keysHint').hidden = !v.midi;
  $('keysNote').hidden = !v.midi;

  const list = $('keysDevices');
  list.replaceChildren();
  if (!v.devices.length) list.append(el('p', 'hint', 'No controller is connected. Plug one into this computer.'));
  for (const d of v.devices) {
    const row = el('div', 'keys-device');
    const meta = el('div', 'meta');
    meta.append(el('b', null, d.name));
    const state = d.listening ? 'connected' : 'not listened to';
    meta.append(el('span', null, d.model ? `${MODEL_NAMES[d.model]} · ${state}` : state));
    const sw = el('label', 'ds-switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = d.listening;
    box.setAttribute('aria-label', `Listen to ${d.name}`);
    box.addEventListener('change', () => listenTo(d.name, box.checked, box));
    sw.append(box, el('span', 'ds-switch-track'), el('span', 'switch-label', 'Listen'));
    row.append(meta, sw);
    list.append(row);
  }
  $('apcLayout').checked = v.apcLayout;

  const root = $('keysList');
  root.replaceChildren();
  const sections = [...new Set(v.actions.map((a) => a.section))];
  for (const section of sections) {
    const box = el('div', 'keys-section');
    box.append(el('h3', 'ds-caps', section));
    for (const a of v.actions.filter((x) => x.section === section)) box.append(keyRow(a));
    root.append(box);
  }
  paintLearn();
}

function keyRow(a) {
  const row = el('div', 'krow');
  row.dataset.does = JSON.stringify(a.does);
  const name = el('div', 'kname');
  name.append(el('b', null, a.label));
  if (a.hold) name.append(el('span', 'khold', a.hold));
  const now = el('span', 'know');
  // Its own key, and the APC mini layout's when that still does it too (a key on another controller, say).
  if (a.key) {
    now.textContent = a.key;
    if (a.standard) now.append(el('span', 'kstd', ` · and the APC mini layout: ${a.standard}`));
  } else if (a.standard) now.append(el('span', 'kstd', `APC mini layout: ${a.standard}`));
  else now.append(el('span', 'kstd', 'No key'));
  now.classList.toggle('set', !!a.key);
  name.append(now);
  const assign = el('button', 'ds-btn ds-btn--quiet kassign', 'Assign a key');
  assign.type = 'button';
  assign.addEventListener('click', () => (sameDoes(keyLearn.does, a.does) ? stopLearn() : learnKey(a.does, a.label)));
  const clear = el('button', 'ds-btn ds-btn--quiet kclear', 'Clear');
  clear.type = 'button';
  clear.hidden = !a.key;
  clear.addEventListener('click', () => clearKey(a.does, a.label));
  const buttons = el('div', 'kbtns');
  buttons.append(assign, clear);
  row.append(name, buttons);
  return row;
}

/** The row waiting for its key says so, with the seconds left; the other rows wait their turn. */
function paintLearn() {
  for (const row of $('keysList').querySelectorAll('.krow')) {
    const waiting = sameDoes(keyLearn.does, JSON.parse(row.dataset.does));
    const btn = row.querySelector('.kassign');
    row.classList.toggle('learning', waiting);
    btn.classList.toggle('ds-btn--primary', waiting);
    btn.classList.toggle('ds-btn--quiet', !waiting);
    btn.disabled = !!keyLearn.does && !waiting;
    const left = Math.max(0, Math.ceil((keyLearn.until - performance.now()) / 1000));
    btn.textContent = waiting ? `Press a key… ${left} s · Stop` : 'Assign a key';
  }
}

async function learnKey(does, label) {
  if (keyLearn.ctl) return;
  const ctl = new AbortController();
  Object.assign(keyLearn, { does, label, ctl, until: performance.now() + 10000 });
  keyLearn.timer = setInterval(paintLearn, 250);
  $('keysNote').textContent = '';
  paintLearn();
  let answer = null;
  try {
    const res = await fetch('/api/keys/learn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ does }), signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    answer = res.ok ? data : { ok: false, message: data.error || `request failed (${res.status})`, bad: true };
  } catch {
    if (!ctl.signal.aborted) answer = { ok: false, message: NOT_ANSWERING, bad: true };
  }
  if (keyLearn.ctl !== ctl) return;
  endLearn();
  if (answer?.ok) {
    $('keysNote').textContent = answer.note ?? `${label} is now ${answer.key}.`;
  } else if (answer) {
    toast(answer.message, answer.bad);
  }
  await loadKeys();
}

function stopLearn() {
  keyLearn.ctl?.abort();
  endLearn();
}

function endLearn() {
  clearInterval(keyLearn.timer);
  Object.assign(keyLearn, { does: null, label: '', ctl: null });
  paintLearn();
}

async function clearKey(does, label) {
  try {
    await call('POST', '/api/keys/clear', { does });
    $('keysNote').textContent = `${label} has no key now.`;
  } catch (err) {
    toast(err.message, true);
  }
  await loadKeys();
}

async function listenTo(device, on, box) {
  const ignored = new Set((keysView?.devices ?? []).filter((d) => !d.listening).map((d) => d.name));
  if (on) ignored.delete(device);
  else ignored.add(device);
  try {
    showKeys(await call('PUT', '/api/controller', { ignored: [...ignored] }));
  } catch (err) {
    box.checked = !on;
    toast(err.message, true);
  }
}

$('apcLayout').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    showKeys(await call('PUT', '/api/controller', { apcLayout: on }));
  } catch (err) {
    e.target.checked = !on;
    toast(err.message, true);
  }
});

// Reset asks twice, as deleting does elsewhere: the first tap arms it for a few seconds.
let resetArmed = 0;
$('apcReset').addEventListener('click', async () => {
  const btn = $('apcReset');
  if (!resetArmed) {
    btn.textContent = 'Tap again to clear every key on the APC mini';
    btn.classList.add('ds-btn--danger');
    resetArmed = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  try {
    showKeys(await call('POST', '/api/keys/reset'));
    $('keysNote').textContent = 'The APC mini has its standard layout again. The keys it had are in a backup (Backups).';
  } catch (err) {
    toast(err.message, true);
  }
});
function disarmReset() {
  clearTimeout(resetArmed);
  resetArmed = 0;
  $('apcReset').textContent = 'Reset to the APC mini layout';
  $('apcReset').classList.remove('ds-btn--danger');
}

/** The live state's reads (watchState), to read again at once after Send DMX changes. */
let stateWatch = null;

// Keep the status pill and the controller card live (the pill also before the PIN is entered, as on Patch).
function watch() {
  stateWatch = watchState({
    pill: $('status'),
    offline: $('offline'),
    onState: async (state) => {
      lastState = state;
      renderStatus();
      if ($('main').hidden || keyLearn.does) return;
      try {
        showKeys(await getJson('/api/controller', 4000));
      } catch {
        // the next read tries again
      }
    },
    // "Not connected" says it all: the DMX card's line (from the last answer) goes too.
    onLost: () => {
      lastState = null;
      $('outputProblem').textContent = '';
    },
    // The page couldn't load while the server was down: load it now.
    onBack: () => { if (!saved) start().catch((err) => toast(err.message, true)); },
  });
}

// ---- Editing ----

function changedFields() {
  const out = {};
  const keys = ['showName', 'output', 'routes', 'frameRate', 'gamma', 'manualForOperators', 'osc', 'contact'];
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
$('contactName').addEventListener('input', (e) => { draft.contact.name = e.target.value; markDirty(); });
$('contactPhone').addEventListener('input', (e) => { draft.contact.phone = e.target.value; markDirty(); });
$('oscEnabled').addEventListener('change', (e) => edit((s) => { s.osc.enabled = e.target.checked; }));
$('oscPort').addEventListener('input', (e) => { draft.osc.port = Number(e.target.value); markDirty(); });
$('frameRate').addEventListener('change', (e) => { draft.frameRate = Number(e.target.value); markDirty(); });
$('gamma').addEventListener('input', (e) => { draft.gamma = Number(e.target.value); markDirty(); });
$('showName').addEventListener('input', (e) => { draft.showName = e.target.value; markDirty(); });

$('discard').addEventListener('click', () => { draft = structuredClone(saved); sacnUnicast.clear(); render(); });
$('save').addEventListener('click', async () => {
  // "One receiver" with no address would save as multicast without a word.
  const noReceiver = draft.routes.find((r) => r.output.kind === 'sacn' && !r.output.host && sacnUnicast.has(r.universe));
  if (noReceiver) return toast(`Type the receiver's IP address for universe ${noReceiver.universe}.`, true);
  try {
    saved = await call('PUT', '/api/settings', changedFields());
    sacnUnicast.clear();
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
    // The pill from the last read (up to 2 s old) would say "Not sending" just after it was turned on: it waits
    // for a fresh read, a moment from now, once the lights have the change.
    if (on && lastState?.output === 'off') showProblem($('status'), null);
    else renderStatus();
    setTimeout(() => stateWatch?.refresh(), 150);
    toast(on ? 'Sending DMX' : 'DMX output off');
  } catch (err) {
    e.target.checked = !on;
    toast(err.message, true);
  }
});

// ---- Art-Net node finder ----

/** Search the network and list the nodes in `box`; "Use" calls `onUse(node)`. */
async function findNodes(btn, box, onUse) {
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
      const use = el('button', 'ds-btn', n.thisMachine ? 'Use anyway' : 'Use');
      use.type = 'button';
      use.addEventListener('click', () => {
        if (n.thisMachine && !confirm(`${n.longName || n.shortName} is software on this computer, not the node box. It only reaches the lights while that program runs. Use it anyway?`)) return;
        onUse(n);
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
}

$('findNodes').addEventListener('click', () => findNodes($('findNodes'), $('nodes'), (n) => edit((s) => {
  s.output = { kind: 'artnet', host: n.ip };
  // Moving the whole rig to the node's universe only works with one universe.
  if (n.universes.length && s.universes.length <= 1) s.universe = n.universes[0];
  $('nodes').replaceChildren();
})));

// ---- ENTTEC ports ----

let portList = null; // the last list of USB serial ports, shared by every port menu

async function serialPorts(refresh) {
  if (!portList || refresh) {
    try {
      portList = await call('GET', '/api/serial-ports');
    } catch {
      portList = [];
    }
  }
  return portList;
}

/** Fill a USB port menu, keeping a chosen port that is unplugged right now. */
async function fillPorts(sel, current, refresh) {
  const ports = await serialPorts(refresh);
  sel.replaceChildren(new Option(ports.length ? 'Choose a port' : 'No USB DMX interface found', ''));
  for (const p of ports) sel.append(new Option(`${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}`, p.path));
  if (current && !ports.some((p) => p.path === current)) sel.append(new Option(`${current} (not connected)`, current));
  sel.value = current ?? '';
}

function loadPorts(current, refresh) {
  return fillPorts($('enttecPort'), current, refresh);
}
$('refreshPorts').addEventListener('click', async () => {
  await loadPorts(draft.output.port, true);
  renderRoutes();
});

// ---- Universes with their own output ----

const MAX_UNIVERSE = 32767;
const KINDS = [['artnet', 'Art-Net'], ['sacn', 'sACN (E1.31)'], ['enttec', 'ENTTEC USB']];

/** Universes set to "One receiver" for sACN whose address isn't typed yet. */
const sacnUnicast = new Set();

function routeFor(u) {
  return draft.routes.find((r) => r.universe === u);
}

/** A new route starts as the same kind of output as the default, with the address still to fill in. */
function newRouteOutput() {
  const kind = draft.output.kind;
  if (kind === 'sacn') return { kind, host: '', priority: draft.output.priority ?? 100 };
  if (kind === 'enttec') return { kind, port: '' };
  return { kind: 'artnet', host: '' };
}

function renderRoutes() {
  const s = draft;
  const counts = s.fixturesPerUniverse ?? {};
  const universes = [...new Set([...s.universes, ...s.routes.map((r) => r.universe)])].sort((a, b) => a - b);
  $('unsent').textContent = (saved?.unsent ?? []).map((x) => `Universe ${x.universe} is not sent: ${x.reason}.`).join(' ');
  const list = $('routeList');
  list.replaceChildren(...universes.map((u) => routeRow(u, counts[u] ?? 0)));
}

/** The next universe number nobody uses: one past the highest in the patch or in a route. */
function nextUniverse() {
  const used = new Set([...draft.universes, ...draft.routes.map((r) => r.universe)]);
  const next = Math.max(-1, ...used) + 1;
  if (next <= MAX_UNIVERSE) return next;
  for (let u = 0; u <= MAX_UNIVERSE; u++) if (!used.has(u)) return u;
  return null;
}

$('addUniverse').addEventListener('click', () => {
  const u = nextUniverse();
  if (u === null) return toast(`All universes up to ${MAX_UNIVERSE} are in use.`, true);
  edit((s) => { s.routes = [...s.routes, { universe: u, output: newRouteOutput() }].sort((a, b) => a.universe - b.universe); });
  const row = document.querySelector(`#routeList [data-universe="${u}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  row?.querySelector('input[type=text]')?.focus();
});

function routeRow(u, fixtures) {
  const route = routeFor(u);
  const row = el('div', 'node route');
  row.dataset.universe = String(u);
  const head = el('div', 'route-head');
  const meta = el('div', 'meta');
  meta.append(el('b', null, `Universe ${u}`));
  meta.append(el('span', null, `${fixtures ? `${fixtures} fixture${fixtures === 1 ? '' : 's'}` : 'No fixtures patched yet'} · ${route ? 'Own output' : 'Default output'}`));
  // A universe nothing is patched on has no output to fall back to: it is only listed because it was added, so it can go.
  const removable = route && !fixtures;
  const toggle = el('button', removable ? 'ds-btn ds-btn--danger' : 'ds-btn ds-btn--quiet', removable ? 'Remove' : route ? 'Use default' : 'Use its own output');
  toggle.type = 'button';
  toggle.addEventListener('click', () => edit((s) => {
    if (route) s.routes = s.routes.filter((r) => r.universe !== u);
    else s.routes = [...s.routes, { universe: u, output: newRouteOutput() }].sort((a, b) => a.universe - b.universe);
  }));
  head.append(meta, toggle);
  row.append(head);
  if (route) row.append(routeFields(u, route.output));
  return row;
}

function routeFields(u, out) {
  const box = el('div', 'route-fields');
  const seg = el('div', 'ds-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', `Output type for universe ${u}`);
  for (const [kind, label] of KINDS) {
    const l = el('label');
    const r = el('input');
    r.type = 'radio';
    r.name = `kind-${u}`;
    r.value = kind;
    r.checked = out.kind === kind;
    r.addEventListener('change', () => edit(() => {
      const host = out.host ?? '';
      routeFor(u).output = kind === 'artnet' ? { kind, host }
        : kind === 'sacn' ? { kind, host: '', priority: draft.output.priority ?? 100 }
        : { kind, port: '' };
    }));
    l.append(r, el('span', null, label));
    seg.append(l);
  }
  box.append(seg);

  const textField = (label, value, placeholder, onInput) => {
    const f = el('div', 'field');
    const id = `route-${u}-${label.replace(/\W+/g, '-').toLowerCase()}`;
    const lab = el('label', null, label);
    lab.htmlFor = id;
    const input = el('input', 'ds-field');
    input.id = id;
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = placeholder;
    input.value = value ?? '';
    input.addEventListener('input', (e) => { onInput(e.target.value.trim()); markDirty(); });
    f.append(lab);
    return { f, input };
  };

  if (out.kind === 'artnet') {
    const { f, input } = textField('Node IP address', out.host, '192.168.0.120', (v) => { routeFor(u).output.host = v; });
    const line = el('div', 'row');
    const find = el('button', 'ds-btn', 'Find nodes');
    find.type = 'button';
    const nodes = el('div', 'nodes');
    find.addEventListener('click', () => findNodes(find, nodes, (n) => edit(() => { routeFor(u).output = { kind: 'artnet', host: n.ip }; })));
    line.append(input, find);
    f.append(line);
    box.append(f, nodes);
  } else if (out.kind === 'sacn') {
    const unicast = Boolean(out.host) || sacnUnicast.has(u);
    const mode = el('div', 'ds-seg');
    for (const [value, label] of [['multicast', 'Multicast'], ['unicast', 'One receiver']]) {
      const l = el('label');
      const r = el('input');
      r.type = 'radio';
      r.name = `sacn-${u}`;
      r.value = value;
      r.checked = (value === 'unicast') === unicast;
      r.addEventListener('change', () => edit(() => {
        routeFor(u).output.host = '';
        // An empty address is multicast to the server, so the page remembers "One receiver" until one is typed.
        if (value === 'unicast') sacnUnicast.add(u);
        else sacnUnicast.delete(u);
      }));
      l.append(r, el('span', null, label));
      mode.append(l);
    }
    box.append(mode);
    if (unicast) {
      const { f, input } = textField('Receiver IP address', out.host, '192.168.0.120', (v) => { routeFor(u).output.host = v; });
      f.append(input);
      box.append(f);
    }
  } else if (out.kind === 'enttec') {
    const f = el('div', 'field');
    const lab = el('label', null, 'USB port');
    const sel = el('select', 'ds-field');
    sel.id = `route-${u}-port`;
    lab.htmlFor = sel.id;
    sel.addEventListener('change', (e) => { routeFor(u).output.port = e.target.value; markDirty(); });
    void fillPorts(sel, out.port);
    f.append(lab, sel, el('span', 'hint', 'A USB interface sends one universe, so each universe needs its own.'));
    box.append(f);
  }
  return box;
}

// ---- Show file and backups ----

// ---- Open a whole show file ----

const NOT_A_SHOW = "This file isn't a Light Runner show";

$('openShowFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    let text;
    let parsed;
    try {
      text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      throw new Error(NOT_A_SHOW);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.schemaVersion !== 'number') throw new Error(NOT_A_SHOW);
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : file.name;
    if (!confirm(`Replace the whole show with "${name}"? The current show is kept as a backup. Send DMX stays as it is now.`)) return;
    const res = await request('/api/show', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: text });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) showLogin();
    if (res.status === 400) throw new Error(NOT_A_SHOW);
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    toast('Show opened');
    await load();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- Import with comparison ----

let comparison = null; // { token, items }
const KIND_TITLES = { profile: 'Fixture types', fixture: 'Fixtures', group: 'Groups', palette: 'Shared colours', preset: 'Presets', look: 'Looks' };
const CHANGE_LABEL = { added: 'New', changed: 'Changed', removed: 'Removed' };

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const lightkey = /\.lightkeyproj$/i.test(file.name);
    const res = await request(`/api/import/preview?name=${encodeURIComponent(file.name)}`, {
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
    section.append(el('h3', 'ds-caps', `${KIND_TITLES[kind]} (${rows.length})`));
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
      row.append(box, el('span', `ds-tag ${item.change}`, CHANGE_LABEL[item.change]), what);
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
    const restore = el('button', 'ds-btn ds-btn--quiet', 'Restore');
    restore.type = 'button';
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
  t.className = bad ? 'ds-toast ds-toast--bad' : 'ds-toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

window.addEventListener('beforeunload', (e) => {
  if (saved && Object.keys(changedFields()).length) e.preventDefault();
});

startClock($('clock'));
watch();
start().catch((err) => toast(err.message, true));
