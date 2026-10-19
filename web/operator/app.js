// Operator page. The server is the single source of truth: this page only
// sends commands and shows the live state it is given.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * How a light's colour is drawn on screen. Whites (light colours with little
 * colour in them: warm white #ffb46b, cool white #dcebff, the safe light) are
 * drawn as soft whites instead of their raw values, which look orange or blue
 * on a screen. Saturated colours are left as they are. Only the drawing
 * changes; what is sent to the lights doesn't.
 */
const CREAM = [241, 236, 228];
function shownRgb(r, g, b) {
  const max = Math.max(r, g, b);
  if (max <= 0) return [r, g, b];
  const chroma = (max - Math.min(r, g, b)) / max;
  if (chroma >= 0.65) return [r, g, b];
  // Mix the colour (at full brightness) 60 % towards cream, then put its brightness back.
  const k = max / 255;
  return [r, g, b].map((v, i) => Math.round(((v / k) * 0.4 + CREAM[i] * 0.6) * k));
}
function shown(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = shownRgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

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
// The ref of an Add to colours that the server hasn't answered yet.
let pendingColour = null;

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
      // Move Preview off an item that is gone (before the list is drawn, so the outline goes to the new one).
      if (preview.on && !previewItem()) {
        preview.item = defaultPreviewItem();
        previewVisual = null;
      }
      buildOrder();
      buildDetails();
      buildQuick();
      buildSheetGroups();
      buildFlash();
      // The show changed (maybe this item): ask for its picture again.
      if (preview.on) loadPreviewVisual();
      render();
    } else if (msg.type === 'state') {
      if (state && msg.state.look !== seenLook) previousLook = seenLook;
      seenLook = msg.state.look;
      state = msg.state;
      render();
    } else if (msg.type === 'result') {
      orderResult(msg);
      if (msg.ref !== null && msg.ref === pendingSave) {
        // The answer to the sheet's Save: on an error the sheet stays open to fix it.
        pendingSave = null;
        if (!msg.error) finishSaveQuick();
        else renderSheet();
      }
      if (msg.ref !== null && msg.ref === pendingColour) finishAddColour(msg.error);
      if (msg.ref !== null && msg.ref === pendingEdit) finishEdit(msg.error);
      if (itemSave && msg.ref === itemSave.ref) {
        if (!msg.error) toast(`Saved to ${itemSave.name}`, true);
        itemSave = null;
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
  if (!on) {
    // The server puts a flash out when it loses us; show the same here.
    for (const h of flashHeld.values()) h.button.classList.remove('down');
    flashHeld.clear();
    // Answers that can no longer come: let a tap on ＋ Add song go through again.
    pendingAdd = null;
    addWanted = false;
    renames.clear();
    moves.clear();
    // After a reconnect Preview is off, as after a reload.
    setPreview(false);
  }
  if (!on && pendingEdit !== null) {
    pendingEdit = null;
    pendingEditNext = [];
    $('peSave').disabled = false;
    $('feSave').disabled = false;
    $('feCopy').disabled = false;
  }
  if (!on && pendingColour !== null) {
    pendingColour = null;
    $('paAddBtn').disabled = false;
  }
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

// ---- Groups: lights, and smoke or haze machines ----

/** A smoke or haze machine: a level and a Puff button, no colour, no Flash, never set by a look. */
const isSmoke = (group) => group?.kind === 'smoke';
const lightGroups = () => (layout?.groups ?? []).filter((g) => !isSmoke(g));

/** Colour-strip blocks for a look, one per light group (smoke groups have no colour). */
function stripBlocks(colours) {
  const blocks = [];
  (colours ?? []).forEach((c, i) => {
    const group = layout.groups[i];
    if (isSmoke(group)) return;
    blocks.push({ colour: c, name: group?.name ?? '' });
  });
  return blocks;
}

// ---- Running order ----

const isBasic = (item) => item.id === layout?.basicLights;

/** Start an item: Basic lights is the show's Safe look; every other item is a look. */
function start(item) {
  send(isBasic(item) ? { type: 'safe' } : { type: 'look', id: item.id });
}

// Editing the running order. While `editing`, rows are fields and handles and
// tapping a row starts nothing.
let editing = false;
// Rows now on screen in edit mode, in order: { id, el, input, del }.
let editRows = [];
// The item whose ⊖ was tapped once and now says "Delete".
let confirmDelete = null;
// A drag in progress: the page keeps the list still until it ends.
let drag = null;
let orderStale = false;
// Items the list showed last time, to spot the one a ＋ Add song made.
let knownIds = null;
let addWanted = false;
let pendingAdd = null;
// Rename and move commands the server hasn't answered yet, by ref.
const renames = new Map();
const moves = new Set();
// Set while the list is being replaced, so removing a field is not taken for the user leaving it.
let rebuilding = false;
// The item that was on stage when the list last scrolled to it.
let revealedId = null;

/** Scrolls the running order just enough to show `node`. */
function reveal(node) {
  const list = $('runningOrder');
  const l = list.getBoundingClientRect(), n = node.getBoundingClientRect();
  if (n.top < l.top) list.scrollTop -= l.top - n.top + 4;
  else if (n.bottom > l.bottom) list.scrollTop += n.bottom - l.bottom + 4;
}

function buildOrder() {
  // A broadcast during a drag waits, so the list never moves under the finger.
  if (drag) {
    orderStale = true;
    return;
  }
  orderStale = false;
  const order = layout.runningOrder ?? [];
  const added = knownIds ? order.filter((i) => !knownIds.has(i.id)).map((i) => i.id) : [];
  knownIds = new Set(order.map((i) => i.id));
  if (confirmDelete && !knownIds.has(confirmDelete)) confirmDelete = null;
  const list = $('runningOrder');
  const top = list.scrollTop;
  if (editing) buildEditRows(order);
  else buildPlainRows(order);
  markSelected();
  list.scrollTop = top;
  if (addWanted && added.length) {
    addWanted = false;
    const node = editing ? editRows.find((r) => r.id === added[0])?.el : orderRows.find((r) => r.item.id === added[0])?.button;
    if (node) reveal(node);
  }
}

function replaceRows(nodes) {
  rebuilding = true;
  $('runningOrder').replaceChildren(...nodes);
  rebuilding = false;
}

function buildPlainRows(order) {
  const nodes = [];
  orderRows = [];
  editRows = [];
  order.forEach((item, k) => {
    const basic = isBasic(item);
    const b = el('button', basic ? 'item fixed' : 'item');
    // One small dot per group (smoke machines left out), in group order: the colour this item
    // gives it, whites drawn as whites. Basic lights' groups without a saved colour run the built-in warm light.
    const strip = el('span', 'dots');
    for (const { colour: c, name } of stripBlocks(item.colours)) {
      const colour = c ?? (basic ? layout.basicSwatch : null);
      const dot = el('i', colour ? null : 'unset');
      if (colour) dot.style.background = shown(colour);
      dot.title = name;
      strip.append(dot);
    }
    const mark = el('span', 'mark', 'changed');
    mark.hidden = true;
    b.append(strip, el('span', 'name', item.name), mark);
    // In Preview a tap picks the item to look at; it starts nothing.
    b.addEventListener('click', () => (preview.on ? selectItem(item.id) : start(item)));
    nodes.push(b);
    orderRows.push({ item, button: b, mark });
    if (basic && k < order.length - 1) nodes.push(el('div', 'sep'));
  });
  replaceRows(nodes);
}

const currentName = (id) => layout?.runningOrder.find((i) => i.id === id)?.name;
const isRenaming = (id) => [...renames.values()].some((r) => r.id === id);

function showDeleteState(row) {
  if (row.fixed) return;
  const sure = confirmDelete === row.id;
  row.del.classList.toggle('sure', sure);
  row.del.textContent = sure ? 'Delete' : '⊖';
  row.del.setAttribute('aria-label', sure ? `Delete ${currentName(row.id) ?? ''}: tap again to confirm` : `Delete ${currentName(row.id) ?? ''}`);
}

function buildEditRows(order) {
  const same = orderRows.length === 0 && editRows.length === order.length && editRows.every((r, k) => r.id === order[k].id);
  if (same) {
    // Same items in the same order: only fresh names go in, and never over what is being typed.
    editRows.forEach((row, k) => {
      if (row.fixed) return;
      if (document.activeElement !== row.input && !isRenaming(row.id)) row.input.value = order[k].name;
      row.name = order[k].name;
      showDeleteState(row);
    });
    return;
  }
  // The list changed under us: rebuild, but carry over a name that is being typed or not answered yet.
  const keep = new Map();
  for (const row of editRows) {
    if (row.fixed) continue;
    const focused = document.activeElement === row.input;
    if (focused || isRenaming(row.id) || row.input.value !== row.name) {
      keep.set(row.id, { value: row.input.value, focused, from: row.input.selectionStart, to: row.input.selectionEnd });
    }
  }
  orderRows = [];
  editRows = [];
  const nodes = [];
  let refocus = null;
  for (const item of order) {
    if (isBasic(item)) {
      const fixed = el('div', 'erow fixed');
      fixed.append(item.name, el('small', null, '· always first'));
      nodes.push(fixed);
      editRows.push({ id: item.id, fixed: true, el: fixed });
      continue;
    }
    const node = el('div', 'erow');
    const del = el('button', 'del', '⊖');
    const input = el('input', 'ename');
    input.type = 'text';
    input.name = 'name';
    input.value = item.name;
    input.maxLength = 40;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('aria-label', 'Name');
    const grip = el('span', 'grip', '≡');
    grip.setAttribute('role', 'button');
    grip.setAttribute('aria-label', 'Drag to move');
    node.append(del, input, grip);
    const row = { id: item.id, name: item.name, el: node, input, del };
    editRows.push(row);
    nodes.push(node);
    showDeleteState(row);
    const k = keep.get(item.id);
    if (k) {
      input.value = k.value;
      if (k.focused) refocus = { input, from: k.from, to: k.to };
    }
    wireEditRow(row, grip);
  }
  replaceRows(nodes);
  if (refocus) {
    refocus.input.focus({ preventScroll: true });
    try { refocus.input.setSelectionRange(refocus.from, refocus.to); } catch { /* no caret to restore */ }
  }
}

function wireEditRow(row, grip) {
  row.del.addEventListener('click', () => {
    if (confirmDelete === row.id) {
      confirmDelete = null;
      send({ type: 'deleteItem', id: row.id });
      showDeleteState(row);
    } else {
      confirmDelete = row.id;
      editRows.forEach(showDeleteState);
    }
  });
  row.input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    // Enter while a keyboard is still composing a letter (accents, other scripts) only finishes the letter.
    if (ev.key === 'Enter' && !ev.isComposing) row.input.blur();
  });
  row.input.addEventListener('blur', () => commitName(row));
  wireDrag(row, grip);
}

/** Sends a changed name when the user leaves the field (Enter or tapping away). */
function commitName(row) {
  if (rebuilding || !layout) return;
  const name = currentName(row.id);
  const value = row.input.value;
  if (name === undefined || value === name) return;
  if ([...renames.values()].some((r) => r.id === row.id && r.value === value)) return;
  const r = send({ type: 'renameItem', id: row.id, name: value });
  if (r === null) row.input.value = name;
  else renames.set(r, { id: row.id, value });
}

