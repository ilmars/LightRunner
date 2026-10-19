// Operator page. The server is the single source of truth: this page only
// sends commands and shows the live state it is given.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let layout = null;
let state = null;
let visual = new Uint8Array(0);
let socket = null;
let connected = false;
let ref = 0;
// One entry per running-order row, in order: { item, button, mark }.
let orderRows = [];
// The look before the one now on stage, for "Song 3 → Song 4" while a fade runs.
let seenLook = null;
let previousLook = null;
// The ref of a Save from the new-quick-look sheet that the server hasn't answered yet.
let pendingSave = null;

// ---- Connection: reconnect every 2 s and resync on reconnect ----

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.onopen = () => setConnected(true);
  ws.onclose = () => {
    setConnected(false);
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      visual = new Uint8Array(ev.data);
      drawStage();
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'layout') {
      layout = msg.layout;
      buildOrder();
      buildDetails();
      buildQuick();
      buildSheetGroups();
      render();
    } else if (msg.type === 'state') {
      if (state && msg.state.look !== seenLook) previousLook = seenLook;
      seenLook = msg.state.look;
      state = msg.state;
      render();
    } else if (msg.type === 'result') {
      if (msg.ref !== null && msg.ref === pendingSave) {
        // The answer to the sheet's Save: on an error the sheet stays open to fix it.
        pendingSave = null;
        if (!msg.error) finishSaveQuick();
        else renderSheet();
      }
      if (msg.error) toast(msg.error);
    }
  };
}

function setConnected(on) {
  connected = on;
  $('banner').hidden = on;
  $('link').classList.toggle('down', !on);
  $('linkText').textContent = on ? 'Connected' : 'Offline';
  if (!on && pendingSave !== null) {
    // The answer may never come; let the user try Save again.
    pendingSave = null;
    renderSheet();
  }
}

/** Sends a command; returns its ref (to match the server's answer), or null when not connected. */
function send(cmd) {
  if (!connected) {
    toast('Not connected. Lights keep running; try again in a moment.');
    return null;
  }
  socket.send(JSON.stringify({ type: 'command', ref: ++ref, cmd }));
  return ref;
}

// ---- Running order ----

const isBasic = (item) => item.id === layout?.basicLights;

/** Start an item: Basic lights is the show's Safe look; every other item is a look. */
function start(item) {
  send(isBasic(item) ? { type: 'safe' } : { type: 'look', id: item.id });
}

function buildOrder() {
  const root = $('runningOrder');
  root.replaceChildren();
  orderRows = [];
  (layout.runningOrder ?? []).forEach((item, k) => {
    const basic = isBasic(item);
    const b = el('button', basic ? 'item fixed' : 'item');
    // A thin strip: one block per group, the colour this item gives it.
    const strip = el('span', 'strip');
    (item.colours ?? []).forEach((c, i) => {
      const block = el('i', c ? null : 'unset');
      if (c) block.style.background = c;
      block.title = layout.groups[i]?.name ?? '';
      strip.append(block);
    });
    const mark = el('span', 'mark', 'changed');
    mark.hidden = true;
    b.append(strip, el('span', 'name', item.name), mark);
    b.addEventListener('click', () => start(item));
    root.append(b);
    orderRows.push({ item, button: b, mark });
    if (basic && k < layout.runningOrder.length - 1) root.append(el('div', 'sep'));
  });
}

/** Index in the running order of what is on stage, or -1 (Blackout, or a look that isn't in the order). */
function stageIndex() {
  const order = layout?.runningOrder ?? [];
  if (!state) return -1;
  if (state.look === 'safe') return order.findIndex(isBasic);
  return order.findIndex((i) => i.id === state.look);
}

/**
 * The item after the one on stage; the first song when nothing is on stage.
 * After Blackout the item before it still counts, so Next carries on the service.
 */
function nextItem() {
  const order = layout?.runningOrder ?? [];
  if (!order.length) return null;
  let k = stageIndex();
  if (k < 0 && state?.lastLook) k = order.findIndex((i) => i.id === state.lastLook);
  if (k < 0) return order.find((i) => !isBasic(i)) ?? null;
  return order[k + 1] ?? null;
}

