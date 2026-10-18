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
let selectedGroup = null;
let ref = 0;
const lookButtons = new Map();
const groupButtons = new Map();

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
      paintGroupColours();
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'layout') {
      layout = msg.layout;
      buildLooks();
      buildGroups();
      buildDimmers();
      if (selectedGroup) openPanel(selectedGroup);
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
  $('link').classList.toggle('down', !on);
  $('linkText').textContent = on ? 'Connected' : 'Offline';
}

function send(cmd) {
  if (!connected) {
    toast('Not connected. Lights keep running; try again in a moment.');
    return;
  }
  socket.send(JSON.stringify({ type: 'command', ref: ++ref, cmd }));
}

// ---- Looks ----

// Looks in service order. Each tile shows its section and the colour it gives
// each group (one block per group, in group-strip order; striped = left alone).
function buildLooks() {
  const root = $('looks');
  root.replaceChildren();
  lookButtons.clear();
  for (const look of layout.looks) {
    const b = el('button', 'look');
    const strip = el('span', 'strip');
    (look.colours ?? []).forEach((c, k) => {
      const block = el('i', c ? null : 'unset');
      if (c) block.style.background = c;
      block.title = layout.groups[k]?.name ?? '';
      strip.append(block);
    });
    b.append(el('span', 'fill'), el('span', 'section', look.section ?? ''), strip, el('span', 'name', look.name));
    b.addEventListener('click', () => send({ type: 'look', id: look.id }));
    root.append(b);
    lookButtons.set(look.id, b);
  }
  render();
}

/** The look after the last one run, in service order; the first look to start with. */
function nextLook() {
  if (!layout?.looks.length) return null;
  const k = layout.looks.findIndex((l) => l.id === state?.lastLook);
  return k < 0 ? layout.looks[0] : layout.looks[k + 1] ?? null;
}

$('next').addEventListener('click', () => {
  const look = nextLook();
  if (look) send({ type: 'look', id: look.id });
});
$('undo').addEventListener('click', () => send({ type: 'undo' }));

// Fade time for every look and preset change; shared by all devices.
for (const b of $('fadeGroup').querySelectorAll('button')) {
  b.addEventListener('click', () => send({ type: 'fadeTime', value: b.dataset.fade === 'auto' ? null : Number(b.dataset.fade) }));
}

// ---- Groups and the group panel ----

function buildGroups() {
  const root = $('groups');
  root.replaceChildren();
  groupButtons.clear();
  for (const g of layout.groups) {
    const b = el('button', 'group');
    const colour = el('span', 'colour');
    const badges = el('span', 'badges');
    const label = el('span', 'label');
    const presetName = el('small');
    label.append(el('span', null, g.name), presetName);
    b.append(colour, label, badges);
    b.addEventListener('click', () => (selectedGroup === g.id ? closePanel() : openPanel(g.id)));
    root.append(b);
    groupButtons.set(g.id, { button: b, colour, badges, presetName });
  }
  render();
}

function openPanel(groupId) {
  const group = layout?.groups.find((g) => g.id === groupId);
  if (!group) return closePanel();
  closeDimmers();
  selectedGroup = groupId;
  $('panelTitle').textContent = group.name;
  const root = $('panelPresets');
  root.replaceChildren();
  for (const p of group.presets) {
    const b = el('button', 'preset');
    b.dataset.preset = p.id;
    const sw = el('span', 'swatch');
    sw.style.background = p.swatch ?? '#444';
    b.append(sw, el('span', null, p.name));
    b.addEventListener('click', () => send({ type: 'groupPreset', group: groupId, preset: p.id }));
    root.append(b);
  }
  $('panel').hidden = false;
  render();
}

function closePanel() {
  selectedGroup = null;
  $('panel').hidden = true;
  render();
}

$('panelClose').addEventListener('click', closePanel);
$('release').addEventListener('click', () => selectedGroup && send({ type: 'release', target: { group: selectedGroup } }));
// One tap outside a panel closes it.
document.addEventListener('pointerdown', (ev) => {
  const t = ev.target;
  if (!$('panel').hidden && !($('panel').contains(t) || $('groups').contains(t) || $('stage').contains(t))) closePanel();
  if (!$('dimmerPanel').hidden && !($('dimmerPanel').contains(t) || $('dimmersToggle').contains(t) || $('masterFader').contains(t))) closeDimmers();
}, true);

// ---- Rendering live state ----