/** The server answered a rename, a move or an add. */
function orderResult(msg) {
  const rename = renames.get(msg.ref);
  if (rename) {
    renames.delete(msg.ref);
    // Fresh names already arrived with the layout; the field takes what the server kept
    // (the old name after an error), unless the user has gone back to typing in it.
    const row = editRows.find((r) => r.id === rename.id);
    const name = currentName(rename.id);
    if (row && name !== undefined && document.activeElement !== row.input && !isRenaming(rename.id)) row.input.value = name;
  }
  if (moves.delete(msg.ref) && msg.error) buildOrder();
  if (msg.ref !== null && msg.ref === pendingAdd) {
    pendingAdd = null;
    if (msg.error) addWanted = false;
  }
}

/**
 * Drag the ≡ handle to reorder. The row follows the finger, the rows it passes
 * make room, and one moveItem goes out on release. Tapping the handle sends nothing.
 */
function wireDrag(row, grip) {
  grip.addEventListener('pointerdown', (ev) => {
    if (drag) return;
    ev.preventDefault();
    // Leaving a field being typed in sends its rename first.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const list = $('runningOrder');
    const listTop = list.getBoundingClientRect().top;
    const rects = editRows.map((r) => r.el.getBoundingClientRect());
    const f = editRows.indexOf(row);
    // Slots are the rows' places, in list coordinates (so scrolling during the drag keeps them right).
    const slot = rects.length > 1 ? rects[1].top - rects[0].top : rects[0].height + 2;
    drag = {
      row, f, t: f, slot, pointerId: ev.pointerId, startY: ev.clientY, y: ev.clientY, startScroll: list.scrollTop, raf: 0,
      // Where the first row starts, and this row's own start, both in list coordinates.
      base: rects[0].top - listTop + list.scrollTop,
      own: rects[f].top - listTop + list.scrollTop,
      count: editRows.length,
    };
    try { grip.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    row.el.classList.add('dragging');
    list.classList.add('reordering');
    drag.raf = requestAnimationFrame(dragFrame);
  });
  grip.addEventListener('pointermove', (ev) => {
    if (!drag || drag.row !== row || ev.pointerId !== drag.pointerId) return;
    drag.y = ev.clientY;
    dragUpdate();
  });
  const end = (cancelled) => (ev) => {
    if (!drag || drag.row !== row || ev.pointerId !== drag.pointerId) return;
    finishDrag(cancelled);
  };
  grip.addEventListener('pointerup', end(false));
  grip.addEventListener('pointercancel', end(true));
}

/** While the finger is near the top or bottom edge, the list scrolls so the drag can go further. */
function dragFrame() {
  if (!drag) return;
  const list = $('runningOrder');
  const r = list.getBoundingClientRect();
  const edge = 44;
  if (drag.y < r.top + edge) list.scrollTop -= Math.ceil((r.top + edge - drag.y) / 4);
  else if (drag.y > r.bottom - edge) list.scrollTop += Math.ceil((drag.y - (r.bottom - edge)) / 4);
  dragUpdate();
  drag.raf = requestAnimationFrame(dragFrame);
}

function dragUpdate() {
  const list = $('runningOrder');
  const d = drag;
  const dy = d.y - d.startY + (list.scrollTop - d.startScroll);
  d.row.el.style.transform = `translateY(${dy}px)`;
  // The slot nearest the dragged row's top; Basic lights (slot 0) is never a place to land.
  const t = Math.min(d.count - 1, Math.max(1, Math.round((d.own + dy - d.base) / d.slot)));
  d.t = t;
  editRows.forEach((r, j) => {
    if (r === d.row) return;
    let shift = 0;
    if (t > d.f && j > d.f && j <= t) shift = -d.slot;
    else if (t < d.f && j >= t && j < d.f) shift = d.slot;
    r.el.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function finishDrag(cancelled) {
  const d = drag;
  cancelAnimationFrame(d.raf);
  drag = null;
  const list = $('runningOrder');
  list.classList.remove('reordering');
  d.row.el.classList.remove('dragging');
  for (const r of editRows) r.el.style.transform = '';
  const move = !cancelled && d.t !== d.f;
  let ok = false;
  if (move) {
    const r = send({ type: 'moveItem', id: d.row.id, to: d.t });
    if (r !== null) {
      moves.add(r);
      ok = true;
    }
  }
  if (ok && !orderStale) {
    // Show the new order at once; the broadcast that follows agrees with it.
    editRows.splice(d.f, 1);
    editRows.splice(d.t, 0, d.row);
    const top = list.scrollTop;
    replaceRows(editRows.map((r) => r.el));
    list.scrollTop = top;
  } else if (orderStale || move) {
    buildOrder();
  }
}

function setEditing(on) {
  if (drag || on === editing) return;
  // Editing the order and Preview don't mix.
  if (on) setPreview(false);
  // On a tablet a tap on this button doesn't leave the field, so do it here: it sends the rename.
  if (document.activeElement instanceof HTMLElement && $('runningOrder').contains(document.activeElement)) document.activeElement.blur();
  editing = on;
  confirmDelete = null;
  revealedId = null;
  $('editBtn').textContent = on ? 'Done' : 'Edit';
  $('editBtn').classList.toggle('on', on);
  $('editBtn').setAttribute('aria-pressed', String(on));
  if (layout) {
    buildOrder();
    render();
  }
}
$('editBtn').addEventListener('click', () => setEditing(!editing));

// ---- Preview: look at an item, and change it, without touching the stage ----
// Only this tablet knows it is on; the server's stage and show are untouched by selecting.

const preview = { on: false, item: null };
// What the selected item looks like settled (3 bytes per fixture), or null until the server has answered.
// While it is null the picture is drawn dark, never as the live stage.
let previewVisual = null;
// The "Preview" label's font and colour, read from the page once when Preview turns on.
let previewLabel = null;
// Counts the asks for a picture, so a slow answer for an earlier choice is dropped.
let previewSeq = 0;

/** The selected running-order item, or null. */
function previewItem() {
  return layout?.runningOrder.find((i) => i.id === preview.item) ?? null;
}

/** The item Preview opens on, and falls back to: what is on stage, else what Next would start. */
const defaultPreviewItem = () => (stageItem() ?? nextItem() ?? layout?.runningOrder[0] ?? null)?.id ?? null;

function markSelected() {
  orderRows.forEach((row) => row.button.classList.toggle('selected', preview.on && row.item.id === preview.item));
}

function setPreview(on) {
  if (on === preview.on) return;
  if (on) {
    if (!layout || phoneQuery.matches) return;
    if (editing) {
      setEditing(false);
      if (editing) return;
    }
  }
  preview.on = on;
  preview.item = on ? defaultPreviewItem() : null;
  // White, Amber and UV moves belong to what the picker showed before.
  extrasMoved = false;
  document.body.classList.toggle('preview', on);
  $('topBar').classList.toggle('preview', on);
  $('previewBtn').setAttribute('aria-pressed', String(on));
  if (on) {
    const style = getComputedStyle(document.body);
    previewLabel = { font: `11px ${style.fontFamily}`, colour: style.getPropertyValue('--ds-muted').trim() || '#8F9AB0' };
    // Things that work on other than the selected item: Save stage as quick look, the colour list's Edit and Add to colours.
    closeSheet();
    if (picker.edit) setEditMode(false);
    if (picker.group && !$('pAdd').hidden) closeAddColour();
    loadPreviewVisual();
  } else {
    // Drop any answer still on its way.
    previewSeq++;
    previewVisual = null;
    drawStage();
  }
  markSelected();
  render();
}
$('previewBtn').addEventListener('click', () => setPreview(!preview.on));

function selectItem(id) {
  if (!preview.on || preview.item === id) return;
  preview.item = id;
  previewVisual = null;
  extrasMoved = false;
  markSelected();
  loadPreviewVisual();
  render();
}

async function loadPreviewVisual() {
  const seq = ++previewSeq;
  if (!preview.on || !preview.item) {
    previewVisual = null;
    drawStage();
    return;
  }
  let bytes = null;
  try {
    const res = await fetch(`/api/looks/${encodeURIComponent(preview.item)}/visual`);
    if (res.ok) bytes = Uint8Array.from((await res.json()).visual);
  } catch {
    // Offline or the item is gone: the picture waits for the next layout.
  }
  if (seq !== previewSeq) return;
  // A failed ask keeps the picture there was (dark when there was none yet).
  if (bytes) previewVisual = bytes;
  drawStage();
}

// A tap anywhere else takes back a "Delete" that was waiting for its second tap.
document.addEventListener('pointerdown', (ev) => {
  if (confirmDelete && !(ev.target instanceof Element && ev.target.closest('.del.sure'))) {
    confirmDelete = null;
    editRows.forEach(showDeleteState);
  }
}, true);

$('addSong').addEventListener('click', () => {
  if (!layout || pendingAdd !== null) return;
  const order = layout.runningOrder ?? [];
  // After the item on stage; at the end when nothing is on stage.
  const after = stageItem()?.id ?? order[order.length - 1]?.id;
  if (!after) return;
  addWanted = true;
  pendingAdd = send({ type: 'addSong', after });
  if (pendingAdd === null) addWanted = false;
});

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
  // Nothing goes on stage while the running order is being edited.
  if (editing) return;
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

// ---- Tempo: beats per minute for the stage (in Preview, for the selected song) ----
// Live it sends `tempo`; in Preview, `itemTempo`. The readout shows the stage's tempo, or the
// selected song's saved one (120 when it has none). The menu steps by 1 (hold to repeat), ×2, ÷2.

const TEMPO_MIN = 40;
const TEMPO_MAX = 240;
const clampTempo = (bpm) => Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(bpm)));

const tempoMenu = $('tempoMenu');
const showTempoMenu = (open) => {
  tempoMenu.hidden = !open;
  $('tempoButton').setAttribute('aria-expanded', String(open));
  if (open) showFadeMenu(false);
};
$('tempoButton').addEventListener('click', () => showTempoMenu(tempoMenu.hidden));
$('fadeButton').addEventListener('click', () => showTempoMenu(false));
document.addEventListener('pointerdown', (ev) => {
  if (!tempoMenu.hidden && !tempoMenu.parentElement.contains(ev.target)) showTempoMenu(false);
}, true);
$('tempoCtl').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || tempoMenu.hidden) return;
  showTempoMenu(false);
  $('tempoButton').focus();
});

/** What the stage runs, or in Preview what the selected song is saved with. */
const shownTempo = () => Math.round(preview.on ? previewItem()?.tempo ?? 120 : state?.tempo ?? 120);

// A step shows at once; the server's answer takes over after a moment (so a held button doesn't jump back).
let tempoLocal = null;
let tempoLocalAt = 0;
function currentTempo() {
  if (tempoLocal !== null && performance.now() - tempoLocalAt < 700) return tempoLocal;
  tempoLocal = null;
  return shownTempo();
}

function sendTempo(bpm) {
  if (!preview.on) send({ type: 'tempo', bpm });
  else if (preview.item) send({ type: 'itemTempo', item: preview.item, bpm });
}

