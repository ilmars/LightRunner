// Operator page. The server is the single source of truth: this page only
// sends commands and shows the live state it is given.

import { barAxis, barEnds, beamCone, outlineCells } from '/shared/stage.js';
import { FlashPresses, isSideways } from '/shared/press.js';
import { HUE_STOPS, WHITE_STOPS, hexRgb, parseChannel, parseHex, rgbHex, stripColour, stripMix, stripPick } from '/shared/colour.js';

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

// Prepare: this tablet works on a draft of the stage that the server keeps for it; Go sends it.
// (The server's commands for it are still called blindStart, blindEnd and blindGo.)
// `state` stays the live stage; `prep.state` is the draft's (same shape), `prep.visual` its picture.
// `session` counts the times Prepare went on or off, so a drag that started before never lands in the other one.
// `startRef` is the ref of the blindStart that began this Prepare (it stays after the answer, to tell this Prepare's
// answers from older ones); `starting` is true until that answer comes.
const prep = { on: false, session: 0, state: null, visual: null, startRef: null, starting: false, goRef: null };
/** The server's answer to a draft command when it has no draft for this tablet. */
const PREPARE_OFF = 'Prepare is off.';

/** The stage the page is working on: the draft while Prepare is on, else the live stage. */
const shownState = () => (prep.on ? prep.state ?? state : state);

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
      paintManual();
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'layout') {
      layout = msg.layout;
      buildOrder();
      buildDetails();
      buildQuick();
      syncQuickSheet();
      buildSheetGroups();
      buildFlash();
      paintKeyChips();
      // Operators can lose manual control in Settings; the panel goes with it.
      if (!layout.manualForOperators) closeManual();
      else if (manualSel.open) buildManual();
      render();
    } else if (msg.type === 'state') {
      if (state && msg.state.look !== seenLook) previousLook = seenLook;
      seenLook = msg.state.look;
      state = msg.state;
      render();
    } else if (msg.type === 'draftState') {
      // Only while this page is in Prepare (one may still be on its way after Prepare went off).
      if (!prep.on) return;
      prep.state = msg.state;
      render();
    } else if (msg.type === 'draftEnded') {
      // The server met a problem in this tablet's draft and dropped it; the lights were not changed.
      // While a start is on its way this is about an older draft: the start's own answer says how it went.
      if (!prep.on || prep.starting) return;
      setPrepare(false, false);
      toast(msg.reason);
    } else if (msg.type === 'draftVisual') {
      if (!prep.on) return;
      prep.visual = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
      drawStage();
    } else if (msg.type === 'result') {
      prepareResult(msg);
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
      // Individual lights' answers say what went wrong in plain words (once for the whole drag).
      if (msg.ref !== null && manualRefs.has(msg.ref)) {
        manualRefs.delete(msg.ref);
        if (msg.error) toast(manualProblem(msg.error));
      } else if (msg.error) toast(msg.error);
    }
  };
}

