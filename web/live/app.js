// The new operator page (25 Nov 2026 design; docs/user-stories.md and the 25 Nov entries in docs/DECISIONS.md).
// Built so far: the layout (the stage as the audience sees it, your changes, who the pads work on, the pads, the colour
// square, the song's steps with Next and Blackout), Prepare, the faders with Master, the song list, and how long a
// change lasts (stay, pin, a few beats) with a running effect's speed, Pin, Freeze and Stop. Favourite effects (from
// the Effects tab) and each song's own colour square come in later steps.
// The server is the single source of truth: every tap becomes a Command and the page only shows the state it gets back.
//
// Prepare works on this tablet's own draft of the stage (the server's blindStart, draft, blindGo and blindEnd): a short
// hold of Prepare peeks, about 1 s keeps it on, and a tap turns it off. While it is on, the pads, the colour square,
// your changes and the steps go to the draft; Next, Flash, Blackout, Fade and Tempo always go to the real stage.
// Save keeps the draft in the step being prepared; Go fades the draft onto the stage; Back to live drops it.

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
// What the pads and the square start lasts until it is changed or the next cue; the effect bar's Pin keeps an effect
// through Next. (The engine can also end a change after some beats, `lasts`; the page doesn't offer it now: next to the
// pads a beats control reads as the effect's speed.)
/** The `lasts` a command carries for the choice (see Lasts in protocol.ts); nothing for Stay. */
const lastsNow = () => ({});

/**
 * Prepare. `state` and `visual` are the draft's (null until the server sends them). `session` counts the times it went on
 * or off, so a hold that started in one never lands in the other. `startRef`, `goRef` and `saveRef` match the server's
 * answers to the start, Go and Save.
 */
const prep = { on: false, locked: false, session: 0, state: null, visual: null, startRef: null, starting: false, goRef: null, saveRef: null, saveName: '' };
/** The server's answer to a draft command when it has no draft for this tablet. */
const PREPARE_OFF = 'Prepare is off.';
/** The stage the page works on: the draft while Prepare is on, else the live stage. */
const shown = () => (prep.on ? prep.state ?? state : state);

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
      if (!prep.on) drawStage();
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
    } else if (msg.type === 'draftState') {
      // Only while Prepare is on here (one may still be on its way after it went off).
      if (!prep.on) return;
      prep.state = msg.state;
      render();
    } else if (msg.type === 'draftVisual') {
      if (!prep.on) return;
      prep.visual = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
      drawStage();
    } else if (msg.type === 'draftEnded') {
      // The server met a problem in this tablet's draft and dropped it; the lights were not changed.
      if (!prep.on || prep.starting) return;
      setPrepare(false, false);
      toast(msg.reason);
    } else if (msg.type === 'result') {
      result(msg);
    }
  };
}