// A held button sends at most 4 a second (every change is an Undo step), and the last one when let go.
let tempoSentAt = 0;
let tempoUnsent = null;
function setTempo(bpm, throttle = false) {
  const v = clampTempo(bpm);
  tempoLocal = v;
  tempoLocalAt = performance.now();
  $('tempoValue').textContent = String(v);
  if (throttle && tempoLocalAt - tempoSentAt < 250) {
    tempoUnsent = v;
    return;
  }
  tempoSentAt = tempoLocalAt;
  tempoUnsent = null;
  sendTempo(v);
}
function flushTempo() {
  if (tempoUnsent === null) return;
  const v = tempoUnsent;
  tempoUnsent = null;
  tempoSentAt = performance.now();
  sendTempo(v);
}

for (const b of tempoMenu.querySelectorAll('button')) {
  const step = b.dataset.step;
  if (step === 'double' || step === 'half') {
    b.addEventListener('click', () => setTempo(currentTempo() * (step === 'double' ? 2 : 0.5)));
    continue;
  }
  const by = Number(step);
  let delay = null;
  let repeat = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(repeat);
    delay = repeat = null;
    flushTempo();
  };
  b.addEventListener('pointerdown', (ev) => {
    if (ev.button || b.disabled) return;
    b.setPointerCapture?.(ev.pointerId);
    setTempo(currentTempo() + by);
    delay = setTimeout(() => {
      repeat = setInterval(() => setTempo(currentTempo() + by, true), 80);
    }, 400);
  });
  b.addEventListener('pointerup', stop);
  b.addEventListener('pointercancel', stop);
  b.addEventListener('lostpointercapture', stop);
  // A key press arrives as a click with no pointer; a pointer's click was already handled on pointerdown.
  b.addEventListener('click', (ev) => {
    if (ev.detail === 0) setTempo(currentTempo() + by);
  });
}

// Tap: the average of the last 4 gaps; a gap over 2 s starts over. Sets the tempo from the second tap.
const tapTimes = [];
function tapTempo() {
  const t = performance.now();
  if (tapTimes.length && t - tapTimes[tapTimes.length - 1] > 2000) tapTimes.length = 0;
  tapTimes.push(t);
  if (tapTimes.length > 5) tapTimes.shift();
  const btn = $('tapBtn');
  btn.classList.add('hit');
  setTimeout(() => btn.classList.remove('hit'), 120);
  if (tapTimes.length < 2) return;
  setTempo((60000 * (tapTimes.length - 1)) / (t - tapTimes[0]));
}
$('tapBtn').addEventListener('pointerdown', (ev) => {
  if (!ev.button) tapTempo();
});
$('tapBtn').addEventListener('click', (ev) => {
  if (ev.detail === 0) tapTempo();
});

function renderTempo() {
  $('tempoValue').textContent = String(currentTempo());
  // In Preview with no song selected there is nothing to change.
  const none = preview.on && !previewItem();
  for (const b of $('tempoCtl').querySelectorAll('button')) {
    if (b !== $('tempoButton')) b.disabled = none;
  }
}

// ---- Rendering live state ----

/** What to call a look id in the top bar. */
function lookName(id) {
  if (id === 'blackout') return 'Blackout';
  if (id === 'safe') return layout.runningOrder.find(isBasic)?.name ?? 'Basic lights';
  return layout.runningOrder.find((i) => i.id === id)?.name ?? layout.looks.find((l) => l.id === id)?.name ?? (id ? 'Deleted item' : '—');
}

/** The full explanation behind the short status label in the top bar. */
let outputDetail = '';
$('outputNote').addEventListener('click', () => toast(outputDetail, true));

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
  // A short label; the full explanation on hover (title) or tap (a message).
  const otherDesk = lost && state.outputProblemKind === 'other-desk';
  $('outputText').textContent = !lost ? 'DMX output inactive' : otherDesk ? 'Another desk is sending' : 'Lights not answering';
  outputDetail = lost
    ? state.outputProblem ?? 'Lights not answering. Check the lighting network box.'
    : 'Light Runner is not sending to the lights (Lightkey has them). Turn Send DMX on in Settings.';
  note.title = outputDetail;
  $('quiet').hidden = lost || off;

  $('fading').hidden = !fading;
  if (fading) {
    $('fadeFill').style.width = `${Math.round(state.lookProgress * 100)}%`;
    $('fadeLeft').textContent = `${state.lookFadeLeft.toFixed(1)} s`;
  }
  // Flash does nothing during Blackout, so the bar doesn't claim it. A Puff shows as smoke, not as a flash.
  const groupOf = (id) => layout.groups.find((g) => g.id === id);
  const held = blackedOut ? [] : state.flashing ?? [];
  const flashing = held.filter((id) => !isSmoke(groupOf(id)));
  $('flashNote').hidden = !flashing.length;
  $('flashNote').textContent = `Flash: ${flashing.map((id) => groupOf(id)?.name ?? id).join(', ')}`;
  // A quiet readout while any smoke machine is running (the highest, if there are several).
  let smoke = 0;
  for (const g of layout.groups) {
    if (isSmoke(g)) smoke = Math.max(smoke, held.includes(g.id) ? 1 : state.groups?.[g.id]?.level ?? 0);
  }
  $('smokeNote').hidden = smoke <= 0;
  $('smokeNote').textContent = `Smoke: ${Math.round(smoke * 100)} %`;
  const top = $('topBar');
  top.classList.toggle('problem', lost);
  top.classList.toggle('off', off);
  top.classList.toggle('flash', flashing.length > 0 && !lost && !off);
  // Blackout is the most important state on the page: the whole bar says so.
  top.classList.toggle('blackout', blackedOut);

  renderTempo();
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
  // Keep what is on stage in view when it changes (and when editing ends).
  const onId = on >= 0 ? layout.runningOrder[on].id : null;
  if (!editing && orderRows.length && onId !== revealedId) {
    revealedId = onId;
    if (onId) reveal(orderRows[on].button);
  }

  // Bottom bar (and a quiet "next" mark on the item Next will start).
  const next = nextItem();
  orderRows.forEach((row) => row.button.classList.toggle('is-next', !editing && !!next && row.item.id === next.id));
  $('nextName').textContent = next ? next.name : 'End of list';
  $('next').disabled = !next || editing;
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
      box.classList.toggle('dimmed', m.v < 0.995);
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

/**
 * The colour of a plain Any colour pick (no white, amber or UV) a group runs, or null. "Add to
 * colours" keeps only plain colours for now; a pick with extras stays a live colour.
 * `s` is the group's live status; the server reads Any colour picks for the page (`s.live`).
 */
function liveColour(s) {
  const live = s?.live;
  return live && !live.white && !live.amber && !live.uv ? live.colour : null;
}

/**
 * What the details panel shows for a group. Live: the stage's status (`state.groups`).
 * In Preview: the selected item's saved entry, `{ preset, level, live: null, entry }`;
 * `entry` is null when the item doesn't set the group ("not set"). Basic lights' unset
 * groups run the built-in Basic light, at full.
 */
function groupStatus(group) {
  if (!preview.on) return state?.groups?.[group.id];
  const item = previewItem();
  const k = layout.groups.findIndex((g) => g.id === group.id);
  const entry = item?.entries?.[k] ?? null;
  if (entry) return { preset: entry.preset, level: item.levels?.[k] ?? 1, live: null, entry };
  if (item && isBasic(item) && !isSmoke(group)) return { preset: '__safe', level: 1, live: null, entry: null };
  return { preset: null, level: 0, live: null, entry: null };
}

/** In Preview: the selected item doesn't set this group. */
const notSet = (s) => s?.entry === null && s.preset === null;

/** In Preview: a group's dimmer can't move (the item doesn't set the group, or Basic lights stays at full). */
function dimmerLocked(group) {
  if (!preview.on) return false;
  const item = previewItem();
  return !item || isBasic(item) || !groupStatus(group)?.entry;
}

/** Preview: changes one group of the selected item, saved straight into it; nothing goes on stage. */
function sendItemGroup(group, change) {
  if (!preview.on || !preview.item) return null;
  return send({ type: 'itemGroup', item: preview.item, group, ...change });
}

/**
 * The effect a group runs now, as groupEffect takes it, or null when it runs a colour.
 * `s` is groupStatus(group). Live: a live change (`s.effect`, an `fx:` id), a listed effect,
 * or an effect a Save kept in a song (a hidden "Custom effect" the group goes on running:
 * its settings come with the look's entry). In Preview: the selected item's entry.
 */
function runningEffect(group, s) {
  if (!s || !group) return null;
  if ('entry' in s) return s.entry?.effect ?? null;
  if (s.live) return null;
  if (s.effect) return s.effect;
  const id = s.preset;
  if (!id) return null;
  const listed = group.presets.find((p) => p.id === id);
  if (listed) return listed.effect ?? null;
  return savedEntry(group, id)?.effect ?? null;
}

/** A look's entry that gives the group this preset (a hidden one Save made): the look on stage first, then any. */
function savedEntry(group, presetId) {
  const k = layout.groups.findIndex((g) => g.id === group.id);
  const looks = [...layout.runningOrder, ...layout.looks, ...layout.quickLooks];
  const onStage = looks.find((l) => l.id === state?.look);
  for (const look of onStage ? [onStage, ...looks] : looks) {
    const entry = look.entries?.[k];
    if (entry?.preset === presetId) return entry;
  }
  return null;
}

/** The group's line: more than one segment (several fixtures, or a bar), so effects have somewhere to move. */
const hasLine = (group) => (group?.segments ?? 1) > 1 || (layout?.members?.[group?.id]?.length ?? 0) > 1;

/** An effect's colours side by side, whites drawn as whites; `loop` ends on the first colour again, for a swatch that moves. */
function effectGradient(effect, loop = false) {
  const colours = effect.colours.map((c) => shown(c.hex));
  if (colours.length === 1) return colours[0];
  return `linear-gradient(90deg, ${(loop ? [...colours, colours[0]] : colours).join(', ')})`;
}

/** The background of a small swatch for what a group runs: the colour, or an effect's colours. */
const swatchFill = (info) => (info.effect ? effectGradient(info.effect) : shown(info.colour) ?? '#0d0e11');

/** What a group runs, as an Any colour pick would make it: { colour, white, amber, uv }. */
function runningLight(group, s) {
  if (s?.live) return s.live;
  // An effect: its first colour, with White, Amber and UV from 0. A strip pick or a slider replaces the effect with a colour.
  const effect = runningEffect(group, s);
  if (effect) return { colour: effect.colours[0]?.hex ?? '#000000', white: 0, amber: 0, uv: 0 };
  if (s?.entry) {
    const light = s.entry.light;
    return light ? { colour: light.hex, white: light.white, amber: light.amber, uv: light.uv } : { colour: '#000000', white: 0, amber: 0, uv: 0 };
  }
  const id = s?.preset;
  const light = id === '__safe' ? layout.basicLight : group?.presets.find((x) => x.id === id)?.light;
  if (light) return { colour: light.hex, white: light.white, amber: light.amber, uv: light.uv };
  return { colour: '#000000', white: 0, amber: 0, uv: 0 };
}