$('next').addEventListener('click', () => {
  const item = nextItem();
  if (item) start(item);
});
$('undo').addEventListener('click', () => send({ type: 'undo' }));

// ---- Fade time for every look and preset change; shared by all devices ----

const fadeMenu = $('fadeMenu');
const showFadeMenu = (open) => {
  fadeMenu.hidden = !open;
  $('fadeButton').setAttribute('aria-expanded', String(open));
};
$('fadeButton').addEventListener('click', () => showFadeMenu(fadeMenu.hidden));
for (const b of fadeMenu.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    send({ type: 'fadeTime', value: b.dataset.fade === 'auto' ? null : Number(b.dataset.fade) });
    showFadeMenu(false);
  });
}
document.addEventListener('pointerdown', (ev) => {
  if (!fadeMenu.hidden && !fadeMenu.parentElement.contains(ev.target)) showFadeMenu(false);
}, true);

// ---- Rendering live state ----

/** What to call a look id in the top bar. */
function lookName(id) {
  if (id === 'blackout') return 'Blackout';
  if (id === 'safe') return layout.runningOrder.find(isBasic)?.name ?? 'Basic lights';
  return layout.runningOrder.find((i) => i.id === id)?.name ?? layout.looks.find((l) => l.id === id)?.name ?? id ?? '—';
}

function render() {
  if (!state || !layout) return;
  const blackedOut = state.look === 'blackout';
  const fading = state.lookProgress < 1 && state.lookFadeLeft > 0;

  // Top bar: the name, an amber "changed", and "A → B" while a fade runs.
  const name = state.look ? lookName(state.look) : '—';
  const from = previousLook ? lookName(previousLook) : null;
  $('nowName').textContent = fading && from && from !== name ? `${from} → ${name}` : name;
  $('nowChanged').hidden = !state.lookChanged || blackedOut;

  // Only the state that matters takes room. A problem with the lights replaces the quiet items.
  const lost = state.output === 'lost';
  const off = state.output === 'off';
  const note = $('outputNote');
  note.hidden = !(lost || off);
  note.classList.toggle('problem', lost);
  note.classList.toggle('off', off);
  $('outputText').textContent = lost
    ? state.outputProblem ?? 'Lights not answering: check the network and the DMX box'
    : 'Not sending to the lights (Lightkey has them)';
  $('quiet').hidden = lost || off;

  $('fading').hidden = !fading;
  if (fading) {
    $('fadeFill').style.width = `${Math.round(state.lookProgress * 100)}%`;
    $('fadeLeft').textContent = `${state.lookFadeLeft.toFixed(1)} s`;
  }
  // Flash does nothing during Blackout, so the bar doesn't claim it.
  const flashing = blackedOut ? [] : state.flashing ?? [];
  $('flashNote').hidden = !flashing.length;
  $('flashNote').textContent = `Flash: ${flashing.map((id) => layout.groups.find((g) => g.id === id)?.name ?? id).join(', ')}`;
  const top = $('topBar');
  top.classList.toggle('problem', lost);
  top.classList.toggle('off', off);
  top.classList.toggle('flash', flashing.length > 0 && !lost && !off);

  const fade = state.fadeTime ?? null;
  $('fadeValue').textContent = fade === null ? 'Auto' : fade === 0 ? 'Instant' : `${fade} s`;
  $('fadeButton').classList.toggle('fixed', fade !== null);
  for (const b of fadeMenu.querySelectorAll('button')) {
    const v = b.dataset.fade === 'auto' ? null : Number(b.dataset.fade);
    b.classList.toggle('on', v === fade);
    b.setAttribute('aria-checked', String(v === fade));
  }

  // Running order: the item on stage is marked, and "changed" while it has live changes.
  const on = stageIndex();
  orderRows.forEach((row, k) => {
    const active = k === on;
    row.button.classList.toggle('on', active);
    row.button.setAttribute('aria-current', active ? 'true' : 'false');
    row.mark.hidden = !(active && state.lookChanged);
  });

  // Bottom bar.
  const next = nextItem();
  $('nextName').textContent = next ? next.name : 'End of list';
  $('next').disabled = !next;
  $('undo').disabled = !state.canUndo;
  $('blackout').classList.toggle('on', blackedOut);
  if (!master.dragging) master.set(state.master);

  renderDetails();
}