function render() {
  if (!state || !layout) return;
  const look = layout.looks.find((l) => l.id === state.look);
  $('lookName').textContent =
    state.look === 'safe' ? 'Safe' : state.look === 'blackout' ? 'Blackout' : look?.name ?? state.look ?? '—';

  // DMX status: impossible to miss when Light Runner isn't driving the lights.
  const bar = $('dmxBar');
  bar.hidden = state.output === 'ok';
  bar.classList.toggle('lost', state.output === 'lost');
  $('dmxText').textContent = state.output === 'off'
    ? "DMX is off: Light Runner isn't controlling the lights."
    : `DMX output lost: ${state.outputProblem ?? 'check the network and the node'}.`;

  // Fade progress and countdown.
  const fading = state.lookProgress < 1 && state.lookFadeLeft > 0;
  $('fade').hidden = !fading;
  if (fading) {
    $('fadeFill').style.width = `${Math.round(state.lookProgress * 100)}%`;
    $('fadeText').textContent = `fading ${Math.ceil(state.lookFadeLeft)} s`;
  }

  const next = nextLook();
  $('nextName').textContent = next ? next.name : 'End of list';
  $('next').disabled = !next;
  $('undo').disabled = !state.canUndo;
  for (const b of $('fadeGroup').querySelectorAll('button')) {
    const v = b.dataset.fade === 'auto' ? null : Number(b.dataset.fade);
    b.classList.toggle('on', v === (state.fadeTime ?? null));
  }

  for (const [id, b] of lookButtons) {
    const active = id === state.look;
    b.classList.toggle('active', active);
    b.querySelector('.fill').style.width = active && state.lookProgress < 1 ? `${state.lookProgress * 100}%` : '0';
  }
  for (const [id, parts] of groupButtons) {
    const g = state.groups[id];
    parts.button.classList.toggle('selected', id === selectedGroup);
    const preset = layout.groups.find((x) => x.id === id)?.presets.find((p) => p.id === g?.preset);
    parts.presetName.textContent = preset ? preset.name : g?.preset === '__safe' ? 'Safe' : g?.preset === '__blackout' ? 'Off' : '';
    parts.badges.replaceChildren();
    if (g?.changed) parts.badges.append(el('span', 'badge', 'changed'));
    if (g?.manual) parts.badges.append(el('span', 'badge m', 'M'));
  }
  if (selectedGroup) {
    const g = state.groups[selectedGroup];
    for (const b of $('panelPresets').children) b.classList.toggle('active', b.dataset.preset === g?.preset);
    $('release').hidden = !g?.manual;
  }
  for (const [id, f] of faders) {
    if (f.dragging) continue;
    f.set(id === MASTER ? state.master : state.groups[id]?.level ?? 1);
  }
  // The Groups button says how many groups are dimmed, so a dimmed group is never hidden.
  const dimmed = Object.values(state.groups).filter((g) => g.level < 0.995).length;
  $('dimmedCount').textContent = dimmed ? `${dimmed} dimmed` : '';
  for (const [id, bar] of miniBars) bar.style.height = `${Math.round((state.groups[id]?.level ?? 1) * 100)}%`;
}

// ---- Dimmers: one fader per group, plus master ----

const MASTER = '__master';
const miniBars = new Map();
const faders = new Map();

// Master is always in the bottom row; group faders live in a panel that the
// Groups button slides up, so the row stays the same however many groups there are.
function buildDimmers() {
  faders.clear();
  $('masterFader').replaceChildren(makeFader(MASTER, 'Master'));
  const minis = $('miniLevels');
  minis.replaceChildren();
  miniBars.clear();
  for (const g of layout.groups) {
    const bar = el('i');
    const level = el('b');
    bar.append(level);
    minis.append(bar);
    miniBars.set(g.id, level);
  }
  const root = $('dimmers');
  root.replaceChildren();
  for (const g of layout.groups) root.append(makeFader(g.id, g.name));
  render();
}

function openDimmers() {
  closePanel();
  $('dimmerPanel').hidden = false;
  $('dimmersToggle').setAttribute('aria-expanded', 'true');
}
function closeDimmers() {
  $('dimmerPanel').hidden = true;
  $('dimmersToggle').setAttribute('aria-expanded', 'false');
}
$('dimmersToggle').addEventListener('click', () => ($('dimmerPanel').hidden ? openDimmers() : closeDimmers()));
$('dimmersClose').addEventListener('click', closeDimmers);
$('allFull').addEventListener('click', () => {
  for (const g of layout?.groups ?? []) send({ type: 'groupLevel', group: g.id, value: 1 });
});