/**
 * Name and colour to show for what a group runs (never throws on an id the layout doesn't list).
 * `effect` is the effect it runs (see runningEffect), or null.
 */
function presetInfo(group, s) {
  const effect = runningEffect(group, s);
  if (s?.entry) return { name: s.entry.name, colour: s.entry.swatch, effect };
  if (notSet(s)) return { name: 'not set', colour: null, effect: null };
  const id = s?.preset;
  if (id === null || id === undefined || id === '__blackout') return { name: 'Off', colour: null, effect: null };
  if (id === '__safe') return { name: 'Basic light', colour: layout.basicSwatch, effect: null };
  if (s.live) return { name: 'Custom', colour: s.live.display, effect: null };
  const p = group?.presets.find((x) => x.id === id);
  if (p) return { name: p.name, colour: p.swatch ?? NEUTRAL, effect };
  // A live change to an effect, or the "Custom effect" a Save kept in the song.
  if (effect) return { name: savedEntry(group, id)?.name ?? 'Custom effect', colour: effect.colours[0]?.hex ?? NEUTRAL, effect };
  return { name: 'Custom', colour: NEUTRAL, effect: null };
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

// One entry per group: { group, smoke, chip, sw, chipName, dim, slab, pct, dragging, holdUntil }.
// A smoke group's row has no chip (a "Smoke" label and a Puff button instead).
let detailRows = [];

function showLevel(row, v) {
  const p = clamp01(v);
  row.value = p;
  // A smooth filled bar: the fill's width is the level.
  row.slab.style.width = `${p * 100}%`;
  row.pct.textContent = `${Math.round(p * 100)} %`;
  row.pct.classList.toggle('zero', p === 0);
  row.dim.setAttribute('aria-valuenow', String(Math.round(p * 100)));
}

function buildDetails() {
  const root = $('groupRows');
  root.replaceChildren();
  detailRows = [];
  for (const group of layout.groups) {
    const smoke = isSmoke(group);
    const box = el('div', smoke ? 'row smoke' : 'row');
    const slab = el('span', 'ds-fill-slab');
    const pct = el('span', 'pct');
    const dim = el('div', 'ds-fill');
    dim.setAttribute('role', 'slider');
    dim.setAttribute('aria-label', smoke ? `${group.name} smoke level` : `${group.name} dimmer`);
    dim.setAttribute('aria-valuemin', '0');
    dim.setAttribute('aria-valuemax', '100');
    dim.append(slab);
    const row = { group, smoke, dim, slab, pct, value: 0, dragging: false, holdUntil: 0 };
    if (smoke) {
      // No colour to pick: a plain "Smoke" label, and Puff (hold) for a burst at full.
      const puff = el('button', 'puff', 'Puff');
      puff.setAttribute('aria-label', `Puff ${group.name} (hold)`);
      wireHold(puff, [group.id]);
      box.append(el('span', 'g', group.name), el('span', 'smoke-tag', 'Smoke'), pct, puff, dim);
    } else {
      const sw = el('i');
      const chipName = el('span');
      const chip = el('button', 'chip');
      chip.append(sw, chipName);
      chip.setAttribute('aria-label', `${group.name}: choose colour`);
      chip.addEventListener('click', () => openPicker(group.id));
      Object.assign(row, { chip, sw, chipName });
      box.append(el('span', 'g', group.name), chip, pct, dim);
    }
    root.append(box);
    detailRows.push(row);
    showLevel(row, 0);
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
  // A Preview drag changes `item` (saved once on release); a live drag changes the stage.
  let inPreview = false, item = null;
  row.dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (row.dim.classList.contains('ds-disabled')) return;
    // The server refuses smoke during Blackout; say so once and leave the slider where it is.
    if (row.smoke && state?.look === 'blackout') {
      toast('Blackout is on.');
      return;
    }
    row.dragging = true;
    inPreview = preview.on;
    item = preview.item;
    try { row.dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    row.dim.classList.add('ds-dragging');
    startX = ev.clientX;
    startV = row.value;
  });
  row.dim.addEventListener('pointermove', (ev) => {
    if (!row.dragging) return;
    showLevel(row, startV + (ev.clientX - startX) / row.dim.clientWidth);
    // In Preview the level is saved into the item once, when the finger lifts.
    if (!inPreview) out.push(row.value);
  });
  const end = () => {
    if (!row.dragging) return;
    row.dragging = false;
    row.dim.classList.remove('ds-dragging');
    // Keep what the finger set until the server has caught up with it.
    row.holdUntil = performance.now() + 600;
    if (row.value === startV) return;
    if (!inPreview) out.end(row.value);
    else if (preview.on && item && preview.item === item) sendItemGroup(row.group.id, { level: Math.round(row.value * 100) / 100 });
  };
  row.dim.addEventListener('pointerup', end);
  row.dim.addEventListener('pointercancel', end);
}

function renderDetails() {
  // In Preview the details are the selected item's, saved straight into it: no Save, no Back.
  const item = preview.on ? null : stageItem();
  if (preview.on) $('dTitle').textContent = previewItem()?.name ?? 'Details';
  else $('dTitle').textContent = item ? item.name : state.look === 'blackout' ? 'Blackout' : 'Details';
  // Without an item on stage there is nothing to save into or go back to.
  $('backBtn').hidden = !item || !state.lookChanged;
  $('saveBtn').hidden = !item;
  if (item) {
    $('backBtn').textContent = `Back to ${item.name}`;
    $('saveBtn').querySelector('.label').replaceChildren(`Save to ${item.name} `, el('small', null, 'hold'));
  }
  const now = performance.now();
  for (const row of detailRows) {
    if (row.smoke) {
      // The slider shows the smoke's own level; a Puff doesn't move it. (Hidden in Preview.)
      const s = state.groups?.[row.group.id];
      if (!row.dragging && now >= row.holdUntil) showLevel(row, s?.level ?? 0);
      continue;
    }
    const s = groupStatus(row.group);
    const info = presetInfo(row.group, s);
    row.sw.style.background = swatchFill(info);
    row.chipName.textContent = info.name;
    row.chip.classList.toggle('unset', notSet(s));
    const locked = dimmerLocked(row.group);
    row.dim.classList.toggle('ds-disabled', locked);
    if (locked) row.dim.setAttribute('aria-disabled', 'true');
    else row.dim.removeAttribute('aria-disabled');
    // The slider carries a little of the group's colour.
    row.dim.style.setProperty('--c', info.colour && info.colour !== '#000000' ? shown(info.colour) : '#5a6478');
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
/** The Save hold waiting for its answer: { ref, name }, to say "Saved to …" when it works. */
let itemSave = null;
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
    if (now && now.id === saveFor) {
      const sent = send({ type: 'saveItem', id: now.id });
      if (sent !== null) itemSave = { ref: sent, name: now.name };
    }
  }, 1000);
});
const stopSave = () => {
  clearTimeout(saveTimer);
  saveBtn.classList.remove('holding');
};
for (const e of ['pointerup', 'pointerleave', 'pointercancel']) saveBtn.addEventListener(e, stopSave);
saveBtn.addEventListener('click', (ev) => ev.preventDefault());

// ---- Colour picker (covers the details panel only) ----

const picker = { group: null, edit: false, tab: 'col' };

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
  // The Colours tab lists colours only; effects have their own tab.
  for (const p of row.group.presets.filter((x) => !x.effect)) {
    const b = el('button', 'pc');
    b.dataset.preset = p.id;
    const sw = el('i');
    sw.style.background = shown(p.swatch) ?? NEUTRAL;
    b.append(sw, el('span', null, p.name));
    b.classList.toggle('editable', picker.edit);
    b.classList.toggle('editing', colourEdit?.id === p.id);
    // While editing, a tap opens the colour's editor and leaves the stage alone. In Preview it goes into the item.
    b.addEventListener('click', () => {
      if (picker.edit) openEditor(row.group.presets.find((x) => x.id === p.id) ?? p);
      else if (preview.on) sendItemGroup(row.group.id, { preset: p.id });
      else send({ type: 'groupPreset', group: row.group.id, preset: p.id });
    });
    grid.append(b);
  }
  $('pTitle').textContent = row.group.name;
  $('pAnyLab').textContent = row.group.whiteOnly ? 'Any white, warm to cool' : 'Any colour';
  $('pAny').className = `strip2 ${row.group.whiteOnly ? 'cct' : 'hue'}`;
  $('pAny').setAttribute('aria-label', $('pAnyLab').textContent);
  buildExtras(row.group);
  buildEffectGrid(row.group);
  // A group that is a single light has nowhere for an effect to move: no Effects tab.
  $('pTabs').hidden = !hasLine(row.group);
  if ($('pTabs').hidden && picker.tab === 'fx') showPickerTab('col');
}

/** The Effects tab: one tile per effect in the group's list, with a small moving swatch of its colours. */
function buildEffectGrid(group) {
  const grid = $('fxGrid');
  grid.replaceChildren();
  const effects = group.presets.filter((p) => p.effect);
  for (const p of effects) {
    const b = el('button', 'pc fx');
    b.dataset.preset = p.id;
    const sw = el('i', 'fxsw');
    sw.style.setProperty('--g', effectGradient(p.effect, true));
    b.append(sw, el('span', null, p.name));
    b.classList.toggle('editable', picker.edit);
    b.classList.toggle('editing', effectEdit?.id === p.id);
    // While editing, a tap opens the effect's editor and leaves the stage alone.
    // In Preview it goes into the selected item; live it goes on stage.
    b.addEventListener('click', () => {
      if (picker.edit) openEffectEditor(group.presets.find((x) => x.id === p.id) ?? p);
      else if (preview.on) sendItemGroup(group.id, { preset: p.id });
      else send({ type: 'groupPreset', group: group.id, preset: p.id });
    });
    grid.append(b);
  }
  if (picker.edit) {
    const add = el('button', 'pc newfx', '＋ New effect');
    add.classList.toggle('editing', effectEdit?.id === null);
    add.addEventListener('click', () => openEffectEditor(null));
    grid.append(add);
  }
  showStill();
}

/** In Preview, Basic lights is always still: the Effects tab shows a note instead of effects it would refuse. */
const previewStill = () => preview.on && !!previewItem() && isBasic(previewItem());

function showStill() {
  const still = previewStill();
  const row = pickerRow();
  $('fxStill').hidden = !still;
  $('fxGrid').hidden = still;
  $('fxNone').hidden = still || picker.edit || !!row?.group.presets.some((p) => p.effect);
}

// White, Amber and UV under the Any colour strip, for groups whose fixtures have them.
const EXTRAS = [
  { key: 'white', label: 'White', tint: '#f4f8ff' },
  { key: 'amber', label: 'Amber', tint: '#ffbf00' },
  { key: 'uv', label: 'UV', tint: '#8c5cff' },
];
// One entry per slider shown: { key, dim, slab, pct, value, dragging, holdUntil }.
let extraRows = [];
// The colour the group runs, which a slider move sends again with the new levels.
let pickerColour = '#000000';
// The group runs an Any colour pick (so its White, Amber and UV levels are the user's own).
let pickerLive = false;
// A White, Amber or UV slider was moved since the picker opened.
let extrasMoved = false;
const NO_EXTRAS = { white: 0, amber: 0, uv: 0 };