function setConnected(on) {
  connected = on;
  $('banner').hidden = on;
  // The server drops a tablet's draft when the connection goes.
  if (!on && prep.on) setPrepare(false, false);
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

/** Sends a stage command to the stage the page works on: this tablet's draft while Prepare is on. */
const sendStage = (cmd) => send(prep.on ? { type: 'draft', cmd } : cmd);

/** The server's answer to a command. */
function result(msg) {
  if (prep.on && msg.ref !== null) {
    if (msg.ref === prep.startRef) {
      prep.starting = false;
      // No draft was made (too many tablets preparing, a problem): Prepare goes off again; the toast says why.
      if (msg.error) {
        setPrepare(false, false);
        toast(msg.error);
        return;
      }
    }
    // The server has no draft for this tablet (it ended it): Prepare is off here too.
    if (msg.error === PREPARE_OFF && !prep.starting && msg.ref > prep.startRef) {
      setPrepare(false, false);
      return;
    }
    if (msg.ref === prep.goRef) {
      prep.goRef = null;
      // On an error the draft stays, to try again.
      if (!msg.error) setPrepare(false, false);
    }
    if (msg.ref === prep.saveRef) {
      prep.saveRef = null;
      if (!msg.error) toast(`Saved to ${prep.saveName}`);
    }
  }
  if (msg.error) toast(msg.error);
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

/** The colour a group shows on stage `s`, for its dot. */
function groupColour(groupId, s = shown()) {
  const st = s?.groups?.[groupId];
  if (st?.hold) return st.hold.colour;
  if (st?.live) return st.live.display;
  return presetOf(groupId, st?.preset)?.swatch ?? '#3a3f4b';
}

/** Index in the running order of what stage `s` shows (Basic lights for Safe); after Blackout, the item before it. */
function stageIndex(s) {
  const order = layout?.runningOrder ?? [];
  if (!s) return -1;
  if (s.look === 'safe') return order.findIndex(isBasic);
  let k = order.findIndex((i) => i.id === s.look);
  if (k < 0 && s.lastLook) k = order.findIndex((i) => i.id === s.lastLook);
  // A section's own look belongs to its song.
  if (k < 0 && s.section) k = order.findIndex((i) => i.id === s.section.song);
  return k;
}

/** The song (running-order item) on stage `s`, its sections (when the planned service gives them) and which is on. */
function songOf(s) {
  const order = layout?.runningOrder ?? [];
  const k = stageIndex(s);
  const item = k >= 0 ? order[k] : null;
  const sections = item ? layout?.songs?.[item.id]?.sections ?? [] : [];
  const sec = s?.section && item && s.section.song === item.id ? sections.findIndex((x) => x.kind === s.section.kind) : -1;
  return { order, k, item, sections, sec };
}

/** A step's name: "Song 2", or "Chorus · Song 2" while a section is on. */
function stepName(s) {
  if (s?.look === 'blackout') return 'Blackout';
  const { item, sections, sec } = songOf(s);
  if (!item) return '—';
  return sec >= 0 ? `${sections[sec].name} · ${item.name}` : item.name;
}

/** What Next starts on the real stage: the song's next section, else the next running-order item (kept rows passed over). */
function nextStep() {
  const { order, k, item, sections, sec } = songOf(state);
  if (item && sections.length && sec < sections.length - 1) {
    const s = sections[sec + 1];
    return { name: s.name, look: lookById(s.look ?? item.id), cmd: { type: 'section', song: item.id, kind: s.kind } };
  }
  const skip = new Set(layout?.skip ?? []);
  const next = k < 0 ? order.find((i) => !isBasic(i) && !skip.has(i.id)) : order.slice(k + 1).find((i) => !skip.has(i.id));
  if (!next) return null;
  return { name: next.name, look: next, cmd: isBasic(next) ? { type: 'safe' } : { type: 'look', id: next.id } };
}

/** In plain words, a list of group changes ("Background to Violets, Key lights to Zils."). */
function sayChanges(names, none) {
  if (!names.length) return none;
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more change.`;
  return `${names.join(', ')}.`;
}

/** Which groups the look would change from what is on stage now. */
function whatChanges(look) {
  if (!look || !state) return '';
  if (isBasic(look)) return 'Every group to Basic lights.';
  const names = [];
  (layout.groups ?? []).forEach((g, i) => {
    const entry = look.entries?.[i];
    if (!entry || g.kind === 'smoke') return;
    if (state.groups?.[g.id]?.preset !== entry.preset) names.push(`${g.name} to ${entry.name}`);
  });
  return sayChanges(names, 'Same colours as now.');
}

/** Which groups Go would change: where the draft runs something else than the stage. */
function whatGoChanges() {
  if (!prep.state || !state) return '';
  if (prep.state.look === 'blackout') return 'Every group off.';
  const names = [];
  for (const g of lightGroups()) {
    const to = prep.state.groups?.[g.id];
    if (!to || to.preset === state.groups?.[g.id]?.preset) continue;
    const p = presetOf(g.id, to.preset);
    names.push(`${g.name} to ${changeName(to, p)}`);
  }
  return sayChanges(names, 'The same as the stage.');
}

/** The library effect a running effect is (the same movement, speed and colours), by name; null when none is. */
function libraryName(layer) {
  const key = effectKey(layer);
  return (layout?.effects ?? []).find((e) => effectKey(libraryLayer(e)) === key)?.name ?? null;
}

/** What a group runs, in a word or two: its colour's name, "own colour" for a colour from the square. */
function changeName(st, p) {
  if (st.effect) return p?.name && p.name !== 'Custom' ? p.name : libraryName(st.effect) ?? 'effect';
  if (st.live || !p || p.name === 'Custom') return 'own colour';
  return p.name;
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
  renderFaders();
  renderSongs();
}

function renderTop() {
  $('nowLabel').textContent = prep.on ? "Preparing · the lights don't change" : 'On stage';
  $('nowName').textContent = prep.on ? `${stepName(shown())}  ·  on stage: ${stepName(state)}` : stepName(state);
  $('fadeValue').textContent = state.fadeTime === null ? 'Auto' : state.fadeTime === 0 ? 'Instant' : `${state.fadeTime} s`;
  $('tempoValue').textContent = String(Math.round(state.tempo));
  if (menuOpen?.menu === $('tempoMenu') && document.activeElement !== $('tempoField')) $('tempoField').value = String(Math.round(state.tempo));
  if (menuOpen?.menu === $('fadeMenu')) renderFadeMenu();
  $('masterValue').textContent = `${Math.round(state.master * 100)} %`;
  $('liveBtn').classList.toggle('on', !prep.on);
  $('liveBtn').setAttribute('aria-pressed', String(!prep.on));
  $('prepBtn').setAttribute('aria-pressed', String(prep.on));
  $('prepBtn').classList.toggle('locked', prep.locked);
}

/** How long a group's change lasts, in a word: "pinned", "6 beats left", "frozen" (or nothing for until Next). */
function lastingTag(st) {
  const words = [];
  if (st.pinned) words.push('pinned');
  if (st.beatsLeft !== null && st.beatsLeft !== undefined) {
    const n = Math.max(1, Math.ceil(st.beatsLeft));
    words.push(`${n} beat${n === 1 ? '' : 's'} left`);
  }
  if (st.frozen) words.push('frozen');
  return words.join(' · ');
}

function renderChanges() {
  const s = shown();
  const look = lookById(s.look);
  const chips = [];
  for (const g of lightGroups()) {
    const st = s.groups?.[g.id];
    if (!st?.changed) continue;
    const back = look?.entries?.[groupIndex(g.id)]?.preset ?? null;
    const tag = lastingTag(st);
    const what = g.whiteOnly && (st.live || presetOf(g.id, st.preset)?.name === 'Custom') ? 'own white' : changeName(st, presetOf(g.id, st.preset));
    chips.push(`<span class="chip${st.pinned ? ' pinned' : ''}"><i style="background:${esc(groupColour(g.id, s))}"></i>${esc(shortName(g.name))} · ${esc(what)}` +
      (tag ? ` <span class="tag">· ${esc(tag)}</span>` : '') +
      (back ? `<button type="button" data-back="${esc(g.id)}" data-preset="${esc(back)}" aria-label="Back to the saved colour for ${esc(g.name)}">×</button>` : '') + '</span>');
  }
  // Flash is always the real stage's.
  for (const id of state.flashing ?? []) {
    const g = groupById(id);
    if (g) chips.push(`<span class="chip flash">${esc(g.name)} · Flash</span>`);
  }
  setHtml($('changes'), chips.join(''));
  $('noChanges').hidden = chips.length > 0;
  $('noChanges').textContent = prep.on ? 'None. The step is as it was saved.' : 'None. The stage is as the cue was saved.';
  // Save: only in Prepare, with a step to save to.
  const item = prep.on && prep.state && prep.state.look !== 'blackout' ? songOf(prep.state).item : null;
  $('saveBtn').hidden = !item;
  if (item) $('saveText').textContent = `Save to ${stepName(prep.state)}`;
}
$('changes').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-back]');
  if (b) sendStage({ type: 'groupPreset', group: b.dataset.back, preset: b.dataset.preset });
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

/** Showing every effect (More) instead of the favourites. */
let padsAll = false;

/** The groups a library effect runs on: the picked ones that have colour (white-only groups can't run one). */
const effectTargets = () => targets().filter((g) => !groupById(g)?.whiteOnly);

/** A library effect as it runs now: in the song's square's colours when it is set to, else its own. */
function libraryLayer(e) {
  const square = squareSong()?.square ?? layout?.square ?? null;
  if (!e.songColours || !square) return e.layer;
  const seen = new Set();
  const colours = square.map((c) => c.colour).filter((c) => !seen.has(c.hex.toLowerCase()) && seen.add(c.hex.toLowerCase()));
  return { ...e.layer, colours };
}

/** What makes two effects the same on the pads: the movement, its direction and colours (not the speed: Speed changes it). */
const effectKey = (l) => JSON.stringify([l.effect, l.direction ?? 'ltr', (l.colours ?? []).map((c) => (c.hex ?? '').toLowerCase())]);

/** Runs a library effect on the picked groups that have colour, lasting as the Stay / Pin / beats switch says. */
function runLibraryEffect(id) {
  const e = (layout.effects ?? []).find((x) => x.id === id);
  if (!e) return;
  const layer = libraryLayer(e);
  for (const g of effectTargets()) sendStage({ type: 'groupEffect', group: g, effect: layer, ...lastsNow() });
}

function renderPads() {
  const s = shown();
  $('padsFor').textContent = `for ${whoName()}`;
  renderSpeed(s);
  renderFxBar(s);
  const pads = [];
  // Looks: the quick looks; with a group picked, only those that set it, for that group alone.
  for (const q of layout.quickLooks ?? []) {
    const sets = who === 'all' ? q.groups : q.groups.filter((g) => g === who);
    const on = sets.length > 0 && sets.every((g) => s.groups?.[g]?.preset === q.entries?.[groupIndex(g)]?.preset);
    pads.push(`<button type="button" class="pad${on ? ' active' : ''}" data-look="${esc(q.id)}"${sets.length ? '' : ' disabled style="opacity:.35"'}>` +
      `<span class="fill" style="${esc(lookFill(q))}"></span><i>Look</i><b>${esc(q.name)}</b></button>`);
  }
  // Effects from the library (the Effects page): the favourites; More shows the rest and the group's own effects.
  const lib = layout.effects ?? [];
  const fxGroups = effectTargets();
  for (const e of lib) {
    if (!e.favourite && !padsAll) continue;
    const layer = libraryLayer(e);
    const key = effectKey(layer);
    const on = fxGroups.length > 0 && fxGroups.every((g) => s.groups?.[g]?.effect && effectKey(s.groups[g].effect) === key);
    const stripe = `linear-gradient(90deg,${layer.colours.map((c) => c.hex).join(',')}${layer.colours.length < 2 ? ',' + layer.colours[0].hex : ''})`;
    pads.push(`<button type="button" class="pad effect${on ? ' active' : ''}" data-lib="${esc(e.id)}"${fxGroups.length ? '' : ' disabled style="opacity:.35"'}>` +
      `<span class="fill"></span><span class="stripe" style="background:${esc(stripe)}"></span><i>${on ? 'Effect · on' : e.favourite ? 'Effect ★' : 'Effect'}</i><b>${esc(e.name)}</b></button>`);
  }
  const own = who === 'all' ? [] : (groupById(who)?.presets ?? []).filter((p) => p.effect);
  if (padsAll) {
    for (const p of own) {
      const on = s.groups?.[who]?.preset === p.id;
      pads.push(`<button type="button" class="pad effect${on ? ' active' : ''}" data-preset="${esc(p.id)}"><span class="fill"></span><i>${on ? 'Effect · on' : 'Group'}</i><b>${esc(p.name)}</b></button>`);
    }
  }
  const more = lib.some((e) => !e.favourite) || own.length > 0;
  if (padsAll) pads.push('<button type="button" class="pad more" data-more="0"><i>Back to</i><b>Favourites</b></button>');
  else if (more) pads.push(`<button type="button" class="pad more" data-more="1"><i>${lib.filter((e) => !e.favourite).length + own.length} more</i><b>More…</b></button>`);
  $('pads').classList.toggle('all', padsAll);
  // Hold: Flash, full white while held, always on the real stage.
  const down = targets().length > 0 && targets().every((g) => state.flashing?.includes(g));
  pads.push(`<button type="button" class="pad hold${down ? ' down' : ''}" data-flash="1"><span class="fill" style="background:#ffffff"></span><i>Hold · live</i><b>Flash</b></button>`);
  setHtml($('pads'), pads.join(''));
}
$('pads').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.look) sendStage({ type: 'quickLook', id: b.dataset.look, ...(who === 'all' ? {} : { only: [who] }) });
  else if (b.dataset.preset) sendStage({ type: 'groupPreset', group: who, preset: b.dataset.preset, ...lastsNow() });
  else if (b.dataset.lib) runLibraryEffect(b.dataset.lib);
  else if (b.dataset.more) {
    padsAll = b.dataset.more === '1';
    render();
  }
});

// ---- Speed: one round of the running effect every 1 to 16 beats, on every picked group that runs one ----

const SPEEDS = [1, 2, 4, 8, 16];

/** The effect group `g` runs on stage `s` (a live effect, or a preset that is one), or null. */
function effectOf(g, s) {
  const st = s?.groups?.[g];
  if (!st?.preset) return null;
  return st.effect ?? presetOf(g, st.preset)?.effect ?? null;
}

function renderSpeed(s) {
  const running = targets().map((g) => effectOf(g, s)).filter(Boolean);
  const beats = new Set(running.map((e) => (e.speed && 'beats' in e.speed ? e.speed.beats : null)));
  const now = beats.size === 1 ? [...beats][0] : null;
  const none = running.length === 0;
  setHtml($('padSpeed'), SPEEDS.map((n) =>
    `<button type="button" data-beats="${n}" class="${now === n ? 'on' : ''}"${none ? ' disabled' : ''} title="${none ? 'Start an effect first' : `One round every ${n} beat${n > 1 ? 's' : ''}`}">${n}</button>`).join(''));
}
$('padSpeed').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-beats]');
  if (!b || b.disabled) return;
  const s = shown();
  for (const g of targets()) {
    const effect = effectOf(g, s);
    // A copy at the new speed, carrying on from where its pattern is, in the same colours; a pin stays.
    if (effect) sendStage({ type: 'groupEffect', group: g, effect: { ...effect, speed: { beats: Number(b.dataset.beats) } }, fade: 0.5, continues: true });
  }
});

// ---- The picked group's running effect: Pin, Freeze and Stop ----

/** The effect the picked group runs on stage `s`, with its name, or null. */
function runningEffect(s) {
  if (who === 'all') return null;
  const st = s?.groups?.[who];
  if (!st?.preset) return null;
  const p = presetOf(who, st.preset);
  const effect = st.effect ?? p?.effect ?? null;
  if (!effect) return null;
  return { st, effect, name: p?.name && p.name !== 'Custom' ? p.name : libraryName(effect) ?? 'Effect' };
}

function renderFxBar(s) {
  const fx = runningEffect(s);
  // The bar keeps its place with nothing running, so the pads never move when an effect starts or stops.
  $('fxBar').classList.toggle('idle', !fx);
  for (const id of ['fxPin', 'fxFreeze', 'fxStop']) $(id).disabled = !fx;
  if (!fx) {
    $('fxName').textContent = who === 'all' ? 'Effects' : `${shortName(groupById(who)?.name ?? '')} · no effect`;
    $('fxNote').textContent = who === 'all' ? 'pick one group' : 'start one from the pads';
    $('fxPin').setAttribute('aria-pressed', 'false');
    $('fxFreeze').setAttribute('aria-pressed', 'false');
    return;
  }
  $('fxName').textContent = `${shortName(groupById(who)?.name ?? '')} · ${fx.name}`;
  $('fxNote').textContent = lastingTag(fx.st) || 'until Next';
  $('fxPin').setAttribute('aria-pressed', String(fx.st.pinned));
  $('fxFreeze').setAttribute('aria-pressed', String(fx.st.frozen));
}
$('fxPin').addEventListener('click', () => {
  const fx = runningEffect(shown());
  if (fx) sendStage({ type: 'pin', group: who, on: !fx.st.pinned });
});
$('fxFreeze').addEventListener('click', () => {
  const fx = runningEffect(shown());
  if (fx) sendStage({ type: 'freeze', group: who, on: !fx.st.frozen });
});
// Stop: back to what the cue gives the group.
$('fxStop').addEventListener('click', () => {
  const s = shown();
  const back = lookById(s.look)?.entries?.[groupIndex(who)]?.preset;
  if (back) sendStage({ type: 'groupPreset', group: who, preset: back });
  else toast('The cue on stage gives this group nothing to go back to.');
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
// Its corners are the song's own square, else the show's (for songs without their own), else the picked group's
// first four colours (with All, the first colour group's). ✎ changes the corners, for this song or every song.

// ---- Colour temperature: the warm-to-cool strip's numbers ----
// The engine turns a white into a colour temperature by its blue-to-red ratio (kelvinOf in packages/engine/src/output.ts,
// with this table). The strip runs evenly in kelvin over the group's own range, and each spot sends the white the
// engine reads as exactly that temperature.

const KELVIN_BY_RATIO = [[0.2, 2000], [0.34, 2700], [0.45, 3200], [0.64, 4000], [0.87, 5600], [1.0, 6500], [1.27, 10000]];
/** The range the strip covers for a group: its CCT channels' range, else 2700–6500 K. */
const kelvinRangeOf = (g) => g?.kelvin ?? { min: 2700, max: 6500 };

/** The blue-to-red ratio of a white at `k` kelvin. */
function ratioOf(k) {
  const T = KELVIN_BY_RATIO;
  if (k <= T[0][1]) return T[0][0];
  for (let i = 1; i < T.length; i++) {
    if (k <= T[i][1]) return T[i - 1][0] + ((k - T[i - 1][1]) / (T[i][1] - T[i - 1][1])) * (T[i][0] - T[i - 1][0]);
  }
  // Past the table: carry on along its last step.
  const [r0, k0] = T[T.length - 2], [r1, k1] = T[T.length - 1];
  return r1 + ((k - k1) / (k1 - k0)) * (r1 - r0);
}

/** A white of `k` kelvin as #rrggbb: red and blue in its ratio (the brighter one full), green between them. */
function whiteOfKelvin(k) {
  const ratio = ratioOf(k);
  const r = ratio <= 1 ? 255 : 255 / ratio;
  const b = ratio <= 1 ? 255 * ratio : 255;
  return hex([r, Math.sqrt(r * b) * 0.97 + 6, b].map((x) => Math.min(255, x)));
}

/** The colour temperature the engine reads from a colour (kelvinOf), in kelvin. */
function kelvinOfHex(h) {
  const [r, , b] = rgb(h).map((x) => x / 255);
  const T = KELVIN_BY_RATIO;
  if (r <= 0) return T[T.length - 1][1];
  const ratio = b / r;
  if (ratio <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) {
    if (ratio <= T[i][0]) return T[i - 1][1] + ((ratio - T[i - 1][0]) / (T[i][0] - T[i - 1][0])) * (T[i][1] - T[i - 1][1]);
  }
  return T[T.length - 1][1];
}

/** Kelvin rounded for reading: to 50 K. */
const roundK = (k) => Math.round(k / 50) * 50;

/** The picked white-only group's colour temperature now (on the stage the page works on), or null. */
function kelvinNow() {
  const st = shown()?.groups?.[who];
  if (!st) return null;
  const colour = st.live?.colour ?? presetOf(who, st.preset)?.colour ?? null;
  return colour ? kelvinOfHex(colour) : null;
}

/** A white-only group is picked: the square is a warm-to-cool strip. */
const whiteMode = () => who !== 'all' && !!groupById(who)?.whiteOnly;
/** The groups a square tap colours: white-only groups are left out (they have their own strip). */
const colourTargets = () => (whiteMode() ? [who] : targets().filter((g) => !groupById(g)?.whiteOnly));

/** The song on the stage the page works on, as the layout gives it (with its `square`), or null. */
function squareSong() {
  const item = songOf(shown()).item;
  return item ? (layout?.runningOrder ?? []).find((l) => l.id === item.id) ?? null : null;
}

/** Where the corners come from now: 'song', 'show', or 'groups' (made from the picked group's colours). */
function cornerSource() {
  if (sqEdit.on) return 'edit';
  if (squareSong()?.square) return 'song';
  if (layout?.square) return 'show';
  return 'groups';
}

function corners() {
  if (sqEdit.on) return sqEdit.draft;
  const own = squareSong()?.square ?? layout?.square ?? null;
  if (own) return own.map((c) => ({ name: c.name, hex: c.colour.hex }));
  return groupCorners();
}

/** Four corners made from the picked group's first colours (with All, the first colour group's). */
function groupCorners() {
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

/** The square, the strip and their dot are dimmed alike, so the dot matches the spot under it and nothing lights the operator's face. */
const DIM = 'linear-gradient(rgba(12,13,17,.42),rgba(12,13,17,.42))';

/** The square as a small picture of the four corners mixed exactly as a tap mixes them (cached per set of corners). */
const squareImages = new Map();
function squareImage(c) {
  const key = c.map((p) => p.hex).join();
  let url = squareImages.get(key);
  if (url) return url;
  const W = 64, H = 32;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(W, H);
  const C = c.map((p) => rgb(p.hex));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1), v = y / (H - 1);
      const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
      const o = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = w[0] * C[0][k] + w[1] * C[1][k] + w[2] * C[2][k] + w[3] * C[3][k];
      img.data[o + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
  url = cv.toDataURL();
  squareImages.set(key, url);
  return url;
}

function renderSquare() {
  const sq = $('square');
  const white = whiteMode();
  sq.classList.toggle('white', white);
  $('sqEdit').hidden = white;
  if (white) {
    // A white-only group has the strip, not corners.
    if (sqEdit.on) endSquareEdit();
    sq.disabled = false;
    const range = kelvinRangeOf(groupById(who));
    const now = kelvinNow();
    $('squareFor').textContent = now !== null ? `warm to cool · now ${roundK(now)} K` : `warm to cool, tap for ${whoName()}`;
    // Evenly in kelvin, in the colours the lights make; dimmed, so the strip never lights the operator's face.
    const stops = [0, 0.2, 0.4, 0.6, 0.8, 1].map((u) => whiteOfKelvin(range.min + u * (range.max - range.min)));
    const bg = `${DIM},linear-gradient(90deg,${stops.join(',')})`;
    if (sq.dataset.bg !== bg) {
      sq.style.background = bg;
      sq.dataset.bg = bg;
    }
    $('cTL').textContent = 'Warm';
    $('cTR').textContent = 'Cool';
    // Ticks every 1000 K (every 500 K on a narrow range).
    const step = range.max - range.min > 3000 ? 1000 : 500;
    const ticks = [];
    for (let k = Math.ceil(range.min / step) * step; k <= range.max; k += step) {
      const u = (k - range.min) / (range.max - range.min);
      const edge = u < 0.04 ? ' class="edge-l"' : u > 0.96 ? ' class="edge-r"' : '';
      ticks.push(`<span${edge} style="left:${(u * 100).toFixed(2)}%">${k}</span>`);
    }
    setHtml($('ticks'), ticks.join(''));
    // The dot sits at the group's temperature now (or where it was last tapped, while that is on its way).
    if (now !== null && (!puck || puck.k === undefined || Math.abs(puck.k - now) < 60)) {
      puck = { u: Math.max(0, Math.min(1, (now - range.min) / (range.max - range.min))), v: 0.45, colour: whiteOfKelvin(now), k: now };
    }
    showPuck();
    return;
  }
  const c = corners();
  const editing = sqEdit.on;
  sq.classList.toggle('editing', editing);
  const ok = c.length === 4 && (editing || colourTargets().length > 0);
  sq.disabled = !ok;
  const song = squareSong();
  const whose = { song: `${song?.name ?? 'the song'}'s square`, show: "the show's square", groups: "the group's colours" }[cornerSource()] ?? '';
  $('squareFor').textContent = editing ? 'tap a corner to change it' : ok ? `${whose} · tap for ${whoName()}` : 'no colour lights here';
  renderSquareEdit();
  // Drawn from the same mix a tap sends, so every spot shows the colour the lights get there.
  const bg = ok ? `${DIM}, center / 100% 100% no-repeat url(${squareImage(c)})` : '#1a1730';
  if (sq.dataset.bg !== bg) {
    sq.style.background = bg;
    sq.dataset.bg = bg;
  }
  ['cTL', 'cTR', 'cBL', 'cBR'].forEach((id, i) => { $(id).textContent = ok ? c[i].name : ''; });
  showPuck();
}

/** A spot on the square in words: the corner colours it mixes, biggest first ("Zils 70 % · Rozā 30 %"); small shares left out. */
function mixLabel(c, u, v) {
  const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
  const by = new Map();
  c.forEach((p, i) => by.set(p.name, (by.get(p.name) ?? 0) + w[i]));
  const parts = [...by].filter(([, x]) => x >= 0.1).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const total = parts.reduce((s, [, x]) => s + x, 0) || 1;
  return parts.map(([name, x]) => `${name} ${Math.round((x / total) * 100)} %`).join(' · ');
}

/** The picked group's colour now (#rrggbb, on the stage the page works on), or null (All, or no plain colour). */
function colourNow() {
  if (who === 'all') return null;
  const st = shown()?.groups?.[who];
  if (!st || st.effect) return null;
  return st.live?.colour ?? presetOf(who, st.preset)?.colour ?? null;
}

/** The exact value field: kelvin for a white-only group, a colour code otherwise; it shows the value now unless typed in. */
function renderColourIn() {
  const input = $('colourIn');
  const white = whiteMode();
  $('colourUnit').textContent = white ? 'K' : '';
  input.inputMode = white ? 'numeric' : 'text';
  input.placeholder = white ? `${kelvinRangeOf(groupById(who)).min}` : '#rrggbb';
  if (document.activeElement === input) return;
  const now = white ? kelvinNow() : colourNow();
  input.value = now === null ? '' : white ? String(roundK(now)) : now;
  input.parentElement.classList.remove('bad');
}

/** Sends the typed value to the picked lights (with how long it lasts); a value it can't use is marked and kept. */
function sendColourIn() {
  const input = $('colourIn');
  const text = input.value.trim();
  let colour;
  if (whiteMode()) {
    const range = kelvinRangeOf(groupById(who));
    const k = Number(text.replace(/\s|k$/gi, ''));
    if (!Number.isFinite(k) || k <= 0) return input.parentElement.classList.add('bad');
    // The lights can't go past their own range: a value outside it is taken to the nearest end.
    const kk = Math.max(range.min, Math.min(range.max, k));
    if (kk !== k) toast(`These lights go from ${range.min} to ${range.max} K.`);
    colour = whiteOfKelvin(kk);
    puck = { u: (kk - range.min) / (range.max - range.min), v: 0.45, colour, k: kk };
  } else {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(text);
    if (!m) return input.parentElement.classList.add('bad');
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    colour = `#${h.toLowerCase()}`;
    puck = null;
  }
  input.parentElement.classList.remove('bad');
  const groups = colourTargets();
  if (!groups.length) return toast('Pick a group that has colour.');
  for (const g of groups) sendStage({ type: 'groupColour', group: g, colour, ...lastsNow() });
  input.blur();
  renderSquare();
}
$('colourIn').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') sendColourIn();
  if (ev.key === 'Escape') ev.currentTarget.blur();
});
$('colourIn').addEventListener('blur', () => setTimeout(renderColourIn, 0));
$('colourIn').addEventListener('input', () => $('colourIn').parentElement.classList.remove('bad'));

