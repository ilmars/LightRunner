// The Effects page (programmer, behind the PIN): the show's effect library. Build an effect in four steps (colours,
// movement, speed, name), see it move on a group's lights (drawn by the server's engine; nothing goes to the lights),
// and ★ it to put it on the operator page's pads. Saves one effect at a time (PUT and DELETE /api/effect); the list
// comes from the operator layout over the WebSocket, so it follows saves made anywhere.

import { setupPageTabs } from '/shared/pagetabs.js';
import { setupFullscreen } from '/shared/fullscreen.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

setupPageTabs(document.querySelector('.ds-pagetabs'));
setupFullscreen($('fsBtn'));

/** The movements, in plain words. */
const KINDS = [
  ['wave', 'Wave', 'colours roll along the lights'],
  ['chase', 'Chase', 'one colour runs from light to light'],
  ['colourFade', 'Colour fade', 'all the lights change colour together'],
  ['breathe', 'Breathe', 'brightness rises and falls'],
  ['sparkle', 'Sparkle', 'lights twinkle at random'],
  ['meteor', 'Meteor', 'a bright head with a fading tail'],
  ['fill', 'Fill', 'a colour fills the line, then the next'],
  ['yoyo', 'Yo-yo', 'there and back again'],
  ['stripes', 'Stripes', 'bands of colour that slide'],
];
const DIRS = [['ltr', 'Left to right'], ['rtl', 'Right to left'], ['centreOut', 'From the middle'], ['outsideIn', 'From the sides']];
const SPEEDS = [1, 2, 4, 8, 16];

let layout = null;
/** The effect being edited (a copy), and whether it is new. */
let draft = null;
let isNew = false;
let dirty = false;

// ---- Requests and the PIN ----

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

async function startPage() {
  const session = await call('GET', '/api/session');
  if (!session.loggedIn) return showLogin();
  $('logout').hidden = !session.pinSet;
  $('main').hidden = false;
  connect();
}
function showLogin() {
  $('main').hidden = true;
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
    await startPage();
  } catch (err) {
    $('loginError').textContent = err.message;
    $('pin').select();
  }
});
$('logout').addEventListener('click', async () => {
  await call('POST', '/api/logout').catch(() => {});
  showLogin();
});

// ---- The layout (the library, the groups and their colours) over the WebSocket ----

let socket = null;
function connect() {
  if (socket) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => { $('offline').hidden = true; };
  ws.onclose = () => {
    socket = null;
    $('offline').hidden = false;
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    if (msg.type !== 'layout' || !msg.layout) return;
    layout = msg.layout;
    renderList();
    renderGroups();
    // A save made elsewhere: the open effect follows it, unless it has unsaved changes here.
    if (draft && !isNew && !dirty) {
      const saved = effects().find((e) => e.id === draft.id);
      if (saved) open(saved);
    }
    renderEditor();
  };
}

const effects = () => layout?.effects ?? [];
/** Groups an effect can move along: light groups with colour and more than one light or segment. */
const movingGroups = () => (layout?.groups ?? []).filter((g) => g.kind !== 'smoke' && !g.whiteOnly && g.segments > 1);

/** The show's colours, once per name (every colour group's plain colours). */
function showColours() {
  const seen = new Map();
  for (const g of layout?.groups ?? []) {
    if (g.kind === 'smoke' || g.whiteOnly) continue;
    for (const p of g.presets) if (!p.effect && p.colour && p.canRecolour && !seen.has(p.name)) seen.set(p.name, { name: p.name, hex: p.colour });
  }
  return [...seen.values()];
}
const nameOfHex = (hex) => showColours().find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
/** The song square's colours (the show's square), for "the song's colours" in the preview. */
const squareColours = () => (layout?.square ?? []).map((c) => ({ hex: c.colour.hex }));

// ---- The list ----