function buildExtras(group) {
  const box = $('pExtras');
  box.replaceChildren();
  extraRows = [];
  for (const x of EXTRAS) {
    if (!group.extras?.[x.key]) continue;
    const slab = el('span', 'ds-fill-slab');
    const dim = el('div', 'ds-fill');
    dim.setAttribute('role', 'slider');
    dim.setAttribute('aria-label', `${group.name} ${x.label}`);
    dim.setAttribute('aria-valuemin', '0');
    dim.setAttribute('aria-valuemax', '100');
    dim.style.setProperty('--c', x.tint);
    dim.append(slab);
    const pct = el('span', 'pct');
    const cell = el('div', 'xcell');
    cell.append(el('span', 'lab2', x.label), pct, dim);
    box.append(cell);
    const row = { key: x.key, dim, slab, pct, value: 0, dragging: false, holdUntil: 0 };
    extraRows.push(row);
    showLevel(row, 0);
    wireExtra(row);
  }
  box.hidden = extraRows.length === 0;
}

/** The levels the sliders show; extras the group has no slider for are 0. */
function extraLevels() {
  const out = { white: 0, amber: 0, uv: 0 };
  for (const r of extraRows) out[r.key] = Math.round(r.value * 100) / 100;
  return out;
}

/** The sends that continue a drag (the strip or a slider) fade this fast, like Master and manual, so the stage follows the finger. */
const DRAG_FADE = 0.2;

/**
 * An Any colour send. The first send of a gesture (a tap, or the start of a drag) fades like
 * a swatch and adds an Undo step; the rest continue it, in 0.2 s each.
 */
function sendColour(hex, first, extras) {
  if (!picker.group) return;
  send({ type: 'groupColour', group: picker.group, colour: hex, ...extras, ...(first ? {} : { continues: true, fade: DRAG_FADE }) });
}

/** Throttled sends for one finger at a time: `start()` on touch, then `push` while it moves and `end` on release. */
function dragSender(sendOne) {
  let first = true;
  const out = throttle((v) => {
    sendOne(v, first);
    first = false;
  });
  return { start() { first = true; }, push: (v) => out.push(v), end: (v) => out.end(v) };
}

/**
 * Same feel as the group dimmers: the level moves relative to where the finger started.
 * In Preview nothing is sent while the finger moves; on release the item gets the colour with the new levels.
 */
function wireExtra(row) {
  const out = dragSender((_v, first) => sendColour(pickerColour, first, extraLevels()));
  let startX = 0, startV = 0, inPreview = false, item = null;
  row.dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    row.dragging = true;
    inPreview = preview.on;
    item = preview.item;
    try { row.dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    row.dim.classList.add('ds-dragging');
    startX = ev.clientX;
    startV = row.value;
    out.start();
  });
  row.dim.addEventListener('pointermove', (ev) => {
    if (!row.dragging) return;
    showLevel(row, startV + (ev.clientX - startX) / row.dim.clientWidth);
    if (row.value !== startV) extrasMoved = true;
    if (!inPreview) out.push();
  });
  const end = () => {
    if (!row.dragging) return;
    row.dragging = false;
    row.dim.classList.remove('ds-dragging');
    row.holdUntil = performance.now() + 600;
    if (row.value === startV) return;
    if (!inPreview) out.end();
    else if (preview.on && item && preview.item === item && picker.group) {
      sendItemGroup(picker.group, { colour: pickerColour, ...extraLevels() });
    }
  };
  row.dim.addEventListener('pointerup', end);
  row.dim.addEventListener('pointercancel', end);
}

/** Keeps "current", the highlighted swatch, the dimmer and the White, Amber and UV sliders in step with the live state. */
function renderPicker() {
  const row = pickerRow();
  if (!row) return;
  const s = groupStatus(row.group);
  const info = presetInfo(row.group, s);
  $('pCurSw').style.background = swatchFill(info);
  $('pCurText').textContent = notSet(s) ? info.name : `${info.name} · ${Math.round((s?.level ?? 0) * 100)}%`;
  for (const b of $('pGrid').children) b.classList.toggle('on', b.dataset.preset === s?.preset);
  for (const b of $('fxGrid').children) b.classList.toggle('on', b.dataset.preset === s?.preset);
  // The settings of the effect the group runs (in Preview: the item's), under the list.
  $('fxSet').hidden = !info.effect || previewStill();
  showStill();
  effectSettings.show(info.effect, preview.on ? previewItem()?.tempo ?? 120 : state?.tempo ?? 120);
  const running = runningLight(row.group, s);
  pickerColour = running.colour;
  // In Preview the item's own Any colour pick is a saved hidden "Custom" preset (not in the colour list):
  // its White, Amber and UV are the user's too.
  pickerLive = preview.on
    ? !!s?.entry && s.entry.name === 'Custom' && !row.group.presets.some((p) => p.id === s.entry.preset)
    : !!s?.live;
  const now = performance.now();
  for (const r of extraRows) if (!r.dragging && now >= r.holdUntil) showLevel(r, running[r.key]);
  renderAddColour();
  renderEditor();
  renderEffectEditor();
}

// ---- Keep a strip colour: "＋ Add to colours" ----

/** The colour the picker's group runs live from the strip, or null. */
function liveOfPicker() {
  const row = pickerRow();
  return row ? liveColour(state?.groups?.[row.group.id]) : null;
}

/** Shows the pill while the group runs a strip colour that isn't a swatch yet; keeps the form in step. */
function renderAddColour() {
  const row = pickerRow();
  const hex = liveOfPicker();
  const listed = !!hex && row.group.presets.some((p) => p.swatch?.toLowerCase() === hex);
  const open = !$('pAdd').hidden;
  // The form follows the colour: it goes when the group no longer runs a new strip colour.
  if (open && (!hex || listed)) $('pAdd').hidden = true;
  $('pAddOpen').hidden = !hex || listed || !$('pAdd').hidden || picker.edit;
  if (hex) $('paSw').style.background = hex;
  if (row) $('paAllText').textContent = row.group.whiteOnly ? 'Add to every white-only group' : 'Add to every colour group';
}

function openAddColour() {
  if (!liveOfPicker()) return;
  $('paName').value = '';
  $('paAll').checked = false;
  $('pAdd').hidden = false;
  renderAddColour();
  // With a long colour list the form opens below the fold of the picker.
  $('pAdd').scrollIntoView({ block: 'nearest' });
}

function closeAddColour() {
  pendingColour = null;
  $('pAdd').hidden = true;
  $('paName').blur();
  if (picker.group) renderAddColour();
}

$('pAddOpen').addEventListener('click', openAddColour);
$('paCancel').addEventListener('click', closeAddColour);
// The keyboard's Done closes the keyboard; nothing else on the page reacts to typing.
$('paName').addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter') $('paName').blur();
});
// A plain tap. The form closes when the server says yes; on an error it stays to fix.
$('paAddBtn').addEventListener('click', () => {
  const hex = liveOfPicker();
  if (pendingColour !== null || !picker.group) return;
  if (!hex) {
    closeAddColour();
    return;
  }
  pendingColour = send({ type: 'addColour', group: picker.group, colour: hex, name: $('paName').value, allGroups: $('paAll').checked });
  $('paAddBtn').disabled = pendingColour !== null;
});

function finishAddColour(error) {
  pendingColour = null;
  $('paAddBtn').disabled = false;
  if (!error) {
    closeAddColour();
    toast('Added to colours', true);
  }
}

function openPicker(groupId) {
  if (isSmoke(layout?.groups.find((g) => g.id === groupId))) return;
  closeSheet();
  if (picker.group !== groupId) {
    $('pAnyH').hidden = true;
  }
  $('pAdd').hidden = true;
  picker.group = groupId;
  picker.edit = false;
  $('pEditBtn').classList.remove('on');
  $('pEditBtn').setAttribute('aria-pressed', 'false');
  $('pCol').classList.remove('editing');
  $('pFx').classList.remove('editing');
  closeEditor();
  extrasMoved = false;
  buildPickerGrid();
  // A group that runs an effect opens on its Effects tab.
  const group = pickerRow()?.group;
  showPickerTab(group && hasLine(group) && runningEffect(group, groupStatus(group)) ? 'fx' : 'col');
  $('picker').hidden = false;
  renderPicker();
}

function closePicker() {
  pendingColour = null;
  $('paAddBtn').disabled = false;
  $('pAdd').hidden = true;
  picker.edit = false;
  closeEditor();
  picker.group = null;
  $('picker').hidden = true;
}

function showPickerTab(name) {
  const changed = picker.tab !== name;
  picker.tab = name;
  for (const t of document.querySelectorAll('[data-pt]')) {
    const on = t.dataset.pt === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  }
  $('pCol').hidden = name !== 'col';
  $('pFx').hidden = name !== 'fx';
  // Edit works on the tab it was turned on in.
  if (changed && picker.edit) setEditMode(false);
}

$('pDone').addEventListener('click', closePicker);
for (const t of document.querySelectorAll('[data-pt]')) t.addEventListener('click', () => showPickerTab(t.dataset.pt));

// ---- Effect settings: speed, direction, waves, size and edges ----

const SPEED_BEATS = [1, 2, 4, 8, 16, 32];
const SPEED_SECONDS = [2, 5, 10, 30, 60];
const DIRECTIONS = [['ltr', 'Left to right'], ['rtl', 'Right to left'], ['centreOut', 'Centre out'], ['outsideIn', 'Outside in']];
/**
 * The settings that change what each kind of effect does (the others are left out), and what
 * its size is called. A wave uses its size only with one colour and hard edges.
 */
const EFFECT_USES = {
  colourFade: {},
  wave: { direction: true, waves: true },
  chase: { direction: true, waves: true, size: 'Size' },
  sparkle: { size: 'Amount' },
  breathe: { size: 'Depth' },
  meteor: { direction: true, size: 'Tail' },
  fill: { direction: true },
  yoyo: { direction: true, size: 'Size' },
};
function effectUses(effect) {
  const uses = EFFECT_USES[effect.effect] ?? { direction: true, waves: true, size: 'Size' };
  if (effect.effect === 'wave' && effect.colours.length === 1 && effect.edge === 'hard') return { ...uses, size: 'Size' };
  return uses;
}

/** The choice nearest to v. */
const nearest = (choices, v) => choices.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));

/** An effect as groupEffect takes it: plain colours, every setting, nothing else. */
function liveLayer(fx) {
  return {
    kind: 'effect', effect: fx.effect,
    colours: fx.colours.map((c) => {
      const out = { hex: c.hex };
      for (const k of ['white', 'amber', 'uv']) if (typeof c[k] === 'number') out[k] = c[k];
      return out;
    }),
    speed: 'beats' in fx.speed ? { beats: fx.speed.beats } : { seconds: fx.speed.seconds },
    direction: fx.direction, waves: fx.waves, size: fx.size, edge: fx.edge, intensity: fx.intensity,
  };
}

/**
 * The settings of one effect, built into `root`. `show(effect, tempo)` puts an effect in (the
 * caller hides the box when there is none). Every change calls `onChange(effect, how)` with the
 * whole effect: `how` is 'tap' for a choice, and 'start', 'move' and 'end' for a Size drag.
 */