function setConnected(on) {
  connected = on;
  $('banner').hidden = on;
  if (!on) {
    // The server puts a flash out when it loses us; show the same here.
    presses.reset();
    // Answers that can no longer come: let a tap on ＋ Add song go through again.
    pendingAdd = null;
    addWanted = false;
    renames.clear();
    moves.clear();
    // The server dropped the draft with the connection; Prepare is off here too.
    setPrepare(false);
  }
  if (!on && pendingEdit !== null) {
    pendingEdit = null;
    $('feSave').disabled = false;
    $('feCopy').disabled = false;
    renderEditor();
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

/** Where a stage command goes now: the live stage, or this tablet's Prepare draft. A drag takes it when the finger touches. */
const stageTarget = () => ({ prep: prep.on, session: prep.session });

/**
 * Sends a command for the stage the page is working on: wrapped for the draft while Prepare is on.
 * Master, Flash, Blackout, Next, Fade and smoke never come here; they always go to the real stage.
 * With a `target` from the start of a drag, a send after Prepare went on or off is dropped.
 */
function sendStage(cmd, target = stageTarget()) {
  if (target.prep !== prep.on || target.session !== prep.session) return null;
  return send(target.prep ? { type: 'draft', cmd } : cmd);
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

/** The command that starts an item: Basic lights is the show's Safe look; every other item is a look. */
const startCommand = (item) => (isBasic(item) ? { type: 'safe' } : { type: 'look', id: item.id });

/** Start an item from the running order (in Prepare, in the draft: it becomes the item being prepared). */
function start(item) {
  sendStage(startCommand(item));
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
    const b = el('button', 'item');
    // One small dot per group (smoke machines left out), in group order: the colour this item
    // gives it, whites drawn as whites. Basic lights' groups without a saved colour run the built-in warm light.
    const strip = el('span', 'dots');
    for (const { colour: c, name } of stripBlocks(item.colours)) {
      const colour = c ?? (basic ? layout.basicSwatch : null);
      // A group the item leaves alone is a faint dot; one it turns off is a ring.
      const dot = el('i', colour === '#000000' ? 'off' : colour ? null : 'unset');
      if (colour && colour !== '#000000') dot.style.background = tint(colour, 0.85);
      dot.title = name;
      strip.append(dot);
    }
    // "● changed", "next" or "safe look"; in Prepare "preparing" on the draft's item, "on stage" on the real stage's.
    const tag = el('span', 'tag');
    b.append(strip, el('span', 'name', item.name), tag);
    b.addEventListener('click', () => start(item));
    nodes.push(b);
    orderRows.push({ item, button: b, tag });
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
  const same = orderRows.length === 0 && editRows.length === order.length && editRows.every((r, k) => r.id === order[k].id)
    && editKeys === keysShown();
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
  editKeys = keysShown();
  const nodes = [];
  let refocus = null;
  for (const item of order) {
    if (isBasic(item)) {
      const fixed = el('div', 'erow fixed');
      const name = el('span', 'fname', item.name);
      name.append(el('small', null, 'always first'));
      fixed.append(name);
      // Its Key chip lines up with the songs' (theirs have the drag handle after it).
      if (showsChip({ kind: 'song', id: item.id })) fixed.append(keyChip({ kind: 'song', id: item.id }, item.name), el('span', 'grip-space'));
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
    node.append(del, input);
    if (showsChip({ kind: 'song', id: item.id })) node.append(keyChip({ kind: 'song', id: item.id }, item.name));
    node.append(grip);
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
  // Editing the order doesn't mix with Prepare.
  if (on) setPrepare(false);
  // On a tablet a tap on this button doesn't leave the field, so do it here: it sends the rename.
  if (document.activeElement instanceof HTMLElement && $('runningOrder').contains(document.activeElement)) document.activeElement.blur();
  editing = on;
  confirmDelete = null;
  revealedId = null;
  // A song's key chip goes with the list: a learn still waiting for one stops.
  if (!on && keyLearn.does?.kind === 'song') stopLearn();
  $('editBtn').textContent = on ? 'Done' : 'Edit list';
  $('editBtn').classList.toggle('on', on);
  $('editBtn').setAttribute('aria-pressed', String(on));
  if (layout) {
    buildOrder();
    render();
  }
}
$('editBtn').addEventListener('click', () => setEditing(!editing));

// ---- Controller keys: a song's or a quick look's key, taken by pressing it on the controller ----
// Only when the server can use MIDI controllers (layout.keys.midi). A tap on a Key chip asks the server to take the
// next key pressed (it waits up to 10 s, one page at a time); the bar at the bottom says so and has Clear and Cancel.
// The key follows the song, not its place. Keys always act on the real stage.

/** What the running-order Edit rows' Key chips were built from (rebuilt when it changes). */
let editKeys = '';
const keysShown = () => JSON.stringify(layout?.keys ?? null);
/**
 * A Key chip shows while a controller is listened to, or when the song or quick look already has a key (so it can
 * be seen and cleared); never without MIDI support.
 */
const showsChip = (does) => !!layout?.keys?.midi && (layout.keys.connected > 0 || !!keyOfTarget(does));
/** What is waiting for its key: what it does, its name, the request and when it gives up. */
const keyLearn = { does: null, name: '', ctl: null, until: 0, timer: 0 };
const sameDoes = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id;

/** The key a song or quick look has now ({ place, name }), or null. */
function keyOfTarget(does) {
  const map = does.kind === 'song' ? layout?.keys?.songs : layout?.keys?.quickLooks;
  return map?.[does.id] ?? null;
}

function keyChip(does, name) {
  const b = el('button', 'kchip');
  b.type = 'button';
  b.dataset.does = JSON.stringify(does);
  b.dataset.name = name;
  paintKeyChip(b);
  // A tap on the chip doesn't reach the row (no drag, no rename).
  b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (sameDoes(keyLearn.does, does)) stopLearn();
    else learnKey(does, b.dataset.name);
  });
  return b;
}

/** The key's place, shortened ("1,3"), "＋" without one, "…" while waiting; the whole name in its title. */
function paintKeyChip(b) {
  const does = JSON.parse(b.dataset.does);
  const key = keyOfTarget(does);
  const waiting = sameDoes(keyLearn.does, does);
  b.classList.toggle('on', waiting);
  b.classList.toggle('set', !!key && !waiting);
  b.textContent = waiting ? '…' : key ? key.short : '＋';
  b.title = key ? `Key: ${key.name}` : 'Assign a key on a controller';
  b.setAttribute('aria-label', waiting ? 'Waiting for a key. Tap to stop' : key ? `Key: ${key.name}. Tap to assign another` : 'Assign a controller key');
}

function paintKeyChips() {
  for (const b of document.querySelectorAll('.kchip[data-does]')) paintKeyChip(b);
  paintLearnBar();
}

function paintLearnBar() {
  const bar = $('learnBar');
  bar.hidden = !keyLearn.does;
  if (!keyLearn.does) return;
  $('lbWhat').textContent = `Press a key on the controller for ${keyLearn.name}`;
  $('lbLeft').textContent = ` · ${Math.max(0, Math.ceil((keyLearn.until - performance.now()) / 1000))} s`;
  $('lbClear').hidden = !keyOfTarget(keyLearn.does);
}

async function learnKey(does, name) {
  if (keyLearn.ctl) stopLearn();
  const ctl = new AbortController();
  Object.assign(keyLearn, { does, name, ctl, until: performance.now() + 10000 });
  keyLearn.timer = setInterval(paintLearnBar, 250);
  paintKeyChips();
  let answer = null;
  try {
    const res = await fetch('/api/keys/learn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ does }), signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    answer = res.ok ? data : { ok: false, message: data.error || 'That did not work.', bad: true };
  } catch {
    if (!ctl.signal.aborted) answer = { ok: false, message: 'Not connected. Lights keep running; try again in a moment.', bad: true };
  }
  // Stopped, or another chip took over.
  if (keyLearn.ctl !== ctl) return;
  endLearn();
  if (!answer) return;
  if (answer.ok) toast(answer.note ?? `${name}: ${answer.key}`, true);
  else toast(answer.message, !answer.bad);
}

function stopLearn() {
  keyLearn.ctl?.abort();
  endLearn();
}

function endLearn() {
  clearInterval(keyLearn.timer);
  Object.assign(keyLearn, { does: null, name: '', ctl: null });
  paintKeyChips();
}

$('lbCancel').addEventListener('click', stopLearn);
$('lbClear').addEventListener('click', async () => {
  const { does, name } = keyLearn;
  if (!does) return;
  stopLearn();
  try {
    const res = await fetch('/api/keys/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ does }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) toast(`${name} has no key now`, true);
    else toast(data.error || 'That did not work.');
  } catch {
    toast('Not connected. Lights keep running; try again in a moment.');
  }
});

// ---- Prepare: get the next moment ready on a draft of the stage, then Go ----
// Only this tablet works on its draft; the server keeps it and sends this page its state and picture.
// A running-order tap starts the item in the draft: that is the item being prepared. Save to it keeps the
// draft in it; Go sends the draft to the lights. Master, Flash, Blackout, Next, Fade and smoke stay on the real stage.

// The stage view's label ("Live", "Off", "Draft · <name>"): its font and colours, read from the page once.
let pictureLabel = null;
function readPictureLabel() {
  const style = getComputedStyle(document.body);
  const v = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  pictureLabel = { font: `600 10px ${style.fontFamily}`, prep: v('--ds-violet', '#B0A6F5'), off: v('--ds-danger-text', '#EC8286'), live: v('--ds-muted', '#97A4BA') };
}

/**
 * Turns Prepare on (a fresh draft of the stage now) or off (the draft is thrown away).
 * `tell` false: the server has already ended it (after Go, or a refused start).
 */
function setPrepare(on, tell = true) {
  if (on === prep.on) return;
  if (on) {
    if (!layout || phoneQuery.matches) return;
    if (editing) {
      setEditing(false);
      if (editing) return;
    }
    const r = send({ type: 'blindStart' });
    if (r === null) return;
    prep.startRef = r;
    prep.starting = true;
  } else {
    // Off before the server made the draft is fine too: a start still on its way then makes none.
    if (tell && connected) send({ type: 'blindEnd' });
    prep.startRef = null;
    prep.starting = false;
  }
  // Individual lights holds the real stage: it closes for Prepare.
  if (on) closeManual();
  prep.on = on;
  prep.session++;
  prep.state = null;
  prep.visual = null;
  prep.goRef = null;
  // White, Amber and UV moves belong to what the picker showed before.
  extrasMoved = false;
  document.body.classList.toggle('prepare', on);
  $('topBar').classList.toggle('prepare', on);
  $('liveBtn').setAttribute('aria-pressed', String(!on));
  $('prepBtn').setAttribute('aria-pressed', String(on));
  $('goBtn').hidden = !on;
  $('goBtn').disabled = false;
  drawStage();
  render();
}
$('liveBtn').addEventListener('click', () => setPrepare(false));
$('prepBtn').addEventListener('click', () => setPrepare(true));

// Go: the whole draft goes to the lights in one change (with the Fade setting); the page is Live again when the server says yes.
$('goBtn').addEventListener('click', () => {
  if (!prep.on || prep.goRef !== null) return;
  prep.goRef = send({ type: 'blindGo' });
  $('goBtn').disabled = prep.goRef !== null;
});

/** The server's answer to Prepare's start or Go, or "Prepare is off." to a draft command. */
function prepareResult(msg) {
  if (msg.ref === null || !prep.on) return;
  if (msg.ref === prep.startRef) {
    prep.starting = false;
    // No draft was made (the stage didn't answer, too many tablets preparing, a problem): Prepare goes off
    // again; the toast says why.
    if (msg.error) return setPrepare(false, false);
  }
  // The server has no draft for this tablet (it ended it): Prepare is off here too. Not while the start is on
  // its way: a draft command that reaches the server before the draft is made is refused the same way.
  if (msg.error === PREPARE_OFF && !prep.starting && msg.ref > prep.startRef) return setPrepare(false, false);
  if (msg.ref === prep.goRef) {
    prep.goRef = null;
    $('goBtn').disabled = false;
    // On an error the draft stays, to try again.
    if (!msg.error) setPrepare(false, false);
  }
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

/**
 * Index in the running order of what is on stage, or -1 (Blackout, or a look that isn't in the order).
 * `s`: the stage to look at; by default the one the page works on (the draft in Prepare).
 */
function stageIndex(s = shownState()) {
  const order = layout?.runningOrder ?? [];
  if (!s) return -1;
  if (s.look === 'safe') return order.findIndex(isBasic);
  return order.findIndex((i) => i.id === s.look);
}

/**
 * The item after the one on stage; the first song when nothing is on stage.
 * After Blackout the item before it still counts, so Next carries on the service.
 * Always the real stage's: Next stays live in Prepare.
 */
function nextItem() {
  const order = layout?.runningOrder ?? [];
  if (!order.length) return null;
  let k = stageIndex(state);
  if (k < 0 && state?.lastLook) k = order.findIndex((i) => i.id === state.lastLook);
  if (k < 0) return order.find((i) => !isBasic(i)) ?? null;
  return order[k + 1] ?? null;
}

$('next').addEventListener('click', () => {
  // Nothing goes on stage while the running order is being edited.
  if (editing) return;
  const item = nextItem();
  // Next always starts on the real stage, in Prepare too.
  if (item) send(startCommand(item));
});
// In Prepare, Undo takes back the draft's last change; otherwise the stage's.
$('undo').addEventListener('click', () => sendStage({ type: 'undo' }));
// Basic lights (safe): always starts it on the real stage, in Prepare too (the draft stays), like Next.
// A safety button never goes into a draft; to prepare Basic lights, tap it in the running order.
$('basicBtn').addEventListener('click', () => send({ type: 'safe' }));

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

// ---- Tempo: beats per minute for the stage (in Prepare, for the draft) ----
// It sends `tempo`. The readout shows the stage's tempo (or the draft's). The menu steps by 1 (hold to repeat), ×2, ÷2.

const TEMPO_MIN = 40;
const TEMPO_MAX = 240;
const clampTempo = (bpm) => Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(bpm)));

const tempoMenu = $('tempoMenu');
const tempoField = $('tempoField');
/** True while the menu closes: a refused tempo then says so in a toast, as its note goes with the menu. */
let tempoClosing = false;
const showTempoMenu = (open) => {
  // Closing with a typed tempo still in the field: the field's change (on blur) sets it, as Done does.
  if (!open && document.activeElement === tempoField) {
    tempoClosing = true;
    tempoField.blur();
    tempoClosing = false;
  }
  tempoMenu.hidden = !open;
  $('tempoButton').setAttribute('aria-expanded', String(open));
  if (open) {
    showFadeMenu(false);
    $('tempoNote').hidden = true;
    tempoField.value = String(currentTempo());
  }
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

/** What the stage runs (in Prepare, the draft). */
const shownTempo = () => Math.round(shownState()?.tempo ?? 120);

// A step shows at once; the server's answer takes over after a moment (so a held button doesn't jump back).
let tempoLocal = null;
let tempoLocalAt = 0;
function currentTempo() {
  if (tempoLocal !== null && performance.now() - tempoLocalAt < 700) return tempoLocal;
  tempoLocal = null;
  return shownTempo();
}

/** Where a tempo change goes, taken when the finger touches: the stage, or the draft in Prepare. */
const tempoTarget = stageTarget;

/**
 * Sends a tempo to where `target` says. A held button that started live or in Prepare
 * never carries on in the other: after Prepare went on or off, the rest is dropped.
 */
function sendTempo(bpm, target = tempoTarget()) {
  sendStage({ type: 'tempo', bpm }, target);
}

// A held button sends at most 4 a second (every change is an Undo step), and the last one when let go.
let tempoSentAt = 0;
let tempoUnsent = null;
let tempoUnsentTarget = null;
function setTempo(bpm, throttle = false, target = tempoTarget()) {
  const v = clampTempo(bpm);
  tempoLocal = v;
  tempoLocalAt = performance.now();
  $('tempoValue').textContent = String(v);
  if (document.activeElement !== tempoField) tempoField.value = String(v);
  if (throttle && tempoLocalAt - tempoSentAt < 250) {
    tempoUnsent = v;
    tempoUnsentTarget = target;
    return;
  }
  tempoSentAt = tempoLocalAt;
  tempoUnsent = null;
  sendTempo(v, target);
}
function flushTempo() {
  if (tempoUnsent === null) return;
  const v = tempoUnsent;
  tempoUnsent = null;
  tempoSentAt = performance.now();
  sendTempo(v, tempoUnsentTarget);
}

/** A step after typing starts from the typed tempo: leaving the field sets it first. */
const takeTyped = () => {
  if (document.activeElement === tempoField) tempoField.blur();
};

for (const b of tempoMenu.querySelectorAll('button')) {
  const step = b.dataset.step;
  if (step === 'double' || step === 'half') {
    b.addEventListener('click', () => {
      takeTyped();
      setTempo(currentTempo() * (step === 'double' ? 2 : 0.5));
    });
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
    takeTyped();
    try { b.setPointerCapture?.(ev.pointerId); } catch { /* pointer already gone */ }
    // The whole hold goes where it started.
    const target = tempoTarget();
    setTempo(currentTempo() + by, false, target);
    delay = setTimeout(() => {
      repeat = setInterval(() => setTempo(currentTempo() + by, true, target), 80);
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
  // Each tap is one send, going where the page works at the moment of the tap.
  setTempo((60000 * (tapTimes.length - 1)) / (t - tapTimes[0]), false, tempoTarget());
}
$('tapBtn').addEventListener('pointerdown', (ev) => {
  if (!ev.button) tapTempo();
});
$('tapBtn').addEventListener('click', (ev) => {
  if (ev.detail === 0) tapTempo();
});

// Typed: Done or Enter (or leaving the field) sets it, through the same `tempo` command (in Prepare, into the draft).
// 40–240 bpm; anything else is refused with a quiet note and the field goes back to the tempo. Escape puts it back.
tempoField.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    tempoField.blur();
  } else if (ev.key === 'Escape') {
    tempoField.value = String(currentTempo());
    $('tempoNote').hidden = true;
  }
});
tempoField.addEventListener('input', () => ($('tempoNote').hidden = true));
// Typing replaces the tempo shown: its text is selected when the field gets focus, and again at the end of the
// tap that gave it focus (on touch, focus comes after the finger lifts, and the tap would put the caret back).
// A tap in a field that already has focus moves the caret as usual.
const selectTempo = () => tempoField.setSelectionRange(0, tempoField.value.length);
let tempoFocusTap = false;
tempoField.addEventListener('pointerdown', () => (tempoFocusTap = document.activeElement !== tempoField));
tempoField.addEventListener('focus', selectTempo);
tempoField.addEventListener('click', () => {
  if (tempoFocusTap) selectTempo();
  tempoFocusTap = false;
});
// Left (after its change, if any): it shows the tempo again, never a number nobody set.
tempoField.addEventListener('blur', () => {
  tempoFocusTap = false;
  tempoField.value = String(currentTempo());
});
tempoField.addEventListener('change', () => {
  const text = tempoField.value.trim();
  const bpm = /^\d+$/.test(text) ? Number(text) : NaN;
  if (text === '' || bpm === currentTempo()) {
    tempoField.value = String(currentTempo());
    return;
  }
  if (!(bpm >= TEMPO_MIN && bpm <= TEMPO_MAX)) {
    const note = $('tempoNote');
    const why = Number.isNaN(bpm) ? 'Type a number' : `${bpm} is too ${bpm < TEMPO_MIN ? 'slow' : 'fast'}`;
    note.textContent = `${why}: tempo goes from ${TEMPO_MIN} to ${TEMPO_MAX} bpm.`;
    // Left by a tap outside, the menu closes and takes the note with it: a quiet toast says it instead.
    if (tempoClosing || tempoMenu.hidden) toast(note.textContent, true);
    else note.hidden = false;
    tempoField.value = String(currentTempo());
    return;
  }
  setTempo(bpm);
});

function renderTempo() {
  const bpm = String(currentTempo());
  $('tempoValue').textContent = bpm;
  // Never while it is being typed in: a state from the server mustn't overwrite what the finger is typing.
  if (document.activeElement !== tempoField) tempoField.value = bpm;
}

// ---- Rendering live state ----

/** What to call a look id in the top bar. */
function lookName(id) {
  if (id === 'blackout') return 'Blackout';
  if (id === 'safe') return layout.runningOrder.find(isBasic)?.name ?? 'Basic lights';
  return layout.runningOrder.find((i) => i.id === id)?.name ?? layout.looks.find((l) => l.id === id)?.name ?? (id ? 'Deleted item' : '—');
}

// ---- The problem pill: tap it for what is wrong, who to call and what still works ----

const problemBox = $('problemBox');
function showProblem(open) {
  problemBox.hidden = !open;
  $('outputNote').setAttribute('aria-expanded', String(open));
}
$('outputNote').addEventListener('click', () => showProblem(problemBox.hidden));
$('problemOk').addEventListener('click', () => showProblem(false));
document.addEventListener('pointerdown', (ev) => {
  if (!problemBox.hidden && !problemBox.parentElement.contains(ev.target)) showProblem(false);
}, true);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !problemBox.hidden) showProblem(false);
});

/** A sentence ends with a full stop. */
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** What the pill and its explanation say: `{ pill, short, title, text }` (short: the phone's pill), or null when nothing is wrong. */
// Patch and Settings show the same pill words (problemWords in web/shared/appbar.js): change both together.
function problemWords(s) {
  const notYou = 'It isn\'t something you did.';
  if (s.output === 'off') {
    return {
      pill: 'Not sending to the lights',
      short: 'Not sending',
      title: 'The lights aren\'t getting any commands',
      text: `Light Runner is working, but its output to the lights is switched off, so the stage won't follow your taps. Usually another desk, such as Lightkey, has the lights for now. ${notYou}`,
    };
  }
  if (s.output !== 'lost') return null;
  if (s.outputProblemKind === 'other-desk') {
    return {
      pill: 'Another desk is sending',
      short: 'Another desk',
      title: 'Another desk is also sending to the lights',
      text: `${sentence(s.outputProblem ?? 'Another desk is also sending')} The lights may follow it instead of your taps. ${notYou}`,
    };
  }
  return {
    pill: 'Lights not answering',
    short: 'Not answering',
    title: 'The lights aren\'t answering',
    text: `${sentence(s.outputProblem ?? 'The lighting network box is not answering')} Light Runner keeps sending, but the stage may not follow your taps. ${notYou}`,
  };
}

/** "Name · phone" from Settings > Who to call, or '' when nobody is set. */
const contactText = () => [layout?.contact?.name, layout?.contact?.phone].filter(Boolean).join(' · ');

/** A colour as a see-through tint (the stage colours are mixed down like this everywhere on the page). */
function tint(hex, alpha) {
  const c = shown(hex);
  if (!/^#[0-9a-f]{6}$/i.test(c ?? '')) return c;
  const n = parseInt(c.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

let lastBlackedOut = false;
function render() {
  if (!state || !layout) return;
  const blackedOut = state.look === 'blackout';
  const fading = state.lookProgress < 1 && state.lookFadeLeft > 0;

  // Top bar: the name, an amber "changed", and "A → B" while a fade runs.
  const name = state.look ? lookName(state.look) : '—';
  const from = previousLook ? lookName(previousLook) : null;
  const onStage = fading && from && from !== name ? `${from} → ${name}` : name;
  $('nowName').textContent = onStage;
  $('nowChanged').hidden = !state.lookChanged || blackedOut;
  // In Prepare: what is being prepared (the draft's item), over what the real stage runs. Blackout has its own head.
  $('liveHead').hidden = prep.on || blackedOut;
  $('blackHead').hidden = prep.on || !blackedOut;
  $('prepHead').hidden = !prep.on;
  if (prep.on) {
    const draft = shownState();
    $('prepName').textContent = draft.look ? lookName(draft.look) : '—';
    $('prepStage').textContent = `On stage: ${onStage}`;
  }

  // A problem with the lights: the amber pill (left out during Blackout, when the bar says the lights are off).
  const problem = problemWords(state);
  const note = $('outputNote');
  note.hidden = !problem || (blackedOut && !prep.on);
  if (note.hidden) showProblem(false);
  if (problem) {
    // While preparing the bar is busier: the pill just says there is a problem.
    $('outputText').textContent = prep.on ? 'Problem' : problem.pill;
    $('outputShort').textContent = problem.short;
    note.setAttribute('aria-label', `${problem.pill}: what it means`);
    $('problemTitle').textContent = problem.title;
    $('problemText').textContent = problem.text;
    const who = contactText();
    $('contactBox').hidden = !who;
    $('contactText').textContent = who;
  }

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
  const allLights = lightGroups().every((g) => flashing.includes(g.id));
  $('flashNote').textContent = `Flash: ${allLights ? 'all lights' : flashing.map((id) => groupOf(id)?.name ?? id).join(', ')}`;
  // A quiet readout while any smoke machine is running (the highest, if there are several).
  let smoke = 0;
  for (const g of layout.groups) {
    if (isSmoke(g)) smoke = Math.max(smoke, held.includes(g.id) ? 1 : state.groups?.[g.id]?.level ?? 0);
  }
  $('smokeNote').hidden = smoke <= 0;
  $('smokeNote').textContent = `Smoke: ${Math.round(smoke * 100)} %`;
  // Blackout is the most important state on the page: the whole bar says so.
  $('topBar').classList.toggle('blackout', blackedOut);

  renderTempo();
  const fade = state.fadeTime ?? null;
  $('fadeValue').textContent = fade === null ? 'Auto' : fade === 0 ? 'Instant' : `${fade} s`;
  for (const b of fadeMenu.querySelectorAll('button')) {
    const v = b.dataset.fade === 'auto' ? null : Number(b.dataset.fade);
    b.classList.toggle('on', v === fade);
    b.setAttribute('aria-checked', String(v === fade));
  }

  // Running order: the item on stage is blue, with "● changed" while it has live changes; "next" on the item Next
  // starts; "safe look" on Basic lights otherwise. In Prepare the draft's item is the violet "preparing" one, and the
  // item on the real stage (when it is another) keeps a dashed outline with "on stage".
  const shownStage = shownState();
  const on = stageIndex(shownStage);
  const live = prep.on ? stageIndex(state) : -1;
  const next = nextItem();
  orderRows.forEach((row, k) => {
    const active = k === on;
    const staged = k === live && !active;
    row.button.classList.toggle('on', active && !prep.on && !blackedOut);
    row.button.classList.toggle('prep', active && prep.on);
    row.button.classList.toggle('live', staged);
    row.button.setAttribute('aria-current', active ? 'true' : 'false');
    const changed = active && !prep.on && !blackedOut && shownStage.lookChanged;
    const isNext = !editing && !prep.on && !active && !!next && row.item.id === next.id;
    const tag = active && prep.on ? 'preparing' : staged ? 'on stage' : changed ? '● changed' : isNext ? 'next' : isBasic(row.item) && !active ? 'safe look' : '';
    row.tag.textContent = tag;
    row.tag.hidden = !tag;
    row.tag.classList.toggle('changed-tag', changed);
  });
  // Keep what is on stage (in Prepare, what is being prepared) in view when it changes (and when editing ends).
  const onId = on >= 0 ? layout.runningOrder[on].id : null;
  if (!editing && orderRows.length && onId !== revealedId) {
    revealedId = onId;
    if (onId) reveal(orderRows[on].button);
  }

  // Bottom bar.
  $('nextName').textContent = next ? next.name : 'End of list';
  $('next').disabled = !next || editing;
  $('undo').disabled = !shownStage.canUndo;
  $('blackout').classList.toggle('on', blackedOut);
  // Blackout's stage view says "Off".
  if (blackedOut !== lastBlackedOut) {
    lastBlackedOut = blackedOut;
    drawStage();
  }
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
      const pct = `${Math.round(m.v * 100)} %`;
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
 * The Any colour pick a group runs, as "Add to colours" keeps it: `{ hex, white, amber, uv, display }`
 * (display: how it looks, white, amber and UV mixed in), or null.
 * `s` is the group's live status; the server reads Any colour picks for the page (`s.live`).
 */
function liveColour(s) {
  const live = s?.live;
  if (!live) return null;
  return { hex: live.colour, white: live.white ?? 0, amber: live.amber ?? 0, uv: live.uv ?? 0, display: live.display ?? live.colour };
}

/** What the details panel shows for a group: the stage's status (`state.groups`; in Prepare, the draft's). */
const groupStatus = (group) => shownState()?.groups?.[group.id];

/**
 * The effect a group runs now, as groupEffect takes it, or null when it runs a colour.
 * `s` is groupStatus(group). Live: a live change (`s.effect`, an `fx:` id), a listed effect,
 * or an effect a Save kept in a song (a hidden "Custom effect" the group goes on running:
 * its settings come with the look's entry).
 */
function runningEffect(group, s) {
  if (!s || !group) return null;
  if (s.live) return null;
  if (s.effect) return s.effect;
  const id = s.preset;
  if (!id) return null;
  const listed = group.presets.find((p) => p.id === id) ?? hiddenPreset(group, id);
  if (listed) return listed.effect ?? null;
  return savedEntry(group, id)?.effect ?? null;
}

/** A hidden preset of the group (an Any colour Save kept, or the copy an edit in Prepare left on stage), or undefined. */
const hiddenPreset = (group, id) => group?.hidden?.find((x) => x.id === id);

/** A look's entry that gives the group this preset (a hidden one Save made): the look on stage first, then any. */
function savedEntry(group, presetId) {
  const k = layout.groups.findIndex((g) => g.id === group.id);
  const looks = [...layout.runningOrder, ...layout.looks, ...layout.quickLooks];
  const onStage = looks.find((l) => l.id === shownState()?.look);
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
  // White, Amber and UV mixed in, as the colours' swatches have them (an amber-only colour is amber, not black).
  const colours = effect.colours.map((c) => shown(mixedColour(c.hex, c)));
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
  const id = s?.preset;
  const light = id === '__safe' ? layout.basicLight : (group?.presets.find((x) => x.id === id) ?? hiddenPreset(group, id))?.light;
  if (light) return { colour: light.hex, white: light.white, amber: light.amber, uv: light.uv };
  return { colour: '#000000', white: 0, amber: 0, uv: 0 };
}

/**
 * Name and colour to show for what a group runs (never throws on an id the layout doesn't list).
 * `effect` is the effect it runs (see runningEffect), or null.
 */
function presetInfo(group, s) {
  const effect = runningEffect(group, s);
  const id = s?.preset;
  if (id === null || id === undefined || id === '__blackout') return { name: 'Off', colour: null, effect: null };
  if (id === '__safe') return { name: 'Basic light', colour: layout.basicSwatch, effect: null };
  if (s.live) return { name: 'Custom', colour: s.live.display, effect: null };
  const p = group?.presets.find((x) => x.id === id);
  if (p) return { name: p.name, colour: p.swatch ?? NEUTRAL, effect };
  // A hidden one: an Any colour Save kept, or the stage's copy of a colour edited in Prepare (shown as it was).
  const hidden = hiddenPreset(group, id);
  if (hidden && !effect) return { name: hidden.name, colour: hidden.swatch ?? NEUTRAL, effect: null };
  // A live change to an effect, or the "Custom effect" a Save kept in the song.
  if (effect) return { name: hidden?.name ?? savedEntry(group, id)?.name ?? 'Custom effect', colour: effect.colours[0]?.hex ?? NEUTRAL, effect };
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
      const cell = el('span', 'smoke-cell');
      cell.append(el('span', 'smoke-tag', 'Smoke'), puff);
      const top = el('div', 'top');
      top.append(el('span', 'g', group.name), cell);
      box.append(top, dim, pct);
    } else {
      const sw = el('i');
      const chipName = el('span');
      const chip = el('button', 'chip');
      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('width', '14');
      chevron.setAttribute('height', '14');
      chevron.setAttribute('viewBox', '0 0 24 24');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.innerHTML = '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/>';
      chip.append(sw, chipName, chevron);
      chip.addEventListener('click', () => openPicker(group.id));
      Object.assign(row, { chip, sw, chipName });
      const top = el('div', 'top');
      top.append(el('span', 'g', group.name), chip);
      box.append(top, dim, pct);
    }
    row.box = box;
    root.append(box);
    detailRows.push(row);
    showLevel(row, 0);
    wireDimmer(row);
  }
  // More than 6 groups: two columns, filled down the left one first (the left gets the extra when it is odd).
  // The row count goes to the stylesheet; the phone keeps its one column (the stylesheet only applies it off the phone).
  const many = layout.groups.length > 6;
  root.classList.toggle('two-col', many);
  root.style.setProperty('--col-rows', String(Math.ceil(layout.groups.length / 2)));
  // A new layout can drop the group the picker was showing.
  if (picker.group && !layout.groups.some((g) => g.id === picker.group)) closePicker();
  else if (picker.group) buildPickerGrid();
}

/**
 * Dragging moves the level relative to where the finger started, so touching a
 * dimmer never makes the lights jump (same as Master).
 */
function wireDimmer(row) {
  // Smoke always goes to the real stage; a light's level goes where the drag started (the draft in Prepare).
  let target = stageTarget();
  const out = throttle((v) => {
    const cmd = { type: 'groupLevel', group: row.group.id, value: v };
    if (row.smoke) send(cmd); else sendStage(cmd, target);
  });
  let startX = 0, startV = 0, pushed = false;
  const down = (ev) => {
    if (ev.type === 'pointerdown') ev.preventDefault();
    // The server refuses smoke during Blackout; say so once and leave the slider where it is.
    if (row.smoke && state?.look === 'blackout') {
      toast('Blackout is on.');
      return;
    }
    row.dragging = true;
    pushed = false;
    target = stageTarget();
    try { row.dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    row.dim.classList.add('ds-dragging');
    startX = ev.clientX;
    startV = row.value;
  };
  row.dim.addEventListener('pointerdown', down);
  // In two columns the whole cell drags the slider (the slider is thin there); the colour button and Puff keep their
  // taps. A press on the cell only becomes a drag once it moves clearly sideways: a vertical swipe scrolls the panel
  // (the browser takes the finger and sends pointercancel) and sends nothing.
  let cellPress = null;
  row.box.addEventListener('pointerdown', (ev) => {
    cellPress = null;
    if (!row.box.parentElement.classList.contains('two-col') || document.body.classList.contains('phone')) return;
    if (row.dim.contains(ev.target) || ev.target.closest('.chip, .puff')) return;
    cellPress = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  });
  row.box.addEventListener('pointermove', (ev) => {
    if (!cellPress || cellPress.id !== ev.pointerId || row.dragging) return;
    if (!isSideways(ev.clientX - cellPress.x, ev.clientY - cellPress.y)) return;
    cellPress = null;
    down(ev);
  });
  for (const name of ['pointerup', 'pointercancel']) row.box.addEventListener(name, (ev) => { if (cellPress?.id === ev.pointerId) cellPress = null; });
  row.dim.addEventListener('pointermove', (ev) => {
    if (!row.dragging) return;
    showLevel(row, startV + (ev.clientX - startX) / row.dim.clientWidth);
    pushed = true;
    out.push(row.value);
  });
  const end = (ev) => {
    if (!row.dragging) return;
    row.dragging = false;
    row.dim.classList.remove('ds-dragging');
    // Keep what the finger set until the server has caught up with it.
    row.holdUntil = performance.now() + 600;
    // The drag was cancelled (a palm, a system gesture): back to where it started, not wherever it got to.
    if (ev.type === 'pointercancel') {
      showLevel(row, startV);
      if (pushed) out.end(startV);
      return;
    }
    if (row.value === startV) return;
    out.end(row.value);
  };
  row.dim.addEventListener('pointerup', end);
  row.dim.addEventListener('pointercancel', end);
}

function renderDetails() {
  // The item on stage (in Prepare, the one being prepared: Save keeps the draft in it).
  const item = stageItem();
  $('dSub').textContent = prep.on ? `${item ? item.name : lookName(shownState().look)} · draft` : 'drag to dim';
  // Without an item on stage there is nothing to save into or go back to.
  const changed = !!item && shownState().lookChanged;
  $('backBtn').hidden = !changed;
  $('saveBtn').hidden = !item;
  $('saveBtn').classList.toggle('dirty', changed && !prep.on);
  // Individual lights: only when operators have manual control; faded in Prepare (manual control is live only).
  $('manualBtn').hidden = !layout.manualForOperators;
  $('manualBtn').classList.toggle('unavail', prep.on);
  $('manualBtn').setAttribute('aria-disabled', String(prep.on));
  $('manualBtn').title = prep.on ? MANUAL_LIVE_ONLY : 'Set single lights';
  if (item) {
    $('backBtn').setAttribute('aria-label', `Back to ${item.name} as saved`);
    $('saveBtn').querySelector('.label').replaceChildren(el('span', null, `Save to ${item.name}`), el('small', null, 'hold'));
  }
  const now = performance.now();
  for (const row of detailRows) {
    if (row.smoke) {
      // The slider shows the smoke's own level; a Puff doesn't move it.
      const s = state.groups?.[row.group.id];
      if (!row.dragging && now >= row.holdUntil) showLevel(row, s?.level ?? 0);
      continue;
    }
    const s = groupStatus(row.group);
    const info = presetInfo(row.group, s);
    // Off is a ring; a colour or an effect a soft disc.
    const off = !info.effect && (!info.colour || info.colour === '#000000');
    row.sw.classList.toggle('off', off);
    row.sw.style.background = off ? 'transparent' : info.effect ? swatchFill(info) : tint(info.colour, 0.85);
    row.chipName.textContent = info.name;
    row.chip.setAttribute('aria-label', `${row.group.name} colour: ${info.name}. Change colour`);
    // The slider carries a little of the group's colour.
    row.dim.style.setProperty('--c', info.colour && info.colour !== '#000000' ? shown(info.colour) : '#5a6478');
    if (!row.dragging && now >= row.holdUntil) showLevel(row, s?.level ?? 0);
  }
  if (picker.group) renderPicker();
  if (qs.open) renderSheet();
  renderManual();
}

// Back and Save.
$('backBtn').addEventListener('click', () => sendStage({ type: 'backToLook' }));

// Save needs a 1 s hold; letting go early does nothing.
const saveBtn = $('saveBtn');
let saveTimer = 0;
let saveFor = null;
// The Prepare session the hold started in: a draft that ends mid-hold (Live, Go, a dropped draft) must never
// turn the hold into a Save of the live stage, nor a hold started live into a Save of a new draft.
let saveSession = 0;
/** The Save hold waiting for its answer: { ref, name }, to say "Saved to …" when it works. */
let itemSave = null;
saveBtn.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  const item = stageItem();
  if (!item) return;
  saveFor = item.id;
  saveSession = prep.session;
  saveBtn.classList.add('holding');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveBtn.classList.remove('holding');
    // Only if the same item is still on stage, in the same Live or Prepare session; for Basic lights the id is the safe look's.
    const now = stageItem();
    if (now && now.id === saveFor && prep.session === saveSession) {
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

const picker = { group: null, tab: 'col' };

// The strips' colours and their maths (place, saturation, exact values) are in /shared/colour.js.

const pickerRow = () => detailRows.find((r) => r.group.id === picker.group);

/** Holding a colour or an effect in the picker this long opens its editor; a tap still puts it on stage. */
const EDIT_HOLD = 500;
/** Moving further than this (px) before then is a swipe (the picker scrolls), not a hold. */
const EDIT_SLOP = 8;
// The hold under way: its pointer, where it started and its timer; `quietUntil`: the clicks that end a hold are not taps.
const editHold = { pointer: null, x: 0, y: 0, timer: 0, fired: false, quietUntil: 0 };

function endEditHold() {
  clearTimeout(editHold.timer);
  editHold.timer = 0;
  editHold.pointer = null;
}

/**
 * A new finger (or the mouse again) while a hold that fired is still waiting for its lift: the lift was lost (the
 * grid was rebuilt under it) or a second finger came. Taps work again at once, so this new one (Save in the editor
 * the hold opened, say) is never taken for the hold's: a lost lift has no click to come, and the first finger of
 * two is over the editor by now, not over the tile.
 */
function dropFiredHold() {
  if (!editHold.fired) return;
  editHold.fired = false;
  editHold.quietUntil = 0;
  endEditHold();
}

/** The picker's tiles are being replaced: a hold that hasn't fired yet ends (it would open a colour that may be gone). */
function cancelEditHold() {
  if (editHold.timer) endEditHold();
}

/**
 * Makes a picker tile open its editor when held (EDIT_HOLD), without changing the stage. The click that ends the hold
 * is swallowed, so the tile's tap (fade to it, run it) doesn't also go. Not on the phone (no editing there).
 */
function holdToEdit(b, open) {
  b.classList.add('movable');
  b.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || document.body.classList.contains('phone')) return;
    dropFiredHold();
    endEditHold();
    editHold.pointer = ev.pointerId;
    editHold.x = ev.clientX;
    editHold.y = ev.clientY;
    editHold.fired = false;
    editHold.timer = setTimeout(() => {
      editHold.timer = 0;
      editHold.fired = true;
      // Until the finger lifts (and a moment after), clicks are the hold's, not taps.
      editHold.quietUntil = Infinity;
      open();
    }, EDIT_HOLD);
  });
  // A long press on a touch screen must not open the page's own menu.
  b.addEventListener('contextmenu', (ev) => { if (editHold.pointer !== null || editHold.fired) ev.preventDefault(); });
}

window.addEventListener('pointermove', (ev) => {
  if (ev.pointerId !== editHold.pointer || !editHold.timer) return;
  if (Math.hypot(ev.clientX - editHold.x, ev.clientY - editHold.y) > EDIT_SLOP) endEditHold();
});
const liftEditHold = (ev) => {
  if (ev.pointerId !== editHold.pointer) return;
  if (editHold.fired) editHold.quietUntil = performance.now() + 400;
  editHold.fired = false;
  endEditHold();
};
window.addEventListener('pointerup', liftEditHold);
// Any new pointer while a fired hold waits for its lift (not only on a tile), so a lost lift can't keep taps quiet.
window.addEventListener('pointerdown', dropFiredHold, true);
window.addEventListener('pointercancel', liftEditHold);
window.addEventListener('click', (ev) => {
  if (performance.now() >= editHold.quietUntil) return;
  editHold.quietUntil = 0;
  ev.stopPropagation();
  ev.preventDefault();
}, true);

function buildPickerGrid() {
  const row = pickerRow();
  if (!row) return;
  const grid = $('pGrid');
  cancelEditHold();
  grid.replaceChildren();
  // The Colours tab lists colours only; effects have their own tab. A tap fades the group to the colour
  // (in Prepare, the draft's group); a hold opens its editor (the stage doesn't change), as do Edit this colour and ＋ New colour.
  for (const p of row.group.presets.filter((x) => !x.effect)) {
    const b = el('button', 'pc');
    b.dataset.preset = p.id;
    const sw = el('i');
    // Off has no light: a dark bar with a faint edge.
    if (!p.swatch || p.swatch === '#000000') sw.classList.add('off');
    else sw.style.background = shown(p.swatch) ?? NEUTRAL;
    b.append(sw, el('span', null, p.name));
    b.addEventListener('click', () => sendStage({ type: 'groupPreset', group: row.group.id, preset: p.id }));
    holdToEdit(b, () => openColourEditor(p));
    grid.append(b);
  }
  // ＋ New colour: always the last tile.
  const add = el('button', 'pc newfx', '＋ New colour');
  add.addEventListener('click', () => openColourEditor(null));
  grid.append(add);
  $('pTitle').textContent = row.group.name;
  $('pAnyLab').textContent = row.group.whiteOnly ? 'Any white · drag to try it live' : 'Any colour · drag to try it live';
  $('pAny').className = `strip2 ${row.group.whiteOnly ? 'cct' : 'hue'}`;
  $('pAny').setAttribute('aria-label', row.group.whiteOnly ? 'Any white, warm to cool' : 'Any colour');
  buildExtras(row.group);
  buildEffectGrid(row.group);
}

/** "Background, Drum cage and Side bar". */
const listNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '');

/**
 * The Effects tab: one tile per effect in the group's list, with a small moving swatch of its colours, and
 * ＋ New effect last. A group that isn't a line of lights says so instead, and names the groups that take effects.
 */
function buildEffectGrid(group) {
  const line = hasLine(group);
  $('fxNotLine').hidden = line;
  $('fxLab').hidden = $('fxGrid').hidden = !line;
  const grid = $('fxGrid');
  grid.replaceChildren();
  if (!line) {
    const lines = lightGroups().filter(hasLine).map((g) => g.name);
    const others = lightGroups().filter((g) => !hasLine(g)).map((g) => g.name);
    $('fxNotLineText').textContent = lines.length
      ? `They run on ${listNames(lines)}. ${listNames(others)} ${others.length === 1 ? 'takes' : 'take'} colours only.`
      : 'No group here is a line of lights, so every group takes colours only.';
    return;
  }
  // ", hold to edit" is left out on the phone (no editing there).
  $('fxLab').replaceChildren(`Effects · tap to run on ${group.name}`, el('span', 'hold-hint', ', hold to edit'));
  for (const p of group.presets.filter((x) => x.effect)) {
    const b = el('button', 'pc fx');
    b.dataset.preset = p.id;
    const sw = el('i', 'fxsw');
    sw.style.setProperty('--g', effectGradient(p.effect, true));
    b.append(sw, el('span', null, p.name));
    // On stage, or in the draft in Prepare; a hold (or All settings, on the running effect's card) opens its editor.
    b.addEventListener('click', () => sendStage({ type: 'groupPreset', group: group.id, preset: p.id }));
    holdToEdit(b, () => openEffectEditor(p));
    grid.append(b);
  }
  const add = el('button', 'pc newfx', '＋ New effect');
  add.addEventListener('click', () => openEffectEditor(null));
  grid.append(add);
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
    const row = extraSlider(box, x, `${group.name} ${x.label}`);
    extraRows.push(row);
    wireExtra(row);
  }
  box.hidden = extraRows.length === 0;
}

/** One White, Amber or UV slider in `box`, at 0: `{ key, dim, slab, pct, value, dragging, holdUntil }`. */
function extraSlider(box, x, label) {
  const slab = el('span', 'ds-fill-slab');
  const dim = el('div', 'ds-fill');
  dim.setAttribute('role', 'slider');
  dim.setAttribute('aria-label', label);
  dim.setAttribute('aria-valuemin', '0');
  dim.setAttribute('aria-valuemax', '100');
  dim.style.setProperty('--c', x.tint);
  dim.append(slab);
  const pct = el('span', 'pct');
  const cell = el('div', 'xcell');
  cell.append(el('span', 'lab2', x.label), pct, dim);
  box.append(cell);
  const row = { key: x.key, dim, slab, pct, value: 0, dragging: false, holdUntil: 0 };
  showLevel(row, 0);
  return row;
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
 * a swatch and adds an Undo step; the rest continue it, in 0.2 s each. `target`: where the gesture started (stageTarget).
 */
function sendColour(hex, first, extras, target) {
  if (!picker.group) return;
  sendStage({ type: 'groupColour', group: picker.group, colour: hex, ...extras, ...(first ? {} : { continues: true, fade: DRAG_FADE }) }, target);
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

/** Same feel as the group dimmers: the level moves relative to where the finger started. */
function wireExtra(row) {
  let target = stageTarget();
  const out = dragSender((_v, first) => sendColour(pickerColour, first, extraLevels(), target));
  let startX = 0, startV = 0;
  row.dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    row.dragging = true;
    target = stageTarget();
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
    out.push();
  });
  const end = () => {
    if (!row.dragging) return;
    row.dragging = false;
    row.dim.classList.remove('ds-dragging');
    row.holdUntil = performance.now() + 600;
    if (row.value === startV) return;
    out.end();
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
  // Off is a ring, as on the group's colour button.
  const off = !info.effect && (!info.colour || info.colour === '#000000');
  $('pCurSw').classList.toggle('off', off);
  $('pCurSw').style.background = off ? 'transparent' : info.effect ? swatchFill(info) : tint(info.colour, 0.85);
  $('pCurText').textContent = `${info.name} · ${Math.round((s?.level ?? 0) * 100)} %`;
  for (const b of $('pGrid').children) b.classList.toggle('on', b.dataset.preset === s?.preset);
  for (const b of $('fxGrid').children) b.classList.toggle('on', b.dataset.preset === s?.preset);
  $('pEditCur').disabled = !currentColour(row.group, s);
  // The effect the group runs: its card under the list (the round's length, Speed, All settings).
  $('fxCard').hidden = !info.effect || !hasLine(row.group);
  if (info.effect) {
    // A listed effect by its name; one that isn't listed (a Speed change makes a live copy) by its kind: "Chase is running".
    const listed = row.group.presets.some((p) => p.id === s?.preset && p.effect);
    const kind = EFFECT_NAMES.find(([k]) => k === info.effect.effect)?.[1] ?? info.name;
    $('fxRunning').textContent = `${listed ? info.name : kind} is running`;
    $('fxNote').textContent = roundText(info.effect, s);
  }
  effectSettings.show(info.effect, shownState()?.tempo ?? 120);
  const running = runningLight(row.group, s);
  pickerColour = running.colour;
  pickerLive = !!s?.live;
  // Any colour follows the group's Any colour pick (the draft's, in Prepare), unless a finger or a field is on it.
  if (!anyColour.busy()) anyColour.set(s?.live ? s.live.colour : null);
  const now = performance.now();
  for (const r of extraRows) if (!r.dragging && now >= r.holdUntil) showLevel(r, running[r.key]);
  renderAddColour();
  renderEditor();
  renderEffectEditor();
}

/** The listed colour a group runs, for Edit this colour; null for a strip pick, an effect, Basic light or Off by Blackout. */
function currentColour(group, s) {
  if (!s?.preset || s.live || runningEffect(group, s)) return null;
  return group.presets.find((p) => p.id === s.preset && !p.effect) ?? null;
}

/**
 * How long one round of a running effect takes, as the stage runs it: "one round = 2 s at 120 bpm" (or
 * "one round = 10 s" for Free), with the speed dial; when light safety slows it, the slowed length and "· slowed to stay safe".
 */
function roundText(effect, s) {
  const st = shownState();
  const speed = st?.speed ?? 1;
  const bpm = st?.tempo ?? 120;
  const beats = 'beats' in effect.speed;
  // The engine's own length (slowed by light safety, when it is); worked out here only for an older server.
  const secs = s?.round ?? (beats ? (effect.speed.beats * 60) / (bpm * speed) : effect.speed.seconds / speed);
  const n = secs >= 10 ? Math.round(secs) : Math.round(secs * 10) / 10;
  const text = beats ? `one round = ${n} s at ${Math.round(bpm)} bpm` : `one round = ${n} s`;
  return s?.slowed ? `${text} · slowed to stay safe` : text;
}

// ---- Keep a strip colour: "＋ Keep as a colour" ----

/** The colour the picker's group runs live from the strip (with its White, Amber and UV), or null. */
function liveOfPicker() {
  const row = pickerRow();
  return row ? liveColour(shownState()?.groups?.[row.group.id]) : null;
}

/** A light with nothing in it: black with no White, Amber or UV (the server refuses to keep it: "that colour has no light"). */
const noLight = (c) => /^#0{6}$/.test(c.hex) && !c.white && !c.amber && !c.uv;

/**
 * ＋ Keep as a colour is always there; it works while the group runs a strip colour that isn't a swatch yet (and has
 * some light in it) and the form isn't open. Keeps the form in step.
 */
function renderAddColour() {
  const row = pickerRow();
  if (!row) return;
  $('paAllText').textContent = row.group.whiteOnly ? 'Add to every white-only group' : 'Add to every colour group';
  const pick = liveOfPicker();
  // Listed: the group's list has this very light (its colour, White, Amber and UV).
  const listed = !!pick && row.group.presets.some((p) => !p.effect && p.light && colourKey(p.light) === colourKey(pick));
  const keepable = !!pick && !listed && !noLight(pick);
  // The form follows the colour: it goes when the group no longer runs a new strip colour.
  if (!$('pAdd').hidden && !keepable) $('pAdd').hidden = true;
  $('pAddOpen').disabled = !keepable || !$('pAdd').hidden;
  if (pick) $('paSw').style.background = shown(pick.display) ?? pick.display;
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

/**
 * A #rrggbb colour with White, Amber and UV mixed in, the way the server makes swatches:
 * the same sums as displayColour() in packages/shared/src/protocol.ts (keep the two alike).
 */
function mixedColour(hex, { white = 0, amber = 0, uv = 0 }) {
  if (!white && !amber && !uv) return hex.toLowerCase();
  const n = parseInt(hex.slice(1), 16);
  const rgb = [
    ((n >> 16) & 255) / 255 + white + amber + 0.25 * uv,
    ((n >> 8) & 255) / 255 + white + (0xbf / 255) * amber,
    (n & 255) / 255 + white + 0.4 * uv,
  ];
  const scale = 1 / Math.max(1, ...rgb);
  return `#${rgb.map((c) => Math.round(c * scale * 255).toString(16).padStart(2, '0')).join('')}`;
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
  if (pendingColour !== null || !picker.group) return;
  const pick = liveOfPicker();
  if (!pick) {
    closeAddColour();
    return;
  }
  const { hex, white, amber, uv } = pick;
  pendingColour = send({ type: 'addColour', group: picker.group, colour: hex, white, amber, uv, name: $('paName').value, allGroups: $('paAll').checked });
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
  $('pAdd').hidden = true;
  picker.group = groupId;
  closeEditor();
  extrasMoved = false;
  buildPickerGrid();
  // Any colour starts from the group's own Any colour pick (none for another kind of colour; renderPicker), Exact values folded.
  anyColour.set(null, true);
  anyColour.fold(false);
  // A group that runs an effect opens on its Effects tab.
  const group = pickerRow()?.group;
  showPickerTab(group && hasLine(group) && runningEffect(group, groupStatus(group)) ? 'fx' : 'col');
  // The picker takes the Groups panel's place.
  $('details').classList.add('picking');
  $('picker').hidden = false;
  $('picker').scrollTop = 0;
  renderPicker();
}

function closePicker() {
  anyColour.cancel();
  pendingColour = null;
  $('paAddBtn').disabled = false;
  $('pAdd').hidden = true;
  closeEditor();
  picker.group = null;
  $('picker').hidden = true;
  $('details').classList.remove('picking');
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
  // An editor belongs to the tab it was opened on.
  if (changed) closeEditor();
}

$('pDone').addEventListener('click', closePicker);
$('pBack').addEventListener('click', closePicker);
for (const t of document.querySelectorAll('[data-pt]')) t.addEventListener('click', () => showPickerTab(t.dataset.pt));

// Edit this colour: the editor, on the colour the group runs (the stage's, or the draft's in Prepare).
$('pEditCur').addEventListener('click', () => {
  const row = pickerRow();
  const preset = row && currentColour(row.group, groupStatus(row.group));
  if (preset) openColourEditor(preset);
});

// All settings: the effect editor, on the effect the group runs. A listed effect is edited in place; one that
// isn't in the list (a live change, or one a Save kept in a song) opens as a new effect with its settings.
$('fxAll').addEventListener('click', () => {
  const row = pickerRow();
  if (!row) return;
  const s = groupStatus(row.group);
  const effect = runningEffect(row.group, s);
  if (!effect) return;
  const listed = !s.effect ? row.group.presets.find((p) => p.id === s.preset && p.effect) : null;
  if (listed) openEffectEditor(listed);
  else openEffectEditor(null, effect);
});

// ---- Effect settings: speed, direction, waves, size and edges ----

const SPEED_BEATS = [1, 2, 4, 8, 16, 32];
const SPEED_SECONDS = [2, 5, 10, 30, 60];
// As the editor shows them (arrows), with the spoken name where it differs.
const DIRECTIONS = [['ltr', 'Left → right', 'Left to right'], ['rtl', 'Right → left', 'Right to left'], ['centreOut', 'Centre out'], ['outsideIn', 'Outside in']];
/**
 * The settings that change what each kind of effect does (the others are left out), and what
 * its size is called. A wave uses its size only with one colour (soft or hard edges).
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
  if (effect.effect === 'wave' && effect.colours.length === 1) return { ...uses, size: 'Size' };
  return uses;
}

/** The choice nearest to v. */
const nearest = (choices, v) => choices.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));

/** A colour as an effect takes it: its hex, and White, Amber and UV when it has them. */
function plainColour(c) {
  const out = { hex: c.hex };
  for (const k of ['white', 'amber', 'uv']) if (typeof c[k] === 'number') out[k] = c[k];
  return out;
}

/** An effect as groupEffect takes it: plain colours, every setting and the base colour (when it has one), nothing else. */
function liveLayer(fx) {
  return {
    kind: 'effect', effect: fx.effect,
    colours: fx.colours.map(plainColour),
    speed: 'beats' in fx.speed ? { beats: fx.speed.beats } : { seconds: fx.speed.seconds },
    direction: fx.direction, waves: fx.waves, size: fx.size, edge: fx.edge, intensity: fx.intensity,
    ...(fx.base ? { base: { colour: plainColour(fx.base.colour), level: fx.base.level } } : {}),
  };
}

/**
 * The settings of one effect, built into `slots`. `show(effect, tempo)` puts an effect in (the
 * caller hides the box when there is none). Every change calls `onChange(effect, how)` with the
 * whole effect: `how` is 'tap' for a choice, and 'start', 'move' and 'end' for a Size drag.
 * `current()`, when given, is the effect a change starts from (the caller's own, which may have
 * changed since it was shown here); otherwise the one last shown.
 *
 * `speedOnly`: just the Speed line in `slots.speed`, its unit after the choices (the picker's running-effect card;
 * All settings has the rest). Otherwise the effect editor's parts: Speed's choices in `slots.speed`, Direction's in
 * `slots.direction` (its row is left out for an effect that doesn't use it), and Fine-tune's Waves at once, Size
 * (or Amount, Depth, Tail) and Edges in `slots.fine`, each left out when the effect doesn't use it.
 */
function effectControls(slots, onChange, current = null, { speedOnly = false } = {}) {
  let fx = null, tempo = 120;
  const now = () => (current ? current() : fx);
  const seg = (label) => {
    const box = el('div', speedOnly ? 'ds-seg' : 'ds-seg ce-seg');
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', label);
    return box;
  };
  const choice = (box, text, label, pick) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', () => { if (now()) pick(); });
    box.append(b);
    return b;
  };
  /** A tap: the whole effect with `patch`, unless nothing changes. */
  const change = (patch) => {
    const from = now();
    const next = { ...from, ...patch };
    if (JSON.stringify(liveLayer(next)) !== JSON.stringify(liveLayer(from))) onChange(liveLayer(next), 'tap');
  };

  // Speed: one round every 1 … 32 beats of the tempo, or Free: every 2 … 60 seconds.
  const beatsBox = seg('Beats for one round');
  const beatButtons = SPEED_BEATS.map((n) => [n, choice(beatsBox, String(n), `One round every ${n} beat${n === 1 ? '' : 's'}`, () => change({ speed: { beats: n } }))]);
  const freeButton = choice(beatsBox, 'Free', 'Free: in seconds, not with the tempo', () => {
    const { speed } = now();
    if ('seconds' in speed) return;
    change({ speed: { seconds: nearest(SPEED_SECONDS, (speed.beats * 60) / tempo) } });
  });
  const secondsBox = seg('Seconds for one round');
  const secondButtons = SPEED_SECONDS.map((n) => [n, choice(secondsBox, `${n} s`, `One round every ${n} seconds`, () => change({ speed: { seconds: n } }))]);
  const speedUnit = el('span', 'fxunit');

  const dirBox = seg('Direction');
  const dirButtons = DIRECTIONS.map(([d, text, label]) => [d, choice(dirBox, text, label, () => change({ direction: d }))]);

  const edgeBox = seg('Edges');
  const edgeButtons = [['soft', 'Soft'], ['hard', 'Hard']].map(([e, text]) => [e, choice(edgeBox, text, `${text} edges`, () => change({ edge: e }))]);

  // Waves at once: − the count +.
  const fewer = el('button', 'fe-stepb', '−');
  const more = el('button', 'fe-stepb', '+');
  const count = el('b', 'fe-count');
  fewer.setAttribute('aria-label', 'Fewer waves');
  more.setAttribute('aria-label', 'More waves');
  fewer.addEventListener('click', () => { const from = now(); if (from && from.waves > 1) change({ waves: from.waves - 1 }); });
  more.addEventListener('click', () => { const from = now(); if (from && from.waves < 16) change({ waves: from.waves + 1 }); });

  // Size: a fill slider, moved relative to where the finger starts (as the dimmers are).
  const slab = el('span', 'ds-fill-slab');
  const dim = el('div', 'ds-fill');
  dim.setAttribute('role', 'slider');
  dim.setAttribute('aria-valuemin', '0');
  dim.setAttribute('aria-valuemax', '100');
  dim.append(slab);
  const pct = el('span', 'pct');
  const sizeName = el('span', null, 'Size');
  const slider = { dim, slab, pct, value: 0, dragging: false, holdUntil: 0 };
  let startX = 0, startV = 0, base = null;
  const sized = () => ({ ...base, size: Math.round(slider.value * 100) / 100 });
  dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (!now()) return;
    slider.dragging = true;
    base = liveLayer(now());
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

  // The parts each kind of effect may leave out (the editor's), set by show().
  let dirRow = null, wavesCell = null, sizeCell = null;
  if (speedOnly) {
    // The card: "Speed" (a 64 px label), the choices, the unit.
    const box = el('span', 'fxitem');
    box.append(el('span', 'lab2', 'Speed'), beatsBox, secondsBox, speedUnit);
    const row = el('div', 'fxrow');
    row.append(box);
    slots.speed.replaceChildren(row);
  } else {
    slots.speed.replaceChildren(beatsBox, secondsBox);
    slots.direction.replaceChildren(dirBox);
    dirRow = slots.direction.closest('.ce-row');
    // Fine-tune: a muted 12 px label over each 44 px control.
    const cell = (lab, control) => {
      const box = el('div', 'fe-cell');
      box.append(lab, control);
      return box;
    };
    const stepper = el('div', 'fe-step');
    stepper.append(fewer, count, more);
    wavesCell = cell(el('span', 'fe-cell-lab', 'Waves at once'), stepper);
    const sizeLab = el('span', 'fe-cell-lab');
    sizeLab.append(sizeName, ' ', pct);
    sizeCell = cell(sizeLab, dim);
    edgeBox.classList.add('fe-edges');
    slots.fine.replaceChildren(wavesCell, sizeCell, cell(el('span', 'fe-cell-lab', 'Edges'), edgeBox));
  }

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
      speedUnit.textContent = free ? 'seconds a round' : 'beats a round';
      mark(dirButtons, fx.direction);
      mark(edgeButtons, fx.edge);
      count.textContent = String(fx.waves);
      fewer.disabled = fx.waves <= 1;
      more.disabled = fx.waves >= 16;
      const uses = effectUses(fx);
      if (dirRow) dirRow.hidden = !uses.direction;
      if (wavesCell) wavesCell.hidden = !uses.waves;
      if (sizeCell) sizeCell.hidden = !uses.size;
      sizeName.textContent = uses.size ?? 'Size';
      dim.setAttribute('aria-label', uses.size ?? 'Size');
      if (!slider.dragging && performance.now() >= slider.holdUntil) showLevel(slider, fx.size);
    },
  };
}