function showPuck() {
  renderColourIn();
  const k = $('puckK');
  // The value at the dot: kelvin on the warm-to-cool strip, the corner colours' mix on the square.
  const text = !puck ? '' : whiteMode() ? (puck.k !== undefined ? `${roundK(puck.k)} K` : '') : puck.label ?? '';
  k.hidden = !text;
  if (!k.hidden) {
    k.textContent = text;
    // Centred over the dot but kept inside the square; near the top it sits under the dot.
    const sq = $('square');
    const w = k.offsetWidth;
    const left = Math.max(6, Math.min(sq.clientWidth - w - 6, puck.u * sq.clientWidth - w / 2));
    k.style.left = `${left}px`;
    k.style.top = `${puck.v * 100}%`;
    k.style.transform = `translateY(${puck.v < 0.3 ? '20px' : '-38px'})`;
  }
  const p = $('puck');
  p.hidden = !puck;
  if (puck) {
    p.style.left = `${puck.u * 100}%`;
    p.style.top = `${puck.v * 100}%`;
    p.style.background = `${DIM}, ${puck.colour}`;
  }
}
$('square').addEventListener('click', (ev) => {
  const r = ev.currentTarget.getBoundingClientRect();
  const u = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  const v = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
  // Changing the corners: a tap picks the nearest corner and opens the colours for it.
  if (sqEdit.on) {
    openPalette((v < 0.5 ? 0 : 2) + (u < 0.5 ? 0 : 1));
    return;
  }
  let colour;
  if (whiteMode()) {
    // Warm (left) to cool (right), evenly in kelvin over the group's range.
    const range = kelvinRangeOf(groupById(who));
    const k = range.min + u * (range.max - range.min);
    colour = whiteOfKelvin(k);
    puck = { u, v: 0.45, colour, k };
  } else {
    const c = corners();
    if (c.length !== 4) return;
    colour = mix(c, u, v);
    puck = { u, v, colour, label: mixLabel(c, u, v) };
  }
  for (const g of colourTargets()) sendStage({ type: 'groupColour', group: g, colour, ...lastsNow() });
  renderSquare();
});