function effectControls(root, onChange) {
  let fx = null, tempo = 120;
  const seg = (label) => {
    const box = el('div', 'ds-seg');
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', label);
    return box;
  };
  const choice = (box, text, label, pick) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', () => { if (fx) pick(); });
    box.append(b);
    return b;
  };
  const item = (label, ...parts) => {
    const box = el('span', 'fxitem');
    const lab = el('span', 'lab2', label);
    box.append(lab, ...parts);
    return { box, lab };
  };
  /** A tap: the whole effect with `patch`, unless nothing changes. */
  const change = (patch) => {
    const next = { ...fx, ...patch };
    if (JSON.stringify(liveLayer(next)) !== JSON.stringify(liveLayer(fx))) onChange(liveLayer(next), 'tap');
  };

  // Speed: one round every 1 … 32 beats of the tempo, or Free: every 2 … 60 seconds.
  const beatsBox = seg('Beats for one round');
  const beatButtons = SPEED_BEATS.map((n) => [n, choice(beatsBox, String(n), `One round every ${n} beat${n === 1 ? '' : 's'}`, () => change({ speed: { beats: n } }))]);
  const freeButton = choice(beatsBox, 'Free', 'Free: in seconds, not with the tempo', () => {
    if ('seconds' in fx.speed) return;
    change({ speed: { seconds: nearest(SPEED_SECONDS, (fx.speed.beats * 60) / tempo) } });
  });
  const secondsBox = seg('Seconds for one round');
  const secondButtons = SPEED_SECONDS.map((n) => [n, choice(secondsBox, `${n} s`, `One round every ${n} seconds`, () => change({ speed: { seconds: n } }))]);
  const speedUnit = el('span', 'lab-note');
  const speed = item('Speed', beatsBox, secondsBox);
  speed.lab.append(' ', speedUnit);

  const dirBox = seg('Direction');
  const dirButtons = DIRECTIONS.map(([d, text]) => [d, choice(dirBox, text, null, () => change({ direction: d }))]);
  const direction = item('Direction', dirBox);

  const edgeBox = seg('Edges');
  const edgeButtons = [['soft', 'Soft'], ['hard', 'Hard']].map(([e, text]) => [e, choice(edgeBox, text, `${text} edges`, () => change({ edge: e }))]);
  const edges = item('Edges', edgeBox);

  const fewer = el('button', 'ds-btn fxstep', '−');
  const more = el('button', 'ds-btn fxstep', '+');
  const count = el('b', 'fxcount');
  fewer.setAttribute('aria-label', 'Fewer waves');
  more.setAttribute('aria-label', 'More waves');
  fewer.addEventListener('click', () => { if (fx && fx.waves > 1) change({ waves: fx.waves - 1 }); });
  more.addEventListener('click', () => { if (fx && fx.waves < 16) change({ waves: fx.waves + 1 }); });
  const waves = item('Waves', fewer, count, more);

  // Size: a fill slider, moved relative to where the finger starts (as the dimmers are).
  const slab = el('span', 'ds-fill-slab');
  const dim = el('div', 'ds-fill');
  dim.setAttribute('role', 'slider');
  dim.setAttribute('aria-valuemin', '0');
  dim.setAttribute('aria-valuemax', '100');
  dim.append(slab);
  const pct = el('span', 'pct');
  const size = item('Size', dim, pct);
  size.box.classList.add('fxsize');
  const slider = { dim, slab, pct, value: 0, dragging: false, holdUntil: 0 };
  let startX = 0, startV = 0, base = null;
  const sized = () => ({ ...base, size: Math.round(slider.value * 100) / 100 });
  dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (!fx) return;
    slider.dragging = true;
    base = liveLayer(fx);
    try { dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    dim.classList.add('ds-dragging');
    startX = ev.clientX;
    startV = slider.value;
    onChange(base, 'start');
  });
  dim.addEventListener('pointermove', (ev) => {
    if (!slider.dragging) return;
    showLevel(slider, startV + (ev.clientX - startX) / dim.clientWidth);
    if (slider.value !== startV) onChange(sized(), 'move');
  });
  const end = () => {
    if (!slider.dragging) return;
    slider.dragging = false;
    dim.classList.remove('ds-dragging');
    // Keep what the finger set until the server has caught up with it.
    slider.holdUntil = performance.now() + 600;
    if (slider.value !== startV) onChange(sized(), 'end');
  };
  dim.addEventListener('pointerup', end);
  dim.addEventListener('pointercancel', end);

  const line = (...items) => {
    const row = el('div', 'fxrow');
    row.append(...items.map((i) => i.box));
    return row;
  };
  root.replaceChildren(line(speed), line(direction, edges), line(waves, size));

  const mark = (pairs, value) => {
    for (const [v, b] of pairs) {
      b.classList.toggle('on', v === value);
      b.setAttribute('aria-checked', String(v === value));
    }
  };
  return {
    show(effect, bpm) {
      fx = effect;
      tempo = bpm;
      if (!fx) return;
      const free = 'seconds' in fx.speed;
      mark(beatButtons, free ? null : fx.speed.beats);
      freeButton.classList.toggle('on', free);
      freeButton.setAttribute('aria-checked', String(free));
      secondsBox.hidden = !free;
      mark(secondButtons, free ? fx.speed.seconds : null);
      speedUnit.textContent = free ? '· seconds a round' : '· beats a round';
      mark(dirButtons, fx.direction);
      mark(edgeButtons, fx.edge);
      count.textContent = String(fx.waves);
      fewer.disabled = fx.waves <= 1;
      more.disabled = fx.waves >= 16;
      const uses = effectUses(fx);
      direction.box.hidden = !uses.direction;
      waves.box.hidden = !uses.waves;
      size.box.hidden = !uses.size;
      size.lab.textContent = uses.size ?? 'Size';
      dim.setAttribute('aria-label', uses.size ?? 'Size');
      if (!slider.dragging && performance.now() >= slider.holdUntil) showLevel(slider, fx.size);
    },
  };
}

/**
 * The picker's effect settings. Live, a change goes on stage (a Size drag is one Undo step:
 * its later sends continue it, in 0.2 s each, like Any colour). In Preview it goes into the
 * selected item: once per tap, and once when a drag ends. The group and item are the ones the
 * finger started on.
 */
const effectSettings = (() => {
  let target = null;
  const sendEffect = (group, effect, first) =>
    send({ type: 'groupEffect', group, effect, ...(first ? {} : { continues: true, fade: DRAG_FADE }) });
  const out = dragSender((effect, first) => target && sendEffect(target.group, effect, first));
  const capture = () => ({ group: picker.group, inPreview: preview.on, item: preview.item });
  const toItem = (t, effect) => {
    if (preview.on && t.item && preview.item === t.item) sendItemGroup(t.group, { effect });
  };
  return effectControls($('fxSet'), (effect, how) => {
    if (how === 'tap') {
      const t = capture();
      if (!t.group) return;
      if (t.inPreview) toItem(t, effect);
      else sendEffect(t.group, effect, true);
      return;
    }
    if (how === 'start') {
      target = capture();
      out.start();
      return;
    }
    if (!target?.group) return;
    if (target.inPreview) {
      if (how === 'end') toItem(target, effect);
    } else if (how === 'move') out.push(effect);
    else out.end(effect);
  });
})();

/**
 * Makes a strip pick colours: `onStart()` when a finger touches, then `onColour(hex, last)`
 * while it moves and once more with `last` when it lifts. `whiteOnly()` says which colours
 * the strip holds.
 */
function attachStrip(strip, handle, whiteOnly, onColour, onStart) {
  let dragging = false;
  let hex = null;
  const pick = (ev) => {
    const r = strip.getBoundingClientRect();
    const p = clamp01((ev.clientX - r.left) / r.width);
    if (whiteOnly() === null) return null;
    handle.hidden = false;
    handle.style.left = `calc(${p * 100}% - ${p * 4}px)`;
    return stripColour(whiteOnly() ? WHITE_STOPS : HUE_STOPS, p);
  };
  strip.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    dragging = true;
    try { strip.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    onStart?.();
    hex = pick(ev);
    if (hex) onColour(hex, false);
  });
  strip.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    hex = pick(ev) ?? hex;
    if (hex) onColour(hex, false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (hex) onColour(hex, true);
    hex = null;
  };
  strip.addEventListener('pointerup', end);
  strip.addEventListener('pointercancel', end);
}

// Any colour: picking sends right away; moves are throttled and the last one always goes.
// The White, Amber and UV sliders' levels go with it when they are the user's: the group
// already runs an Any colour pick, or a slider was moved since the picker opened. Otherwise
// (a preset or Basic light with its own white) the pick is the plain colour.
// In Preview nothing is sent while the finger moves: the item gets one colour when it lifts.
(() => {
  let keep = false, inPreview = false, item = null;
  const out = dragSender((hex, first) => sendColour(hex, first, keep ? extraLevels() : NO_EXTRAS));
  attachStrip($('pAny'), $('pAnyH'), () => pickerRow()?.group.whiteOnly ?? null,
    (hex, last) => {
      if (!inPreview) {
        if (last) out.end(hex); else out.push(hex);
      } else if (last && preview.on && item && preview.item === item && picker.group) {
        sendItemGroup(picker.group, { colour: hex, ...(keep ? extraLevels() : {}) });
      }
    },
    () => {
      out.start();
      keep = pickerLive || extrasMoved;
      inPreview = preview.on;
      item = preview.item;
    });
})();

// ---- Edit colours: tap a swatch to rename it, change its colour or delete it ----

/** The preset the editor is open on: { id, name, colour (picked, or null), swatch (as listed) }. */
let colourEdit = null;
let deleteArmed = 0;
// The ref of an edit or delete the server hasn't answered yet.
let pendingEdit = null;
// What to say when the answer is yes, and the commands still to send after it (an effect's name, then its settings).
let pendingEditToast = 'Colour saved';
let pendingEditNext = [];
/** The effect the editor is open on: { id (null for a new one), name, effect, original, choices }. */
let effectEdit = null;

const editedPreset = () => (colourEdit ? pickerRow()?.group.presets.find((p) => p.id === colourEdit.id) : undefined);

function setEditMode(on) {
  picker.edit = on;
  closeEditor();
  $('pEditBtn').classList.toggle('on', on);
  $('pEditBtn').setAttribute('aria-pressed', String(on));
  $('pCol').classList.toggle('editing', on);
  $('pFx').classList.toggle('editing', on);
  if (on) $('pAdd').hidden = true;
  buildPickerGrid();
  renderPicker();
}

function openEditor(preset) {
  const row = pickerRow();
  if (!row) return;
  colourEdit = { id: preset.id, name: preset.name, colour: null, swatch: preset.swatch ?? NEUTRAL };
  pendingEdit = null;
  disarmDelete();
  $('peName').value = preset.name;
  $('peStrip').className = `strip2 pe-strip ${row.group.whiteOnly ? 'cct' : 'hue'}`;
  $('peStrip').setAttribute('aria-label', row.group.whiteOnly ? 'Change the colour: warm to cool' : 'Change the colour');
  $('peH').hidden = true;
  $('peSw').style.background = colourEdit.swatch;
  // The switch never carries over from an earlier colour: a change reaches other groups only when asked for each time.
  $('peSame').checked = false;
  $('peSave').disabled = false;
  $('pEdit').hidden = false;
  renderEditor();
  for (const b of $('pGrid').children) b.classList.toggle('editing', b.dataset.preset === preset.id);
  $('pEdit').scrollIntoView({ block: 'nearest' });
}