function renderList() {
  const list = effects();
  $('list').innerHTML = list.length
    ? list.map((e) => {
      const cols = (e.songColours ? squareColours() : e.layer.colours).slice(0, 6);
      const sw = cols.map((c) => `<i style="background:${esc(c.hex)}"></i>`).join('');
      return `<div class="fx-item${draft && draft.id === e.id ? ' on' : ''}" role="listitem">` +
        `<button type="button" class="fx-star${e.favourite ? ' fav' : ''}" data-star="${esc(e.id)}" aria-pressed="${e.favourite}" aria-label="Favourite: on the operator page's pads" title="Favourite: on the operator page's pads">★</button>` +
        `<button type="button" class="fx-open" data-open="${esc(e.id)}"><b>${esc(e.name)}</b><span class="fx-sw">${sw}${e.songColours ? '<em>song</em>' : ''}</span></button></div>`;
    }).join('')
    : '<p class="card-desc">No effects yet. Make one with ＋ New effect.</p>';
}
$('list').addEventListener('click', async (ev) => {
  const star = ev.target.closest('[data-star]');
  if (star) {
    const e = effects().find((x) => x.id === star.dataset.star);
    if (!e) return;
    try {
      await call('PUT', '/api/effect', { ...e, favourite: !e.favourite });
    } catch (err) {
      $('error').textContent = err.message;
    }
    return;
  }
  const b = ev.target.closest('[data-open]');
  if (!b) return;
  if (dirty && !confirm('Leave this effect without saving?')) return;
  const e = effects().find((x) => x.id === b.dataset.open);
  if (e) open(e);
});

// ---- Editing ----

function open(e) {
  draft = structuredClone(e);
  isNew = false;
  dirty = false;
  $('error').textContent = '';
  renderList();
  renderEditor();
  preview();
}
$('newBtn').addEventListener('click', () => {
  if (dirty && !confirm('Leave this effect without saving?')) return;
  const cols = showColours();
  draft = {
    id: '', name: '', favourite: true, songColours: !!layout?.square,
    layer: { kind: 'effect', effect: 'wave', colours: (cols.length ? cols.slice(0, 2) : [{ hex: '#2b4dff' }, { hex: '#8f4dff' }]).map((c) => ({ hex: c.hex })), speed: { beats: 4 }, direction: 'ltr', waves: 1, size: 0.5, edge: 'soft', intensity: 1 },
  };
  isNew = true;
  dirty = false;
  $('error').textContent = '';
  renderList();
  renderEditor();
  preview();
  $('name').focus();
});
const changed = () => {
  dirty = true;
  renderEditor();
  preview();
};

function renderEditor() {
  $('editor').hidden = !draft;
  $('empty').hidden = !!draft;
  if (!draft) return;
  const l = draft.layer;
  $('songColours').checked = draft.songColours;
  $('chosen').innerHTML = l.colours.map((c, i) =>
    `<button type="button" class="fx-chip" data-remove="${i}" title="Take this colour out"${l.colours.length < 2 ? ' disabled' : ''}><i style="background:${esc(c.hex)}"></i>${esc(nameOfHex(c.hex))} <span aria-hidden="true">×</span></button>`).join('');
  $('chosen').classList.toggle('muted', draft.songColours);
  $('chosenNote').textContent = draft.songColours
    ? "It runs in the song's four corner colours. These are kept for a song without a square."
    : l.colours.length >= 6 ? 'Six colours at most.' : 'Tap a colour below to add it.';
  $('palette').innerHTML = showColours().map((c) =>
    `<button type="button" class="fx-chip" data-add="${esc(c.hex)}"${l.colours.length >= 6 ? ' disabled' : ''}><i style="background:${esc(c.hex)}"></i>${esc(c.name)}</button>`).join('');
  $('kinds').innerHTML = KINDS.map(([k, name, what]) =>
    `<button type="button" class="fx-kind" role="radio" aria-checked="${l.effect === k}" data-kind="${k}"><b>${name}</b><span>${what}</span></button>`).join('');
  $('dirs').innerHTML = DIRS.map(([d, name]) => `<button type="button" role="radio" aria-checked="${l.direction === d}" data-dir="${d}">${name}</button>`).join('');
  const beats = l.speed && 'beats' in l.speed ? l.speed.beats : null;
  $('speeds').innerHTML = SPEEDS.map((n) => `<button type="button" role="radio" aria-checked="${beats === n}" data-beats="${n}">${n}</button>`).join('');
  if (document.activeElement !== $('name')) $('name').value = draft.name;
  $('favourite').checked = draft.favourite;
  $('deleteBtn').hidden = isNew;
  $('saveBtn').textContent = isNew ? 'Save effect' : dirty ? 'Save changes' : 'Saved';
  $('saveBtn').disabled = !isNew && !dirty;
}