/**
 * The running effect's Speed, on the picker's card: a tap goes on stage, or in the draft in Prepare, for the
 * group the finger started on. (The drag path is effectControls' Size, which the card leaves out.)
 */
const effectSettings = (() => {
  let target = null;
  // `stage`: where the tap or drag started (stageTarget), so a drag stays on the draft or on the stage.
  const sendEffect = (group, effect, first, stage) =>
    sendStage({ type: 'groupEffect', group, effect, ...(first ? {} : { continues: true, fade: DRAG_FADE }) }, stage);
  const out = dragSender((effect, first) => target && sendEffect(target.group, effect, first, target.stage));
  const capture = () => ({ group: picker.group, stage: stageTarget() });
  return effectControls({ speed: $('fxSet') }, (effect, how) => {
    if (how === 'tap') {
      const t = capture();
      if (t.group) sendEffect(t.group, effect, true, t.stage);
      return;
    }
    if (how === 'start') {
      target = capture();
      out.start();
      return;
    }
    if (!target?.group) return;
    if (how === 'move') out.push(effect);
    else out.end(effect);
  }, null, { speedOnly: true });
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

/** After the page changes a colour, what the stage says is shown again only this much later (its answer can lag a move). */
const COLOUR_HOLD = 800;
/** A typed R, G or B is taken this long after the last key (at once when the field is left), so "128" isn't 1, 12, then 128. */
const CHANNEL_WAIT = 400;
let colourToolsMade = 0;

/**
 * A colour strip with Saturation under it and Exact values (a hex field and R, G, B, folded). The hex is the one
 * source of truth: the strip's handle, Saturation and the fields are worked out from it (`set`), so a typed colour
 * that isn't on the strip stays exactly as typed (the handle goes to the nearest place). A move on the strip or on
 * Saturation makes a new hex from the place, the saturation and the strength the colour had (see /shared/colour.js).
 *
 * `onStart()` when a change begins (a touch on the strip or Saturation, or the first change typed since a field got
 * focus), then `onColour(hex, last)` as it changes and once more with `last` at its end (the finger lifts, or the
 * field is left). `whiteOnly()` says which strip it is (warm to cool has no Saturation), null while it can't be used.
 * The parts go into `sat` (Saturation), `fold` (the Exact values button) and `exact` (the fields); `row`: Saturation
 * as the editors' rows have Brightness (the range inside, the value beside), else "Saturation 100 %" over the slider.
 */
function colourTools({ strip, handle, sat, fold, exact, row = false, whiteOnly, onColour, onStart }) {
  const st = { hex: null, p: null, s: 1, v: 1 };
  let dragging = false, holdUntil = 0;
  // A typed change under way: `began` once onStart has gone; `timer` for an R, G or B still being typed (`chan` says
  // which); `skip`: Escape, or the change was already finished by flush or cancel.
  const typed = { began: false, timer: 0, chan: -1, skip: false };

  // Saturation: a fill slider carrying the full colour of the strip's place.
  const satRow = { dim: el('div', 'ds-fill'), slab: el('span', 'ds-fill-slab'), pct: el('span', 'pct'), value: 1, dragging: false };
  satRow.dim.setAttribute('role', 'slider');
  satRow.dim.setAttribute('aria-label', 'Saturation');
  satRow.dim.setAttribute('aria-valuemin', '0');
  satRow.dim.setAttribute('aria-valuemax', '100');
  satRow.dim.append(satRow.slab);
  if (row) {
    satRow.dim.append(el('span', 'ce-range', '0 – 100 %'));
    sat.append(satRow.dim, satRow.pct);
  } else {
    sat.append(el('span', 'lab2', 'Saturation'), satRow.pct, satRow.dim);
  }

  // Exact values: folded; open, a hex field and R, G, B, and a quiet note when something typed can't be used.
  const foldBtn = el('button', 'cx-fold');
  foldBtn.type = 'button';
  foldBtn.append('Exact values', el('span', 'cx-arrow', '›'));
  if (!exact.id) exact.id = `cxExact${++colourToolsMade}`;
  foldBtn.setAttribute('aria-controls', exact.id);
  foldBtn.setAttribute('aria-expanded', 'false');
  fold.append(foldBtn);
  const field = (cls, label, numeric) => {
    const f = el('input', `ds-field ${cls}`);
    f.type = 'text';
    f.autocomplete = 'off';
    f.spellcheck = false;
    f.setAttribute('enterkeyhint', 'done');
    f.setAttribute('aria-label', label);
    if (numeric) {
      f.inputMode = 'numeric';
      f.pattern = '[0-9]*';
      f.maxLength = 3;
    } else {
      f.maxLength = 7;
      f.placeholder = '#RRGGBB';
      f.setAttribute('autocapitalize', 'characters');
    }
    return f;
  };
  const hexField = field('cx-hex', 'Colour as hex, #RRGGBB', false);
  const chans = ['Red', 'Green', 'Blue'].map((name) => field('cx-num', `${name}, 0 to 255`, true));
  const fields = [hexField, ...chans];
  const note = el('p', 'cx-note');
  note.setAttribute('role', 'status');
  note.hidden = true;
  const line = el('div', 'cx-fields');
  const cell = (text, f) => {
    const l = el('label', 'cx-cell');
    l.append(el('span', 'cx-lab', text), f);
    return l;
  };
  line.append(cell('Hex', hexField), ...chans.map((f, i) => cell('RGB'[i], f)));
  exact.append(line, note);
  exact.hidden = true;

  function render() {
    const w = whiteOnly();
    sat.hidden = w !== false;
    const lit = st.hex !== null && st.v > 0;
    handle.hidden = st.p === null || !lit;
    if (!handle.hidden) handle.style.left = `calc(${st.p * 100}% - ${st.p * 4}px)`;
    // Saturation pales a hue: unavailable until there is one (nothing picked yet, black, or a white typed with none before).
    const paled = st.p !== null && lit;
    satRow.dim.classList.toggle('ds-disabled', !paled);
    satRow.dim.setAttribute('aria-disabled', String(!paled));
    if (!satRow.dragging) showLevel(satRow, st.hex ? st.s : 1);
    satRow.dim.style.setProperty('--c', st.p === null ? '#6a7898' : shown(stripMix(false, st.p, 1, 1)));
    // A field being typed in is never written over.
    const rgb = st.hex ? hexRgb(st.hex) : null;
    if (document.activeElement !== hexField) hexField.value = st.hex ? st.hex.toUpperCase() : '';
    chans.forEach((f, i) => {
      if (document.activeElement !== f) f.value = rgb ? String(rgb[i]) : '';
    });
  }

  /** A finger on the strip or Saturation first ends any typing (its field would otherwise keep focus and go stale). */
  const blurFields = () => {
    if (fields.includes(document.activeElement)) document.activeElement.blur();
  };

  // The strip: the place it is touched picks the hue, at the saturation and strength the colour had.
  const place = (ev) => {
    const r = strip.getBoundingClientRect();
    return r.width > 0 ? clamp01((ev.clientX - r.left) / r.width) : null;
  };
  const fromStrip = (ev) => {
    const w = whiteOnly();
    const p = place(ev);
    if (w === null || p === null) return;
    st.p = p;
    st.hex = stripMix(w, st.p, st.s, st.v);
    render();
    onColour(st.hex, false);
  };
  strip.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const w = whiteOnly();
    if (w === null) return;
    blurFields();
    note.hidden = true;
    dragging = true;
    try { strip.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    // From black (No colour) the strip lights again; from white light (0 %), a hue comes back at full colour.
    if (!st.hex || st.v === 0) st.v = 1;
    if (!w && st.s === 0) st.s = 1;
    onStart?.();
    fromStrip(ev);
  });
  strip.addEventListener('pointermove', (ev) => {
    if (dragging) fromStrip(ev);
  });
  const endStrip = () => {
    if (!dragging) return;
    dragging = false;
    holdUntil = performance.now() + COLOUR_HOLD;
    if (st.hex) onColour(st.hex, true);
  };
  strip.addEventListener('pointerup', endStrip);
  strip.addEventListener('pointercancel', endStrip);

  // Saturation: moves relative to where the finger starts, like the other sliders; whole percent.
  {
    let startX = 0, startS = 1, moved = false;
    const dim = satRow.dim;
    dim.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (whiteOnly() !== false || st.p === null || !st.hex || st.v === 0) return;
      blurFields();
      note.hidden = true;
      satRow.dragging = true;
      try { dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
      dim.classList.add('ds-dragging');
      startX = ev.clientX;
      startS = st.s;
      moved = false;
      onStart?.();
    });
    dim.addEventListener('pointermove', (ev) => {
      if (!satRow.dragging) return;
      const s = Math.round(clamp01(startS + (ev.clientX - startX) / dim.clientWidth) * 100) / 100;
      showLevel(satRow, s);
      if (s === st.s) return;
      st.s = s;
      st.hex = stripMix(false, st.p, s, st.v);
      moved = true;
      render();
      onColour(st.hex, false);
    });
    const end = () => {
      if (!satRow.dragging) return;
      satRow.dragging = false;
      dim.classList.remove('ds-dragging');
      holdUntil = performance.now() + COLOUR_HOLD;
      if (moved) onColour(st.hex, true);
    };
    dim.addEventListener('pointerup', end);
    dim.addEventListener('pointercancel', end);
  }

  // The fields. A whole hex is taken as it is typed; R, G and B a moment after the last key. Left (Done, Enter, a tap
  // elsewhere), a field that can't be used says why in a quiet note and shows the colour again. Escape puts it back.
  function apply(hex) {
    if (hex === st.hex) return;
    if (!typed.began) {
      typed.began = true;
      onStart?.();
    }
    Object.assign(st, stripPick(!!whiteOnly(), hex, st));
    st.hex = hex;
    render();
    onColour(hex, false);
  }
  const takeChannel = (i) => {
    const n = parseChannel(chans[i].value);
    if (n === null) return false;
    const rgb = st.hex ? hexRgb(st.hex) : [0, 0, 0];
    rgb[i] = n;
    apply(rgbHex(rgb));
    return true;
  };
  const refuse = (text) => {
    note.textContent = text;
    note.hidden = false;
  };
  hexField.addEventListener('input', () => {
    note.hidden = true;
    const hex = parseHex(hexField.value);
    if (hex) apply(hex);
  });
  chans.forEach((f, i) => f.addEventListener('input', () => {
    note.hidden = true;
    clearTimeout(typed.timer);
    typed.chan = i;
    typed.timer = setTimeout(() => {
      typed.timer = 0;
      takeChannel(i);
    }, CHANNEL_WAIT);
  }));
  for (const f of fields) {
    // Typing replaces what the field shows: its text is selected on focus, and again at the end of the tap that gave it
    // focus (on touch, focus comes before the finger lifts, and the tap would put the caret back), as Tempo's field does.
    let focusTap = false;
    const select = () => f.setSelectionRange(0, f.value.length);
    f.addEventListener('pointerdown', () => (focusTap = document.activeElement !== f));
    f.addEventListener('focus', () => {
      typed.began = false;
      typed.skip = false;
      select();
    });
    f.addEventListener('click', () => {
      if (focusTap) select();
      focusTap = false;
    });
    f.addEventListener('keydown', (ev) => {
      // Nothing else on the page reacts to typing.
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        f.blur();
      } else if (ev.key === 'Escape') {
        typed.skip = true;
        f.blur();
      }
    });
    f.addEventListener('blur', () => {
      clearTimeout(typed.timer);
      typed.timer = 0;
      const text = f.value.trim();
      if (!typed.skip && text !== '') {
        if (f === hexField) {
          const hex = parseHex(text);
          if (hex) apply(hex);
          else refuse('Type a colour as # and six digits or letters A to F, like #FF8800.');
        } else if (!takeChannel(chans.indexOf(f))) {
          refuse('R, G and B are whole numbers from 0 to 255.');
        }
      }
      typed.skip = false;
      if (typed.began) {
        typed.began = false;
        holdUntil = performance.now() + COLOUR_HOLD;
        onColour(st.hex, true);
      }
      render();
    });
  }

  /**
   * Ends a typed change now: with `take`, an R, G or B still waiting is taken (and a field that can't be used says
   * why), else it is dropped; either way the change ends (`onColour(hex, true)`) and the field is left. On iPad Safari
   * a tap on a button doesn't take the focus from a field, so Save, Done, a tile and the like call this first.
   */
  function endTyping(take, quiet = false) {
    const f = fields.includes(document.activeElement) ? document.activeElement : null;
    if (!f && !typed.timer && !typed.began) return;
    const waiting = typed.timer ? typed.chan : -1;
    clearTimeout(typed.timer);
    typed.timer = 0;
    if (take && f && !typed.skip && f.value.trim() !== '') {
      if (f === hexField) {
        const hex = parseHex(f.value.trim());
        if (hex) apply(hex);
        else refuse('Type a colour as # and six digits or letters A to F, like #FF8800.');
      } else if (!takeChannel(chans.indexOf(f))) {
        refuse('R, G and B are whole numbers from 0 to 255.');
      }
    } else if (take && waiting >= 0) {
      takeChannel(waiting);
    }
    if (typed.began) {
      typed.began = false;
      holdUntil = performance.now() + COLOUR_HOLD;
      if (!quiet) onColour(st.hex, true);
    }
    if (f) {
      // Its blur has nothing more to do.
      typed.skip = true;
      f.blur();
    }
    typed.skip = false;
    render();
  }

  const showFold = (open) => {
    if (!open) blurFields();
    exact.hidden = !open;
    note.hidden = true;
    foldBtn.classList.toggle('open', open);
    foldBtn.setAttribute('aria-expanded', String(open));
  };
  foldBtn.addEventListener('click', () => showFold(exact.hidden));

  return {
    /** The colour now (#rrggbb), null for none. */
    get hex() { return st.hex; },
    /**
     * Shows `hex` (null: none). `fresh` forgets the colour before (a new editor, another group); otherwise a colour
     * with no hue (black, grey or white) keeps the place it had.
     */
    set(hex, fresh = false) {
      const h = hex ? hex.toLowerCase() : null;
      if (fresh) {
        Object.assign(st, { hex: null, p: null, s: 1, v: 1 });
        holdUntil = 0;
      }
      if (h !== st.hex) {
        note.hidden = true;
        if (h) Object.assign(st, stripPick(!!whiteOnly(), h, st));
        else Object.assign(st, { p: null, s: 1, v: 1 });
        st.hex = h;
      }
      render();
    },
    /** Folds Exact values (or opens it). */
    fold: (open = false) => showFold(open),
    /** Takes what is being typed now (an R, G or B still waiting too) and ends the change. */
    flush: () => endTyping(true),
    /** Drops an R, G or B still waiting (the picker or editor is closing) and ends the change. */
    cancel: () => endTyping(false),
    /** As cancel, but nothing more is sent at all (not even the end of the change): the stage is in Blackout. */
    drop: () => endTyping(false, true),
    /** A finger or a field is changing it, or did a moment ago: what the stage says must wait. */
    busy: () => dragging || satRow.dragging || fields.includes(document.activeElement) || performance.now() < holdUntil,
    render,
  };
}

