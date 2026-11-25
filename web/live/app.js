// The new operator page (25 Nov 2026 design; docs/user-stories.md and the 25 Nov entries in docs/DECISIONS.md).
// This first step is the layout: the stage as the audience sees it, your changes, who the pads work on, the pads,
// the colour square, and the song's steps with Next and Blackout, all drawn from the server's live state. Faders,
// Prepare, the song list, effects with how long, and each song's own colour square come in later steps.
// The server is the single source of truth: every tap becomes a Command and the page only shows the state it gets back.

import { drawStagePicture } from '/shared/stagedraw.js';
import { setupPageTabs } from '/shared/pagetabs.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let layout = null;
let state = null;
let visual = null;
let socket = null;
let connected = false;
let ref = 0;
/** Who the pads and the colour square work on: 'all' or a group id. Kept per page (each tablet picks its own). */
let who = 'all';
/** Where the colour square was last tapped, for its dot: { u, v, colour }. */
let puck = null;

setupPageTabs($('pageTabs'));

// ---- Connection: reconnect every 2 s ----

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
      if (who !== 'all' && !lightGroups().some((g) => g.id === who)) who = 'all';
      render();
      drawStage();
    } else if (msg.type === 'state') {
      state = msg.state;
      render();
    } else if (msg.type === 'result' && msg.error) {
      toast(msg.error);
    }
  };
}

function setConnected(on) {
  connected = on;
  $('banner').hidden = on;
}