// ---- Master: a horizontal fader ----

/**
 * Dragging moves it relative to where the finger started, so touching the
 * fader never makes it jump; the server smooths every move. Tapping the bar
 * twice goes back to 100%.
 */
const master = (() => {
  const box = $('masterFader');
  const track = $('masterTrack');
  const m = {
    dragging: false, v: 1,
    set(v) {
      m.v = Math.min(1, Math.max(0, v));
      const pct = `${Math.round(m.v * 100)}%`;
      $('masterValue').textContent = pct;
      $('masterFill').style.width = `${m.v * 100}%`;
      $('masterHandle').style.left = `${m.v * 100}%`;
      track.setAttribute('aria-valuenow', String(Math.round(m.v * 100)));
    },
  };
  const sendLevel = (v) => send({ type: 'master', value: v });
  let startX = 0, startV = 0, moved = false, timer = 0, lastTap = 0;
  box.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    m.dragging = true;
    moved = false;
    // Keep receiving moves when the finger slides off the fader.
    try { box.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    box.classList.add('dragging');
    startX = ev.clientX;
    startV = m.v;
  });
  box.addEventListener('pointermove', (ev) => {
    if (!m.dragging) return;
    if (Math.abs(ev.clientX - startX) > 4) moved = true;
    m.set(startV + (ev.clientX - startX) / track.clientWidth);
    // At most one update every 40 ms while dragging.
    if (!timer) timer = setTimeout(() => { timer = 0; sendLevel(m.v); }, 40);
  });
  const end = () => {
    if (!m.dragging) return;
    m.dragging = false;
    box.classList.remove('dragging');
    clearTimeout(timer);
    timer = 0;
    if (!moved) {
      const now = Date.now();
      if (now - lastTap < 400) { m.set(1); sendLevel(1); lastTap = 0; } else { lastTap = now; m.set(startV); }
      return;
    }
    sendLevel(m.v);
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  return m;
})();

// ---- Details: one row per group, Save / Back, and the colour picker ----