// Any colour: picking sends right away; moves are throttled and the last one always goes. Saturation and a typed
// colour send the same way (one Undo step per touch, or per field until it is left); in Prepare they go to the draft.
// The White, Amber and UV sliders' levels go with it when they are the user's: the group
// already runs an Any colour pick, or a slider was moved since the picker opened. Otherwise
// (a preset or Basic light with its own white) the pick is the plain colour.
const anyColour = (() => {
  let keep = false, target = stageTarget();
  const out = dragSender((hex, first) => sendColour(hex, first, keep ? extraLevels() : NO_EXTRAS, target));
  return colourTools({
    strip: $('pAny'), handle: $('pAnyH'), sat: $('pSat'), fold: $('pFold'), exact: $('pExact'),
    whiteOnly: () => pickerRow()?.group.whiteOnly ?? null,
    onColour: (hex, last) => {
      if (last) out.end(hex); else out.push(hex);
    },
    onStart: () => {
      out.start();
      keep = pickerLive || extrasMoved;
      target = stageTarget();
    },
  });
})();

// ---- The colour editor: a listed colour (Edit this colour) or a new one (＋ New colour), in the whole right column ----

/**
 * The colour editor while it is open. `group`: the group it opened for (it stays on it, and on this colour, whatever
 * the stage does meanwhile). `id`: the listed colour, null for a new one. `name`: as it opened. `hex`: the colour picked
 * on the strip, null for none yet (or No colour). `level` / `startLevel`: its brightness (null: no Brightness, as for Off).
 * `fade` / `startFade`: its fade in seconds. `all`: Apply to every group.
 */
let colourEdit = null;
let deleteArmed = 0;
// The ref of an edit or delete the server hasn't answered yet.
let pendingEdit = null;
// What to say when the answer is yes.
let pendingEditToast = 'Colour saved';
/** The effect the editor is open on: { id (null for a new one), name, effect, original, choices }. */
let effectEdit = null;
/** The editor's moving strip (see startEffectStrip). */
const fxStrip = {
  canvas: $('feStrip'),
  group: null,
  // Counts the asks, so an older answer that comes late is dropped.
  seq: 0,
  timer: 0,
  raf: 0,
  // The last answer: frames (RGB per segment, frame after frame), how many, how fast, and each fixture's segments.
  frames: null, count: 0, fps: 20, segments: 0, fixtures: [],
  // The tempo and speed the frames were made at, as "tempo|speed", to ask again when they change.
  clock: null,
  // The rate the answer ran the effect at (cycles a second, slowed by light safety when it is) and the effect it was for.
  rate: 0, answerFor: null,
  start: 0,
  // When the last ask went (performance.now()), for the Size drag's one ask per FX_STRIP_WAIT.
  askedAt: -Infinity,
  // The last ask got no answer: the strip is dark and asks again on the next state.
  failed: false,
  // The frame on the canvas now (-1: dark), so it is only drawn again when that changes; null: draw next time.
  drawn: null,
};
/** A change is shown this long after the last one; a Size drag asks at most this often. */
const FX_STRIP_WAIT = 250;
/** The gap between two fixtures, so bars read as bars. */
const FX_STRIP_GAP = 6;
/** Mixed down like a swatch, so the strip never lights the operator's face. */
const FX_STRIP_ALPHA = 0.85;

/** The group the colour editor is for, and the listed colour it edits (undefined for a new one, or once it is gone). */
const editGroup = () => (colourEdit ? layout?.groups.find((g) => g.id === colourEdit.group) : undefined);
const editedPreset = () => (colourEdit?.id ? editGroup()?.presets.find((p) => p.id === colourEdit.id) : undefined);

/** The fades the editor offers, in seconds. A colour with another fade gets one more button, selected. */
const COLOUR_FADES = [0, 1, 2, 3, 5, 10];
const fadeText = (s) => (s === 0 ? 'Instant' : `${s} s`);
const MIN_LEVEL = 0.05;
/** The Brightness slider of the colour editor, in the shape `showLevel` wants. */
const ceLevel = { dim: $('ceLevel'), slab: $('ceLevelSlab'), pct: $('ceLevelPct'), value: 1, dragging: false };
/** A new colour's White, Amber and UV sliders (for groups with those channels), shaped as showLevel wants. */
let editExtraRows = [];

/** Shows the brightness the editor holds (5–100 %). */
function showEditLevel(v) {
  showLevel(ceLevel, Math.max(MIN_LEVEL, v));
  if (colourEdit) colourEdit.level = ceLevel.value;
}

/**
 * A segmented choice of `values` in `box` (Fade into it, Apply to): the buttons are made again only when the
 * labels change, so a render never takes a tap away. `pick(value)` runs on a tap.
 */
function buildChoice(box, values, label, pick) {
  const key = values.map(label).join('|');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...values.map((v) => {
    const b = el('button', null, label(v));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = JSON.stringify(v);
    b.addEventListener('click', () => {
      if (!colourEdit) return;
      pick(v);
      disarmDelete();
      renderEditor();
    });
    return b;
  }));
}

function markChoice(box, selected) {
  for (const b of box.children) {
    const on = b.dataset.value === JSON.stringify(selected);
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

/** The colour's White, Amber and UV, as its sliders show them (as it was, or 0, where the group has no slider). */
function editLevels() {
  const levels = { ...(colourEdit?.startExtras ?? NO_EXTRAS) };
  for (const r of editExtraRows) levels[r.key] = Math.round(r.value * 100) / 100;
  return levels;
}

/** The White, Amber and UV sliders were moved away from what the listed colour has. */
function extrasChanged() {
  if (!colourEdit?.id) return false;
  const now = editLevels();
  return ['white', 'amber', 'uv'].some((k) => Math.abs(now[k] - colourEdit.startExtras[k]) >= 0.005);
}

/** The colour (#rrggbb) Save would keep: the one picked on the strip, else the listed colour's own (black for None yet). */
function editHex() {
  const p = editedPreset();
  return colourEdit.hex ?? (p ? presetHex(p) : '#000000');
}

/** There is some light in it: a colour, or White, Amber or UV above 0 (an amber-only colour, say). Save needs it. */
function editReady() {
  if (!colourEdit) return false;
  const p = editedPreset();
  // Off and colours of several layers keep their light (only their name and fade change).
  if (p && p.canRecolour === false) return true;
  const l = editLevels();
  return !/^#0{6}$/i.test(editHex()) || l.white > 0 || l.amber > 0 || l.uv > 0;
}

/** White, Amber and UV sliders, as Any colour has them, from `start`; they change only the editor, never the stage. */
function buildEditExtras(group, start) {
  const box = $('ceExtras');
  box.replaceChildren();
  editExtraRows = [];
  const names = [];
  for (const x of group ? EXTRAS : []) {
    if (!group.extras?.[x.key]) continue;
    names.push(x.label);
    const row = extraSlider(box, x, `${x.label} in the colour`);
    showLevel(row, start[x.key]);
    editExtraRows.push(row);
    let startX = 0, startV = 0;
    row.dim.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      row.dragging = true;
      try { row.dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
      row.dim.classList.add('ds-dragging');
      startX = ev.clientX;
      startV = row.value;
    });
    row.dim.addEventListener('pointermove', (ev) => {
      if (!row.dragging) return;
      showLevel(row, startV + (ev.clientX - startX) / row.dim.clientWidth);
      renderEditor();
    });
    const end = () => {
      row.dragging = false;
      row.dim.classList.remove('ds-dragging');
    };
    row.dim.addEventListener('pointerup', end);
    row.dim.addEventListener('pointercancel', end);
  }
  $('ceExtrasLab').textContent = names.join(' · ');
}

/** A listed colour's own White, Amber and UV, to whole percent (its light is scaled by its brightness; this undoes that). */
function presetExtras(p) {
  const k = p.level && p.level > 0 ? p.level : 1;
  const raw = (v) => Math.min(1, Math.round(((v ?? 0) / k) * 100) / 100);
  return { white: raw(p.light?.white), amber: raw(p.light?.amber), uv: raw(p.light?.uv) };
}

/** A listed colour's own #rrggbb, before its brightness (from an older server: its light, scaled back up). */
function presetHex(p) {
  if (p.colour) return p.colour;
  const hex = p.light?.hex;
  if (!hex) return '#000000';
  const k = p.level && p.level > 0 ? p.level : 1;
  const n = parseInt(hex.slice(1), 16);
  return `#${[16, 8, 0].map((sh) => Math.min(255, Math.round(((n >> sh) & 255) / k)).toString(16).padStart(2, '0')).join('')}`;
}

/** "Song 2, Song 3 · quick looks: Worship, Prayer": the songs (and any other look) first, then the quick looks. */
function usedInText(names) {
  if (!names.length) return 'Nothing yet';
  const order = new Set(layout.runningOrder.map((l) => l.name));
  const quick = new Set(layout.quickLooks.map((q) => q.name));
  const songs = names.filter((n) => order.has(n) || !quick.has(n));
  const looks = names.filter((n) => !songs.includes(n));
  const list = (xs) => (xs.length > 6 ? `${xs.slice(0, 6).join(', ')} and ${xs.length - 6} more` : xs.join(', '));
  if (!songs.length) return `Quick looks: ${list(looks)}`;
  return looks.length ? `${list(songs)} · quick looks: ${list(looks)}` : list(songs);
}

/** "Used in …" for the songs and quick looks that use any of these presets (the effect editor's line). */
function usedText(presets) {
  const used = [...new Set(presets.flatMap((x) => x.usedBy ?? []))];
  return used.length ? `Used in ${used.slice(0, 4).join(', ')}${used.length > 4 ? ` and ${used.length - 4} more` : ''}` : 'Not used in any song or quick look';
}

/**
 * Opens the colour editor in the whole right column: on a listed colour (from Edit this colour), or with `preset`
 * null on a new one (＋ New colour). It stays on that colour whatever the stage does, until Cancel, Save or Delete.
 */
function openColourEditor(preset) {
  const row = pickerRow();
  if (!row) return;
  closeEditor();
  const group = row.group;
  const fade = preset ? preset.fade ?? 0 : 3;
  // Off has a level of 0 and no colour to dim, and a colour of several layers has no one brightness: no slider.
  const level = !preset ? 1 : preset.canRecolour === false ? null : preset.level ?? null;
  // A listed plain colour's White, Amber and UV can change too; a new colour starts without them.
  const recolour = !preset || preset.canRecolour !== false;
  const startExtras = preset && recolour ? presetExtras(preset) : { ...NO_EXTRAS };
  // The colour as it is: its own hex (before its brightness), so Exact values show exactly what was typed or picked.
  const startHex = preset && recolour ? presetHex(preset) : null;
  colourEdit = { group: group.id, id: preset?.id ?? null, name: preset?.name ?? '', hex: null, startHex, level, startLevel: level, fade, startFade: fade, all: false, startExtras };
  pendingEdit = null;
  disarmDelete();
  $('ceName').value = colourEdit.name;
  $('ceBack').textContent = `‹ ${group.name}`;
  $('ceBack').setAttribute('aria-label', `Back to ${group.name}'s colours`);
  $('ceStrip').className = `strip2 ce-strip ${group.whiteOnly ? 'cct' : 'hue'}`;
  $('ceStrip').setAttribute('aria-label', group.whiteOnly ? 'Pick the colour: warm to cool' : 'Pick the colour');
  // The colour's place on the strip (the nearest to its hue), its saturation and exact values; a new colour has none until one is picked.
  ceColour.set(startHex, true);
  ceColour.fold(false);
  buildEditExtras(recolour ? group : null, startExtras);
  if (level !== null) showEditLevel(level);
  $('ceDelRow').hidden = !preset;
  $('colEdit').hidden = false;
  markEditorOpen();
  $('colEdit').scrollTop = 0;
  renderEditor();
}

/** Back to the picker (the colour editor only); `keepPending` keeps waiting for a Save or Delete already sent. */
function closeColourEditor(keepPending = false) {
  colourEdit = null;
  ceColour.cancel();
  if (!keepPending) pendingEdit = null;
  disarmDelete();
  $('ceName').blur();
  $('colEdit').hidden = true;
  markEditorOpen();
}

/** An editor (colour or effect) or Individual lights open: it takes the whole right column, and Quick looks and Groups give way. */
function markEditorOpen() {
  $('colEdit').parentElement.classList.toggle('ce-open', !$('colEdit').hidden || !$('fxEdit').hidden || !$('manual').hidden);
}

/** Closes whichever editor is open (colour or effect). */
function closeEditor(keepPending = false) {
  closeColourEditor(keepPending);
  closeEffectEditor();
}

/** Keeps the editor true to the show and to what has been picked: titles, swatch, the rows that apply, Used in, Delete. */
function renderEditor() {
  if (!colourEdit) return;
  const group = editGroup();
  const p = editedPreset();
  // The colour (or its group) went: deleted on another tablet, or by Undo.
  if (!group || (colourEdit.id && !p)) {
    closeColourEditor(true);
    return;
  }
  const isNew = !p;
  // Renamed elsewhere (another tablet, Undo): an untouched name field follows.
  if (!isNew && p.name !== colourEdit.name) {
    if ($('ceName').value === colourEdit.name) $('ceName').value = p.name;
    colourEdit.name = p.name;
  }
  $('ceTitle').textContent = isNew ? `New colour for ${group.name}` : `${p.name} on ${group.name}`;
  // In Prepare a Save changes the colour in the list (and the draft) but never the lights: the stage keeps
  // showing it as it was until it next takes that colour.
  $('ceNote').textContent = isNew ? 'Trying colours here never changes the stage'
    : prep.on ? 'Saving changes this colour; the lights change when the stage next uses it' : 'The stage changes only when you Save';

  // The swatch: what Save would keep (nothing while there is no light in it).
  const recolour = isNew || p.canRecolour !== false;
  const colourChanged = !isNew && recolour && (hexChanged() || extrasChanged());
  let look = null;
  if (isNew || colourChanged) look = editReady() ? mixedColour(editHex(), editLevels()) : null;
  else look = p.swatch ?? null;
  const off = !look || look === '#000000';
  $('ceSw').classList.toggle('off', off);
  $('ceSw').style.background = off ? '' : shown(look) ?? look;
  // The Brightness slider carries a little of the colour, as the group dimmers do.
  ceLevel.dim.style.setProperty('--c', off ? '#6a7898' : shown(look) ?? look);

  // Colour: not for Off or a colour of several layers (they can be renamed only). No colour: White, Amber or UV alone.
  // Saturation: not on the warm-to-cool strip. Exact values: the colour as hex and R, G, B.
  $('ceColourRow').hidden = !recolour;
  $('ceSatRow').hidden = !recolour || group.whiteOnly;
  $('ceExactRow').hidden = !recolour;
  $('ceNoColour').hidden = !recolour || !editExtraRows.length;
  const none = /^#0{6}$/i.test(editHex());
  $('ceNoColour').classList.toggle('on', none);
  $('ceNoColour').setAttribute('aria-pressed', String(none));
  $('ceExtrasRow').hidden = !recolour || !editExtraRows.length;
  // Brightness: only where it can change (not Off, an effect or a colour of several layers).
  $('ceLevelRow').hidden = colourEdit.level === null;

  // Fade into it: the usual ones, and the colour's own when it isn't one of them.
  const fades = COLOUR_FADES.includes(colourEdit.startFade) ? COLOUR_FADES : [...COLOUR_FADES, colourEdit.startFade].sort((a, b) => a - b);
  buildChoice($('ceFade'), fades, fadeText, (v) => { colourEdit.fade = v; });
  markChoice($('ceFade'), colourEdit.fade);

  // Apply to: only this group, or every group with this colour: the other groups' colours of this name (name, colour,
  // brightness, fade), and with a new colour the shared colour it points to. A new one: every group of its kind.
  // Left out when no other group could be reached; "Every group" is unavailable while this edit can't reach another
  // (a shared colour with no other of its name, until a colour or White, Amber or UV is changed).
  const others = isNew ? [] : layout.groups.filter((g) => g.id !== group.id).flatMap((g) => g.presets.filter((x) => x.name === p.name));
  const shared = isNew ? null : p.shared && p.shared.groups > 1 ? p.shared : null;
  const kind = layout.groups.filter((g) => g.id !== group.id && !isSmoke(g) && g.whiteOnly === group.whiteOnly);
  const showAll = isNew ? kind.length > 0 : others.length > 0 || !!shared;
  const reachesMore = isNew ? kind.length > 0 : others.length > 0 || (!!shared && colourChanged);
  if (!reachesMore) colourEdit.all = false;
  $('ceApplyRow').hidden = !showAll;
  const everyLabel = isNew ? (group.whiteOnly ? 'Every white-only group' : 'Every colour group') : `Every group with ${p.name}`;
  buildChoice($('ceApply'), [false, true], (all) => (all ? everyLabel : `Only ${group.name}`), (all) => { colourEdit.all = all; });
  markChoice($('ceApply'), colourEdit.all);
  $('ceApply').children[1].disabled = !reachesMore;

  // Used in: what Save will change. With every group, the other groups' colours of this name, and with a new
  // colour (or White, Amber or UV) everything that uses the shared colour.
  let used = [];
  if (!isNew) {
    const affected = colourEdit.all ? [p, ...others] : [p];
    used = [...new Set([...affected.flatMap((x) => x.usedBy ?? []), ...(colourEdit.all && shared && colourChanged ? shared.usedBy : [])])];
  }
  $('ceUsed').textContent = usedInText(used);

  // Save: the colour needs some light in it.
  $('ceSave').disabled = pendingEdit !== null || !editReady();

  // Delete: the server refuses a colour a song or quick look uses, and one the group shows (on stage, or in this tablet's draft).
  if (!isNew) {
    const users = p.usedBy ?? [];
    const showing = [state, prep.on ? prep.state : null].some((st) => st?.groups?.[group.id]?.preset === p.id);
    $('ceDelete').disabled = pendingEdit !== null || users.length > 0 || showing;
    if (users.length || showing) disarmDelete();
    $('ceDelNote').textContent = users.length
      ? "It can't be deleted while a song or quick look uses it: give them another colour first."
      : showing
        ? `It can't be deleted while ${group.name} shows it.`
        : 'No song or quick look uses it, so deleting it changes nothing else.';
  }
}

function disarmDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = 0;
  $('ceDelete').classList.remove('armed');
  $('ceDelete').textContent = 'Delete colour';
  $('feDelete').classList.remove('armed');
  $('feDelete').textContent = 'Delete';
}

$('ceBack').addEventListener('click', () => closeEditor());
$('ceCancel').addEventListener('click', () => closeEditor());
$('ceName').addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter') $('ceName').blur();
});
$('ceName').addEventListener('input', disarmDelete);

// No colour: the colour comes off, so the colour can be White, Amber or UV alone.
$('ceNoColour').addEventListener('click', () => {
  if (!colourEdit) return;
  colourEdit.hex = colourEdit.id ? '#000000' : null;
  ceColour.set(colourEdit.hex);
  disarmDelete();
  renderEditor();
});

// Brightness: moves relative to where the finger starts, like the other sliders. Only the editor's value moves; Save sends it.
{
  let startX = 0, startV = 0;
  const dim = ceLevel.dim;
  dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (!colourEdit || colourEdit.level === null) return;
    ceLevel.dragging = true;
    try { dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    dim.classList.add('ds-dragging');
    startX = ev.clientX;
    startV = ceLevel.value;
  });
  dim.addEventListener('pointermove', (ev) => {
    if (!ceLevel.dragging) return;
    showEditLevel(startV + (ev.clientX - startX) / dim.clientWidth);
    disarmDelete();
  });
  const end = () => {
    ceLevel.dragging = false;
    dim.classList.remove('ds-dragging');
  };
  dim.addEventListener('pointerup', end);
  dim.addEventListener('pointercancel', end);
}

// The strip, Saturation and Exact values only change the editor: the stage changes when an edited colour that is lit
// is saved, never while picking.
const ceColour = colourTools({
  strip: $('ceStrip'), handle: $('ceH'), sat: $('ceSat'), fold: $('ceFold'), exact: $('ceExact'), row: true,
  whiteOnly: () => editGroup()?.whiteOnly ?? null,
  onColour: (hex) => {
    if (!colourEdit) return;
    colourEdit.hex = hex;
    disarmDelete();
    renderEditor();
  },
});

/** The colour (#rrggbb) was changed from what the listed colour has (picking it again, or typing it, is no change). */
const hexChanged = () => !!colourEdit?.hex && colourEdit.hex !== colourEdit.startHex;

const editLevel = () => Math.min(1, Math.max(MIN_LEVEL, Math.round(colourEdit.level * 100) / 100));

// A plain tap. Only what changed is sent; the editor goes back to the picker when the server says yes (one Undo step).
$('ceSave').addEventListener('click', () => {
  if (!colourEdit || pendingEdit !== null) return;
  const group = editGroup();
  if (!group) return;
  const name = $('ceName').value;
  if (!colourEdit.id) {
    if (!editReady()) return;
    // No colour picked: the light is its White, Amber or UV alone, on a black colour.
    const cmd = { type: 'addColour', group: group.id, colour: colourEdit.hex ?? '#000000', ...editLevels(), name, allGroups: colourEdit.all, fade: colourEdit.fade };
    if (colourEdit.level !== null && colourEdit.level < 1) cmd.level = editLevel();
    pendingEditToast = 'Added to colours';
    pendingEdit = send(cmd);
    renderEditor();
    return;
  }
  const p = editedPreset();
  if (!p) return;
  if (!editReady()) return;
  // Every group: the other groups' colours of this name too (name, colour, White, Amber and UV, brightness and fade),
  // and with a new colour (or White, Amber or UV), the shared colour it points to, so every colour that points to it follows.
  const all = colourEdit.all && !$('ceApplyRow').hidden;
  const cmd = { type: 'editColour', preset: colourEdit.id, sameName: all };
  if (name.trim() !== colourEdit.name) cmd.name = name;
  if (hexChanged() && !$('ceColourRow').hidden) cmd.colour = colourEdit.hex;
  if (extrasChanged()) {
    const now = editLevels();
    for (const k of ['white', 'amber', 'uv']) if (Math.abs(now[k] - colourEdit.startExtras[k]) >= 0.005) cmd[k] = now[k];
  }
  const recoloured = cmd.colour !== undefined || cmd.white !== undefined || cmd.amber !== undefined || cmd.uv !== undefined;
  if (colourEdit.level !== null && Math.abs(colourEdit.level - colourEdit.startLevel) >= 0.005) cmd.level = editLevel();
  if (colourEdit.fade !== colourEdit.startFade) cmd.fade = colourEdit.fade;
  if (recoloured && all && p.shared) cmd.shared = true;
  if (cmd.name === undefined && !recoloured && cmd.level === undefined && cmd.fade === undefined) {
    closeEditor();
    return;
  }
  pendingEditToast = 'Colour saved';
  pendingEdit = send(cmd);
  renderEditor();
});