$('songColours').addEventListener('change', (ev) => { draft.songColours = ev.target.checked; changed(); });
$('chosen').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-remove]');
  if (!b || draft.layer.colours.length < 2) return;
  draft.layer.colours.splice(Number(b.dataset.remove), 1);
  changed();
});
$('palette').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-add]');
  if (!b || draft.layer.colours.length >= 6) return;
  draft.layer.colours.push({ hex: b.dataset.add });
  changed();
});
$('kinds').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-kind]');
  if (b) { draft.layer.effect = b.dataset.kind; changed(); }
});
$('dirs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-dir]');
  if (b) { draft.layer.direction = b.dataset.dir; changed(); }
});
$('speeds').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-beats]');
  if (b) { draft.layer.speed = { beats: Number(b.dataset.beats) }; changed(); }
});
$('name').addEventListener('input', () => { draft.name = $('name').value; dirty = true; renderEditor(); });
$('favourite').addEventListener('change', (ev) => { draft.favourite = ev.target.checked; changed(); });

/** An id from the name, not taken by another effect. */
function idFor(name) {
  const base = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'effect';
  const taken = new Set(effects().map((e) => e.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

$('saveBtn').addEventListener('click', async () => {
  if (!draft) return;
  const name = draft.name.trim();
  if (!name) {
    $('error').textContent = 'Give the effect a name.';
    $('name').focus();
    return;
  }
  const effect = { ...draft, name, id: isNew ? idFor(name) : draft.id };
  try {
    const saved = await call('PUT', '/api/effect', effect);
    draft = structuredClone(saved);
    isNew = false;
    dirty = false;
    $('error').textContent = '';
    renderList();
    renderEditor();
  } catch (err) {
    $('error').textContent = err.message;
  }
});

let sure = false;
$('deleteBtn').addEventListener('click', async () => {
  if (!draft || isNew) return;
  if (!sure) {
    sure = true;
    $('deleteBtn').textContent = 'Tap again to delete';
    setTimeout(() => { sure = false; $('deleteBtn').textContent = 'Delete'; }, 3000);
    return;
  }
  sure = false;
  $('deleteBtn').textContent = 'Delete';
  try {
    await call('DELETE', `/api/effect?id=${encodeURIComponent(draft.id)}`);
    draft = null;
    dirty = false;
    renderList();
    renderEditor();
  } catch (err) {
    $('error').textContent = err.message;
  }
});

// ---- The preview: the server's engine draws the effect on a group's lights; it loops here ----

function renderGroups() {
  const sel = $('group');
  const was = sel.value;
  sel.innerHTML = movingGroups().map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  if (movingGroups().some((g) => g.id === was)) sel.value = was;
}
$('group').addEventListener('change', () => preview());

let anim = null;
let previewTimer = 0;
function preview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const group = $('group').value;
    if (!draft || !group) return;
    const colours = draft.songColours && squareColours().length ? squareColours() : draft.layer.colours;
    try {
      const res = await fetch('/api/effect-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group, effect: { ...draft.layer, colours } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'no preview');
      anim = { ...data, bytes: Uint8Array.from(atob(data.frames), (c) => c.charCodeAt(0)), start: performance.now() };
    } catch (err) {
      anim = null;
      $('error').textContent = err.message;
    }
  }, 150);
}

function draw(now) {
  const cv = $('strip');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (anim && anim.segments > 0) {
    const f = Math.floor(((now - anim.start) / 1000) * anim.fps) % anim.count;
    const cell = w / anim.segments;
    for (let s = 0; s < anim.segments; s++) {
      const o = (f * anim.segments + s) * 3;
      ctx.fillStyle = `rgb(${anim.bytes[o]},${anim.bytes[o + 1]},${anim.bytes[o + 2]})`;
      ctx.fillRect(s * cell + 1, 4, Math.max(1, cell - 2), h - 8);
    }
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

startPage().catch((err) => { $('loginError').textContent = err.message; showLogin(); });