const NEUTRAL = '#5a5f69';
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** `live:<group>:<#rrggbb>` is a colour picked with Any colour. */
function liveColour(id) {
  const m = /^live:([^:]+):(#[0-9a-f]{6})$/i.exec(id ?? '');
  return m ? m[2].toLowerCase() : null;
}

/** Name and colour to show for a preset id of a group (never throws on an id the layout doesn't list). */
function presetInfo(group, id) {
  if (id === null || id === undefined || id === '__blackout') return { name: 'Off', colour: null };
  if (id === '__safe') return { name: 'Basic light', colour: '#ffd2a0' };
  const hex = liveColour(id);
  if (hex) return { name: 'Custom', colour: hex };
  const p = group?.presets.find((x) => x.id === id);
  if (p) return { name: p.name, colour: p.swatch ?? NEUTRAL };
  return { name: 'Custom', colour: NEUTRAL };
}

/** At most one send every 40 ms while a finger moves; `end` always sends the last value. */
function throttle(sendValue) {
  let timer = 0, last;
  return {
    push(v) {
      last = v;
      if (!timer) timer = setTimeout(() => { timer = 0; sendValue(last); }, 40);
    },
    end(v) {
      clearTimeout(timer);
      timer = 0;
      sendValue(v);
    },
  };
}

/** The running-order item on stage, or null (Blackout, nothing yet, or a look that isn't in the order). */
function stageItem() {
  const k = stageIndex();
  return k >= 0 ? layout.runningOrder[k] : null;
}

// One entry per group: { group, chip, sw, chipName, dim, lvl, tint, handle, pct, dragging, holdUntil }.
let detailRows = [];

function showLevel(row, v) {
  const p = clamp01(v);
  row.value = p;
  row.lvl.style.width = `${p * 100}%`;
  row.tint.style.width = `${p * 100}%`;
  row.handle.style.left = `calc(${p * 100}% - ${p * 4}px)`;
  row.pct.textContent = `${Math.round(p * 100)}%`;
  row.dim.setAttribute('aria-valuenow', String(Math.round(p * 100)));
}

function buildDetails() {
  const root = $('groupRows');
  root.replaceChildren();
  detailRows = [];
  for (const group of layout.groups) {
    const box = el('div', 'row');
    const sw = el('i');
    const chipName = el('span');
    const chip = el('button', 'chip');
    chip.append(sw, chipName);
    chip.setAttribute('aria-label', `${group.name}: choose colour`);
    const lvl = el('span', 'lvl'), tint = el('span', 'tint'), handle = el('span', 'handle');
    const dim = el('div', 'dim');
    dim.setAttribute('role', 'slider');
    dim.setAttribute('aria-label', `${group.name} dimmer`);
    dim.setAttribute('aria-valuemin', '0');
    dim.setAttribute('aria-valuemax', '100');
    dim.append(lvl, tint, handle);
    const pct = el('span', 'pct');
    box.append(el('span', 'g', group.name), chip, dim, pct);
    root.append(box);
    const row = { group, chip, sw, chipName, dim, lvl, tint, handle, pct, value: 0, dragging: false, holdUntil: 0 };
    detailRows.push(row);
    showLevel(row, 0);
    chip.addEventListener('click', () => openPicker(group.id));
    wireDimmer(row);
  }
  // A new layout can drop the group the picker was showing.
  if (picker.group && !layout.groups.some((g) => g.id === picker.group)) closePicker();
  else if (picker.group) buildPickerGrid();
}

/**
 * Dragging moves the level relative to where the finger started, so touching a
 * dimmer never makes the lights jump (same as Master).
 */
function wireDimmer(row) {
  const out = throttle((v) => send({ type: 'groupLevel', group: row.group.id, value: v }));
  let startX = 0, startV = 0;
  row.dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    row.dragging = true;
    try { row.dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    row.dim.classList.add('dragging');
    startX = ev.clientX;
    startV = row.value;
  });
  row.dim.addEventListener('pointermove', (ev) => {
    if (!row.dragging) return;
    showLevel(row, startV + (ev.clientX - startX) / row.dim.clientWidth);
    out.push(row.value);
  });
  const end = () => {
    if (!row.dragging) return;
    row.dragging = false;
    row.dim.classList.remove('dragging');
    // Keep what the finger set until the server has caught up with it.
    row.holdUntil = performance.now() + 600;
    if (row.value !== startV) out.end(row.value);
  };
  row.dim.addEventListener('pointerup', end);
  row.dim.addEventListener('pointercancel', end);
}

function renderDetails() {
  const item = stageItem();
  $('dTitle').textContent = item ? item.name : state.look === 'blackout' ? 'Blackout' : 'Details';
  // Without an item on stage there is nothing to save into or go back to.
  $('backBtn').hidden = !item || !state.lookChanged;
  $('saveBtn').hidden = !item;
  if (item) {
    $('backBtn').textContent = `Back to ${item.name}`;
    $('saveBtn').querySelector('.label').replaceChildren(`Save to ${item.name} `, el('small', null, 'hold'));
  }
  const now = performance.now();
  for (const row of detailRows) {
    const s = state.groups?.[row.group.id];
    const info = presetInfo(row.group, s?.preset);
    row.sw.style.background = info.colour ?? '#0d0e11';
    row.chipName.textContent = info.name;
    row.tint.style.background = info.colour ?? 'transparent';
    if (!row.dragging && now >= row.holdUntil) showLevel(row, s?.level ?? 0);
  }
  if (picker.group) renderPicker();
  if (qs.open) renderSheet();
}

// Back and Save.
$('backBtn').addEventListener('click', () => send({ type: 'backToLook' }));