// ---- Changing the square's corners (✎) ----

/** Edit mode: a draft of the four corners, whose square it is ('song' or 'show'), and the corner being picked. */
const sqEdit = { on: false, draft: [], scope: 'song', picking: null };
const CORNER_NAMES = ['top left', 'top right', 'bottom left', 'bottom right'];

/** The show's named colours to pick from: every colour group's plain colours, once per name. */
function showColours() {
  const seen = new Map();
  for (const g of lightGroups()) {
    if (g.whiteOnly) continue;
    for (const p of g.presets) {
      if (p.effect || !p.colour || !p.canRecolour || seen.has(p.name)) continue;
      seen.set(p.name, { name: p.name, hex: p.colour });
    }
  }
  return [...seen.values()];
}

function startSquareEdit() {
  const c = corners();
  if (c.length !== 4) return toast('There are no colours to make a square from.');
  const song = squareSong();
  sqEdit.on = true;
  sqEdit.draft = c.map((x) => ({ ...x }));
  // A song with its own square edits that; otherwise the show's, unless there is a song to give one.
  sqEdit.scope = song?.square ? 'song' : layout.square || !song ? 'show' : 'song';
  sqEdit.picking = null;
  render();
}
function endSquareEdit() {
  sqEdit.on = false;
  sqEdit.picking = null;
  $('sqPalette').hidden = true;
  render();
}
$('sqEdit').addEventListener('click', () => (sqEdit.on ? endSquareEdit() : startSquareEdit()));
$('sqCancel').addEventListener('click', endSquareEdit);
$('sqScope').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-scope]');
  if (!b || b.disabled) return;
  sqEdit.scope = b.dataset.scope;
  render();
});
$('sqSave').addEventListener('click', () => {
  const song = squareSong();
  const item = sqEdit.scope === 'song' ? song?.id ?? null : null;
  if (sqEdit.scope === 'song' && !item) return toast('There is no song on stage to give the square to.');
  send({ type: 'colourSquare', item, corners: sqEdit.draft.map((c) => ({ name: c.name, colour: { hex: c.hex } })) });
  toast(item ? `Saved: ${song.name}'s square` : "Saved: the show's square, for songs without their own");
  endSquareEdit();
});
$('sqClear').addEventListener('click', () => {
  const song = squareSong();
  if (!song?.square) return;
  send({ type: 'colourSquare', item: song.id, corners: null });
  toast(`${song.name} uses the show's square again`);
  endSquareEdit();
});