// First tap arms it ("Tap again to delete"), the second one deletes. It disarms after a few seconds.
$('ceDelete').addEventListener('click', () => {
  if (!colourEdit?.id || pendingEdit !== null) return;
  if (!deleteArmed) {
    deleteArmed = setTimeout(disarmDelete, 4000);
    $('ceDelete').classList.add('armed');
    $('ceDelete').textContent = 'Tap again to delete';
    return;
  }
  pendingEditToast = 'Colour deleted';
  pendingEdit = send({ type: 'deleteColour', preset: colourEdit.id });
  disarmDelete();
  renderEditor();
});

/** The server's answer to a Save or Delete in either editor: done (back to the picker), or kept open to fix. */
function finishEdit(error) {
  pendingEdit = null;
  $('feSave').disabled = false;
  $('feCopy').disabled = false;
  if (!error) {
    closeEditor();
    toast(pendingEditToast, true);
  } else {
    renderEditor();
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
const effectSig = (layer) => JSON.stringify({
  ...layer, colours: layer.colours.map(colourKey), base: layer.base ? [colourKey(layer.base.colour), layer.base.level] : null,
});

/** Yo-yo and meteor run in one colour: tapping a colour picks it instead of adding it. */
const ONE_COLOUR = new Set(['yoyo', 'meteor']);

/**
 * The colours the editor offers: the group's own colour list, then the effect's own colours (any
 * colour it has, or has as its base, that is not in the list), so they can be taken out and put back.
 */
function effectChoices(group, effect) {
  const choices = [];
  for (const p of group.presets) {
    if (p.effect || !p.light) continue;
    addChoice(choices, p.name, p.swatch ?? NEUTRAL, { hex: p.light.hex, white: p.light.white, amber: p.light.amber, uv: p.light.uv });
  }
  for (const c of [...effect.colours, ...(effect.base ? [effect.base.colour] : [])]) addOwnChoice(choices, c);
  return choices;
}

/** Adds a choice unless one of the same colour is there already; returns the one there. */
function addChoice(choices, name, swatch, colour) {
  const key = colourKey(colour);
  const found = choices.find((c) => c.key === key);
  if (found) return found;
  const choice = { key, name, swatch, colour, own: false };
  choices.push(choice);
  return choice;
}

/** An own colour: one the effect has that is in no list of the group's. They are numbered Own 1, Own 2 … to tell them apart. */
function addOwnChoice(choices, colour) {
  const count = choices.length;
  const choice = addChoice(choices, `Own ${choices.filter((c) => c.own).length + 1}`, colour.hex, plainColour(colour));
  if (choices.length > count) choice.own = true;
  return choice;
}

/** The group's Off colour: no light, so as a base it is the same as None. */
const OFF_KEY = '#000000|0|0|0';

/** A new effect starts as a wave of the group's first two colours (not Off), one round every 4 beats. */
function newEffectLayer(choices) {
  const colours = choices.filter((c) => c.key !== OFF_KEY).slice(0, 2).map((c) => ({ ...c.colour }));
  if (!colours.length) colours.push({ hex: '#ffffff' });
  return liveLayer({ effect: 'wave', colours, speed: { beats: 4 }, direction: 'ltr', waves: 1, size: 0.5, edge: 'soft', intensity: 1 });
}

/** Fine-tune (Waves, Size, Edges): folded each time the editor opens, open once tapped. */
let fineOpen = false;
/** The list open under its row: 'colours' (＋ Colour), 'base' (a base colour) or null. */
let feTray = null;

/**
 * Opens the effect editor in the whole right column: on a listed effect, or (preset null) on a new one: a new wave,
 * or `from`'s settings when given (All settings on a running effect that isn't in the list).
 */
function openEffectEditor(preset, from = null) {
  const row = pickerRow();
  if (!row) return;
  closeEditor();
  const saved = preset ? liveLayer(preset.effect) : from ? liveLayer(from) : null;
  // Yo-yo and meteor run in their first colour only (a ready-made one may list more): the editor shows that one,
  // and Save keeps just it, so `original` is the effect as saved.
  const opened = saved && ONE_COLOUR.has(saved.effect) ? { ...saved, colours: saved.colours.slice(0, 1) } : saved;
  const choices = effectChoices(row.group, opened ?? { colours: [] });
  const effect = opened ?? newEffectLayer(choices);
  effectEdit = { id: preset?.id ?? null, name: preset?.name ?? '', effect, original: effectSig(saved ?? effect), choices };
  pendingEdit = null;
  disarmDelete();
  fineOpen = false;
  feTray = null;
  const group = row.group;
  $('feName').value = effectEdit.name;
  $('feBack').textContent = `‹ ${group.name}`;
  $('feBack').setAttribute('aria-label', `Back to ${group.name}'s effects`);
  $('fePrevLab').textContent = `Preview on ${group.name}`;
  $('feSave').disabled = false;
  $('feCopy').disabled = false;
  // Save as a copy and Delete are for a listed effect.
  $('feMoreWrap').hidden = !preset;
  showEffectMenu(false);
  $('feUsed').hidden = !preset;
  closeOwnStrips();
  $('fxEdit').hidden = false;
  markEditorOpen();
  $('fxEdit').scrollTop = 0;
  drawEffectEditor();
  startEffectStrip(picker.group);
  renderEffectEditor();
}

function closeEffectEditor() {
  effectEdit = null;
  effectMover.end();
  closeOwnStrips();
  feTray = null;
  showEffectMenu(false);
  stopEffectStrip();
  $('feName').blur();
  $('fxEdit').hidden = true;
  markEditorOpen();
}

/** Keeps "Used in …" and the round's length true as the show and the tempo change; closes the editor if the effect is gone. */
function renderEffectEditor() {
  if (!effectEdit) return;
  $('feNote').textContent = prep.on ? 'only here — after Save, the lights change when the stage next runs it' : "only here — the stage doesn't change until Save";
  followEffectStripClock();
  drawSpeedNote();
  if (effectEdit.id === null) return;
  const p = pickerRow()?.group.presets.find((x) => x.id === effectEdit.id);
  if (!p?.effect) {
    closeEffectEditor();
    return;
  }
  $('feUsed').textContent = usedText([p]);
}

/** Draws what the editor holds: the kind, the colours in order (and their list), the base, the settings and Fine-tune. */
function drawEffectEditor() {
  const { effect, choices } = effectEdit;
  for (const b of $('feKind').children) {
    const on = b.dataset.kind === effect.effect;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  const one = ONE_COLOUR.has(effect.effect);
  const kindName = EFFECT_NAMES.find(([k]) => k === effect.effect)?.[1] ?? 'This effect';
  $('feColLab').textContent = one ? 'Colour' : 'Colours';

  // Colours: the chosen ones in the order they play, numbered (hold one and drag it onto another), then ＋ Colour.
  const choiceOf = (c) => choices.find((x) => x.key === colourKey(c)) ?? { name: 'Own', swatch: c.hex };
  const order = $('feColours');
  order.replaceChildren();
  order.setAttribute('role', 'group');
  order.setAttribute('aria-label', one ? 'Colour' : 'Colours, in the order they play');
  effect.colours.forEach((c, at) => {
    const b = orderChip(choiceOf(c), one ? null : at + 1);
    if (!one && effect.colours.length > 1) effectMover.wire(b, at);
    // A tap opens the list (to take it out or add another); the click a drag ends with is not a tap.
    b.addEventListener('click', () => { if (!effectMover.quiet()) showTray('colours'); });
    order.append(b);
  });
  const add = el('button', 'fe-add', one ? 'Change colour' : '＋ Colour');
  add.type = 'button';
  add.setAttribute('aria-expanded', String(feTray === 'colours'));
  add.classList.toggle('open', feTray === 'colours');
  add.addEventListener('click', () => showTray(feTray === 'colours' ? null : 'colours'));
  order.append(add);
  const note = one ? `${kindName} runs in one colour` : effect.colours.length > 1 ? 'hold & drag to reorder' : '';
  if (note) order.append(el('span', 'fe-note', note));

  // The list: the group's colours and the effect's own; a tap adds or removes one (picks it, for one colour).
  $('feTray').hidden = feTray !== 'colours';
  $('feTrayLab').textContent = one ? 'Tap a colour to use it' : 'Tap to add or remove · 1 to 6 colours';
  const keys = effect.colours.map(colourKey);
  const list = $('feChoices');
  list.replaceChildren();
  list.setAttribute('role', one ? 'radiogroup' : 'group');
  list.setAttribute('aria-label', one ? 'Colour' : 'Colours');
  for (const c of choices) {
    const at = keys.indexOf(c.key);
    const b = colourChip(c, at >= 0, one ? 'radio' : 'checkbox');
    if (at >= 0 && !one) b.append(el('b', 'fenum', String(at + 1)));
    b.addEventListener('click', () => toggleEffectColour(c));
    list.append(b);
  }
  // Full only once a pick has ended: the strip must stay under the finger while it picks the sixth colour.
  // Full only when the open box's own colour isn't one of the six: it must stay open while it changes the sixth.
  list.append(ownChip('feOwn', 'Pick an own colour for the effect', !one && effect.colours.length >= 6 && ownPlace() < 0));

  // Base: None, a colour of the list or an own colour, at its brightness.
  const baseKey = effect.base ? colourKey(effect.base.colour) : null;
  const baseChoice = baseKey ? choices.find((c) => c.key === baseKey) ?? null : null;
  const ownBase = !!effect.base && (!baseChoice || baseChoice.own);
  const listedBase = effect.base && !ownBase ? baseChoice : null;
  const seg = $('feBase');
  seg.replaceChildren();
  const segButton = (text, on, open, pick) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(on));
    b.classList.toggle('on', on);
    if (open !== null) b.setAttribute('aria-expanded', String(open));
    b.addEventListener('click', pick);
    seg.append(b);
    return b;
  };
  segButton('None', !effect.base, null, () => {
    feTray = feTray === 'base' ? null : feTray;
    closeOwnStrips();
    setEffectBase(null);
    drawEffectEditor();
  });
  const baseOpen = feTray === 'base';
  const ownOpen = baseOpen && !$('feBaseOwnBox').hidden;
  segButton(listedBase?.name ?? 'Colour', !!listedBase, baseOpen && !ownOpen, () => showTray(baseOpen && !ownOpen ? null : 'base'));
  segButton('Own colour', ownBase, ownOpen, () => {
    if (ownOpen) return showTray(null);
    showTray('base');
    openOwnStrip('feBaseOwn');
    drawEffectEditor();
  });
  $('feBaseTray').hidden = !baseOpen;
  const bases = $('feBaseChoices');
  bases.replaceChildren();
  for (const c of choices) {
    if (c.key === OFF_KEY) continue;
    const b = colourChip(c, c.key === baseKey, 'radio');
    b.addEventListener('click', () => {
      feTray = null;
      closeOwnStrips();
      setEffectBase(c.colour);
      drawEffectEditor();
    });
    bases.append(b);
  }
  bases.append(ownChip('feBaseOwn', 'Pick an own colour for the base'));
  // Its brightness: the fill carries the base colour; "Dark where the effect is dark" without one.
  const dim = baseLevel.dim;
  dim.classList.toggle('fe-off', !effect.base);
  dim.setAttribute('aria-disabled', String(!effect.base));
  $('feBaseLevelLab').hidden = !effect.base;
  $('feBaseNone').hidden = !!effect.base;
  if (effect.base) {
    const sw = baseChoice?.swatch ?? effect.base.colour.hex;
    dim.style.setProperty('--c', shown(sw) ?? sw);
    if (!baseLevel.dragging) showLevel(baseLevel, effect.base.level);
  } else {
    baseLevel.slab.style.width = '0';
    dim.removeAttribute('aria-valuenow');
  }

  effectEditSettings.show(effect, shownState()?.tempo ?? 120);
  drawSpeedNote();
  drawFineTune();
}

/** Fine-tune's one-line summary ("Waves 2 · Size 50 % · Soft edges", the settings this effect uses) and its fold. */
function drawFineTune() {
  const { effect } = effectEdit;
  const uses = effectUses(effect);
  const parts = [];
  if (uses.waves) parts.push(`Waves ${effect.waves}`);
  if (uses.size) parts.push(`${uses.size} ${Math.round(effect.size * 100)} %`);
  parts.push(effect.edge === 'hard' ? 'Hard edges' : 'Soft edges');
  $('feFineSum').textContent = parts.join(' · ');
  $('feFine').setAttribute('aria-expanded', String(fineOpen));
  $('feFineArrow').textContent = fineOpen ? '▴' : '▾';
  $('feFineBox').hidden = !fineOpen;
}

/**
 * The round's length beside Speed: "one round = 2 s at 120 bpm" (or "one round = 10 s" for Free) at the tempo and speed
 * the page shows (the draft's in Prepare). Once the strip's answer for this very effect is in, its rate (slowed by light
 * safety, as on stage) gives the length, with "· slowed to stay safe" when it is.
 */
function drawSpeedNote() {
  if (!effectEdit) return;
  const effect = liveLayer(effectEdit.effect);
  const { tempo, speed } = stripClock();
  const asked = 'beats' in effect.speed ? (effect.speed.beats * 60) / (tempo * speed) : effect.speed.seconds / speed;
  const answered = fxStrip.rate > 0 && Number.isFinite(fxStrip.rate) && fxStrip.answerFor === effectSig(effect) && fxStrip.clock === `${tempo}|${speed}`;
  const round = answered ? Math.max(asked, 1 / fxStrip.rate) : asked;
  $('feSpeedNote').textContent = roundText(effect, { round, slowed: round > asked * 1.01 });
}

/** Opens one list under its row ('colours' or 'base'), or none; an own colour strip that was open closes. */
function showTray(name) {
  feTray = name;
  closeOwnStrips();
  drawEffectEditor();
}

// ---- Hold and drag: hold a tile, then drop it on another to give it that place (effect colours, quick looks) ----

/** How long a finger (or the mouse) holds a tile before it lifts, in ms. */
const REORDER_HOLD = 300;
/** Moving further than this (px) before it lifts is a swipe (the panel scrolls), not a hold. */
const REORDER_SLOP = 8;

/**
 * One hold-and-drag over the tiles of `container`. Each tile is wired with `mover.wire(tile, at)`, `at` being its place;
 * `tileSelector` matches the wired tiles. A hold of REORDER_HOLD lifts the tile (its place dims), a quiet copy
 * (`ghostClass`) follows the pointer, and the tile under it is outlined. Letting go over another tile calls
 * `onDrop(from, over, token)`. A touch that moves further than REORDER_SLOP before the lift is a swipe, not a hold.
 *
 * `state()` says whether moving is allowed now: it returns a token (anything truthy) or a falsy value. The token
 * is what `state()` gave when the hold began, so `onDrop` can tell whether what was held is still there.
 * `mover.end()` ends a hold (call it when the tiles are replaced); `mover.quiet()` is true for a moment after a drop,
 * so the click that ends a drag is not taken for a tap.
 */
function holdToMove({ container, tileSelector, ghostClass, state, onDrop }) {
  const m = { pointer: null, timer: 0, from: -1, over: -1, x: 0, y: 0, startX: 0, startY: 0, lifted: false, ghost: null, quietUntil: 0, token: null };
  const tiles = () => container.querySelectorAll(tileSelector);

  function end() {
    clearTimeout(m.timer);
    m.timer = 0;
    m.pointer = null;
    m.lifted = false;
    m.token = null;
    m.from = m.over = -1;
    m.ghost?.remove();
    m.ghost = null;
    for (const b of container.querySelectorAll('.lifted, .drop')) b.classList.remove('lifted', 'drop');
  }

  function lift() {
    m.timer = 0;
    const tile = container.querySelector(`${tileSelector}[data-at="${m.from}"]`);
    if (!state() || !tile) return end();
    m.lifted = true;
    tile.classList.add('lifted');
    // A quiet copy follows the finger.
    const r = tile.getBoundingClientRect();
    const ghost = tile.cloneNode(true);
    ghost.className = ghostClass;
    ghost.removeAttribute('data-at');
    ghost.removeAttribute('data-id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    ghost.dataset.dx = String(m.startX - r.left);
    ghost.dataset.dy = String(m.startY - r.top);
    document.body.append(ghost);
    m.ghost = ghost;
    follow();
  }

  /** Moves the copy to the pointer and outlines the tile under it (the only places it can go). */
  function follow() {
    const { ghost } = m;
    if (!ghost) return;
    ghost.style.left = `${m.x - Number(ghost.dataset.dx)}px`;
    // A little above the finger, so the outline of the tile under it still shows.
    ghost.style.top = `${m.y - Number(ghost.dataset.dy) - 10}px`;
    const under = document.elementFromPoint(m.x, m.y)?.closest(tileSelector);
    m.over = under && container.contains(under) ? Number(under.dataset.at) : -1;
    for (const b of tiles()) b.classList.toggle('drop', Number(b.dataset.at) === m.over && m.over !== m.from);
  }

  function drop() {
    const { from, over, token } = m;
    const moved = m.lifted;
    end();
    if (!moved) return;
    // The click that follows the lift is not a tap on the tile.
    m.quietUntil = performance.now() + 400;
    if (over < 0 || over === from) return;
    onDrop(from, over, token);
  }

  window.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== m.pointer) return;
    m.x = ev.clientX;
    m.y = ev.clientY;
    if (m.lifted) follow();
    else if (Math.hypot(ev.clientX - m.startX, ev.clientY - m.startY) > REORDER_SLOP) end();
  });
  window.addEventListener('pointerup', (ev) => { if (ev.pointerId === m.pointer) drop(); });
  window.addEventListener('pointercancel', (ev) => { if (ev.pointerId === m.pointer) end(); });
  // While a tile is lifted the finger moves it, not the panel.
  container.addEventListener('touchmove', (ev) => { if (m.lifted) ev.preventDefault(); }, { passive: false });
  container.addEventListener('click', (ev) => {
    if (performance.now() >= m.quietUntil) return;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  return {
    end,
    quiet: () => performance.now() < m.quietUntil,
    /** Makes `b`, the tile at place `at`, something to hold. */
    wire(b, at) {
      b.dataset.at = String(at);
      b.classList.add('movable');
      if (m.lifted && m.from === at) b.classList.add('lifted');
      b.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        const token = state();
        if (!token) return;
        end();
        m.pointer = ev.pointerId;
        m.from = at;
        // A drop applies only to what it was held on: the caller compares the token.
        m.token = token;
        m.x = m.startX = ev.clientX;
        m.y = m.startY = ev.clientY;
        m.timer = setTimeout(lift, REORDER_HOLD);
      });
      // A long press on a touch screen must not open the page's own menu.
      b.addEventListener('contextmenu', (ev) => { if (m.pointer !== null) ev.preventDefault(); });
    },
  };
}

/** An effect's chosen colours, held and dragged onto another to take its number. */
const effectMover = holdToMove({
  container: $('feColours'),
  tileSelector: '.fechip.movable',
  ghostClass: 'fechip fe-ghost',
  // A drop applies only to the effect it was held on: any other change in between ends the hold.
  state: () => (effectEdit ? effectEdit.effect : null),
  onDrop(from, over, effect) {
    if (!effectEdit || effectEdit.effect !== effect) return;
    const n = effect.colours.length;
    if (ONE_COLOUR.has(effect.effect) || from < 0 || from >= n || over < 0 || over >= n) return;
    const colours = [...effect.colours];
    const [colour] = colours.splice(from, 1);
    colours.splice(over, 0, colour);
    setEffectEdit({ ...effectEdit.effect, colours });
  },
});

/** One colour to choose in the editor: its swatch and name, on when chosen. */
function colourChip(c, on, role) {
  const b = el('button', 'fecol');
  b.type = 'button';
  b.setAttribute('role', role);
  b.setAttribute('aria-checked', String(on));
  const sw = el('i');
  sw.style.background = c.swatch ? shown(c.swatch) ?? NEUTRAL : 'transparent';
  b.append(sw, el('span', null, c.name));
  b.classList.toggle('on', on);
  return b;
}

/** A chosen colour in the Colours row: its number in the order (none for a one-colour effect), a round swatch and its name. */
function orderChip(c, n) {
  const b = el('button', 'fechip');
  b.type = 'button';
  if (n !== null) b.append(el('span', 'fechip-n', String(n)));
  const sw = el('i');
  if (!c.swatch || c.swatch === '#000000') sw.classList.add('off');
  else sw.style.background = shown(c.swatch) ?? NEUTRAL;
  b.append(sw, el('span', 'fechip-name', c.name));
  if (n !== null) b.setAttribute('aria-label', `${n}: ${c.name}`);
  return b;
}

/** ＋ Own colour: opens (or closes) its own colour box under its row; `full` when there is no room for another colour. */
function ownChip(stripId, label, full = false) {
  if (full && ownPick.strip === stripId) closeOwnStrips();
  const open = !$(`${stripId}Box`).hidden;
  const b = el('button', 'fecol add', '＋ Own colour');
  b.type = 'button';
  b.disabled = full;
  b.setAttribute('aria-label', full ? `${label} (an effect has at most six colours)` : label);
  b.setAttribute('aria-expanded', String(open));
  b.classList.toggle('open', open);
  b.addEventListener('click', () => {
    closeOwnStrips();
    if (!open) openOwnStrip(stripId);
    drawEffectEditor();
  });
  return b;
}

/** Which colours the own colour strips hold: hues, or warm to cool for a white-only group. */
const ownWhiteOnly = () => (pickerRow() ? pickerRow().group.whiteOnly : null);

/** Opens an own colour box with nothing picked yet (the first change adds the colour), Exact values folded. */
function openOwnStrip(id) {
  closeOwnStrips();
  $(id).className = `strip2 ${ownWhiteOnly() ? 'cct' : 'hue'} fe-own`;
  Object.assign(ownPick, { strip: id, key: null, made: null });
  ownTools[id].set(null, true);
  ownTools[id].fold(false);
  $(`${id}Box`).hidden = false;
}

/** Closes the own colour boxes; the colour a box made stays in the effect. */
function closeOwnStrips() {
  Object.assign(ownPick, { strip: null, key: null, made: null });
  for (const t of Object.values(ownTools)) t.cancel();
  for (const id of ['feOwn', 'feBaseOwn']) $(`${id}Box`).hidden = true;
}

function setEffectEdit(next) {
  if (!effectEdit) return;
  // A colour held for a new place belongs to the effect as it was: a change ends the hold.
  effectMover.end();
  effectEdit.effect = next;
  disarmDelete();
  drawEffectEditor();
  effectStripSoon();
}

/**
 * A tap on a colour adds it at the end of the order, or takes it out. An effect has one to six.
 * Yo-yo and meteor have one: a tap picks it instead.
 */
function toggleEffectColour(choice) {
  const { effect } = effectEdit;
  if (ONE_COLOUR.has(effect.effect)) {
    // The one colour is picked: the list closes.
    feTray = null;
    closeOwnStrips();
    if (colourKey(effect.colours[0]) !== choice.key) setEffectEdit({ ...effect, colours: [{ ...choice.colour }] });
    else drawEffectEditor();
    return;
  }
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
    if (!effectEdit || effectEdit.effect.effect === kind) return;
    const { colours } = effectEdit.effect;
    // Yo-yo and meteor run in one colour: they keep the first.
    setEffectEdit({ ...effectEdit.effect, effect: kind, colours: ONE_COLOUR.has(kind) ? colours.slice(0, 1) : colours });
  });
  $('feKind').append(b);
}

// The same settings as the Effects tab shows for a running effect; here they only change what is being edited.
const effectEditSettings = effectControls({ speed: $('feSpeed'), direction: $('feDir'), fine: $('feFineBox') }, (effect, how) => {
  if (!effectEdit || how === 'start') return;
  effectEdit.effect = effect;
  disarmDelete();
  if (how !== 'move') drawEffectEditor();
  else drawFineTune();
  if (how === 'move' || how === 'end') effectStripDrag(how);
  else effectStripSoon();
}, () => effectEdit?.effect ?? null);

/** The base colour: a colour (at the brightness it had, or half for a new base), or none. */
function setEffectBase(colour) {
  const { effect } = effectEdit;
  if (!colour) {
    if (!effect.base) return;
    const { base, ...rest } = effect;
    setEffectEdit(rest);
    return;
  }
  if (effect.base && colourKey(effect.base.colour) === colourKey(colour)) return;
  setEffectEdit({ ...effect, base: { colour: plainColour(colour), level: effect.base?.level ?? 0.5 } });
}

/**
 * The own colour boxes (＋ Own colour, for the colours or the base): a strip, Saturation and Exact values. The first
 * change adds an own colour (to the effect's colours, or as its base) and every change after it, while the box is
 * open, changes that same colour; ＋ Own colour again (or another list) closes the box. Own colours join the effect
 * only, never the group's list.
 *
 * The own colour pick in the open box: its strip's id (null: no box open), the key of the colour it gave the effect
 * (null until the first change) and the choice it added to the list (null when the colour was in the list already).
 */
const ownPick = { strip: null, key: null, made: null };

/** The place in the effect's colours of the own colour the open box made, or -1. */
function ownPlace() {
  if (ownPick.strip !== 'feOwn' || !ownPick.key || !effectEdit) return -1;
  return effectEdit.effect.colours.findIndex((c) => colourKey(c) === ownPick.key);
}

/**
 * Puts `hex` in the effect as the open box's own colour: its place in the colours (a new one at the end, the only one
 * for a yo-yo or meteor) or the base. False when it can't go there (no room, or the effect has it elsewhere already).
 */