/**
 * A vertical fader. Dragging moves it relative to where the finger started,
 * so touching a fader never makes it jump; the server smooths every move.
 */
function makeFader(id, name) {
  const box = el('div', id === MASTER ? 'fader master' : 'fader');
  const value = el('span', 'value', '100%');
  const track = el('div', 'track');
  const fill = el('div', 'fill');
  const handle = el('div', 'handle');
  track.append(fill, handle);
  box.append(value, track, el('span', 'name', name));
  box.title = `${name}: drag to dim, double-tap the % for 100%`;

  const f = {
    fill, dragging: false, v: 1,
    set(v) {
      f.v = Math.min(1, Math.max(0, v));
      const pct = `${Math.round(f.v * 100)}%`;
      value.textContent = pct;
      fill.style.height = pct;
      handle.style.bottom = pct;
    },
  };
  const sendLevel = (v) => send(id === MASTER ? { type: 'master', value: v } : { type: 'groupLevel', group: id, value: v });
  let startY = 0, startV = 0, timer = 0;
  track.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    f.dragging = true;
    // Keep receiving moves when the finger slides off the fader.
    try { track.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    box.classList.add('dragging');
    startY = ev.clientY;
    startV = f.v;
  });
  track.addEventListener('pointermove', (ev) => {
    if (!f.dragging) return;
    f.set(startV + (startY - ev.clientY) / track.clientHeight);
    // At most one update every 40 ms while dragging.
    if (!timer) timer = setTimeout(() => { timer = 0; sendLevel(f.v); }, 40);
  });
  const end = () => {
    if (!f.dragging) return;
    f.dragging = false;
    box.classList.remove('dragging');
    clearTimeout(timer);
    timer = 0;
    sendLevel(f.v);
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  // Double-tap the level to go back to 100% (one tap alone does nothing, so no accidents).
  let lastTap = 0;
  value.addEventListener('pointerup', () => {
    const now = Date.now();
    if (now - lastTap < 400) { f.set(1); sendLevel(1); lastTap = 0; } else lastTap = now;
  });
  faders.set(id, f);
  return box;
}

// ---- Mini visualiser ----

const canvas = $('stage');
const ctx = canvas.getContext('2d');

function drawStage() {
  if (!layout) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = 16, r = Math.max(6, Math.min(12, h / 14));
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
        ctx.shadowBlur = 14;
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

// Tapping near a fixture selects its group.
canvas.addEventListener('click', (ev) => {
  if (!layout) return;
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const pad = 16;
  let best = null, dist = Infinity;
  layout.fixtures.forEach((f) => {
    const x = pad + f.x * (rect.width - 2 * pad), y = pad + f.y * (rect.height - 2 * pad);
    const hw = ((f.w ?? 0) * (rect.width - 2 * pad)) / 2, hh = ((f.h ?? 0) * (rect.height - 2 * pad)) / 2;
    const d = Math.hypot(Math.max(0, Math.abs(x - px) - hw), Math.max(0, Math.abs(y - py) - hh));
    if (d < dist) { dist = d; best = f; }
  });
  if (!best || dist > 40) return;
  const group = layout.groups.find((g) => (layout.members[g.id] ?? []).includes(best.id));
  if (group) openPanel(group.id);
});

function paintGroupColours() {
  if (!layout) return;
  const index = new Map(layout.fixtures.map((f, k) => [f.id, k]));
  for (const [id, parts] of groupButtons) {
    let r = 0, g = 0, b = 0, n = 0;
    for (const fid of layout.members[id] ?? []) {
      const k = index.get(fid);
      if (k === undefined) continue;
      r += visual[k * 3]; g += visual[k * 3 + 1]; b += visual[k * 3 + 2]; n++;
    }
    if (n) {
      const rgb = [r / n, g / n, b / n].map(Math.round);
      parts.colour.style.background = `rgb(${rgb.join(',')})`;
      // Fader fills take the group's colour; a dark group keeps a visible grey.
      const fader = faders.get(id);
      const colour = Math.max(...rgb) > 40 ? `rgb(${rgb.join(',')})` : '#5a5f68';
      if (fader) fader.fill.style.background = colour;
      const mini = miniBars.get(id);
      if (mini) mini.style.background = colour;
    }
  }
}

window.addEventListener('resize', drawStage);

// ---- Controls ----

$('backToLook').addEventListener('click', () => send({ type: 'backToLook' }));
$('safe').addEventListener('click', () => send({ type: 'safe' }));

// Blackout needs a 1 s hold so a stray tap never darkens the room.
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