function closeEditor(keepPending = false) {
  colourEdit = null;
  if (!keepPending) pendingEdit = null;
  disarmDelete();
  $('peName').blur();
  $('pEdit').hidden = true;
  for (const b of $('pGrid').children) b.classList.remove('editing');
  closeEffectEditor();
}

/** "Used in …" for the songs and quick looks that use any of these presets. */
function usedText(presets) {
  const used = [...new Set(presets.flatMap((x) => x.usedBy ?? []))];
  return used.length ? `Used in ${used.slice(0, 4).join(', ')}${used.length > 4 ? ` and ${used.length - 4} more` : ''}` : 'Not used in any song or quick look';
}

/** Who uses it, and whether other groups have a colour of the same name. */
function renderEditor() {
  const p = editedPreset();
  if (!p) {
    if (colourEdit) closeEditor(true);
    return;
  }
  const others = layout.groups.filter((g) => g.id !== picker.group).flatMap((g) => g.presets.filter((x) => x.name === p.name));
  $('peSameWrap').hidden = !others.length;
  if (!others.length) $('peSame').checked = false;
  // With the switch on, the change reaches every same-named colour, so list where any of them is used.
  const affected = $('peSame').checked ? [p, ...others] : [p];
  $('peUsed').textContent = usedText(affected);
  // An Off colour can be renamed but has no colour to change.
  $('peStrip').hidden = p.canRecolour === false;
}

function disarmDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = 0;
  for (const id of ['peDelete', 'feDelete']) {
    $(id).classList.remove('armed');
    $(id).textContent = 'Delete';
  }
}

$('pEditBtn').addEventListener('click', () => setEditMode(!picker.edit));
$('peCancel').addEventListener('click', () => closeEditor());
$('peName').addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter') $('peName').blur();
});
$('peName').addEventListener('input', disarmDelete);
$('peSame').addEventListener('change', renderEditor);
attachStrip($('peStrip'), $('peH'), () => (pickerRow() ? pickerRow().group.whiteOnly : null), (hex) => {
  if (!colourEdit) return;
  colourEdit.colour = hex;
  $('peSw').style.background = hex;
  disarmDelete();
});

// A plain tap. Only what changed is sent; the editor closes when the server says yes.
$('peSave').addEventListener('click', () => {
  if (!colourEdit || pendingEdit !== null) return;
  const name = $('peName').value;
  const cmd = { type: 'editColour', preset: colourEdit.id, sameName: $('peSame').checked && !$('peSameWrap').hidden };
  if (name.trim() !== colourEdit.name) cmd.name = name;
  if (colourEdit.colour && !$('peStrip').hidden) cmd.colour = colourEdit.colour;
  if (cmd.name === undefined && cmd.colour === undefined) {
    closeEditor();
    return;
  }
  pendingEditToast = 'Colour saved';
  pendingEditNext = [];
  pendingEdit = send(cmd);
  $('peSave').disabled = pendingEdit !== null;
});

// First tap arms it ("Delete?"), the second one deletes. It disarms after a few seconds.
$('peDelete').addEventListener('click', () => {
  if (!colourEdit || pendingEdit !== null) return;
  if (!deleteArmed) {
    deleteArmed = setTimeout(disarmDelete, 4000);
    $('peDelete').classList.add('armed');
    $('peDelete').textContent = 'Delete?';
    return;
  }
  pendingEditToast = 'Colour deleted';
  pendingEditNext = [];
  pendingEdit = send({ type: 'deleteColour', preset: colourEdit.id });
  disarmDelete();
});

/** The server's answer to a Save or Delete in either editor: the next command if one is waiting, else done. */
function finishEdit(error) {
  pendingEdit = null;
  let failed = !!error;
  if (!failed && pendingEditNext.length) {
    pendingEdit = send(pendingEditNext.shift());
    if (pendingEdit !== null) return;
    failed = true;
  }
  pendingEditNext = [];
  $('peSave').disabled = false;
  $('feSave').disabled = false;
  $('feCopy').disabled = false;
  if (!failed) {
    closeEditor();
    toast(pendingEditToast, true);
  }
}

// ---- Edit effects: the Effects tab's Edit, the same way as the colour list's ----

const EFFECT_NAMES = [
  ['colourFade', 'Colour fade'], ['wave', 'Wave'], ['chase', 'Chase'], ['sparkle', 'Sparkle'],
  ['breathe', 'Breathe'], ['meteor', 'Meteor'], ['fill', 'Fill'], ['yoyo', 'Yo-yo'],
];

/** A colour as one string: its hex and White, Amber and UV levels, so the same colour always matches. */
const colourKey = (c) => [c.hex.toLowerCase(), ...['white', 'amber', 'uv'].map((k) => Math.round((c[k] ?? 0) * 1000) / 1000)].join('|');

/** An effect as one string, the colours by their keys, for telling whether the editor changed it. */
const effectSig = (layer) => JSON.stringify({ ...layer, colours: layer.colours.map(colourKey) });

/**
 * The colours the editor offers: the group's own colour list, then any colour the effect already
 * has that is not in the list (a colour picked on the strip, say), so it can be taken out and put back.
 */
function effectChoices(group, effect) {
  const choices = [];
  const seen = new Set();
  const add = (name, swatch, colour) => {
    const key = colourKey(colour);
    if (seen.has(key)) return;
    seen.add(key);
    choices.push({ key, name, swatch, colour });
  };
  for (const p of group.presets) {
    if (p.effect || !p.light) continue;
    add(p.name, p.swatch ?? NEUTRAL, { hex: p.light.hex, white: p.light.white, amber: p.light.amber, uv: p.light.uv });
  }
  for (const c of effect.colours) add('Custom', c.hex, { ...c });
  return choices;
}

/** A new effect starts as a wave of the group's first two colours (not Off), one round every 4 beats. */
function newEffectLayer(choices) {
  const colours = choices.filter((c) => colourKey(c.colour) !== '#000000|0|0|0').slice(0, 2).map((c) => ({ ...c.colour }));
  if (!colours.length) colours.push({ hex: '#ffffff' });
  return liveLayer({ effect: 'wave', colours, speed: { beats: 4 }, direction: 'ltr', waves: 1, size: 0.5, edge: 'soft', intensity: 1 });
}

/** Opens the editor on a listed effect, or empty (preset null) for a new one. */
function openEffectEditor(preset) {
  const row = pickerRow();
  if (!row) return;
  const choices = effectChoices(row.group, preset ? preset.effect : { colours: [] });
  const effect = preset ? liveLayer(preset.effect) : newEffectLayer(choices);
  effectEdit = { id: preset?.id ?? null, name: preset?.name ?? '', effect, original: effectSig(effect), choices };
  pendingEdit = null;
  pendingEditNext = [];
  disarmDelete();
  $('feName').value = effectEdit.name;
  $('feSave').disabled = false;
  $('feCopy').disabled = false;
  $('feSave').textContent = preset ? 'Save' : 'Add';
  $('feDelete').hidden = $('feCopy').hidden = $('feUsed').hidden = !preset;
  $('fxEdit').hidden = false;
  drawEffectEditor();
  renderEffectEditor();
  for (const b of $('fxGrid').children) b.classList.toggle('editing', preset ? b.dataset.preset === preset.id : b.classList.contains('newfx'));
  $('fxEdit').scrollIntoView({ block: 'nearest' });
}

function closeEffectEditor() {
  effectEdit = null;
  $('feName').blur();
  $('fxEdit').hidden = true;
  for (const b of $('fxGrid').children) b.classList.remove('editing');
}

/** Keeps "Used in …" true as the show changes; closes the editor if the effect is gone. */
function renderEffectEditor() {
  if (!effectEdit || effectEdit.id === null) return;
  const p = pickerRow()?.group.presets.find((x) => x.id === effectEdit.id);
  if (!p?.effect) {
    closeEffectEditor();
    return;
  }
  $('feUsed').textContent = usedText([p]);
}

/** Draws what the editor holds: the swatch, the kind, the colours in order and the settings. */
function drawEffectEditor() {
  const { effect, choices } = effectEdit;
  $('feSw').style.background = effectGradient(effect);
  for (const b of $('feKind').children) {
    const on = b.dataset.kind === effect.effect;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  const order = effect.colours.map(colourKey);
  const box = $('feColours');
  box.replaceChildren();
  for (const c of choices) {
    const at = order.indexOf(c.key);
    const b = el('button', 'fecol');
    b.type = 'button';
    b.setAttribute('role', 'checkbox');
    b.setAttribute('aria-checked', String(at >= 0));
    const sw = el('i');
    sw.style.background = shown(c.swatch) ?? NEUTRAL;
    b.append(sw, el('span', null, c.name));
    if (at >= 0) b.append(el('b', 'fenum', String(at + 1)));
    b.classList.toggle('on', at >= 0);
    b.addEventListener('click', () => toggleEffectColour(c));
    box.append(b);
  }
  effectEditSettings.show(effect, state?.tempo ?? 120);
}

function setEffectEdit(next) {
  if (!effectEdit) return;
  effectEdit.effect = next;
  disarmDelete();
  drawEffectEditor();
}

/** A tap on a colour adds it at the end of the order, or takes it out. An effect has one to six. */
function toggleEffectColour(choice) {
  const { effect } = effectEdit;
  const at = effect.colours.map(colourKey).indexOf(choice.key);
  if (at >= 0) {
    if (effect.colours.length === 1) return toast('An effect needs at least one colour', true);
    setEffectEdit({ ...effect, colours: effect.colours.filter((_, i) => i !== at) });
  } else {
    if (effect.colours.length >= 6) return toast('An effect has at most six colours', true);
    setEffectEdit({ ...effect, colours: [...effect.colours, { ...choice.colour }] });
  }
}

for (const [kind, text] of EFFECT_NAMES) {
  const b = el('button', null, text);
  b.type = 'button';
  b.dataset.kind = kind;
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => {
    if (effectEdit && effectEdit.effect.effect !== kind) setEffectEdit({ ...effectEdit.effect, effect: kind });
  });
  $('feKind').append(b);
}

// The same settings as the Effects tab shows for a running effect; here they only change what is being edited.
const effectEditSettings = effectControls($('feSet'), (effect, how) => {
  if (!effectEdit || how === 'start') return;
  effectEdit.effect = effect;
  disarmDelete();
  if (how !== 'move') drawEffectEditor();
});

$('feCancel').addEventListener('click', () => closeEditor());
$('feName').addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter') $('feName').blur();
});
$('feName').addEventListener('input', disarmDelete);

/** Sends the commands one after the other: the next goes when the server has said yes to the one before. */
function sendEffectEdit(cmds, doneText) {
  pendingEditToast = doneText;
  pendingEditNext = cmds.slice(1);
  pendingEdit = send(cmds[0]);
  $('feSave').disabled = $('feCopy').disabled = pendingEdit !== null;
}