function putOwnColour(stripId, hex, last) {
  const { choices, effect } = effectEdit;
  const key = colourKey({ hex });
  const colour = plainColour({ hex });
  let next;
  if (stripId === 'feOwn') {
    const one = ONE_COLOUR.has(effect.effect);
    let at = one ? 0 : ownPlace();
    if (at < 0) at = effect.colours.length;
    if (at >= 6) {
      if (last) toast('An effect has at most six colours', true);
      return false;
    }
    // The list never holds a colour twice: one the effect already has elsewhere is passed over.
    if (effect.colours.some((c, i) => i !== at && colourKey(c) === key)) {
      if (last) toast('That colour is in the effect already', true);
      return false;
    }
    const colours = [...effect.colours];
    colours[at] = colour;
    next = { ...effect, colours };
  } else {
    next = { ...effect, base: { colour, level: effect.base?.level ?? 0.5 } };
  }
  // The choice this box added before goes when nothing uses it any more, so the list doesn't fill with every step.
  const { made } = ownPick;
  const uses = (k) => next.colours.some((c) => colourKey(c) === k) || (!!next.base && colourKey(next.base.colour) === k);
  if (made && made.key !== key && choices.includes(made) && !uses(made.key)) choices.splice(choices.indexOf(made), 1);
  const count = choices.length;
  const choice = addOwnChoice(choices, colour);
  if (choices.length > count) ownPick.made = choice;
  else if (made?.key !== key) ownPick.made = null;
  effectEdit.effect = next;
  ownPick.key = key;
  disarmDelete();
  return true;
}

/** Every colour field's typing is taken now (see colourTools' flush), before a button acts on what the colour is. */
function flushColours() {
  // Any colour sends to the live stage: in Blackout a typed colour would light its group, so it is dropped there.
  if (!prep.on && state?.look === 'blackout') anyColour.drop();
  else anyColour.flush();
  ceColour.flush();
  for (const t of Object.values(ownTools)) t.flush();
}

// On iPad Safari a tap on a button leaves the focus in a field, so an R, G or B being typed would land after the tap
// (or never, behind a closed editor): a finger or pen coming down on any button first takes what is typed (Save, Done,
// Back, Cancel, a tile), before the button's own pointerdown starts a hold (Blackout, Flash, Puff, Save to the item),
// so nothing typed is ever sent after a hold has done its job. A click with no pointerdown before it (a keyboard)
// takes it then.
const FLUSH_ON = 'button, a, [role="button"], [role="tab"]';
let flushedDown = false;
document.addEventListener('pointerdown', (ev) => {
  flushedDown = ev.target instanceof Element && !!ev.target.closest(FLUSH_ON);
  if (flushedDown) flushColours();
}, true);
document.addEventListener('click', (ev) => {
  if (flushedDown) {
    flushedDown = false;
    return;
  }
  if (ev.target instanceof Element && ev.target.closest(FLUSH_ON)) flushColours();
}, true);

const ownTools = {};
for (const stripId of ['feOwn', 'feBaseOwn']) {
  ownTools[stripId] = colourTools({
    strip: $(stripId), handle: $(`${stripId}H`), sat: $(`${stripId}Sat`), fold: $(`${stripId}Fold`), exact: $(`${stripId}Exact`),
    whiteOnly: ownWhiteOnly,
    onColour: (hex, last) => {
      if (!effectEdit || ownPick.strip !== stripId) return;
      if (!putOwnColour(stripId, hex, last) && !last) return;
      drawEffectEditor();
      effectStripDrag(last ? 'end' : 'move');
    },
  });
}

// Base brightness: moves relative to where the finger starts, like Size. Only the edited effect changes; Save keeps it.
const baseLevel = { dim: $('feBaseLevel'), slab: $('feBaseLevelSlab'), pct: $('feBaseLevelPct'), value: 0.5, dragging: false };
{
  let startX = 0, startV = 0;
  const dim = baseLevel.dim;
  dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (!effectEdit?.effect.base) return;
    baseLevel.dragging = true;
    try { dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    dim.classList.add('ds-dragging');
    startX = ev.clientX;
    startV = baseLevel.value;
  });
  dim.addEventListener('pointermove', (ev) => {
    if (!baseLevel.dragging || !effectEdit?.effect.base) return;
    showLevel(baseLevel, startV + (ev.clientX - startX) / dim.clientWidth);
    const level = Math.round(baseLevel.value * 100) / 100;
    if (level === effectEdit.effect.base.level) return;
    effectEdit.effect = { ...effectEdit.effect, base: { ...effectEdit.effect.base, level } };
    disarmDelete();
    effectStripDrag('move');
  });
  const end = () => {
    if (!baseLevel.dragging) return;
    baseLevel.dragging = false;
    dim.classList.remove('ds-dragging');
    if (!effectEdit) return;
    drawEffectEditor();
    effectStripDrag('end');
  };
  dim.addEventListener('pointerup', end);
  dim.addEventListener('pointercancel', end);
}

$('feBack').addEventListener('click', () => closeEditor());
$('feCancel').addEventListener('click', () => closeEditor());
$('feFine').addEventListener('click', () => {
  if (!effectEdit) return;
  fineOpen = !fineOpen;
  drawFineTune();
});

/** ⋯: Save as a copy and Delete, in a small menu under the button. */
function showEffectMenu(open) {
  $('feMenu').hidden = !open;
  $('feMore').setAttribute('aria-expanded', String(open));
  $('feMore').classList.toggle('open', open);
  if (!open && deleteArmed && effectEdit) disarmDelete();
}
$('feMore').addEventListener('click', () => showEffectMenu($('feMenu').hidden));
// A touch anywhere else closes it.
window.addEventListener('pointerdown', (ev) => {
  if (!$('feMenu').hidden && !$('feMoreWrap').contains(ev.target)) showEffectMenu(false);
}, true);
// Escape closes it, and the keyboard goes back to ⋯ (as the Tempo menu's).
$('feMoreWrap').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || $('feMenu').hidden) return;
  showEffectMenu(false);
  $('feMore').focus();
});
$('feName').addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter') $('feName').blur();
});
$('feName').addEventListener('input', disarmDelete);

/** Sends the editor's one command; `doneText` is the toast when the server says yes. */
function sendEffectEdit(cmd, doneText) {
  pendingEditToast = doneText;
  pendingEdit = send(cmd);
  $('feSave').disabled = $('feCopy').disabled = pendingEdit !== null;
}

// A plain tap. Only what changed is sent, in one command; the editor closes when the server says yes.
$('feSave').addEventListener('click', () => {
  if (!effectEdit || pendingEdit !== null) return;
  const name = $('feName').value;
  const effect = liveLayer(effectEdit.effect);
  if (effectEdit.id === null) {
    sendEffectEdit({ type: 'addEffect', group: picker.group, name, effect }, 'Effect added');
    return;
  }
  // One command, so one Undo step: new settings (with the new name, when there is one), or a new name alone.
  const renamed = name.trim() !== effectEdit.name;
  let cmd = null;
  if (effectSig(effect) !== effectEdit.original) cmd = { type: 'editEffect', preset: effectEdit.id, effect, ...(renamed ? { name } : {}) };
  else if (renamed) cmd = { type: 'editColour', preset: effectEdit.id, name, sameName: false };
  if (!cmd) {
    closeEditor();
    return;
  }
  sendEffectEdit(cmd, 'Effect saved');
});

// Save as a copy: a new effect with these settings; the original stays as it was. Under the same name it becomes "… copy".
$('feCopy').addEventListener('click', () => {
  if (!effectEdit || effectEdit.id === null || pendingEdit !== null) return;
  let name = $('feName').value.trim();
  if (name === effectEdit.name) name = `${name} copy`;
  showEffectMenu(false);
  sendEffectEdit({ type: 'addEffect', group: picker.group, name, effect: liveLayer(effectEdit.effect) }, 'Saved as a copy');
});

// First tap arms it ("Tap again to delete"), the second one deletes. A song or quick look that uses it refuses, and the toast names them.
$('feDelete').addEventListener('click', () => {
  if (!effectEdit || effectEdit.id === null || pendingEdit !== null) return;
  if (!deleteArmed) {
    deleteArmed = setTimeout(disarmDelete, 4000);
    $('feDelete').classList.add('armed');
    $('feDelete').textContent = 'Tap again to delete';
    return;
  }
  pendingEditToast = 'Effect deleted';
  pendingEdit = send({ type: 'deleteColour', preset: effectEdit.id });
  disarmDelete();
  showEffectMenu(false);
});

// ---- The effect editor's strip: the effect as it is being edited, moving along the group's lights ----
// The server renders the frames with the engine (light safety, the live tempo and speed); the page only plays them.

/** Opens the strip for a group: dark until the first answer, which is asked for at once. */
function startEffectStrip(group) {
  stopEffectStrip();
  fxStrip.group = group;
  fxStrip.start = performance.now();
  loadEffectStrip();
  fxStrip.raf = requestAnimationFrame(playEffectStrip);
}

function stopEffectStrip() {
  fxStrip.seq++;
  clearTimeout(fxStrip.timer);
  fxStrip.timer = 0;
  cancelAnimationFrame(fxStrip.raf);
  fxStrip.raf = 0;
  fxStrip.frames = null;
  fxStrip.count = 0;
  fxStrip.clock = null;
  fxStrip.failed = false;
  fxStrip.drawn = null;
  fxStrip.rate = 0;
  fxStrip.answerFor = null;
}

/** Shows the edited effect a moment after the last change. */
function effectStripSoon() {
  if (!effectEdit) return;
  clearTimeout(fxStrip.timer);
  fxStrip.timer = setTimeout(() => {
    fxStrip.timer = 0;
    loadEffectStrip();
  }, FX_STRIP_WAIT);
}

/**
 * During a Size drag: at most one ask per FX_STRIP_WAIT, so the strip follows the finger, and one
 * more when the finger lifts. The ask takes the effect as it is when it goes.
 */
function effectStripDrag(how) {
  if (!effectEdit) return;
  if (how === 'end') {
    clearTimeout(fxStrip.timer);
    fxStrip.timer = 0;
    loadEffectStrip();
    return;
  }
  if (fxStrip.timer) return;
  const wait = fxStrip.askedAt + FX_STRIP_WAIT - performance.now();
  if (wait <= 0) loadEffectStrip();
  else fxStrip.timer = setTimeout(() => {
    fxStrip.timer = 0;
    loadEffectStrip();
  }, wait);
}

/** On each state: ask again after a failed ask, or when the tempo or speed changed on stage, so the strip keeps the stage's time. */
function followEffectStripClock() {
  if (!effectEdit || !state || fxStrip.timer) return;
  if (fxStrip.failed) {
    fxStrip.failed = false;
    effectStripSoon();
    return;
  }
  if (fxStrip.clock === null) return;
  const { tempo, speed } = stripClock();
  const clock = `${tempo}|${speed}`;
  if (clock === fxStrip.clock) return;
  fxStrip.clock = clock;
  effectStripSoon();
}

/**
 * The tempo and speed dial the page shows: the draft's in Prepare, else the stage's. The strip runs
 * at these.
 */
function stripClock() {
  const shown = shownState();
  return { tempo: shown?.tempo ?? 120, speed: shown?.speed ?? 1 };
}

async function loadEffectStrip() {
  if (!effectEdit || !fxStrip.group) return;
  const seq = ++fxStrip.seq;
  fxStrip.askedAt = performance.now();
  let answer = null, refused = false;
  const effect = liveLayer(effectEdit.effect);
  try {
    const res = await fetch('/api/effect-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group: fxStrip.group, effect, ...stripClock() }),
    });
    if (res.ok) answer = await res.json();
    // A 4xx is the server saying no to this effect: asking again changes nothing until the effect does.
    else refused = res.status >= 400 && res.status < 500;
  } catch {
    // Offline or restarting: dark, and asked again (below).
  }
  if (seq !== fxStrip.seq || !effectEdit) return;
  fxStrip.drawn = null;
  if (!answer) {
    // Never the previous effect as if it were this one: dark. After a network error or a server error
    // the next state asks again; after a refusal the strip waits for the next change to the effect.
    fxStrip.frames = null;
    fxStrip.count = 0;
    fxStrip.failed = !refused;
    if (refused) fxStrip.clock = null;
    return;
  }
  fxStrip.failed = false;
  fxStrip.frames = Uint8Array.from(atob(answer.frames), (c) => c.charCodeAt(0));
  fxStrip.count = answer.count;
  fxStrip.fps = answer.fps;
  fxStrip.segments = answer.segments;
  fxStrip.fixtures = answer.fixtures;
  fxStrip.clock = `${answer.tempo}|${answer.speed}`;
  // How fast it runs there (light safety may slow it), for the round's length beside Speed.
  fxStrip.rate = answer.rate ?? 0;
  fxStrip.answerFor = effectSig(effect);
  drawSpeedNote();
}

/** Draws only when the frame to show changes (about 20 times a second), not at the display's rate. */
function playEffectStrip(now) {
  if (!effectEdit) return;
  const frame = !fxStrip.frames ? -1 : fxStrip.count ? Math.floor(((now - fxStrip.start) / 1000) * fxStrip.fps) % fxStrip.count : 0;
  if (frame !== fxStrip.drawn && drawEffectStrip(frame)) fxStrip.drawn = frame;
  fxStrip.raf = requestAnimationFrame(playEffectStrip);
}

window.addEventListener('resize', () => { fxStrip.drawn = null; });

/**
 * One frame (-1: dark): a rounded cell run per fixture, one cell per segment, whites drawn as the
 * stage picture draws them. False when the strip isn't on screen to draw.
 */
function drawEffectStrip(frame) {
  const c = fxStrip.canvas;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return false;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const { frames, segments, fixtures } = fxStrip;
  if (!frames || !segments || frame < 0) return true;
  const pad = 5;
  const gaps = FX_STRIP_GAP * Math.max(0, fixtures.length - 1);
  const cellW = (w - 2 * pad - gaps) / segments, cellH = h - 2 * pad;
  if (cellW <= 0 || cellH <= 0) return true;
  const base = frame * segments * 3;
  g.globalAlpha = FX_STRIP_ALPHA;
  let k = 0, x = pad;
  for (const cells of fixtures) {
    g.save();
    g.beginPath();
    g.roundRect(x, pad, cells * cellW, cellH, 4);
    g.clip();
    for (let s = 0; s < cells; s++, k++) {
      const [R, G, B] = shownRgb(frames[base + k * 3] ?? 0, frames[base + k * 3 + 1] ?? 0, frames[base + k * 3 + 2] ?? 0);
      g.fillStyle = `rgb(${R},${G},${B})`;
      g.fillRect(x + s * cellW, pad, cellW + 0.5, cellH);
    }
    g.restore();
    x += cells * cellW + FX_STRIP_GAP;
  }
  g.globalAlpha = 1;
  return true;
}

// ---- Individual lights: single lights (or one segment of a bar) held at a colour and level until released ----
// Manual control of the live stage (never a Prepare draft): `manual`, `release` and `releaseAll` with fixture and
// segment targets. Only when operators have manual control (Settings). What is held comes from the live state
// (`state.held`, and `manual` on a group); the plan draws what each light shows now from the live picture.

/** Said when Individual lights is tapped in Prepare. */
const MANUAL_LIVE_ONLY = 'Individual lights work on the live stage only. Switch to Live to use them.';

/**
 * The panel while it is open. `fixtures`: the picked lights' ids, in the order they were picked. `segments`: the picked
 * segments (as the engine numbers them) of the one bar picked; empty for the whole of each light.
 */
const manualSel = { open: false, fixtures: [], segments: [] };
/** One entry per light on the plan: { f, first, group, button, cells, dot, vert, round }; `cells` in their places along it. */
let manualFix = [];
/** The segment row's buttons, for the one bar picked: { segment, button, cell, dot }; `segRowFor` is that bar's id. */
let manualSegs = [];
let segRowFor = null;
/** The colour circles on show and the groups they came from (to rebuild only when that changes). */
let manualColours = [];
let manualColoursKey = null;
/** The level slider: { value, dragging, holdUntil }. */
const manualLevel = { dim: $('mLevel'), slab: $('mLevelSlab'), pct: $('mLevelPct'), value: 0, dragging: false, holdUntil: 0 };

/** Lights that are smoke machines (in a smoke group): manual control can't hold them, so they aren't on the plan. */
function smokeFixtures() {
  const out = new Set();
  for (const g of layout?.groups ?? []) if (isSmoke(g)) for (const id of layout.members?.[g.id] ?? []) out.add(id);
  return out;
}

/** The first light group a fixture is in (what it runs when nothing holds it), or undefined. */
const lightGroupOf = (id) => lightGroups().find((g) => (layout.members?.[g.id] ?? []).includes(id));

/** A light's short name on the plan: the first word of its name ("B3" for "B3 SonicPulse LED Bar 10"). */
const shortName = (f) => (f.name || f.id).trim().split(/\s+/)[0] || f.id;

/**
 * A colour as manual control holds it: brightest channel at full, with what it would send and how it looks (`display`,
 * White, Amber and UV mixed in). `off` when it has no light at all.
 */
function normalLight(hex, { white = 0, amber = 0, uv = 0 } = {}) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const m = Math.max(...rgb, white, amber, uv);
  if (m < 0.004) return { off: true, hex: '#000000', white: 0, amber: 0, uv: 0, display: '#000000', bright: 0 };
  const full = `#${rgb.map((v) => Math.round((v / m) * 255).toString(16).padStart(2, '0')).join('')}`;
  const extras = { white: white / m, amber: amber / m, uv: uv / m };
  return { off: false, hex: full, ...extras, display: mixedColour(full, extras), bright: m };
}

/** Two colours from normalLight() that are the same but for rounding (a colour kept at half brightness, scaled back up). */
function sameLight(a, b) {
  if (a.off || b.off) return a.off === b.off;
  const parts = (c) => {
    const n = parseInt(c.hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255).concat([c.white, c.amber, c.uv]);
  };
  const x = parts(a), y = parts(b);
  return x.every((v, k) => Math.abs(v - y[k]) < 0.03);
}

/** The held entry for a light (segment null: the whole light) in the live state, or null. */
const heldOf = (fixture, segment = null) => state?.held?.find((h) => h.fixture === fixture && h.segment === segment) ?? null;
const heldSegmentsOf = (fixture) => (state?.held ?? []).filter((h) => h.fixture === fixture && h.segment !== null);

/** Every light held one way or another: on its own, by a segment, or by its group (from another desk or the API). */
function heldFixtures() {
  const out = new Set((state?.held ?? []).map((h) => h.fixture));
  for (const g of lightGroups()) if (state?.groups?.[g.id]?.manual) for (const id of layout.members?.[g.id] ?? []) out.add(id);
  return out;
}

/**
 * What a light (or one segment) shows now, as this panel works with it: { display, level, name, held }. Held: its colour
 * and level. Otherwise its group's: the colour it runs and the level it shows (the group's dimmer times the colour's brightness).
 */
function lightNow(fixture, segment = null) {
  const h = (segment !== null ? heldOf(fixture, segment) : null) ?? heldOf(fixture);
  if (h) {
    const circle = manualColours.find((c) => !c.off && c.display === h.colour);
    // (The name of the circle it was set with; a strip colour is "Custom".)
    return { display: h.colour, light: null, level: h.level, name: h.level > 0 ? circle?.name ?? 'Custom' : 'Off', held: true };
  }
  // A group under manual control (from another desk or the API) owns its lights: they show its hold, times its dimmer.
  const groups = lightGroups().filter((x) => (layout.members?.[x.id] ?? []).includes(fixture));
  const heldGroup = groups.find((x) => state?.groups?.[x.id]?.manual && state.groups[x.id].hold);
  if (heldGroup) {
    const { hold, level = 1 } = state.groups[heldGroup.id];
    const shows = clamp01(hold.level * level);
    const circle = manualColours.find((c) => !c.off && c.display === hold.colour);
    return { display: hold.colour, light: null, level: shows, name: shows > 0 ? circle?.name ?? 'Custom' : 'Off', held: true };
  }
  const g = groups[0];
  const s = g ? state?.groups?.[g.id] : null;
  if (!g || !s) return { display: '#000000', light: null, level: 0, name: 'Off', held: false };
  const run = runningLight(g, s);
  const c = normalLight(run.colour, run);
  const info = presetInfo(g, s);
  return { display: c.display, light: c.off ? null : c, level: clamp01((s.level ?? 0) * c.bright), name: c.off ? 'Off' : info.name, held: false };
}

/** What a send goes to: the picked segments of the one bar picked, else each picked light. */
function manualTargets() {
  if (manualSel.segments.length && manualSel.fixtures.length === 1) {
    const fixture = manualSel.fixtures[0];
    return manualSel.segments.map((segment) => ({ fixture, segment }));
  }
  return manualSel.fixtures.map((fixture) => ({ fixture }));
}

/** The groups of the picked lights (every light group when nothing is picked), for the colour circles. */
function pickedGroups() {
  if (!manualSel.fixtures.length) return lightGroups();
  return lightGroups().filter((g) => manualSel.fixtures.some((id) => (layout.members?.[g.id] ?? []).includes(id)));
}

function openManual() {
  if (!layout?.manualForOperators || phoneQuery.matches) return;
  if (prep.on) {
    toast(MANUAL_LIVE_ONLY, true);
    return;
  }
  closePicker();
  closeSheet();
  manualSel.open = true;
  $('manual').hidden = false;
  markEditorOpen();
  buildManual();
  renderManual();
  $('manual').scrollTop = 0;
}

/** Done: the panel goes, and the pick with it (it opens on a fresh pick). The lights stay held. */
function closeManual() {
  if (!manualSel.open) return;
  manualSel.open = false;
  manualSel.fixtures = [];
  manualSel.segments = [];
  manualLevel.dragging = false;
  $('manual').hidden = true;
  showManualStrip(false);
  markEditorOpen();
}

function showManualStrip(open) {
  $('mAny').hidden = !open;
  $('mAnyBtn').setAttribute('aria-expanded', String(open));
  if (!open) $('mAnyH').hidden = true;
}

/** The Pick chips and the plan, from the layout; the plan's places come from Patch, as the stage view draws them. */
function buildManual() {
  if (!layout) return;
  const smoke = smokeFixtures();
  // Where each light's segments start in the visualiser's frames (every fixture counts, smoke machines too).
  let at = 0;
  const planned = [];
  for (const f of layout.fixtures) {
    const first = at;
    at += Math.max(1, f.segments ?? 1);
    if (!smoke.has(f.id)) planned.push({ f, first });
  }
  const known = new Set(planned.map((p) => p.f.id));
  manualSel.fixtures = manualSel.fixtures.filter((id) => known.has(id));
  // A re-patch can take segments away: picked ones the light no longer has go.
  const onePicked = manualSel.fixtures.length === 1 ? planned.find((p) => p.f.id === manualSel.fixtures[0]) : null;
  const segCount = onePicked ? Math.max(1, onePicked.f.segments ?? 1) : 0;
  manualSel.segments = segCount > 1 ? manualSel.segments.filter((k) => k < segCount) : [];

  const chips = $('mGroups');
  chips.replaceChildren();
  const pickChip = (name, ids) => {
    const b = el('button', 'ce-chip', name);
    b.dataset.ids = ids.join(' ');
    b.addEventListener('click', () => {
      manualSel.fixtures = [...ids];
      manualSel.segments = [];
      renderManual();
    });
    chips.append(b);
  };
  pickChip('All', planned.map((p) => p.f.id));
  for (const g of lightGroups()) {
    const ids = (layout.members?.[g.id] ?? []).filter((id) => known.has(id));
    if (ids.length) pickChip(g.name, ids);
  }

  const plan = $('mPlan');
  for (const old of manualFix) old.button.remove();
  // Beams' cones go under every button, as the stage view draws them under every light.
  let cones = plan.querySelector('.m-cones');
  if (!cones) {
    cones = document.createElementNS(SVG_NS, 'svg');
    cones.classList.add('m-cones');
    cones.setAttribute('aria-hidden', 'true');
    plan.prepend(cones);
  }
  cones.replaceChildren();
  manualFix = planned.map(({ f, first }, k) => {
    const segs = Math.max(1, f.segments ?? 1);
    // As the stage view draws it (a light in a smoke group is never here; a lone "smoke" light is a spot).
    const stored = f.shape ?? (f.w || f.h ? 'bar' : 'dot');
    const shape = stored === 'bar' || stored === 'outline' || stored === 'beam' ? stored : 'dot';
    const button = el('button', 'mfix');
    const wrap = el('span', 'mshape');
    let vis, cells, cone = null;
    if (shape === 'outline') {
      // A strip round something: one stroke per segment, clockwise from the top left (placed in placeManual).
      vis = document.createElementNS(SVG_NS, 'svg');
      vis.classList.add('mvis', 'outline');
      cells = Array.from({ length: segs }, () => document.createElementNS(SVG_NS, 'polyline'));
      vis.append(...cells);
    } else {
      vis = el('span', 'mvis');
      // One cell per segment, in its place: segment 0 at the bar's start, at its end when hung reversed.
      cells = Array.from({ length: segs }, () => el('i'));
      const order = Array.from({ length: segs }, (_, s) => (f.reversed ? segs - 1 - s : s));
      vis.append(...order.map((s) => cells[s]));
    }
    if (shape === 'beam') {
      const id = `mcone${k}`;
      const grad = document.createElementNS(SVG_NS, 'linearGradient');
      grad.id = id;
      grad.setAttribute('gradientUnits', 'userSpaceOnUse');
      const stops = [0, 1].map((offset) => {
        const s = document.createElementNS(SVG_NS, 'stop');
        s.setAttribute('offset', String(offset));
        s.setAttribute('stop-opacity', '0');
        grad.append(s);
        return s;
      });
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('fill', `url(#${id})`);
      cones.append(grad, poly);
      cone = { grad, stops, poly, painted: null };
    }
    wrap.append(vis);
    const dot = el('span', 'mdot');
    dot.hidden = true;
    button.append(wrap, el('span', 'mname', shortName(f)), dot);
    button.addEventListener('click', () => {
      const k = manualSel.fixtures.indexOf(f.id);
      if (k >= 0) manualSel.fixtures.splice(k, 1); else manualSel.fixtures.push(f.id);
      manualSel.segments = [];
      renderManual();
    });
    plan.append(button);
    return { f, first, group: lightGroupOf(f.id), button, shape, wrap, vis, cells, cone, dot, painted: [] };
  });
  placeManual();
  segRowFor = null;
  manualColoursKey = null;
}