function renderSquareEdit() {
  $('sqEdit').setAttribute('aria-pressed', String(sqEdit.on));
  $('sqEditBar').hidden = !sqEdit.on;
  if (!sqEdit.on) return;
  const song = squareSong();
  $('sqSong').disabled = !song;
  $('sqSong').textContent = song ? song.name : 'This song';
  $('sqSong').title = song ? `Only ${song.name} gets this square` : '';
  for (const b of $('sqScope').querySelectorAll('button')) b.classList.toggle('on', b.dataset.scope === sqEdit.scope);
  $('sqClear').hidden = !(sqEdit.scope === 'song' && song?.square);
  ['cTL', 'cTR', 'cBL', 'cBR'].forEach((id, i) => $(id).classList.toggle('picking', sqEdit.picking === i));
}

function openPalette(corner) {
  sqEdit.picking = corner;
  $('sqPalTitle').textContent = `Colour for the ${CORNER_NAMES[corner]} corner`;
  const now = sqEdit.draft[corner];
  $('sqColours').innerHTML = showColours().map((c) =>
    `<button type="button" data-name="${esc(c.name)}" data-hex="${esc(c.hex)}" class="${now && now.name === c.name ? 'on' : ''}"><i style="background:${esc(c.hex)}"></i>${esc(c.name)}</button>`).join('');
  $('sqPalette').hidden = false;
  renderSquare();
}
$('sqColours').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-hex]');
  if (!b || sqEdit.picking === null) return;
  sqEdit.draft[sqEdit.picking] = { name: b.dataset.name, hex: b.dataset.hex };
  sqEdit.picking = null;
  $('sqPalette').hidden = true;
  renderSquare();
});
$('sqPalClose').addEventListener('click', () => {
  sqEdit.picking = null;
  $('sqPalette').hidden = true;
  renderSquare();
});

// ---- Bottom: the song, its steps, Next (in Prepare: Back to live and Go) and Blackout ----