/** Sends a command to the server (the live stage). */
function send(cmd) {
  if (!connected) {
    toast('Not connected. Lights keep running; try again in a moment.');
    return;
  }
  socket.send(JSON.stringify({ type: 'command', ref: ++ref, cmd }));
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

// ---- What the layout and state say ----

const lightGroups = () => (layout?.groups ?? []).filter((g) => g.kind !== 'smoke');
const groupIndex = (id) => (layout?.groups ?? []).findIndex((g) => g.id === id);
const groupById = (id) => (layout?.groups ?? []).find((g) => g.id === id);
const lookById = (id) => (layout?.looks ?? []).find((l) => l.id === id) ?? (layout?.runningOrder ?? []).find((l) => l.id === id) ?? null;
const isBasic = (item) => item.id === layout?.basicLights;
/** The groups the pads work on now. */
const targets = () => (who === 'all' ? lightGroups().map((g) => g.id) : [who]);
/** A group's name for its small button: "Front lights" is "Front" (the row is narrow); the whole name is its title. */
const shortName = (name) => name.replace(/\s+lights?$/i, '') || name;
const whoName = () => (who === 'all' ? 'all lights' : groupById(who)?.name ?? '');

/** A preset's name and colour, from the group's colours or its hidden ones (an Any colour, a live effect). */
function presetOf(groupId, presetId) {
  const g = groupById(groupId);
  if (!g || !presetId) return null;
  return g.presets.find((p) => p.id === presetId) ?? g.hidden.find((p) => p.id === presetId) ?? null;
}

/** The colour a group shows now, for its dot. */
function groupColour(groupId) {
  const st = state?.groups?.[groupId];
  if (st?.hold) return st.hold.colour;
  if (st?.live) return st.live.display;
  return presetOf(groupId, st?.preset)?.swatch ?? '#3a3f4b';
}

/** Index in the running order of what is on stage (Basic lights for Safe); after Blackout, the item before it. */
function stageIndex() {
  const order = layout?.runningOrder ?? [];
  if (!state) return -1;
  if (state.look === 'safe') return order.findIndex(isBasic);
  let k = order.findIndex((i) => i.id === state.look);
  if (k < 0 && state.lastLook) k = order.findIndex((i) => i.id === state.lastLook);
  return k;
}

/** The song (running-order item) on stage, its sections (when the planned service gives them) and which is on. */
function songNow() {
  const order = layout?.runningOrder ?? [];
  const k = stageIndex();
  const item = k >= 0 ? order[k] : null;
  const sections = item ? layout?.songs?.[item.id]?.sections ?? [] : [];
  const sec = state?.section && item && state.section.song === item.id ? sections.findIndex((s) => s.kind === state.section.kind) : -1;
  return { order, k, item, sections, sec };
}

/** What Next starts: the song's next section, else the next running-order item (kept rows of a loaded service passed over). */
function nextStep() {
  const { order, k, item, sections, sec } = songNow();
  if (item && sections.length && sec < sections.length - 1) {
    const s = sections[sec + 1];
    return { name: s.name, look: lookById(s.look ?? item.id), cmd: { type: 'section', song: item.id, kind: s.kind } };
  }
  const skip = new Set(layout?.skip ?? []);
  const next = k < 0 ? order.find((i) => !isBasic(i) && !skip.has(i.id)) : order.slice(k + 1).find((i) => !skip.has(i.id));
  if (!next) return null;
  return { name: next.name, look: next, cmd: isBasic(next) ? { type: 'safe' } : { type: 'look', id: next.id } };
}

/** In plain words, which groups the look would change from what is on stage now. */
function whatChanges(look) {
  if (!look || !state) return '';
  if (isBasic(look)) return 'Every group to Basic lights.';
  const names = [];
  (layout.groups ?? []).forEach((g, i) => {
    const entry = look.entries?.[i];
    if (!entry || g.kind === 'smoke') return;
    if (state.groups?.[g.id]?.preset !== entry.preset) names.push(`${g.name} to ${entry.name}`);
  });
  if (!names.length) return 'Same colours as now.';
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more change.`;
  return `${names.join(', ')}.`;
}

// ---- Drawing ----

/** Sets innerHTML only when it changed, so state updates during a fade don't rebuild the buttons under a finger. */
function setHtml(el, html) {
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

function render() {
  if (!layout || !state) return;
  renderTop();
  renderChanges();
  renderWho();
  renderPads();
  renderSquare();
  renderBottom();
}

function renderTop() {
  const { item, sections, sec } = songNow();
  let now = '—';
  if (state.look === 'blackout') now = 'Blackout';
  else if (item) now = item.name + (sec >= 0 ? ` · ${sections[sec].name}` : '');
  $('nowName').textContent = now;
  $('fadeValue').textContent = state.fadeTime === null ? 'Auto' : state.fadeTime === 0 ? 'Instant' : `${state.fadeTime} s`;
  $('tempoValue').textContent = String(Math.round(state.tempo));
  $('masterValue').textContent = `${Math.round(state.master * 100)} %`;
}

/** What a changed group runs, in a word or two: its colour's name, "own colour" for a colour from the square. */
function changeName(groupId, st, p) {
  if (st.effect) return p?.name && p.name !== 'Custom' ? p.name : 'effect';
  if (st.live || !p || p.name === 'Custom') return 'own colour';
  return p.name;
}

function renderChanges() {
  const look = lookById(state.look);
  const chips = [];
  for (const g of lightGroups()) {
    const st = state.groups?.[g.id];
    if (!st?.changed) continue;
    const p = presetOf(g.id, st.preset);
    const back = look?.entries?.[groupIndex(g.id)]?.preset ?? null;
    chips.push(`<span class="chip"><i style="background:${esc(groupColour(g.id))}"></i>${esc(shortName(g.name))} · ${esc(changeName(g.id, st, p))}` +
      (back ? `<button type="button" data-back="${esc(g.id)}" data-preset="${esc(back)}" aria-label="Back to the saved colour for ${esc(g.name)}">×</button>` : '') + '</span>');
  }
  for (const id of state.flashing ?? []) {
    const g = groupById(id);
    if (g) chips.push(`<span class="chip flash">${esc(g.name)} · Flash</span>`);
  }
  setHtml($('changes'), chips.join(''));
  $('noChanges').hidden = chips.length > 0;
}
$('changes').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-back]');
  if (b) send({ type: 'groupPreset', group: b.dataset.back, preset: b.dataset.preset });
});

function renderWho() {
  const all = `<button type="button" class="btn${who === 'all' ? ' on' : ''}" data-who="all" role="radio" aria-checked="${who === 'all'}"><span class="dot" style="background:#b8bcc6"></span><span>All</span></button>`;
  const rest = lightGroups().map((g) =>
    `<button type="button" class="btn${who === g.id ? ' on' : ''}" data-who="${esc(g.id)}" role="radio" aria-checked="${who === g.id}" title="${esc(g.name)}"><span class="dot" style="background:${esc(groupColour(g.id))}"></span><span>${esc(shortName(g.name))}</span></button>`);
  setHtml($('who'), all + rest.join(''));
}
$('who').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-who]');
  if (!b) return;
  who = b.dataset.who;
  puck = null;
  render();
});

/** A look pad's colours, as a soft gradient of the colours it gives (back to front). */
function lookFill(look) {
  const cols = [...new Set((look.colours ?? []).filter(Boolean))].slice(0, 3);
  if (!cols.length) return 'background:transparent';
  if (cols.length === 1) cols.push(cols[0]);
  return `background:linear-gradient(135deg,${cols.join(',')})`;
}

function renderPads() {
  $('padsFor').textContent = `for ${whoName()}`;
  const pads = [];
  // Looks: the quick looks; with a group picked, only those that set it, for that group alone.
  for (const q of layout.quickLooks ?? []) {
    const sets = who === 'all' ? q.groups : q.groups.filter((g) => g === who);
    const on = sets.length > 0 && sets.every((g) => state.groups?.[g]?.preset === q.entries?.[groupIndex(g)]?.preset);
    pads.push(`<button type="button" class="pad${on ? ' active' : ''}" data-look="${esc(q.id)}"${sets.length ? '' : ' disabled style="opacity:.35"'}>` +
      `<span class="fill" style="${esc(lookFill(q))}"></span><i>Look</i><b>${esc(q.name)}</b></button>`);
  }
  // Effects: the picked group's own.
  if (who !== 'all') {
    for (const p of groupById(who)?.presets ?? []) {
      if (!p.effect) continue;
      const on = state.groups?.[who]?.preset === p.id;
      pads.push(`<button type="button" class="pad effect${on ? ' active' : ''}" data-preset="${esc(p.id)}"><span class="fill"></span><i>${on ? 'Effect · on' : 'Effect'}</i><b>${esc(p.name)}</b></button>`);
    }
  }
  const room = 15;
  if (pads.length > room) pads.splice(room - 1, pads.length, '<button type="button" class="pad more" disabled title="The full list comes in a later step"><i>All</i><b>More…</b></button>');
  // Hold: Flash, full white while held.
  const down = targets().length > 0 && targets().every((g) => state.flashing?.includes(g));
  pads.push(`<button type="button" class="pad hold${down ? ' down' : ''}" data-flash="1"><span class="fill" style="background:#ffffff"></span><i>Hold</i><b>Flash</b></button>`);
  setHtml($('pads'), pads.join(''));
}
$('pads').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.look) send({ type: 'quickLook', id: b.dataset.look, ...(who === 'all' ? {} : { only: [who] }) });
  else if (b.dataset.preset) send({ type: 'groupPreset', group: who, preset: b.dataset.preset });
});
// Flash: on while the finger is down, off when it lifts or slides off.
let flashing = null;
$('pads').addEventListener('pointerdown', (ev) => {
  const b = ev.target.closest('button[data-flash]');
  if (!b) return;
  ev.preventDefault();
  flashing = targets();
  send({ type: 'flash', groups: flashing, on: true });
});
const flashOff = () => {
  if (!flashing) return;
  send({ type: 'flash', groups: flashing, on: false });
  flashing = null;
};
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) $('pads').addEventListener(type, flashOff);

// ---- The colour square ----
// For now its corners are the picked group's first four colours (with All, the first colour group's). Each song's own
// four corners, set on the Timeline page, come in a later step.

/** The groups a square tap colours: white-only groups are left out. */
const colourTargets = () => targets().filter((g) => !groupById(g)?.whiteOnly);

function corners() {
  const from = who === 'all' ? lightGroups().find((g) => !g.whiteOnly) : groupById(who);
  if (!from || from.whiteOnly) return [];
  const cols = from.presets.filter((p) => !p.effect && p.colour && p.canRecolour).slice(0, 4);
  while (cols.length && cols.length < 4) cols.push(cols[cols.length - 1]);
  return cols.map((p) => ({ name: p.name, hex: p.colour }));
}

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
function mix(c, u, v) {
  const C = c.map((p) => rgb(p.hex));
  const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
  return hex([0, 1, 2].map((k) => w[0] * C[0][k] + w[1] * C[1][k] + w[2] * C[2][k] + w[3] * C[3][k]));
}

function renderSquare() {
  const c = corners();
  const sq = $('square');
  const ok = c.length === 4 && colourTargets().length > 0;
  sq.disabled = !ok;
  $('squareFor').textContent = ok ? `tap for ${whoName()}` : 'this group only has white';
  const at = ['0 0', '100% 0', '0 100%', '100% 100%'];
  const bg = ok ? c.map((p, i) => `radial-gradient(circle at ${at[i]},${p.hex}cc,${p.hex}00 72%)`).join(',') + ',#1a1730' : '#1a1730';
  if (sq.dataset.bg !== bg) {
    sq.style.background = bg;
    sq.dataset.bg = bg;
  }
  ['cTL', 'cTR', 'cBL', 'cBR'].forEach((id, i) => { $(id).textContent = ok ? c[i].name : ''; });
  const p = $('puck');
  p.hidden = !puck;
  if (puck) {
    p.style.left = `${puck.u * 100}%`;
    p.style.top = `${puck.v * 100}%`;
    p.style.background = puck.colour;
  }
}
$('square').addEventListener('click', (ev) => {
  const c = corners();
  if (c.length !== 4) return;
  const r = ev.currentTarget.getBoundingClientRect();
  const u = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  const v = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
  const colour = mix(c, u, v);
  puck = { u, v, colour };
  for (const g of colourTargets()) send({ type: 'groupColour', group: g, colour });
  renderSquare();
});

// ---- Bottom: the song, its steps, Next and Blackout ----

function renderBottom() {
  const { order, k, item, sections, sec } = songNow();
  let html;
  if (item && sections.length) {
    $('songOf').textContent = `Song · ${k + 1} of ${order.length}`;
    html = sections.map((s, i) =>
      `<button type="button" class="btn${i === sec ? ' here' : i < sec ? ' done' : ''}" data-section="${esc(s.kind)}">${esc(s.name)}</button>`).join('');
  } else {
    // No sections (no planned service loaded): the running order itself is the steps.
    $('songOf').textContent = order.length ? `Item · ${k + 1} of ${order.length}` : 'Running order';
    html = order.map((i, n) =>
      `<button type="button" class="btn${n === k ? ' here' : n < k ? ' done' : ''}" data-item="${esc(i.id)}">${esc(i.name)}</button>`).join('');
  }
  $('songName').textContent = item?.name ?? '—';
  const steps = $('steps');
  const before = steps.dataset.html;
  setHtml(steps, html);
  if (steps.dataset.html !== before) steps.querySelector('.here')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  const next = nextStep();
  $('nextName').textContent = next ? next.name : 'End of list';
  $('nextWhat').textContent = next ? whatChanges(next.look) : '';
  $('next').disabled = !next;
  $('blackout').classList.toggle('on', state.look === 'blackout');
}
$('steps').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  const { item } = songNow();
  if (b.dataset.section && item) send({ type: 'section', song: item.id, kind: b.dataset.section });
  else if (b.dataset.item) {
    const i = (layout.runningOrder ?? []).find((x) => x.id === b.dataset.item);
    if (i) send(isBasic(i) ? { type: 'safe' } : { type: 'look', id: i.id });
  }
});
$('next').addEventListener('click', () => {
  const next = nextStep();
  if (next) send(next.cmd);
});

// Blackout needs a 1 s hold so a stray tap never darkens the room.
const blackout = $('blackout');
let holdTimer = 0;
blackout.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  blackout.classList.add('holding');
  holdTimer = setTimeout(() => {
    blackout.classList.remove('holding');
    send({ type: 'blackout' });
  }, 1000);
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  blackout.addEventListener(type, () => {
    clearTimeout(holdTimer);
    blackout.classList.remove('holding');
  });
}

// ---- Top bar: Fade steps through the choices; Tap sets the tempo from the last few taps ----

const FADES = [null, 0, 1, 2, 3, 5, 10];
$('fadeBtn').addEventListener('click', () => {
  const i = FADES.indexOf(state?.fadeTime ?? null);
  send({ type: 'fadeTime', value: FADES[(i + 1) % FADES.length] });
});
let taps = [];
$('tapBtn').addEventListener('click', () => {
  const now = performance.now();
  taps = taps.filter((t) => now - t < 2000).concat(now).slice(-6);
  if (taps.length < 3) return;
  const bpm = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
  send({ type: 'tempo', bpm: Math.max(40, Math.min(240, bpm)) });
});

// ---- The stage, as the audience sees it (light beams from each fixture) ----

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
  drawStagePicture(ctx, w, h, layout, visual, (g) => state?.groups?.[g]?.level ?? 0, { view: 'front' });
  const off = state?.look === 'blackout';
  ctx.font = '600 10px Inter, system-ui, sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.9px';
  ctx.fillStyle = off ? '#ff9a9a' : '#8a8f9c';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(off ? 'OFF' : 'LIVE', w - 10, h - 8);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}
new ResizeObserver(() => drawStage()).observe(canvas);

connect();