/**
 * Puts each light's button where the stage plan has it, sized to the light, 44 px at least: a bar at its length and
 * turned to its angle (the button takes the space it covers), an outline at its size, a spot or beam an 18 px circle.
 */
function placeManual() {
  const plan = $('mPlan');
  const W = plan.clientWidth, H = plan.clientHeight;
  if (!W || !H) return;
  const padX = 30, padTop = 30, padBottom = 30;
  const iw = W - 2 * padX, ih = H - padTop - padBottom;
  const toPx = (p) => [padX + p.x * iw, padTop + p.y * ih];
  for (const m of manualFix) {
    const { f } = m;
    const [cx, cy] = toPx(f);
    // The light's drawing (vw × vh, turned by `turn` degrees) and the space it covers on the plan (bw × bh).
    let vw = 18, vh = 18, turn = 0;
    if (m.shape === 'bar') {
      const [a, b] = barEnds(f).map(toPx);
      vw = Math.max(8, Math.hypot(b[0] - a[0], b[1] - a[1]));
      vh = Math.min(12, Math.max(6, barAxis(f).thickness * ih));
      turn = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    } else if (m.shape === 'outline') {
      vw = Math.max(14, (f.w ?? 0) * iw);
      vh = Math.max(14, (f.h ?? 0) * ih);
    }
    const t = (turn * Math.PI) / 180, cos = Math.abs(Math.cos(t)), sin = Math.abs(Math.sin(t));
    const bw = vw * cos + vh * sin, bh = vw * sin + vh * cos;
    m.button.classList.toggle('round', m.shape === 'dot' || m.shape === 'beam');
    Object.assign(m.wrap.style, { width: `${bw}px`, height: `${bh}px` });
    Object.assign(m.vis.style, {
      width: `${vw}px`, height: `${vh}px`, left: `${(bw - vw) / 2}px`, top: `${(bh - vh) / 2}px`,
      transform: turn ? `rotate(${turn}deg)` : '',
    });
    if (m.shape === 'outline') {
      m.vis.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
      outlineCells({ left: 1.5, top: 1.5, width: vw - 3, height: vh - 3 }, m.cells.length, f.reversed).forEach((points, s) => {
        m.cells[s].setAttribute('points', points.map((p) => p.join(',')).join(' '));
      });
    }
    // The light, 5 px, then its 11 px name; the light's middle sits at its place on the plan.
    const content = bh + 16;
    // A bar's button is as long as the bar (and a little), so bars hung end to end keep apart.
    const w = Math.max(44, bw + 8);
    const h = Math.max(44, content + 8);
    m.box = { cx, cy, left: cx - w / 2, top: cy - bh / 2 - (h - content) / 2, w, h, lift: bh / 2 + (h - content) / 2 };
  }
  spreadBoxes(manualFix.filter((m) => m.box.w <= 44).map((m) => m.box));
  separateBoxes(manualFix.map((m) => m.box), W, H);
  const cones = plan.querySelector('.m-cones');
  cones?.setAttribute('viewBox', `0 0 ${W} ${H}`);
  for (const m of manualFix) {
    const { left, top, w, h } = m.box;
    Object.assign(m.button.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    if (m.cone) {
      // The cone starts at the lamp's circle, wherever its button had to move to.
      const dx = left + w / 2 - m.box.cx, dy = top + m.box.lift - m.box.cy;
      const c = beamCone(m.f);
      const at = (p) => toPx(p).map((v, k) => v + (k ? dy : dx));
      m.cone.poly.setAttribute('points', [c.lamp, c.left, c.right].map((p) => at(p).join(',')).join(' '));
      const [[x1, y1], [x2, y2]] = [at(c.lamp), at(c.tip)];
      Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => m.cone.grad.setAttribute(k, String(v)));
    }
  }
}

/**
 * Any two buttons that still overlap (a short bar just over a long one, a side bar over the end of a row) move apart
 * the short way: the smaller one moves (both half way when they are the same size), inside the plan. No two 44 px
 * targets overlap, and each light stays as near its place as that allows.
 */
function separateBoxes(boxes, W, H) {
  const gap = 2;
  const clamp = (b) => {
    b.left = Math.min(Math.max(2, b.left), W - b.w - 2);
    b.top = Math.min(Math.max(2, b.top), H - b.h - 2);
  };
  boxes.forEach(clamp);
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ox = Math.min(a.left + a.w, b.left + b.w) - Math.max(a.left, b.left) + gap;
        const oy = Math.min(a.top + a.h, b.top + b.h) - Math.max(a.top, b.top) + gap;
        if (ox <= gap || oy <= gap) continue;
        moved = true;
        const across = ox < oy;
        const centre = (x) => (across ? x.left + x.w / 2 : x.top + x.h / 2);
        // Which way each goes: away from the other (by list order when they sit on the same spot).
        const dir = centre(a) < centre(b) || (centre(a) === centre(b) && i < j) ? -1 : 1;
        const sizeA = a.w * a.h, sizeB = b.w * b.h;
        const shareA = sizeA === sizeB ? 0.5 : sizeA < sizeB ? 1 : 0;
        const by = across ? ox : oy;
        const key = across ? 'left' : 'top';
        a[key] += dir * by * shareA;
        b[key] -= dir * by * (1 - shareA);
        clamp(a);
        clamp(b);
      }
    }
    if (!moved) break;
  }
}

/**
 * Small lights in a row closer together than a button is wide (a row of spot lights) move apart just enough for one
 * 44 px button each, the row staying centred where they are.
 */
function spreadBoxes(boxes) {
  const gap = 2;
  const rows = [];
  for (const b of [...boxes].sort((x, y) => x.left - y.left)) {
    const row = rows.find((r) => {
      const last = r[r.length - 1];
      return Math.abs(b.cy - last.cy) < 8 && b.left < last.left + last.w + gap;
    });
    if (!row) {
      rows.push([b]);
      continue;
    }
    const last = row[row.length - 1];
    b.left = last.left + last.w + gap;
    row.push(b);
  }
  for (const row of rows) {
    if (row.length < 2) continue;
    const shift = row.reduce((sum, b) => sum + b.cx - (b.left + b.w / 2), 0) / row.length;
    for (const b of row) b.left += shift;
  }
}
if ('ResizeObserver' in window) new ResizeObserver(() => { if (manualSel.open) placeManual(); }).observe($('mPlan'));

/** A light's colour as the stage shows it now (from the live picture), or '' for a dark one (the faint shape shows). */
function visualColour(index) {
  const v = visual;
  const [r, g, b] = shownRgb(v[index * 3] ?? 0, v[index * 3 + 1] ?? 0, v[index * 3 + 2] ?? 0);
  return Math.max(r, g, b) < 10 ? '' : `rgb(${r},${g},${b})`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A dark light on the plan: a faint shape. */
const DARK_SHAPE = 'rgba(148, 163, 184, 0.12)';

/**
 * A beam's cone as the stage view draws it: the light's colour, at most 22 % at the lamp and gone at the tip. When the
 * light is off, a faint grey cone still shows where it points.
 */
function paintCone(cone, index) {
  const [r, g, b] = shownRgb(visual[index * 3] ?? 0, visual[index * 3 + 1] ?? 0, visual[index * 3 + 2] ?? 0);
  const lit = Math.max(r, g, b) / 255;
  const [colour, alpha] = lit > 0.02 ? [`rgb(${r},${g},${b})`, 0.22 * lit] : ['rgb(148,163,184)', 0.06];
  const key = `${colour} ${alpha.toFixed(3)}`;
  if (cone.painted === key) return;
  cone.painted = key;
  cone.stops[0].setAttribute('stop-color', colour);
  cone.stops[0].setAttribute('stop-opacity', alpha.toFixed(3));
  cone.stops[1].setAttribute('stop-color', colour);
}

/** Each light's cells (and the segment row's) in the colours the stage shows now; only what changed is touched. */
function paintManual() {
  if (!manualSel.open) return;
  for (const m of manualFix) {
    m.cells.forEach((cell, s) => {
      const c = visualColour(m.first + s);
      if (m.painted[s] !== c) {
        m.painted[s] = c;
        // An outline's cells are strokes; a dark one is the faint shape, as elsewhere on the plan.
        if (m.shape === 'outline') cell.style.stroke = c || DARK_SHAPE;
        else cell.style.background = c;
      }
    });
    if (m.cone) paintCone(m.cone, m.first);
  }
  const bar = manualFix.find((m) => m.f.id === segRowFor);
  if (bar) for (const s of manualSegs) s.cell.style.background = visualColour(bar.first + s.segment);
}

/** The segment row for the one bar picked (nothing for a light of one segment, or several lights). */
function buildSegRow() {
  const one = manualSel.fixtures.length === 1 ? manualFix.find((m) => m.f.id === manualSel.fixtures[0]) : null;
  const id = one && one.cells.length > 1 ? one.f.id : null;
  $('mSegRow').hidden = !id;
  if (id === segRowFor) return;
  segRowFor = id;
  const row = $('mSegs');
  row.replaceChildren();
  manualSegs = [];
  if (!one || !id) return;
  const segs = one.cells.length;
  $('mSegOf').textContent = `Segments of ${shortName(one.f)}`;
  row.setAttribute('aria-label', `Segments of ${one.f.name}`);
  for (let k = 0; k < segs; k++) {
    // Left to right (top to bottom) as on the bar: reversed bars number their segments from the other end.
    const segment = one.f.reversed ? segs - 1 - k : k;
    const button = el('button', 'mseg');
    const cell = el('i');
    const dot = el('span', 'mdot');
    dot.hidden = true;
    button.append(cell, dot);
    button.addEventListener('click', () => {
      const n = manualSel.segments.indexOf(segment);
      if (n >= 0) manualSel.segments.splice(n, 1); else manualSel.segments.push(segment);
      renderManual();
    });
    row.append(button);
    manualSegs.push({ segment, button, cell, dot, place: k });
  }
}

/** The colour circles: the picked lights' group colours (one of each), faded while nothing is picked. */
function buildManualColours() {
  const groups = pickedGroups();
  const key = groups.map((g) => g.id).join(' ');
  if (key === manualColoursKey) return;
  manualColoursKey = key;
  manualColours = [];
  for (const g of groups) {
    for (const p of g.presets) {
      if (p.effect || !p.light) continue;
      const c = normalLight(p.light.hex, p.light);
      // One circle per colour: "Silti 50%" is "Silti 3200K" at half, and this panel's level does the dimming.
      if (manualColours.some((x) => sameLight(x, c))) continue;
      manualColours.push({ name: p.name, ...c });
    }
  }
  // Off last, as in the colour lists.
  manualColours.sort((a, b) => Number(a.off) - Number(b.off));
  const pal = $('mPal');
  pal.replaceChildren();
  for (const c of manualColours) {
    const b = el('button', c.off ? 'mcol off' : 'mcol');
    if (!c.off) b.style.background = tint(c.display, 0.82);
    b.setAttribute('aria-label', c.name);
    b.title = c.name;
    b.addEventListener('click', () => pickManualColour(c));
    c.button = b;
    pal.append(b);
  }
}

/**
 * Hold the picked lights (or segments) at a colour. Each keeps its own level; a dark one comes up at the colour's own
 * brightness. Off keeps the colour and takes the level to 0. A whole light's colour replaces its held segments' (they fade back to it).
 */
function sendManualColour(c) {
  const targets = manualTargets();
  if (!targets.length) {
    toast('Tap lights on the plan to pick them first.', true);
    return;
  }
  if (blackedOut()) return;
  // A whole light's held segments fade back to its new colour, in the same change.
  const releaseSegments = targets.some((t) => t.segment === undefined) || undefined;
  if (c.off) {
    sendManual({ type: 'manual', targets, intensity: 0, releaseSegments });
    return;
  }
  // One command for each level among the targets (usually one): each keeps its own, a dark one comes up at the colour's.
  const byLevel = new Map();
  for (const target of targets) {
    const now = lightNow(target.fixture, target.segment ?? null);
    const level = Math.round((now.level >= 0.05 ? now.level : c.bright) * 1000) / 1000;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(target);
  }
  const extras = Object.fromEntries(['white', 'amber', 'uv'].filter((k) => c[k] > 0.001).map((k) => [k, Math.round(c[k] * 1000) / 1000]));
  for (const [intensity, list] of byLevel) {
    sendManual({ type: 'manual', targets: list, colour: c.hex, ...extras, intensity, releaseSegments });
  }
}

/** The refs of Individual lights' commands the server hasn't answered yet (their errors get plain words). */
const manualRefs = new Set();
function sendManual(cmd) {
  const r = send(cmd);
  if (r !== null) manualRefs.add(r);
  return r;
}

/** What to say when the server refuses an Individual lights change; never its own wording. */
function manualProblem(error) {
  if (/not enabled/.test(error)) return 'Individual lights are turned off in Settings.';
  return "Those lights couldn't be changed. Pick them again and try once more.";
}

/** Blackout is on: the lights stay off until a song or Basic lights, so this panel changes nothing meanwhile. */
const blackedOut = () => state?.look === 'blackout';

function pickManualColour(c) {
  sendManualColour(c);
  renderManual();
}

/**
 * The level for every picked target; a whole light's held segments follow it, so the whole bar dims. A level never
 * changes a light's colour: one not held yet is held at the colour it shows now (one command per colour, usually one).
 */
function sendManualLevel(v) {
  if (blackedOut()) return;
  const intensity = Math.round(clamp01(v) * 1000) / 1000;
  const targets = manualTargets();
  for (const t of manualTargets()) {
    if (t.segment === undefined) for (const h of heldSegmentsOf(t.fixture)) targets.push({ fixture: h.fixture, segment: h.segment });
  }
  if (!targets.length) return;
  // Held ones keep their colour by themselves; the rest take the colour they show (an effect's first colour).
  const held = [];
  const byColour = new Map();
  for (const t of targets) {
    const now = lightNow(t.fixture, t.segment ?? null);
    if (now.held || !now.light) {
      held.push(t);
      continue;
    }
    const c = now.light;
    const extras = Object.fromEntries(['white', 'amber', 'uv'].filter((k) => c[k] > 0.001).map((k) => [k, Math.round(c[k] * 1000) / 1000]));
    const key = JSON.stringify([c.hex, extras]);
    if (!byColour.has(key)) byColour.set(key, { colour: c.hex, extras, targets: [] });
    byColour.get(key).targets.push(t);
  }
  // Usually one command for them all, changed in one frame.
  if (held.length) sendManual({ type: 'manual', targets: held, intensity });
  for (const { colour, extras, targets: list } of byColour.values()) sendManual({ type: 'manual', targets: list, colour, ...extras, intensity });
}

function showManualLevel(v) {
  const p = clamp01(v);
  manualLevel.value = p;
  manualLevel.slab.style.width = `${p * 100}%`;
  manualLevel.pct.textContent = `${Math.round(p * 100)} %`;
  manualLevel.pct.classList.toggle('zero', p === 0);
  manualLevel.dim.setAttribute('aria-valuenow', String(Math.round(p * 100)));
}

// The level moves relative to where the finger starts, as the group dimmers; nothing happens with nothing picked.
(() => {
  const m = manualLevel;
  const out = throttle(sendManualLevel);
  let startX = 0, startV = 0;
  m.dim.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (!manualTargets().length || blackedOut()) return;
    m.dragging = true;
    try { m.dim.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    m.dim.classList.add('ds-dragging');
    startX = ev.clientX;
    startV = m.value;
  });
  m.dim.addEventListener('pointermove', (ev) => {
    if (!m.dragging) return;
    showManualLevel(startV + (ev.clientX - startX) / m.dim.clientWidth);
    out.push(m.value);
  });
  const end = () => {
    if (!m.dragging) return;
    m.dragging = false;
    m.dim.classList.remove('ds-dragging');
    m.holdUntil = performance.now() + 600;
    if (m.value !== startV) out.end(m.value);
  };
  m.dim.addEventListener('pointerup', end);
  m.dim.addEventListener('pointercancel', end);
})();

// Any colour …: a strip under the circles (warm to cool when every picked light is white only). Moves are throttled; the last one always goes.
(() => {
  const out = throttle((hex) => sendManualColour(normalLight(hex)));
  const whiteOnly = () => {
    if (!manualTargets().length || blackedOut()) return null;
    return pickedGroups().every((g) => g.whiteOnly);
  };
  attachStrip($('mAny'), $('mAnyH'), whiteOnly, (hex, last) => (last ? out.end(hex) : out.push(hex)), () => {
    if (!manualTargets().length) toast('Tap lights on the plan to pick them first.', true);
  });
})();

$('mAnyBtn').addEventListener('click', () => showManualStrip($('mAny').hidden));
$('manualBtn').addEventListener('click', openManual);
$('mBack').addEventListener('click', closeManual);
$('mDone').addEventListener('click', closeManual);
$('mNone').addEventListener('click', () => {
  manualSel.fixtures = [];
  manualSel.segments = [];
  renderManual();
});
// Release picked: the picked segments, or each picked light with any segments of it that are held.
$('mRelease').addEventListener('click', () => {
  const targets = manualTargets();
  if (!targets.length || blackedOut()) return;
  sendManual({ type: 'release', targets, releaseSegments: true });
  manualSel.segments = [];
  renderManual();
});
$('mReleaseAll').addEventListener('click', () => {
  if (!blackedOut()) sendManual({ type: 'releaseAll' });
});

/** Keeps the panel true to the live state and the pick: chips, the plan's picks and dots, segments, summary, colours, level. */
function renderManual() {
  if (!manualSel.open || !layout || !state) return;
  const picked = new Set(manualSel.fixtures);
  for (const chip of $('mGroups').children) {
    const ids = chip.dataset.ids ? chip.dataset.ids.split(' ') : [];
    chip.classList.toggle('on', ids.length > 0 && ids.length === picked.size && ids.every((id) => picked.has(id)));
  }
  const held = heldFixtures();
  buildManualColours();
  for (const m of manualFix) {
    const on = picked.has(m.f.id);
    m.button.classList.toggle('on', on);
    m.button.setAttribute('aria-pressed', String(on));
    m.dot.hidden = !held.has(m.f.id);
    const now = lightNow(m.f.id);
    m.button.setAttribute('aria-label', `${m.f.name}, ${m.group?.name ?? 'no group'}, ${now.name} ${Math.round(now.level * 100)} %${held.has(m.f.id) ? ', held' : ''}`);
  }
  buildSegRow();
  const bar = manualFix.find((m) => m.f.id === segRowFor);
  for (const s of manualSegs) {
    const on = manualSel.segments.includes(s.segment);
    s.button.classList.toggle('on', on);
    s.button.setAttribute('aria-pressed', String(on));
    const h = heldOf(segRowFor, s.segment);
    s.dot.hidden = !h;
    s.button.setAttribute('aria-label', `${shortName(bar.f)} segment ${s.place + 1}${h ? ', held' : ''}`);
  }

  // The summary, and what the first picked target shows (its colour circle, the level).
  const targets = manualTargets();
  const first = targets[0];
  const now = first ? lightNow(first.fixture, first.segment ?? null) : null;
  const n = manualSel.fixtures.length;
  const segs = manualSel.segments.length;
  $('mSelTitle').textContent = n
    ? `${n} ${n > 1 ? 'lights' : 'light'} picked${segs && bar ? ` · ${segs} of ${bar.cells.length} segments` : ''}`
    : 'Tap lights on the plan to pick them';
  const names = manualSel.fixtures.map((id) => shortName(manualFix.find((m) => m.f.id === id)?.f ?? { id }));
  $('mSelNames').textContent = n ? `${names.join(', ')} · ${now.name}` : 'or pick a whole group above';
  const dark = blackedOut();
  $('mBlackNote').hidden = !dark;
  $('mPal').classList.toggle('idle', !n || dark);
  for (const c of manualColours) c.button.disabled = dark;
  $('mAnyBtn').disabled = dark;
  if (dark && !$('mAny').hidden) showManualStrip(false);
  for (const c of manualColours) {
    // A held light by its exact colour; one its group drives by the colour it runs (at whatever brightness).
    const on = !!now && (c.off ? now.level === 0 : now.level > 0 && (now.light ? sameLight(c, now.light) : c.display === now.display));
    c.button.classList.toggle('on', on);
    c.button.setAttribute('aria-pressed', String(on));
  }
  const whiteOnly = n > 0 && pickedGroups().every((g) => g.whiteOnly);
  $('mAny').className = `strip2 m-any ${whiteOnly ? 'cct' : 'hue'}`;
  $('mAny').setAttribute('aria-label', whiteOnly ? 'Any white, warm to cool' : 'Any colour');
  $('mAnyBtn').textContent = whiteOnly ? 'Any white …' : 'Any colour …';
  manualLevel.dim.classList.toggle('idle', !n || dark);
  manualLevel.dim.setAttribute('aria-disabled', String(dark));
  manualLevel.dim.style.setProperty('--c', now && now.level > 0 ? shown(now.display) : '#5a6478');
  if (!manualLevel.dragging && performance.now() >= manualLevel.holdUntil) showManualLevel(now?.level ?? 0);

  // Release picked: while something picked is held. Release all: every light held, however it was taken.
  const pickedHeld = targets.some((t) => (t.segment === undefined
    ? !!heldOf(t.fixture) || heldSegmentsOf(t.fixture).length > 0
    : !!heldOf(t.fixture, t.segment)));
  $('mRelease').disabled = !pickedHeld || dark;
  $('mReleaseAll').textContent = `Release all · ${held.size}`;
  $('mReleaseAll').disabled = held.size === 0 || dark;
  paintManual();
}

// ---- Quick looks: tabs and grid ----

let quickTab = 'plain';
// Edit on: a tap opens the quick look in the sheet instead of applying it, and a hold-and-drag changes its place.
let quickEditing = false;

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
  // A rebuild (another tablet changed the show) ends a hold that is under way.
  quickMover.end();
  const grid = $('qGrid');
  grid.replaceChildren();
  const mine = (layout?.quickLooks ?? []).filter((q) => q.tab === quickTab);
  mine.forEach((q, at) => {
    const b = el('button', 'ql');
    b.append(el('span', 'qname', q.name));
    // A thin strip along the bottom: one block per group, the colour this quick look gives it.
    const strip = el('span', 'qstrip');
    for (const { colour, name } of stripBlocks(q.colours)) {
      // Faint for a group the quick look leaves alone, grey for one it turns off.
      const block = el('i', colour === '#000000' ? 'off' : null);
      if (colour && colour !== '#000000') block.style.background = tint(colour, 0.8);
      block.title = name;
      strip.append(block);
    }
    b.append(strip);
    b.dataset.id = q.id;
    b.dataset.at = String(at);
    if (quickEditing) {
      b.classList.add('editable');
      b.classList.toggle('editing', qs.open && qs.look === q.id);
      b.setAttribute('aria-label', `Edit ${q.name}`);
    }
    // Edit on: the quick look opens in the sheet. Otherwise it goes on stage (in Prepare, in the draft).
    b.addEventListener('click', () => {
      if (quickEditing) openSheet(q);
      else sendStage({ type: 'quickLook', id: q.id });
    });
    if (quickEditing) quickMover.wire(b, at);
    grid.append(b);
  });
  if (!mine.length) grid.append(el('span', 'qnone', 'None yet.'));
  const add = el('button', 'ql newq');
  add.append('＋ Save stage', el('br'), 'as a look');
  add.addEventListener('click', () => openSheet());
  grid.append(add);
}

/** Edit on or off; Prepare can stay on. Off closes the edit sheet. */
function setQuickEditing(on) {
  if (on === quickEditing) return;
  quickEditing = on;
  $('qEditBtn').textContent = on ? 'Done' : 'Edit looks';
  $('qEditBtn').classList.toggle('on', on);
  $('qEditBtn').setAttribute('aria-pressed', String(on));
  if (!on && qs.look) closeSheet();
  buildQuick();
}
$('qEditBtn').addEventListener('click', () => setQuickEditing(!quickEditing));

// ---- Changing the place of a quick look: hold it, then drag it onto another on the same tab ----

/** Edit on: holding a quick look lifts it; letting go over another one gives it that place. A tap still opens it. */
const quickMover = holdToMove({
  container: $('qGrid'),
  tileSelector: '.ql.movable',
  ghostClass: 'ql ql-ghost',
  state: () => (quickEditing ? true : null),
  onDrop(from, over) {
    const look = [...$('qGrid').querySelectorAll('.ql.movable')].find((b) => Number(b.dataset.at) === from)?.dataset.id;
    if (look) send({ type: 'moveQuickLook', look, to: over });
  },
});

// ---- Quick look sheet: new from the stage, or Edit (covers the details panel, like the colour picker) ----

// `look`: the id of the quick look being edited, or null for a new one. `orig`: what it was when the sheet opened.
// `stage`: the Update from the stage switch; `stageAuto`: the page turned it on (for a new group), not the user.
// `armed`: the Delete button was tapped once.
const qs = { open: false, tab: 'plain', left: new Set(), saved: 'plain', look: null, orig: null, stage: false, stageAuto: false, armed: 0 };

/** The layout's quick look being edited, or null. */
const editedQuick = () => (qs.look ? layout?.quickLooks.find((q) => q.id === qs.look) ?? null : null);