function renderBottom() {
  const s = shown();
  const { order, k, item, sections, sec } = songOf(s);
  // In Prepare the step on the real stage is marked too.
  const live = prep.on ? songOf(state) : null;
  const tag = (here, onStage) => (prep.on && here ? '<small>preparing</small>' : onStage ? '<small>on stage</small>' : '');
  let html;
  if (item && sections.length) {
    $('songOf').textContent = `Song · ${k + 1} of ${order.length}`;
    html = sections.map((x, i) => {
      const onStage = !!live && live.item?.id === item.id && live.sec === i && i !== sec;
      const cls = i === sec ? ' here' + (prep.on ? ' stack' : '') : onStage ? ' live-here' : i < sec ? ' done' : '';
      return `<button type="button" class="btn${cls}" data-section="${esc(x.kind)}"><span>${esc(x.name)}</span>${tag(i === sec, onStage)}</button>`;
    }).join('');
  } else {
    // No sections (no planned service loaded): the running order itself is the steps.
    $('songOf').textContent = order.length ? `Item · ${k + 1} of ${order.length}` : 'Running order';
    html = order.map((x, n) => {
      const onStage = !!live && live.k === n && n !== k;
      const cls = n === k ? ' here' + (prep.on ? ' stack' : '') : onStage ? ' live-here' : n < k ? ' done' : '';
      return `<button type="button" class="btn${cls}" data-item="${esc(x.id)}"><span>${esc(x.name)}</span>${tag(n === k, onStage)}</button>`;
    }).join('');
  }
  $('songName').textContent = item?.name ?? '—';
  const steps = $('steps');
  const before = steps.dataset.html;
  setHtml(steps, html);
  if (steps.dataset.html !== before) steps.querySelector('.here')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  // Live: Next. Prepare: Back to live and Go, which says what it will change on the stage.
  $('next').hidden = prep.on;
  $('backLive').hidden = !prep.on;
  $('goBtn').hidden = !prep.on;
  if (prep.on) {
    $('goName').textContent = prep.state ? stepName(prep.state) : '…';
    $('goWhat').textContent = prep.state ? whatGoChanges() : 'Getting the draft ready';
    $('goBtn').disabled = !prep.state || prep.goRef !== null;
  } else {
    const next = nextStep();
    $('nextName').textContent = next ? next.name : 'End of list';
    $('nextWhat').textContent = next ? whatChanges(next.look) : '';
    $('next').disabled = !next;
  }
  $('blackout').classList.toggle('on', state.look === 'blackout');
}
$('steps').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  const { item } = songOf(shown());
  // Not wrapped for the draft: while this tablet has one, the server puts the section into it.
  if (b.dataset.section && item) send({ type: 'section', song: item.id, kind: b.dataset.section });
  else if (b.dataset.item) {
    const i = (layout.runningOrder ?? []).find((x) => x.id === b.dataset.item);
    if (i) sendStage(isBasic(i) ? { type: 'safe' } : { type: 'look', id: i.id });
  }
});
$('next').addEventListener('click', () => {
  const next = nextStep();
  if (next) send(next.cmd);
});

/** A button that does its thing after a 1 s hold (Blackout, Save), so a stray tap never does it. */
function holdButton(button, done) {
  let timer = 0;
  button.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    button.classList.add('holding');
    const session = prep.session;
    timer = setTimeout(() => {
      button.classList.remove('holding');
      done(session);
    }, 1000);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    button.addEventListener(type, () => {
      clearTimeout(timer);
      button.classList.remove('holding');
    });
  }
}
holdButton($('blackout'), () => send({ type: 'blackout' }));

// ---- Prepare ----

/**
 * Turns Prepare on (a fresh draft of the stage now) or off (the draft is thrown away).
 * `tell` false: the server has already ended it (after Go, a refused start, a lost connection).
 */
function setPrepare(on, tell = true) {
  if (on === prep.on) return;
  if (on) {
    if (!layout) return;
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
  prep.on = on;
  prep.locked = false;
  prep.session++;
  prep.state = null;
  prep.visual = null;
  prep.goRef = null;
  prep.saveRef = null;
  puck = null;
  document.body.classList.toggle('prepare', on);
  drawStage();
  render();
}

// The Prepare button: a short hold peeks (off again on letting go); about 1 s keeps it on; a tap turns it off.
const prepBtn = $('prepBtn');
let lockTimer = 0;
let turnOff = false;
prepBtn.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  try {
    prepBtn.setPointerCapture(ev.pointerId); // letting go off the button still counts
  } catch {
    // no capture here: fine
  }
  if (prep.on) {
    turnOff = true;
    return;
  }
  turnOff = false;
  setPrepare(true);
  if (!prep.on) return;
  prepBtn.classList.add('holding');
  const session = prep.session;
  lockTimer = setTimeout(() => {
    prepBtn.classList.remove('holding');
    if (prep.on && prep.session === session) {
      prep.locked = true;
      render();
    }
  }, 1000);
});
const prepUp = () => {
  clearTimeout(lockTimer);
  prepBtn.classList.remove('holding');
  if (!prep.on) return;
  // A tap while it is kept on, or letting go of a peek, turns it off.
  if (turnOff || !prep.locked) setPrepare(false);
  turnOff = false;
};
prepBtn.addEventListener('pointerup', prepUp);
prepBtn.addEventListener('pointercancel', prepUp);
$('liveBtn').addEventListener('click', () => setPrepare(false));
$('backLive').addEventListener('click', () => setPrepare(false));

// Go: the whole draft fades onto the lights in one change (with the Fade setting); Live again when the server says yes.
$('goBtn').addEventListener('click', () => {
  if (!prep.on || !prep.state || prep.goRef !== null) return;
  prep.goRef = send({ type: 'blindGo' });
  render();
});

// Save: keeps the draft in the step being prepared (into the section's own look while a section is prepared).
holdButton($('saveBtn'), (session) => {
  if (!prep.on || prep.session !== session || !prep.state) return;
  const { item } = songOf(prep.state);
  if (!item) return;
  prep.saveName = stepName(prep.state);
  prep.saveRef = send({ type: 'saveItem', id: item.id });
});

// ---- Faders: Master and one per group; a group's arrow opens a fader per light ----
// A drag moves the level from where the finger lands, so touching a fader never makes the lights jump. Master always
// goes to the real stage; a group's level goes where the page works (the draft in Prepare). A single light is held by
// manual control until let go, live only, and only when Settings lets operators use single lights.

/** Open or not, and the group whose single lights show (null: all the groups). */
const faders = { open: false, group: null };
/** Levels being dragged, by fader key, so the state coming back mid-drag doesn't pull the fader. */
const dragging = new Map();

function openFaders(open, group = null) {
  faders.open = open;
  faders.group = open ? group : null;
  $('faders').hidden = !open;
  $('fadersBtn').setAttribute('aria-expanded', String(open));
  $('fadersBtn').classList.toggle('on', open);
  renderFaders();
}
$('fadersBtn').addEventListener('click', () => openFaders(!faders.open));
$('masterBtn').addEventListener('click', () => openFaders(!faders.open));
$('fClose').addEventListener('click', () => openFaders(false));
$('fBack').addEventListener('click', () => openFaders(true));
// A tap anywhere else closes them.
document.addEventListener('pointerdown', (ev) => {
  if (!faders.open || !(ev.target instanceof Element)) return;
  if (ev.target.closest('#faders, #fadersBtn, #masterBtn')) return;
  openFaders(false);
}, true);

const pct = (v) => `${Math.round(v * 100)} %`;
const fixtureById = (id) => (layout?.fixtures ?? []).find((f) => f.id === id);
/** A light's hold as a whole fixture (HeldLight with no segment), or null. */
const heldOf = (fixture) => (state?.held ?? []).find((h) => h.fixture === fixture && h.segment === null) ?? null;
const singleLightsOk = () => !!layout?.manualForOperators;