// Save needs a 1 s hold; letting go early does nothing.
const saveBtn = $('saveBtn');
let saveTimer = 0;
let saveFor = null;
saveBtn.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  const item = stageItem();
  if (!item) return;
  saveFor = item.id;
  saveBtn.classList.add('holding');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveBtn.classList.remove('holding');
    // Only if the same item is still on stage; for Basic lights the id is the safe look's.
    const now = stageItem();
    if (now && now.id === saveFor) send({ type: 'saveItem', id: now.id });
  }, 1000);
});
const stopSave = () => {
  clearTimeout(saveTimer);
  saveBtn.classList.remove('holding');
};
for (const e of ['pointerup', 'pointerleave', 'pointercancel']) saveBtn.addEventListener(e, stopSave);
saveBtn.addEventListener('click', (ev) => ev.preventDefault());

// ---- Colour picker (covers the details panel only) ----

const picker = { group: null };

const HUE_STOPS = ['#ff0000', '#ffc800', '#00ff00', '#00ffc8', '#0000ff', '#8c00ff', '#ff008c', '#ff0000'];
const WHITE_STOPS = ['#ffb46b', '#f4f8ff'];

/** The colour a strip shows at position p (0..1), blended like the CSS gradient does. */
function stripColour(stops, p) {
  const x = clamp01(p) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const t = x - i;
  const rgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const a = rgb(stops[i]), b = rgb(stops[i + 1]);
  return `#${a.map((v, k) => Math.round(v + (b[k] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

const pickerRow = () => detailRows.find((r) => r.group.id === picker.group);

function buildPickerGrid() {
  const row = pickerRow();
  if (!row) return;
  const grid = $('pGrid');
  grid.replaceChildren();
  for (const p of row.group.presets) {
    const b = el('button', 'pc');
    b.dataset.preset = p.id;
    const sw = el('i');
    sw.style.background = p.swatch ?? NEUTRAL;
    b.append(sw, el('span', null, p.name));
    b.addEventListener('click', () => send({ type: 'groupPreset', group: row.group.id, preset: p.id }));
    grid.append(b);
  }
  $('pTitle').textContent = row.group.name;
  $('pAnyLab').textContent = row.group.whiteOnly ? 'Any white, warm to cool' : 'Any colour';
  $('pAny').className = `strip2 ${row.group.whiteOnly ? 'cct' : 'hue'}`;
  $('pAny').setAttribute('aria-label', $('pAnyLab').textContent);
}

/** Keeps "current", the highlighted swatch and the dimmer in step with the live state. */
function renderPicker() {
  const row = pickerRow();
  if (!row) return;
  const s = state.groups?.[row.group.id];
  const info = presetInfo(row.group, s?.preset);
  $('pCurSw').style.background = info.colour ?? '#0d0e11';
  $('pCurText').textContent = `${info.name} · ${Math.round((s?.level ?? 0) * 100)}%`;
  for (const b of $('pGrid').children) b.classList.toggle('on', b.dataset.preset === s?.preset);
}

function openPicker(groupId) {
  closeSheet();
  if (picker.group !== groupId) {
    $('pAnyH').hidden = true;
  }
  picker.group = groupId;
  buildPickerGrid();
  showPickerTab('col');
  $('picker').hidden = false;
  renderPicker();
}

function closePicker() {
  picker.group = null;
  $('picker').hidden = true;
}

function showPickerTab(name) {
  for (const t of document.querySelectorAll('[data-pt]')) {
    const on = t.dataset.pt === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  }
  $('pCol').hidden = name !== 'col';
  $('pFx').hidden = name !== 'fx';
}

$('pDone').addEventListener('click', closePicker);
for (const t of document.querySelectorAll('[data-pt]')) t.addEventListener('click', () => showPickerTab(t.dataset.pt));

// Any colour: picking sends right away; moves are throttled and the last one always goes.
(() => {
  const strip = $('pAny');
  const out = throttle((hex) => {
    if (picker.group) send({ type: 'groupColour', group: picker.group, colour: hex });
  });
  let dragging = false;
  const pick = (ev) => {
    const r = strip.getBoundingClientRect();
    const p = clamp01((ev.clientX - r.left) / r.width);
    const row = pickerRow();
    if (!row) return null;
    $('pAnyH').hidden = false;
    $('pAnyH').style.left = `calc(${p * 100}% - ${p * 4}px)`;
    return stripColour(row.group.whiteOnly ? WHITE_STOPS : HUE_STOPS, p);
  };
  let hex = null;
  strip.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    dragging = true;
    try { strip.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    hex = pick(ev);
    if (hex) out.push(hex);
  });
  strip.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    hex = pick(ev) ?? hex;
    if (hex) out.push(hex);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (hex) out.end(hex);
    hex = null;
  };
  strip.addEventListener('pointerup', end);
  strip.addEventListener('pointercancel', end);
})();

// ---- Quick looks: tabs and grid ----

let quickTab = 'plain';

function showQuickTab(name) {
  quickTab = name;
  for (const t of document.querySelectorAll('[data-qt]')) {
    const on = t.dataset.qt === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  }
  buildQuick();
}
for (const t of document.querySelectorAll('[data-qt]')) t.addEventListener('click', () => showQuickTab(t.dataset.qt));

function buildQuick() {
  const grid = $('qGrid');
  grid.replaceChildren();
  const mine = (layout?.quickLooks ?? []).filter((q) => q.tab === quickTab);
  for (const q of mine) {
    const b = el('button', 'ql');
    b.append(el('span', 'qname', q.name));
    // A thin strip along the bottom: one block per group, the colour this quick look gives it.
    const strip = el('span', 'qstrip');
    (q.colours ?? []).forEach((c, i) => {
      const block = el('i');
      if (c) block.style.background = c;
      block.title = layout.groups[i]?.name ?? '';
      strip.append(block);
    });
    b.append(strip);
    b.addEventListener('click', () => send({ type: 'quickLook', id: q.id }));
    grid.append(b);
  }
  if (!mine.length) grid.append(el('span', 'qnone', 'None yet.'));
  const add = el('button', 'ql newq', '＋ Save stage as quick look');
  add.addEventListener('click', openSheet);
  grid.append(add);
}

// ---- New quick look sheet (covers the details panel, like the colour picker) ----

const qs = { open: false, tab: 'plain', left: new Set(), saved: 'plain' };

function openSheet() {
  closePicker();
  qs.open = true;
  qs.tab = quickTab;
  qs.left = new Set();
  pendingSave = null;
  $('qsName').value = '';
  buildSheetGroups();
  $('qSheet').hidden = false;
  renderSheet();
}

function closeSheet() {
  qs.open = false;
  pendingSave = null;
  $('qSheet').hidden = true;
  $('qsName').blur();
}

/** One tile per group; tapping one toggles "left out". */
function buildSheetGroups() {
  const root = $('qsGroups');
  root.replaceChildren();
  if (!layout) return;
  const ids = new Set(layout.groups.map((g) => g.id));
  for (const id of [...qs.left]) if (!ids.has(id)) qs.left.delete(id);
  for (const group of layout.groups) {
    const b = el('button');
    b.dataset.group = group.id;
    const line = el('span', 'gs');
    line.append(el('i'), el('span'));
    b.append(el('span', 'gn', group.name), line, el('span', 'gl'));
    b.addEventListener('click', () => {
      if (qs.left.has(group.id)) qs.left.delete(group.id); else qs.left.add(group.id);
      renderSheet();
    });
    root.append(b);
  }
}

function renderSheet() {
  if (!qs.open || !layout) return;
  for (const b of $('qsTab').children) {
    const on = b.dataset.t === qs.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  for (const b of $('qsGroups').children) {
    const group = layout.groups.find((g) => g.id === b.dataset.group);
    const s = state?.groups?.[b.dataset.group];
    const info = presetInfo(group, s?.preset);
    const left = qs.left.has(b.dataset.group);
    b.classList.toggle('off', left);
    b.setAttribute('aria-pressed', String(!left));
    b.querySelector('i').style.background = info.colour ?? '#0d0e11';
    b.querySelector('.gs span').textContent = left ? 'left out' : info.name;
    b.querySelector('.gl').textContent = left ? '' : `${Math.round((s?.level ?? 0) * 100)}%`;
  }
  $('qsSave').disabled = pendingSave !== null;
}

for (const b of $('qsTab').children) {
  b.addEventListener('click', () => {
    qs.tab = b.dataset.t;
    renderSheet();
  });
}
$('qsCancel').addEventListener('click', closeSheet);
// The keyboard's Done closes the keyboard; nothing else on the page reacts to typing.
$('qsName').addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter') $('qsName').blur();
});
// A plain tap: a new quick look overwrites nothing. The sheet closes when the server says yes.
$('qsSave').addEventListener('click', () => {
  if (pendingSave !== null || !layout) return;
  const groups = layout.groups.map((g) => g.id).filter((id) => !qs.left.has(id));
  // The server would say this too, but in less friendly words.
  if (!groups.length) {
    toast('pick at least one group');
    return;
  }
  qs.saved = qs.tab;
  pendingSave = send({ type: 'saveQuickLook', name: $('qsName').value, tab: qs.tab, groups });
  renderSheet();
});

function finishSaveQuick() {
  const tab = qs.saved;
  closeSheet();
  showQuickTab(tab);
}

// ---- Mini visualiser (for looking only) ----

const canvas = $('stage');
const ctx = canvas.getContext('2d');

function drawStage() {
  if (!layout) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = 14, r = Math.max(5, Math.min(9, h / 16));
  layout.fixtures.forEach((f, k) => {
    const x = pad + f.x * (w - 2 * pad), y = pad + f.y * (h - 2 * pad);
    const R = visual[k * 3] ?? 0, G = visual[k * 3 + 1] ?? 0, B = visual[k * 3 + 2] ?? 0;
    const lit = Math.max(R, G, B) / 255;
    if (f.w || f.h) {
      // A bar or strip: a lit rounded rectangle at its real size.
      const bw = Math.max(8, (f.w ?? 0) * (w - 2 * pad)), bh = Math.max(8, (f.h ?? 0) * (h - 2 * pad));
      ctx.save();
      if (lit > 0.02) {
        ctx.shadowColor = `rgba(${R},${G},${B},${0.8 * lit})`;
        ctx.shadowBlur = 10;
      }
      ctx.beginPath();
      ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, 4);
      ctx.fillStyle = `rgb(${R},${G},${B})`;
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#3a3f48';
      ctx.stroke();
      return;
    }
    if (lit > 0.02) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
      glow.addColorStop(0, `rgba(${R},${G},${B},${0.55 * lit})`);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - r * 3.2, y - r * 3.2, r * 6.4, r * 6.4);
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${R},${G},${B})`;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#3a3f48';
    ctx.stroke();
  });
}

window.addEventListener('resize', drawStage);

// ---- Blackout needs a 1 s hold so a stray tap never darkens the room ----

const blackout = $('blackout');
let holdTimer = 0;
const startHold = (ev) => {
  ev.preventDefault();
  blackout.classList.add('holding');
  holdTimer = setTimeout(() => {
    blackout.classList.remove('holding');
    send({ type: 'blackout' });
  }, 1000);
};
const stopHold = () => {
  clearTimeout(holdTimer);
  blackout.classList.remove('holding');
};
blackout.addEventListener('pointerdown', startHold);
for (const e of ['pointerup', 'pointerleave', 'pointercancel']) blackout.addEventListener(e, stopHold);
blackout.addEventListener('click', (ev) => ev.preventDefault());

// ---- Clock, toast, wake lock ----

function tick() {
  const d = new Date();
  $('clock').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
setInterval(tick, 10_000);
tick();

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// Keep the screen awake. iPad Safari only allows this on HTTPS pages; on plain
// HTTP set the tablet's Auto-Lock to Never instead.
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch {
    // not available here
  }
}
document.addEventListener('visibilitychange', keepAwake);
keepAwake();

connect();