/** `q`: a quick look of the layout to edit; none for a new one. */
function openSheet(q) {
  closePicker();
  qs.open = true;
  qs.look = q?.id ?? null;
  qs.orig = q ? { name: q.name, tab: q.tab, groups: [...q.groups] } : null;
  qs.tab = q ? q.tab : quickTab;
  qs.left = new Set(q ? lightGroups().map((g) => g.id).filter((id) => !q.groups.includes(id)) : []);
  qs.stage = false;
  qs.stageAuto = false;
  disarmQuickDelete();
  pendingSave = null;
  $('qsName').value = q ? q.name : '';
  $('qsTitle').textContent = q ? 'Edit quick look' : 'New quick look from the stage';
  $('qsDelete').hidden = !q;
  $('qsStageRow').hidden = !q;
  // Its controller key, once it exists (a new quick look gets one after Save, from its Edit).
  const keyed = !!q && showsChip({ kind: 'quickLook', id: q.id });
  $('qsKeyRow').hidden = !keyed;
  $('qsKeyLine').replaceChildren(...(keyed ? [keyChip({ kind: 'quickLook', id: q.id }, q.name)] : []));
  $('qsGroupsNote').textContent = q ? '· tap a group to leave it out or to add it' : '· tap a group to leave it out; left-out groups keep what they have';
  buildSheetGroups();
  $('qSheet').hidden = false;
  renderSheet();
  markEditedQuick();
}

function closeSheet() {
  if (keyLearn.does?.kind === 'quickLook') stopLearn();
  qs.open = false;
  qs.look = null;
  qs.orig = null;
  pendingSave = null;
  disarmQuickDelete();
  $('qSheet').hidden = true;
  $('qsName').blur();
  markEditedQuick();
}

/** The tile of the quick look in the sheet gets the accent outline. */
function markEditedQuick() {
  for (const b of $('qGrid').querySelectorAll('.ql[data-id]')) b.classList.toggle('editing', quickEditing && qs.open && qs.look === b.dataset.id);
}

/**
 * The layout changed. A quick look that is gone closes its sheet. One that changed elsewhere (another tablet, Undo)
 * gives the sheet its new starting values for the fields the user hasn't touched, so Save never puts an old value back.
 */
function syncQuickSheet() {
  if (!qs.open || !qs.look) return;
  const q = editedQuick();
  if (!q) {
    const own = pendingSave !== null;
    const deleting = own && qs.saved === null;
    const tab = qs.saved;
    closeSheet();
    if (deleting) toast('Quick look deleted', true);
    // Our own Save that gave the quick look a copy of its look: the sheet is done, and the tab follows.
    else if (own && tab) showQuickTab(tab);
    else if (!own) toast('That quick look was removed.');
    return;
  }
  const o = qs.orig;
  const sameGroups = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
  if (q.name === o.name && q.tab === o.tab && sameGroups(q.groups, o.groups)) return;
  const lights = lightGroups().map((g) => g.id);
  const nameTouched = $('qsName').value.trim() !== o.name;
  const tabTouched = qs.tab !== o.tab;
  const groupsTouched = !sameGroups(lights.filter((id) => qs.left.has(id)), lights.filter((id) => !o.groups.includes(id)));
  if (!nameTouched) $('qsName').value = q.name;
  if (!tabTouched) qs.tab = q.tab;
  if (!groupsTouched) qs.left = new Set(lights.filter((id) => !q.groups.includes(id)));
  qs.orig = { name: q.name, tab: q.tab, groups: [...q.groups] };
  dropAutoStage();
}

/** Update from the stage goes off again when the page turned it on for a new group and no new group is left. */
function dropAutoStage() {
  if (qs.stageAuto && !quickGroupsNew().length) {
    qs.stage = false;
    qs.stageAuto = false;
  }
}

/** The groups the quick look being edited gives that the sheet's group tiles say: it has them, or the stage does. */
const quickGroupsNew = () => (qs.orig ? lightGroups().map((g) => g.id).filter((id) => !qs.left.has(id) && !qs.orig.groups.includes(id)) : []);

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
      if (qs.left.has(group.id)) {
        qs.left.delete(group.id);
        // A group the quick look doesn't set has no value yet: it takes the stage's, so Update from the stage goes on.
        if (qs.orig && !qs.orig.groups.includes(group.id) && !qs.stage) {
          qs.stage = true;
          qs.stageAuto = true;
        }
      } else {
        qs.left.add(group.id);
      }
      dropAutoStage();
      renderSheet();
    });
    root.append(b);
  }
}

function renderSheet() {
  if (!qs.open || !layout) return;
  const quick = editedQuick();
  for (const b of $('qsTab').children) {
    const on = b.dataset.t === qs.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  for (const b of $('qsGroups').children) {
    const k = layout.groups.findIndex((g) => g.id === b.dataset.group);
    const group = layout.groups[k];
    const left = qs.left.has(b.dataset.group);
    // Editing: what the quick look gives the group, until it is updated from the stage (or the group is new to it).
    const own = quick && !qs.stage && quick.entries?.[k];
    let info, level;
    if (own) {
      info = presetInfo(group, { preset: own.preset, level: quick.levels?.[k] ?? 1, live: null, entry: own });
      level = quick.levels?.[k] ?? 1;
    } else {
      const s = group ? groupStatus(group) : shownState()?.groups?.[b.dataset.group];
      info = presetInfo(group, s);
      level = s?.level ?? 0;
    }
    b.classList.toggle('off', left);
    b.setAttribute('aria-pressed', String(!left));
    b.querySelector('i').style.background = swatchFill(info);
    b.querySelector('.gs span').textContent = left ? 'left out' : info.name;
    b.querySelector('.gl').textContent = left ? '' : `${Math.round(level * 100)}%`;
  }
  if (qs.orig) {
    $('qsStage').checked = qs.stage;
    const added = quickGroupsNew();
    const names = added.map((id) => layout.groups.find((g) => g.id === id)?.name ?? id);
    const from = prep.on ? 'the draft' : 'the stage';
    const many = names.length > 1;
    $('qsStageNote').textContent = !names.length
      ? `Replaces what this quick look gives its groups with what ${from} has now.`
      : qs.stage
        ? `On because ${names.join(' and ')} ${many ? 'are' : 'is'} new to this quick look: ${many ? 'they take' : 'it takes'} what ${from} has now.`
        : `${names.join(' and ')} ${many ? 'need' : 'needs'} a colour from ${from}: turn this on to add ${many ? 'them' : 'it'}.`;
  }
  $('qsSave').disabled = pendingSave !== null;
  $('qsDelete').disabled = pendingSave !== null;
}

for (const b of $('qsTab').children) {
  b.addEventListener('click', () => {
    qs.tab = b.dataset.t;
    renderSheet();
  });
}
$('qsStage').addEventListener('change', () => {
  qs.stage = $('qsStage').checked;
  // The user's own choice from here on, whatever the groups do.
  qs.stageAuto = false;
  renderSheet();
});
$('qsCancel').addEventListener('click', closeSheet);
// The keyboard's Done closes the keyboard; nothing else on the page reacts to typing.
$('qsName').addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter') $('qsName').blur();
});
$('qsName').addEventListener('input', disarmQuickDelete);

/** The Delete button says "Delete" again. */
function disarmQuickDelete() {
  clearTimeout(qs.armed);
  qs.armed = 0;
  $('qsDelete').classList.remove('armed');
  $('qsDelete').textContent = 'Delete';
}

// Delete asks twice, as the colour editor's does: the first tap turns the button red ("Delete?"), the second deletes.
// A tap anywhere else (or a few seconds) takes the first one back.
$('qsDelete').addEventListener('click', () => {
  if (!qs.look || pendingSave !== null || !layout) return;
  if (!qs.armed) {
    qs.armed = setTimeout(disarmQuickDelete, 4000);
    $('qsDelete').classList.add('armed');
    $('qsDelete').textContent = 'Delete?';
    return;
  }
  disarmQuickDelete();
  qs.saved = null;
  pendingSave = send({ type: 'deleteQuickLook', look: qs.look });
  renderSheet();
});
document.addEventListener('pointerdown', (ev) => {
  if (qs.armed && !(ev.target instanceof Element && ev.target.closest('#qsDelete'))) disarmQuickDelete();
}, true);

// A plain tap on a new quick look overwrites nothing. Editing sends only what changed.
// The sheet closes when the server says yes.
$('qsSave').addEventListener('click', () => {
  if (pendingSave !== null || !layout) return;
  const groups = lightGroups().map((g) => g.id).filter((id) => !qs.left.has(id));
  // The server would say this too, but in less friendly words.
  if (!groups.length) {
    toast('pick at least one group');
    return;
  }
  qs.saved = qs.tab;
  if (qs.look) {
    const orig = qs.orig;
    const cmd = { type: 'editQuickLook', look: qs.look };
    const name = $('qsName').value;
    if (name.trim() !== orig.name) cmd.name = name;
    if (qs.tab !== orig.tab) cmd.tab = qs.tab;
    if (groups.length !== orig.groups.length || groups.some((id) => !orig.groups.includes(id))) cmd.groups = groups;
    if (qs.stage) cmd.fromStage = true;
    if (cmd.groups && !qs.stage && quickGroupsNew().length) {
      toast('turn on Update from the stage to add a group');
      return;
    }
    // Nothing changed: nothing to send.
    if (Object.keys(cmd).length === 2) {
      closeSheet();
      return;
    }
    pendingSave = send(cmd);
  } else {
    pendingSave = send({ type: 'saveQuickLook', name: $('qsName').value, tab: qs.tab, groups });
  }
  renderSheet();
});

function finishSaveQuick() {
  const tab = qs.saved;
  closeSheet();
  if (tab) {
    showQuickTab(tab);
  } else {
    buildQuick();
    toast('Quick look deleted', true);
  }
}

// ---- "N more ↓": a list that scrolls says so ----

/**
 * Adds a quiet cue to the bottom edge of a scrolling list: a soft fade and a pill, "N more ↓", while there is more
 * below. A tap scrolls down `step()` pixels; it goes away at the end. Only when at least 2 entries are not fully in
 * view (one cut-off row isn't worth covering it with a pill): `all` says what counts as an entry (the quick-look
 * grid's "Save stage" tile counts), `items` which of them the number counts (the grid's looks only; "More ↓" when
 * that is none).
 */
function scrollCue(scroller, { items, all = items, step }) {
  const pill = el('button', 'more-pill');
  pill.type = 'button';
  const cue = el('div', 'more-cue');
  cue.hidden = true;
  cue.append(pill);
  scroller.parentElement.append(cue);
  const update = () => {
    const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    if (room <= 2 || scroller.clientHeight === 0) {
      cue.hidden = true;
      return;
    }
    const bottom = scroller.scrollTop + scroller.clientHeight;
    const out = (n) => n.offsetTop + n.offsetHeight > bottom + 2;
    const hidden = [...scroller.querySelectorAll(items)].filter(out).length;
    if ([...scroller.querySelectorAll(all)].filter(out).length < 2) {
      cue.hidden = true;
      return;
    }
    cue.hidden = false;
    const text = hidden ? `${hidden} more ↓` : 'More ↓';
    if (pill.textContent !== text) pill.textContent = text;
    pill.setAttribute('aria-label', `${text.replace(' ↓', '')}, scroll down`);
  };
  pill.addEventListener('click', () => scroller.scrollBy({ top: step(), behavior: 'smooth' }));
  scroller.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scroller);
  new MutationObserver(update).observe(scroller, { childList: true });
  update();
}

// The quick-look grid: one row (a tile and a gap) at a time. The running order: nearly a page.
scrollCue($('qGrid'), { items: '.ql:not(.newq)', all: '.ql', step: () => ($('qGrid').querySelector('.ql')?.offsetHeight ?? 56) + 8 });
scrollCue($('runningOrder'), { items: '.item', step: () => Math.max(96, $('runningOrder').clientHeight - 56) });

// ---- Flash: hold a button and the group goes to full white ----

// Every press on a Flash or Puff button: web/shared/press.js (tested in server/test/press.test.ts).
const presses = new FlashPresses({
  send: (cmd) => send(cmd),
  setDown: (b, down) => b.classList.toggle('down', down),
  // A press that waited out its 70 ms only counts if its button is still on the page and the page is in view.
  canFlash: (b) => b.isConnected && document.visibilityState === 'visible',
});
const flashAllOff = () => presses.allOff();

/**
 * Holding the button flashes the groups; letting go (or losing the finger) puts them out, never sooner than 100 ms
 * after it went on. Flash buttons and a smoke group's Puff both work this way.
 *
 * `swipe`: the button sits in the Flash row. Only while that row really scrolls (its buttons don't all fit) does a
 * finger or pen wait 70 ms before the flash goes on, and a move over 8 px in that time is a swipe: no flash (the row
 * also then lets the browser pan it, see .flash-scroll.scrolls). A row that fits presses at once, as it always did,
 * and a finger drifting a little on a held button keeps it held. The mouse always presses at once.
 */
function wireHold(b, groups, { swipe = false } = {}) {
  // Pointers that lifted: the leave and lost-capture events that follow must not cut the minimum hold short.
  const lifted = new Set();
  b.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    lifted.delete(ev.pointerId);
    // Keep getting the release when the finger slides off the button.
    try { b.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    const sc = b.parentElement;
    const wait = swipe && ev.pointerType !== 'mouse' && sc.scrollWidth > sc.clientWidth + 1;
    presses.press(ev.pointerId, b, groups, { wait, x: ev.clientX, y: ev.clientY });
  });
  b.addEventListener('pointermove', (ev) => presses.move(ev.pointerId, ev.clientX, ev.clientY));
  b.addEventListener('pointerup', (ev) => {
    lifted.add(ev.pointerId);
    setTimeout(() => lifted.delete(ev.pointerId), 500);
    presses.release(ev.pointerId);
  });
  for (const name of ['pointercancel', 'pointerleave', 'lostpointercapture']) {
    b.addEventListener(name, (ev) => { if (!lifted.has(ev.pointerId)) presses.cancel(ev.pointerId); });
  }
  b.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

// True when every Flash button's short name differs from the others (and from "All").
let flashShortsDiffer = false;

/** The Flash row scrolls sideways: a soft fade at an edge only while there is more to scroll that way. */
function updateFlashFades() {
  const sc = $('flashArea').querySelector('.flash-scroll');
  if (!sc) return;
  // Only a row that really scrolls lets the browser pan it from a finger on a button (see .flash-scroll.scrolls).
  sc.classList.toggle('scrolls', sc.scrollWidth > sc.clientWidth + 1);
  sc.style.setProperty('--fl', sc.scrollLeft > 1 ? '28px' : '0px');
  sc.style.setProperty('--fr', sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1 ? '28px' : '0px');
}

/**
 * A short name for a Flash button: the first word of the group's name, cut to 4 letters when it is longer than 6
 * ("Front", "Key", "Back", "Drum", "B8"). Used only on the iPad's one-line bar, and only when no two short names
 * (or "All") are the same and they all fit; otherwise the buttons carry the full names.
 */
function shortFlashName(name) {
  const w = name.trim().split(/\s+/)[0] ?? '';
  return w.length > 6 ? w.slice(0, 4) : w;
}

/** Writes the short (or the full) name on every Flash button. The label for assistive tech is always the full name. */
function setFlashLabels(short) {
  for (const b of $('flashArea').querySelectorAll('button')) b.textContent = short ? b.dataset.short : b.dataset.full;
  document.body.classList.toggle('flash-short', short);
  updateFlashFades();
}

function buildFlash() {
  flashAllOff();
  // A rebuild can change how many buttons there are: fit the bar again once they are in.
  queueMicrotask(fitBottomBar);
  const root = $('flashArea');
  const scroll = el('div', 'flash-scroll');
  root.replaceChildren(el('span', 'flash-label ds-caps', 'Flash'), scroll);
  // Smoke machines have Puff in the details instead, and "All" never includes them.
  const lights = lightGroups();
  const buttons = [['All', lights.map((g) => g.id), 'All lights', 'All']];
  for (const g of lights) buttons.push([g.name, [g.id], g.name, shortFlashName(g.name)]);
  const shorts = buttons.map((x) => x[3].toLowerCase());
  flashShortsDiffer = new Set(shorts).size === shorts.length;
  for (const [text, groups, full, short] of buttons) {
    const b = el('button', null, text);
    b.dataset.full = text;
    b.dataset.short = short;
    b.title = full;
    b.setAttribute('aria-label', `Flash ${full} (hold)`);
    scroll.append(b);
    wireHold(b, groups, { swipe: true });
  }
  scroll.addEventListener('scroll', updateFlashFades, { passive: true });
  // A mouse wheel turns the row too (a trackpad swipe or shift + wheel already does).
  scroll.addEventListener('wheel', (ev) => {
    if (ev.deltaX || !ev.deltaY || scroll.scrollWidth <= scroll.clientWidth) return;
    scroll.scrollLeft += ev.deltaY;
    ev.preventDefault();
  }, { passive: false });
  new ResizeObserver(updateFlashFades).observe(scroll);
  updateFlashFades();
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
  // In Prepare it is the draft, moving like the stage would: dark until its first frame.
  const shownVisual = prep.on ? prep.visual ?? NO_VISUAL : visual;
  const pad = 14, r = Math.max(5, Math.min(9, h / 16));
  const iw = w - 2 * pad, ih = h - 2 * pad;
  const toPx = (p) => [pad + p.x * iw, pad + p.y * ih];
  // Where each fixture's segments start in the visual, counted in segments.
  const starts = [];
  let at = 0;
  for (const f of layout.fixtures) {
    starts.push(at);
    at += Math.max(1, f.segments ?? 1);
  }
  const cellsOf = (k) => {
    const f = layout.fixtures[k], first = starts[k];
    return Array.from({ length: Math.max(1, f.segments ?? 1) }, (_, s) =>
      shownRgb(shownVisual[(first + s) * 3] ?? 0, shownVisual[(first + s) * 3 + 1] ?? 0, shownVisual[(first + s) * 3 + 2] ?? 0));
  };
  const brightest = (cells) => cells.reduce((best, c) => (Math.max(...c) > Math.max(...best) ? c : best), cells[0]);
  const shapeOf = (f) => f.shape ?? (f.w || f.h ? 'bar' : 'dot');
  // Beams' cones and smoke go first, so they never cover a light.
  layout.fixtures.forEach((f, k) => {
    if (shapeOf(f) === 'beam') drawCone(f, cellsOf(k)[0]);
    if (shapeOf(f) === 'smoke') drawSmoke(f);
  });
  layout.fixtures.forEach((f, k) => {
    const shape = shapeOf(f);
    if (shape === 'bar') drawBar(f, cellsOf(k));
    else if (shape === 'outline') drawOutline(f, cellsOf(k));
    else if (shape !== 'smoke') drawDot(f, cellsOf(k)[0]);
  });

  /** A faint cone in the light's colour, strongest at the lamp and gone at the tip; nothing when it is off. */
  function drawCone(f, [R, G, B]) {
    const lit = Math.max(R, G, B) / 255;
    if (lit <= 0.02) return;
    const cone = beamCone(f);
    const [lx, ly] = toPx(cone.lamp), [tx, ty] = toPx(cone.tip);
    const fade = ctx.createLinearGradient(lx, ly, tx, ty);
    fade.addColorStop(0, `rgba(${R},${G},${B},${0.22 * lit})`);
    fade.addColorStop(1, `rgba(${R},${G},${B},0)`);
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(...toPx(cone.left));
    ctx.lineTo(...toPx(cone.right));
    ctx.closePath();
    ctx.fillStyle = fade;
    ctx.fill();
  }

  /** A small grey cloud, a little brighter while its smoke group's level is up. */
  function drawSmoke(f) {
    const groups = (layout.groups ?? []).filter((g) => isSmoke(g) && layout.members?.[g.id]?.includes(f.id));
    const level = Math.max(0, ...groups.map((g) => state?.groups?.[g.id]?.level ?? 0));
    const [x, y] = toPx(f);
    ctx.fillStyle = `rgba(148,170,210,${0.16 + 0.24 * level})`;
    for (const [dx, dy, s] of [[-0.55, 0.15, 0.7], [0, -0.2, 0.9], [0.6, 0.1, 0.75]]) {
      ctx.beginPath();
      ctx.arc(x + dx * r * 1.6, y + dy * r * 1.6, s * r * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** A bar or strip at its real size and angle, one cell per segment from its start to its end. */
  function drawBar(f, cells) {
    const [a, b] = barEnds(f).map(toPx);
    const len = Math.max(8, Math.hypot(b[0] - a[0], b[1] - a[1]));
    const thick = Math.max(8, barAxis(f).thickness * ih);
    const glow = brightest(cells);
    const lit = Math.max(...glow) / 255;
    ctx.save();
    ctx.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    ctx.rotate(Math.atan2(b[1] - a[1], b[0] - a[0]));
    const box = () => {
      ctx.beginPath();
      ctx.roundRect(-len / 2, -thick / 2, len, thick, 4);
    };
    ctx.save();
    if (lit > 0.02) {
      ctx.shadowColor = `rgba(${glow[0]},${glow[1]},${glow[2]},${0.8 * lit})`;
      ctx.shadowBlur = 10;
    }
    box();
    ctx.fillStyle = `rgb(${glow[0]},${glow[1]},${glow[2]})`;
    ctx.fill();
    ctx.restore();
    ctx.save();
    box();
    ctx.clip();
    const cell = len / cells.length;
    cells.forEach(([R, G, B], s) => {
      // Segment 0 is at the bar's start (left or top); at its end when the fixture hangs reversed.
      const slot = f.reversed ? cells.length - 1 - s : s;
      ctx.fillStyle = `rgb(${R},${G},${B})`;
      ctx.fillRect(-len / 2 + slot * cell, -thick / 2, cell + 0.5, thick);
    });
    ctx.restore();
    box();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#3a3f48';
    ctx.stroke();
    ctx.restore();
  }

  /** A strip round something: its cells clockwise from the top left (anticlockwise when reversed). */
  function drawOutline(f, cells) {
    const box = { left: pad + (f.x - (f.w ?? 0) / 2) * iw, top: pad + (f.y - (f.h ?? 0) / 2) * ih, width: (f.w ?? 0) * iw, height: (f.h ?? 0) * ih };
    const path = (points) => {
      ctx.beginPath();
      points.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    };
    ctx.save();
    ctx.lineJoin = 'round';
    // The strip itself, dark where it is off.
    ctx.beginPath();
    ctx.roundRect(box.left, box.top, box.width, box.height, 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#3a3f48';
    ctx.stroke();
    const glow = brightest(cells);
    const lit = Math.max(...glow) / 255;
    if (lit > 0.02) {
      ctx.shadowColor = `rgba(${glow[0]},${glow[1]},${glow[2]},${0.8 * lit})`;
      ctx.shadowBlur = 10;
    }
    ctx.lineWidth = 4;
    outlineCells(box, cells.length, f.reversed).forEach((points, s) => {
      const [R, G, B] = cells[s];
      path(points);
      ctx.strokeStyle = `rgb(${R},${G},${B})`;
      ctx.stroke();
    });
    ctx.restore();
  }

  /** A lamp: a dot with a soft glow in its colour. */
  function drawDot(f, [R, G, B]) {
    const [x, y] = toPx(f);
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
  // A small label at the bottom right, so the picture can't be mistaken for something else: "Live", "Off" during
  // Blackout, or in violet "Draft · <name>" while preparing.
  if (!pictureLabel) readPictureLabel();
  const draft = prep.on ? shownState() : null;
  const off = !prep.on && state?.look === 'blackout';
  const text = (prep.on ? `Draft · ${draft?.look ? lookName(draft.look) : '—'}` : off ? 'Off' : 'Live').toUpperCase();
  ctx.font = pictureLabel.font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.9px';
  ctx.fillStyle = prep.on ? pictureLabel.prep : off ? pictureLabel.off : pictureLabel.live;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';
  ctx.fillText(text, w - 8, h - 6, w - 16);
  ctx.textAlign = 'start';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
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
  // The same message again (a drag refused at every move) just stays up a little longer.
  if (!t.hidden && t.textContent === text) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
    return;
  }
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
const midQuery = window.matchMedia('(min-width: 701px) and (max-width: 1079px) and (min-height: 501px)');

/**
 * The bottom bar on two lines (Flash above Master and the buttons): always between a phone and the iPad in
 * landscape, and on the iPad when the Flash buttons don't fit on the bar's one line (many light groups, a wider
 * font). Never on the phone, where Flash sits in Groups.
 */
function fitBottomBar() {
  const body = document.body;
  const area = $('flashArea').querySelector('.flash-scroll');
  if (phoneQuery.matches || midQuery.matches) {
    body.classList.toggle('bar-two-rows', !phoneQuery.matches);
    if (area) setFlashLabels(false);
    return;
  }
  if (!area) return;
  // The iPad's one line, measured with no paint in between: short names when they all differ and fit; else the full
  // names on that line when they fit, else the full names in a row of their own (two lines).
  body.classList.remove('bar-two-rows');
  const overflows = () => area.scrollWidth > area.clientWidth + 1;
  if (flashShortsDiffer) {
    setFlashLabels(true);
    if (!overflows()) return;
  }
  setFlashLabels(false);
  if (overflows()) body.classList.add('bar-two-rows');
}
window.addEventListener('resize', fitBottomBar);
midQuery.addEventListener('change', fitBottomBar);
// Inter arrives after the first paint (font-display: swap), and widens the Flash names: check again when it has
// loaded (each 'loadingdone' is a font that finished; `ready` covers one that loaded before this ran). The stage
// view's label is drawn in it too.
document.fonts?.ready.then(fitBottomBar);
document.fonts?.addEventListener?.('loadingdone', () => {
  fitBottomBar();
  drawStage();
});

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
    // Editing belongs to the iPad: the running order's, and the colour picker's editors (their buttons are hidden here).
    if (editing) setEditing(false);
    if (quickEditing) setQuickEditing(false);
    // No Prepare on the phone: it stays a remote for the live stage.
    setPrepare(false);
    if (picker.group) closeEditor();
    closeSheet();
    closeManual();
  } else {
    if (flash.parentElement !== $('masterFader').parentElement) $('masterFader').after(flash);
    if (tempo.parentElement !== $('quiet')) $('fadeButton').parentElement.after(tempo);
  }
  showTempoMenu(false);
  fitBottomBar();
  if (!document.body.dataset.tab) setPhoneTab('order');
}

for (const b of $('phoneTabs').querySelectorAll('button')) b.addEventListener('click', () => setPhoneTab(b.dataset.tab));
phoneQuery.addEventListener('change', applyPhone);
applyPhone();

connect();