/** The faders to show: { key, kind, id, name, title?, value, dot?, held?, open? }. */
function faderList() {
  const s = shown();
  if (faders.group) {
    const g = groupById(faders.group);
    const level = s.groups?.[faders.group]?.level ?? 0;
    return (layout.members?.[faders.group] ?? []).map((id) => {
      const h = heldOf(id);
      return { key: `light:${id}`, kind: 'light', id, name: fixtureById(id)?.name ?? id, value: h ? h.level : level, held: !!h, dot: h ? h.colour : groupColour(g.id, s) };
    });
  }
  const list = [{ key: 'master', kind: 'master', id: 'master', name: 'Master', value: state.master }];
  for (const g of lightGroups()) {
    const members = layout.members?.[g.id] ?? [];
    list.push({ key: `group:${g.id}`, kind: 'group', id: g.id, name: shortName(g.name), title: g.name, value: s.groups?.[g.id]?.level ?? 0, dot: groupColour(g.id, s), open: members.length > 1 });
  }
  return list;
}

function renderFaders() {
  if (!faders.open || !layout || !state) return;
  const g = faders.group ? groupById(faders.group) : null;
  if (faders.group && !g) return openFaders(true);
  $('fBack').hidden = !g;
  $('fTitle').textContent = g ? g.name : 'Faders';
  const heldHere = g ? (layout.members?.[g.id] ?? []).filter((id) => heldOf(id)) : [];
  $('fRelease').hidden = !heldHere.length || prep.on;
  $('fRelease').textContent = `Let go of all · ${heldHere.length}`;
  $('fSub').textContent = g
    ? (prep.on ? 'Single lights work live only' : 'A light you move leaves its group until you let go')
    : prep.on ? 'Groups change the draft; Master is live' : '';
  // While a finger is on a fader only its fill and number move, so the element under the finger stays.
  if (dragging.size) {
    for (const el of $('faderRow').querySelectorAll('.fader')) {
      const v = dragging.get(el.dataset.key);
      if (v === undefined) continue;
      el.querySelector('.f-fill').style.height = `${(v * 100).toFixed(1)}%`;
      el.querySelector('.f-val').textContent = pct(v);
    }
    return;
  }
  const lightsOff = !!g && prep.on;
  const html = faderList().map((f) => {
    const v = f.value;
    const cls = `fader${f.kind === 'master' ? ' master' : ''}${f.held ? ' held' : ''}${f.kind === 'light' && lightsOff ? ' off' : ''}`;
    const dot = f.dot ? `<span class="dot" style="background:${esc(f.dot)}"></span>` : '';
    const name = f.title ?? f.name;
    const open = f.kind === 'group'
      ? `<button type="button" class="btn f-open" data-open="${esc(f.id)}"${f.open && singleLightsOk() ? '' : ' disabled'} title="${singleLightsOk() ? 'Single lights' : 'Single lights are switched off in Settings'}" aria-label="Single lights of ${esc(name)}">Lights ›</button>`
      : '';
    return `<div class="${cls}" data-key="${esc(f.key)}"><span class="f-name" title="${esc(name)}">${dot}${esc(f.name)}</span>` +
      `<div class="f-track" role="slider" aria-label="${esc(name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v * 100)}" data-kind="${f.kind}" data-id="${esc(f.id)}"><div class="f-fill" style="height:${(v * 100).toFixed(1)}%"></div></div>` +
      `<span class="f-val">${f.held ? 'held · ' : ''}${pct(v)}</span>${open}</div>`;
  }).join('');
  setHtml($('faderRow'), html);
}

$('faderRow').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-open]');
  if (b && !b.disabled) openFaders(true, b.dataset.open);
});
$('fRelease').addEventListener('click', () => {
  const ids = (layout.members?.[faders.group] ?? []).filter((id) => heldOf(id));
  if (ids.length) send({ type: 'release', targets: ids.map((fixture) => ({ fixture })), releaseSegments: true });
});

/** Sends a fader's level: Master live, a group to the stage the page works on, a light as a live manual hold. */
function sendLevel(kind, id, value, session) {
  if (kind === 'master') send({ type: 'master', value });
  else if (kind === 'group') {
    if (prep.session === session) sendStage({ type: 'groupLevel', group: id, value });
  } else if (!prep.on) send({ type: 'manual', target: { fixture: id }, intensity: value });
}