// A plain tap. Only what changed is sent (the name, then the settings); the editor closes when the server says yes.
$('feSave').addEventListener('click', () => {
  if (!effectEdit || pendingEdit !== null) return;
  const name = $('feName').value;
  const effect = liveLayer(effectEdit.effect);
  if (effectEdit.id === null) {
    sendEffectEdit([{ type: 'addEffect', group: picker.group, name, effect }], 'Effect added');
    return;
  }
  const cmds = [];
  if (name.trim() !== effectEdit.name) cmds.push({ type: 'editColour', preset: effectEdit.id, name, sameName: false });
  if (effectSig(effect) !== effectEdit.original) cmds.push({ type: 'editEffect', preset: effectEdit.id, effect });
  if (!cmds.length) {
    closeEditor();
    return;
  }
  sendEffectEdit(cmds, 'Effect saved');
});

// Save as a copy: a new effect with these settings; the original stays as it was. Under the same name it becomes "… copy".
$('feCopy').addEventListener('click', () => {
  if (!effectEdit || effectEdit.id === null || pendingEdit !== null) return;
  let name = $('feName').value.trim();
  if (name === effectEdit.name) name = `${name} copy`;
  sendEffectEdit([{ type: 'addEffect', group: picker.group, name, effect: liveLayer(effectEdit.effect) }], 'Saved as a copy');
});

// First tap arms it ("Delete?"), the second one deletes. A song or quick look that uses it refuses, and the toast names them.
$('feDelete').addEventListener('click', () => {
  if (!effectEdit || effectEdit.id === null || pendingEdit !== null) return;
  if (!deleteArmed) {
    deleteArmed = setTimeout(disarmDelete, 4000);
    $('feDelete').classList.add('armed');
    $('feDelete').textContent = 'Delete?';
    return;
  }
  pendingEditToast = 'Effect deleted';
  pendingEditNext = [];
  pendingEdit = send({ type: 'deleteColour', preset: effectEdit.id });
  disarmDelete();
});

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
    for (const { colour, name } of stripBlocks(q.colours)) {
      const block = el('i');
      if (colour) block.style.background = shown(colour);
      block.title = name;
      strip.append(block);
    }
    b.append(strip);
    // In Preview the quick look's groups go into the selected item, not on stage.
    b.addEventListener('click', () => {
      if (!preview.on) send({ type: 'quickLook', id: q.id });
      else if (preview.item) send({ type: 'itemQuickLook', item: preview.item, look: q.id });
    });
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
  // A quick look never sets smoke, so smoke groups aren't offered.
  const ids = new Set(lightGroups().map((g) => g.id));
  for (const id of [...qs.left]) if (!ids.has(id)) qs.left.delete(id);
  for (const group of lightGroups()) {
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
    const s = group ? groupStatus(group) : state?.groups?.[b.dataset.group];
    const info = presetInfo(group, s);
    const left = qs.left.has(b.dataset.group);
    b.classList.toggle('off', left);
    b.setAttribute('aria-pressed', String(!left));
    b.querySelector('i').style.background = swatchFill(info);
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
  const groups = lightGroups().map((g) => g.id).filter((id) => !qs.left.has(id));
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

// ---- Flash: hold a button and the group goes to full white ----

/**
 * Short label for each group, as the spec's "Front, Key, Back, Drum, B8": the first
 * word of its name, cut to 4 letters when it is longer than 6. Groups that would share
 * a label (or take "All") get their name cut to 8 instead, then 2, 3, … if still the same.
 */
function flashLabels(groups) {
  const names = groups.map((g) => g.name.trim());
  const firstWord = (name) => {
    const w = name.split(/\s+/)[0] ?? '';
    return w.length > 6 ? w.slice(0, 4) : w;
  };
  // "All" is the first button, so it counts as taken.
  const clashes = (list, i) => list.filter((w) => w.toLowerCase() === list[i].toLowerCase()).length > 1;
  const short = ['All', ...names.map(firstWord)];
  const longer = short.map((w, i) => (i > 0 && clashes(short, i) ? names[i - 1].slice(0, 8) : w));
  const seen = new Map();
  return longer.map((w) => {
    const key = w.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? w : `${w} ${n}`;
  }).slice(1);
}

// Buttons now held: pointer id -> { button, groups }.
const flashHeld = new Map();

/** Puts out one flash. Groups another held button still covers stay on. */
function flashOff(pointerId) {
  const h = flashHeld.get(pointerId);
  if (!h) return;
  flashHeld.delete(pointerId);
  h.button.classList.remove('down');
  const still = new Set([...flashHeld.values()].flatMap((o) => o.groups));
  const groups = h.groups.filter((id) => !still.has(id));
  if (groups.length) send({ type: 'flash', groups, on: false });
}

const flashAllOff = () => { for (const id of [...flashHeld.keys()]) flashOff(id); };

/**
 * Holding the button flashes the groups; letting go (or losing the finger) puts
 * them out. Flash buttons and a smoke group's Puff both work this way.
 */
function wireHold(b, groups) {
  b.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (flashHeld.has(ev.pointerId)) return;
    // Keep getting the release when the finger slides off the button.
    try { b.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    if (send({ type: 'flash', groups, on: true }) === null) return;
    flashHeld.set(ev.pointerId, { button: b, groups });
    b.classList.add('down');
  });
  const end = (ev) => flashOff(ev.pointerId);
  for (const name of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) b.addEventListener(name, end);
  b.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

function buildFlash() {
  flashAllOff();
  const root = $('flashArea');
  root.replaceChildren(el('span', 'flash-label', 'Flash'));
  // Smoke machines have Puff in the details instead, and "All" never includes them.
  const lights = lightGroups();
  const labels = flashLabels(lights);
  const buttons = [['All', lights.map((g) => g.id), 'All lights']];
  lights.forEach((g, i) => buttons.push([labels[i], [g.id], g.name]));
  for (const [text, groups, full] of buttons) {
    const b = el('button', null, text);
    b.setAttribute('aria-label', `Flash ${full} (hold)`);
    root.append(b);
    wireHold(b, groups);
  }
}

// A page that goes to the background or loses its connection can't send the release; end every flash here.
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') flashAllOff(); });
window.addEventListener('blur', flashAllOff);

// ---- Mini visualiser (for looking only) ----

const canvas = $('stage');
const ctx = canvas.getContext('2d');
const NO_VISUAL = new Uint8Array(0);

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
  // In Preview the picture is the selected item settled, never the stage: dark until it has come.
  const shownVisual = preview.on ? previewVisual ?? NO_VISUAL : visual;
  const pad = 14, r = Math.max(5, Math.min(9, h / 16));
  let at = 0; // where this fixture's segments start in the visual, counted in segments
  for (const f of layout.fixtures) {
    const first = at;
    const segs = Math.max(1, f.segments ?? 1);
    at += segs;
    const x = pad + f.x * (w - 2 * pad), y = pad + f.y * (h - 2 * pad);
    const colourAt = (s) => shownRgb(shownVisual[(first + s) * 3] ?? 0, shownVisual[(first + s) * 3 + 1] ?? 0, shownVisual[(first + s) * 3 + 2] ?? 0);
    if (f.w || f.h) {
      // A bar or strip: a rounded rectangle at its real size, one cell per segment along its longer side.
      const bw = Math.max(8, (f.w ?? 0) * (w - 2 * pad)), bh = Math.max(8, (f.h ?? 0) * (h - 2 * pad));
      const across = bw >= bh;
      const cellW = bw / segs, cellH = bh / segs;
      const cells = Array.from({ length: segs }, (_, s) => colourAt(s));
      const glow = cells.reduce((best, c) => (Math.max(...c) > Math.max(...best) ? c : best), cells[0]);
      const lit = Math.max(...glow) / 255;
      ctx.save();
      if (lit > 0.02) {
        ctx.shadowColor = `rgba(${glow[0]},${glow[1]},${glow[2]},${0.8 * lit})`;
        ctx.shadowBlur = 10;
      }
      ctx.beginPath();
      ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, 4);
      ctx.fillStyle = `rgb(${glow[0]},${glow[1]},${glow[2]})`;
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, 4);
      ctx.clip();
      cells.forEach(([R, G, B], s) => {
        // Segment 0 is at the left or top; at the right or bottom when the fixture hangs reversed.
        const slot = f.reversed ? segs - 1 - s : s;
        ctx.fillStyle = `rgb(${R},${G},${B})`;
        if (across) ctx.fillRect(x - bw / 2 + slot * cellW, y - bh / 2, cellW + 0.5, bh);
        else ctx.fillRect(x - bw / 2, y - bh / 2 + slot * cellH, bw, cellH + 0.5);
      });
      ctx.restore();
      ctx.beginPath();
      ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, 4);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#3a3f48';
      ctx.stroke();
      continue;
    }
    const [R, G, B] = colourAt(0);
    const lit = Math.max(R, G, B) / 255;
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
  }
  if (preview.on && previewLabel) {
    // So the picture can't be mistaken for the real stage.
    ctx.font = previewLabel.font;
    ctx.fillStyle = previewLabel.colour;
    ctx.textBaseline = 'top';
    ctx.fillText('Preview', 10, 8);
  }
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
/** Shows a short message: a problem, or with `quiet` a plain confirmation. */
function toast(text, quiet = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('quiet', quiet);
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


// ---- Phone remote (narrow screens) ----
// The same page as a remote: Order, Groups and Looks tabs; Master and the dock always
// visible; nothing that saves or edits the show (the styles hide those). Flash moves from
// the bottom bar to the top of Groups. See docs/superpowers/specs/2026-10-19-phone-remote-design.md.

const phoneQuery = window.matchMedia('(max-width: 700px), (max-height: 500px)');

function setPhoneTab(tab) {
  document.body.dataset.tab = tab;
  for (const b of $('phoneTabs').querySelectorAll('button')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
}

function applyPhone() {
  const phone = phoneQuery.matches;
  document.body.classList.toggle('phone', phone);
  const flash = $('flashArea');
  // The tempo row goes first in Groups (the top bar's quiet items are hidden here).
  const tempo = $('tempoCtl');
  if (phone) {
    $('details').insertBefore(tempo, $('groupRows'));
    $('details').insertBefore(flash, $('groupRows'));
    // Editing belongs to the iPad: the running order's, and the colour list's (its buttons are hidden here,
    // and in Edit a swatch tap opens the editor instead of setting the colour).
    if (editing) setEditing(false);
    // No Preview on the phone: it stays a remote for the live stage.
    setPreview(false);
    if (picker.edit) setEditMode(false);
    closeSheet();
  } else {
    if (flash.parentElement !== $('masterFader').parentElement) $('masterFader').after(flash);
    if (tempo.parentElement !== $('quiet')) $('fadeButton').parentElement.after(tempo);
  }
  showTempoMenu(false);
  if (!document.body.dataset.tab) setPhoneTab('order');
}

for (const b of $('phoneTabs').querySelectorAll('button')) b.addEventListener('click', () => setPhoneTab(b.dataset.tab));
phoneQuery.addEventListener('change', applyPhone);
applyPhone();

connect();