$('faderRow').addEventListener('pointerdown', (ev) => {
  const track = ev.target.closest('.f-track');
  if (!track) return;
  const { kind, id } = track.dataset;
  if (kind === 'light' && prep.on) return;
  ev.preventDefault();
  const key = track.closest('.fader').dataset.key;
  const f = faderList().find((x) => x.key === key);
  if (!f) return;
  try { track.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
  track.classList.add('dragging');
  const session = prep.session;
  const startY = ev.clientY;
  const startV = f.value;
  const height = track.getBoundingClientRect().height || 1;
  let last = 0, pending = null, timer = 0;
  dragging.set(key, startV);
  const flush = () => {
    timer = 0;
    if (pending === null) return;
    sendLevel(kind, id, pending, session);
    last = performance.now();
    pending = null;
  };
  const move = (e) => {
    const v = Math.max(0, Math.min(1, startV + (startY - e.clientY) / height));
    dragging.set(key, v);
    renderFaders();
    pending = Math.round(v * 1000) / 1000;
    // At most 20 sends a second; the engine smooths in between.
    const wait = 50 - (performance.now() - last);
    if (wait <= 0) flush();
    else if (!timer) timer = setTimeout(flush, wait);
  };
  const up = () => {
    track.removeEventListener('pointermove', move);
    track.removeEventListener('pointerup', up);
    track.removeEventListener('pointercancel', up);
    clearTimeout(timer);
    flush();
    track.classList.remove('dragging');
    // Keep showing the dragged value until the state has had a moment to catch up.
    setTimeout(() => {
      dragging.delete(key);
      $('faderRow').dataset.html = '';
      renderFaders();
    }, 300);
  };
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', up);
  track.addEventListener('pointercancel', up);
});

// ---- The song list: the service's order to jump anywhere, opened from the song button ----
// Tapping a song shows its parts (from the planned service) and a Start button, so a stray tap never changes the stage.
// Starting goes where the page works: the stage, or this tablet's draft in Prepare.

/** Open or not, and the running-order item picked in the list. */
const songs = { open: false, pick: null };

function openSongs(open) {
  songs.open = open;
  $('songs').hidden = !open;
  $('songBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    openFaders(false);
    songs.pick = songOf(shown()).item?.id ?? (layout?.runningOrder ?? [])[0]?.id ?? null;
  }
  renderSongs();
  if (open) $('songList').querySelector('.picked')?.scrollIntoView({ block: 'center' });
}
$('songBtn').addEventListener('click', () => openSongs(!songs.open));
$('sClose').addEventListener('click', () => openSongs(false));
document.addEventListener('pointerdown', (ev) => {
  if (!songs.open || !(ev.target instanceof Element)) return;
  if (ev.target.closest('#songs, #songBtn')) return;
  openSongs(false);
}, true);

/** The rows to list: the service's rows when a service is loaded, else the running order. */
function songRows() {
  const order = layout?.runningOrder ?? [];
  const rows = layout?.rows?.length ? layout.rows : order.map((l) => ({ kind: 'look', look: l.id, header: false }));
  return rows;
}

function renderSongs() {
  if (!songs.open || !layout || !state) return;
  const order = layout.runningOrder ?? [];
  const liveK = songOf(state).k;
  const prepK = prep.on && prep.state ? songOf(prep.state).k : -1;
  const next = nextStep();
  const nextId = next?.cmd.type === 'look' ? next.cmd.id : next?.cmd.type === 'safe' ? layout.basicLights : null;
  const svc = layout.service;
  $('sSub').textContent = svc ? [svc.title, svc.start, svc.place].filter(Boolean).join(' · ') : 'The running order';
  const html = songRows().map((r) => {
    if (r.kind === 'header') return `<div class="s-head caps">${esc(r.name)}</div>`;
    if (r.kind === 'verses') return `<div class="s-row s-other"><span>${esc(r.names.join(', '))}</span><small>no lights of its own</small></div>`;
    if (r.kind === 'item') return `<div class="s-row s-other"><span>${esc(r.name)}</span><small>${r.look ? 'again' : 'no lights of its own'}</small></div>`;
    const k = order.findIndex((l) => l.id === r.look);
    const item = order[k];
    if (!item) return '';
    if (r.header) return `<button type="button" class="s-head caps s-headbtn${songs.pick === item.id ? ' picked' : ''}" data-pick="${esc(item.id)}">${esc(item.name)}</button>`;
    const tag = k === prepK && prep.on ? '<small class="prep">preparing</small>'
      : k === liveK ? '<small class="here">on stage</small>'
      : item.id === nextId && !prep.on ? '<small>next</small>'
      : k < liveK ? '<small>done</small>' : '';
    const cls = `s-row s-song${songs.pick === item.id ? ' picked' : ''}${k < liveK && k !== prepK ? ' done' : ''}`;
    return `<button type="button" class="${cls}" data-pick="${esc(item.id)}"><span class="s-sw" style="${esc(lookFill(item))}"></span><span>${esc(item.name)}</span>${tag}</button>`;
  }).join('');
  setHtml($('songList'), html);

  // The picked song: what the planned service says about it, its parts, and Start.
  const item = order.find((l) => l.id === songs.pick) ?? null;
  const song = item ? layout.songs?.[item.id] : null;
  $('sName').textContent = item?.name ?? '—';
  const facts = song ? [song.key && `Key ${song.key}`, song.tempo && `${song.tempo} bpm`, song.timeSignature, song.artist].filter(Boolean) : [];
  $('sFacts').textContent = facts.join(' · ');
  const s = shown();
  const onThis = item && songOf(s).item?.id === item.id ? songOf(s).sec : -2;
  const parts = song?.sections ?? [];
  setHtml($('sParts'), parts.length
    ? parts.map((x, i) => `<button type="button" class="btn${i === onThis ? ' here' : ''}" data-part="${esc(x.kind)}">${esc(x.name)}${x.look ? '' : '<small>song\'s look</small>'}</button>`).join('')
    : '<span class="sub">No parts: the song has one look.</span>');
  $('sStart').hidden = !item;
  $('sStart').textContent = item ? `${prep.on ? 'Prepare' : 'Start'} ${item.name}` : '';
}

$('songList').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-pick]');
  if (!b) return;
  songs.pick = b.dataset.pick;
  renderSongs();
});
$('sParts').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-part]');
  if (!b || !songs.pick) return;
  // Not wrapped for the draft: while this tablet has one, the server puts the section into it.
  send({ type: 'section', song: songs.pick, kind: b.dataset.part });
  openSongs(false);
});
$('sStart').addEventListener('click', () => {
  const item = (layout?.runningOrder ?? []).find((l) => l.id === songs.pick);
  if (!item) return;
  sendStage(isBasic(item) ? { type: 'safe' } : { type: 'look', id: item.id });
  openSongs(false);
});

// ---- Top bar: Fade steps through the choices; Tap sets the tempo from the last few taps ----

// The Fade and Tempo menus open under their button; a tap anywhere else closes them. Fade and Tempo always change the
// real stage (Prepare too), as on today's operator page.
const FADES = [[null, 'Auto', "each look's own"], [0, 'Instant'], [1, '1 s'], [2, '2 s'], [3, '3 s'], [5, '5 s'], [10, '10 s']];
let menuOpen = null;
function openMenu(id, button) {
  closeMenu();
  const menu = $(id);
  menu.hidden = false;
  const r = button.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  menu.style.top = `${r.bottom + 8}px`;
  button.classList.add('open');
  menuOpen = { menu, button };
}
function closeMenu() {
  if (!menuOpen) return;
  menuOpen.menu.hidden = true;
  menuOpen.button.classList.remove('open');
  menuOpen = null;
}
document.addEventListener('pointerdown', (ev) => {
  if (!menuOpen || !(ev.target instanceof Element)) return;
  if (menuOpen.menu.contains(ev.target) || menuOpen.button.contains(ev.target)) return;
  closeMenu();
}, true);

function renderFadeMenu() {
  const now = state?.fadeTime ?? null;
  setHtml($('fadeChoices'), FADES.map(([v, label, note]) =>
    `<button type="button" role="menuitemradio" aria-checked="${v === now}" class="${v === now ? 'on' : ''}" data-fade="${v === null ? 'auto' : v}">${label}${note ? `<small>${note}</small>` : ''}</button>`).join(''));
}
$('fadeBtn').addEventListener('click', () => {
  if (menuOpen?.menu === $('fadeMenu')) return closeMenu();
  renderFadeMenu();
  openMenu('fadeMenu', $('fadeBtn'));
});
$('fadeChoices').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-fade]');
  if (!b) return;
  send({ type: 'fadeTime', value: b.dataset.fade === 'auto' ? null : Number(b.dataset.fade) });
  closeMenu();
});

const clampBpm = (v) => Math.max(40, Math.min(240, Math.round(v)));
$('tempoBtn').addEventListener('click', () => {
  if (menuOpen?.menu === $('tempoMenu')) return closeMenu();
  $('tempoField').value = String(Math.round(state?.tempo ?? 120));
  openMenu('tempoMenu', $('tempoBtn'));
});
$('tempoMenu').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-step]');
  if (!b || !state) return;
  const now = state.tempo;
  const step = b.dataset.step;
  const bpm = clampBpm(step === 'half' ? now / 2 : step === 'double' ? now * 2 : now + Number(step));
  if ((step === 'half' && now / 2 < 40) || (step === 'double' && now * 2 > 240)) toast('The tempo goes from 40 to 240 bpm.');
  send({ type: 'tempo', bpm });
  $('tempoField').value = String(bpm);
});
$('tempoField').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const v = Number($('tempoField').value);
  if (!Number.isFinite(v) || v <= 0) return toast('Type the tempo in beats per minute, 40 to 240.');
  send({ type: 'tempo', bpm: clampBpm(v) });
  closeMenu();
});
let taps = [];
$('tapBtn').addEventListener('click', () => {
  const now = performance.now();
  taps = taps.filter((t) => now - t < 2000).concat(now).slice(-6);
  if (taps.length < 3) return;
  const bpm = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
  send({ type: 'tempo', bpm: Math.max(40, Math.min(240, bpm)) });
});

// ---- The stage, as the audience sees it (light beams from each fixture); the draft while preparing ----

const NO_VISUAL = new Uint8Array(0);
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
  const s = shown();
  drawStagePicture(ctx, w, h, layout, prep.on ? prep.visual ?? NO_VISUAL : visual, (g) => s?.groups?.[g]?.level ?? 0, { view: 'front' });
  const off = !prep.on && state?.look === 'blackout';
  ctx.font = "600 10px 'Inter Tight', Inter, system-ui, sans-serif";
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.9px';
  ctx.fillStyle = prep.on ? '#b9a6ff' : off ? '#ff9a9a' : '#8a8f9c';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(prep.on ? 'DRAFT · NOT ON STAGE' : off ? 'OFF' : 'LIVE', w - 10, h - 8);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}
new ResizeObserver(() => drawStage()).observe(canvas);

connect();
