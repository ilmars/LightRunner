// Timeline page for the programmer: the show's timelines, a recording with its waveform, markers, and playback.
// The browser that presses Start plays the sound; it tells the server where the recording is about 4 times a second
// and the server runs the lights in step (or, in Prepare, this page's own draft on the stage view only).
// The page edits its copy of the show's timelines and saves one timeline at a time (PUT /api/timeline) after a pause.

import { NOT_ANSWERING, request, showProblem, startClock } from '/shared/appbar.js';
import { LOUDNESS_RATE, decodeBytes, encodeBytes, loudnessTrack, peaksTrack } from '/shared/loudness.js';
import { drawStagePicture } from '/shared/stagedraw.js';
import {
  MAX_ZOOM, barsFor, blockSpans, fitZoom, followScroll, formatLength, formatTime, markerRows, mixToMono, newTimeline,
  nextMarkerText, normalisePeaks, rulerTicks, timeToX, viewLength, xToTime, zoomed,
} from './model.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** The Whole stage layer's id (STAGE_LAYER in the show's schema). */
const STAGE = '*';
/** The biggest recording the Mac keeps (the server says the same). */
const MAX_BYTES = 100 * 1024 * 1024;
const AUDIO_FILE = /\.(mp3|m4a|aac|wav)$/i;
/** An edit is saved after this long without another. */
const SAVE_DELAY = 600;
/** How often the page that plays tells the server where the recording is (ms). */
const REPORT_EVERY = 250;

// ---- What the page knows ----

/** The show's groups, looks and colours (names for the layers and blocks). */
let show = { groups: [], looks: [], presets: [] };
/** The show's timelines, as this page edits them. */
let timelines = [];
/** The ids of the recordings the Mac has. */
let onMac = new Set();
/** The timeline open on the page. */
let openId = null;
/** The operator layout (the stage view's fixtures, the colours' swatches) and the live state, from the WebSocket. */
let layout = null;
let layoutSign = '';
let liveState = null;
let liveAt = 0;
let visual = new Uint8Array(0);
let socket = null;
let connected = false;
let ref = 0;

/**
 * Prepare: the server keeps a draft of the stage for this page; a Start then runs the timeline in it.
 * `startRef` is the ref of the blindStart that began it, until the server answers.
 */
const prep = { on: false, startRef: null, state: null, visual: null };

/**
 * What this page plays: the timeline it pressed Start on (`id`), in Prepare or Live. Only then does it report the
 * recording's position (an idle page never does: it would take over the live timeline). `confirmed` once the server
 * said yes; `audio` when the recording plays here (else the page counts the time itself from basePos at baseAt);
 * `ended` once the recording played out (the server goes on by itself to the timeline's end).
 */
let run = idleRun();
function idleRun() {
  return { id: null, prepare: false, startRef: null, confirmed: false, audio: false, ended: false, basePos: 0, baseAt: 0, length: 0 };
}

/** The play position when no recording can be asked (none, or missing on this Mac). */
let playPos = 0;
/** The waveform's zoom (pixels a second) and scroll (pixels from the start). */
let view = { pxPerSec: 10, scroll: 0 };
let fitted = true;
/** The open timeline's waveform and loudness, decoded (bytes 0..255), or null. */
let peaks = null;
let loudness = null;
/** The recording can't be played in this browser. */
let audioBroken = false;
/** A recording being added (the busy message shows). */
let adding = false;

const audio = $('audio');
const current = () => timelines.find((t) => t.id === openId) ?? null;
const usableAudio = (t = current()) => Boolean(t?.recording && onMac.has(t.recording.id) && !audioBroken && audio.getAttribute('src'));
/** How long the open timeline is: the recording, or its last block. */
function lengthOf(t) {
  if (!t) return 0;
  let end = t.recording?.duration ?? 0;
  for (const layer of t.layers) for (const b of layer.blocks) end = Math.max(end, b.end ?? b.start);
  return end;
}

// ---- Requests ----

async function call(method, path, body) {
  const res = await request(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') showLogin();
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// ---- Login ----

async function startPage() {
  const session = await call('GET', '/api/session');
  if (!session.loggedIn) return showLogin();
  $('logout').hidden = !session.pinSet;
  await load();
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
    $('logout').hidden = false;
    // The WebSocket learns it is the programmer's when it connects: a fresh one after the PIN.
    disconnect();
    await load();
  } catch (err) {
    $('loginError').textContent = err.message;
    $('pin').select();
  }
});

$('logout').addEventListener('click', async () => {
  if (run.id) stop();
  await call('POST', '/api/logout').catch(() => {});
  disconnect();
  showLogin();
});

async function load() {
  const [full, list] = await Promise.all([call('GET', '/api/show'), call('GET', '/api/recordings')]);
  show = { groups: full.groups ?? [], looks: full.looks ?? [], presets: full.presets ?? [] };
  timelines = full.timelines ?? [];
  onMac = new Set(list.map((r) => r.id));
  $('main').hidden = false;
  const wanted = decodeURIComponent(location.hash.slice(1));
  open(timelines.some((t) => t.id === wanted) ? wanted : timelines[0]?.id ?? null);
  if (!socket) connect();
}

/** The show's groups, looks and colours again (Patch or an operator changed them); the timelines here stay as edited. */
let refreshTimer = 0;
function refreshShow() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const full = await call('GET', '/api/show');
      show = { groups: full.groups ?? [], looks: full.looks ?? [], presets: full.presets ?? [] };
      renderLanes();
    } catch {
      // the next change tries again
    }
  }, 400);
}

// ---- Connection: the live state, the stage view, Prepare and the timeline messages ----

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.onopen = () => {
    if (socket === ws) setConnected(true);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    setConnected(false);
    socket = null;
    if (!$('main').hidden) setTimeout(() => { if (!socket && !$('main').hidden) connect(); }, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    if (socket !== ws) return;
    if (ev.data instanceof ArrayBuffer) {
      visual = new Uint8Array(ev.data);
      if (!prep.on) drawStage();
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'layout') {
      // The layout comes again after every save; the show's names are read again only when they changed.
      const sign = JSON.stringify([msg.layout.groups, msg.layout.looks]);
      if (layout && sign !== layoutSign) refreshShow();
      layoutSign = sign;
      layout = msg.layout;
      renderLanes();
      drawStage();
    } else if (msg.type === 'state') {
      liveState = msg.state;
      liveAt = performance.now();
      showProblem($('status'), liveState);
      onLiveState();
    } else if (msg.type === 'draftState') {
      if (!prep.on) return;
      prep.state = msg.state;
      onDraftState();
    } else if (msg.type === 'draftVisual') {
      if (!prep.on) return;
      prep.visual = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
      drawStage();
    } else if (msg.type === 'draftEnded') {
      // The server met a problem in this page's draft and dropped it; the lights were not changed.
      if (!prep.on || prep.startRef !== null) return;
      setPrepare(false, false);
      toast(msg.reason, true);
    } else if (msg.type === 'result') {
      onResult(msg);
    }
  };
}

/** Closes the WebSocket for good (a new one is opened by load()). */
function disconnect() {
  const old = socket;
  socket = null;
  if (old) {
    setConnected(false);
    old.close();
  }
  // Closed on purpose (the PIN): not a lost connection.
  $('offline').hidden = true;
}

function setConnected(on) {
  connected = on;
  $('offline').hidden = on;
  if (!on) {
    showProblem($('status'), null);
    // The server dropped this page's draft with the connection, and its Prepare timeline with it.
    if (run.prepare) endRun('The connection was lost, so Prepare stopped. The real lights were not changed.');
    if (prep.on) setPrepare(false, false);
  }
  // A live timeline this page plays goes on by itself meanwhile; back on, the reports take it up again.
  renderTransport();
}

/** Sends a message; returns its ref, or null when not connected. */
function send(msg) {
  if (!connected) {
    toast('Not connected to Light Runner. Try again in a moment.', true);
    return null;
  }
  socket.send(JSON.stringify({ ...msg, ref: ++ref }));
  return ref;
}

function onResult(msg) {
  if (msg.ref !== null && msg.ref === prep.startRef) {
    prep.startRef = null;
    if (msg.error) {
      setPrepare(false, false);
      toast(msg.error, true);
    }
    return;
  }
  if (msg.ref !== null && msg.ref === run.startRef) {
    run.startRef = null;
    if (msg.error) {
      endRun(msg.error);
      return;
    }
    run.confirmed = true;
    report();
    renderTransport();
    return;
  }
  if (msg.error) toast(msg.error, true);
}

/** The live state: a live timeline this page played that stopped (Blackout, a song, Stop elsewhere, its end) ends here too. */
function onLiveState() {
  const tl = liveState?.timeline ?? null;
  if (run.id && !run.prepare && run.confirmed && tl?.id !== run.id) endRun(stoppedWords());
  renderList();
  renderTransport();
}

/** This page's draft: the same for its Prepare timeline. */
function onDraftState() {
  const tl = prep.state?.timeline ?? null;
  if (run.id && run.prepare && run.confirmed && tl?.id !== run.id) endRun(stoppedWords());
}

/** What to say when the server stopped what this page played: nothing when it came to its end. */
function stoppedWords() {
  if (run.ended || position() >= run.length - 0.5) return null;
  return run.prepare
    ? 'The Prepare timeline stopped.'
    : 'The timeline stopped: Stop, Blackout, Basic lights or a song on another page.';
}

// ---- Live / Prepare ----

function setPrepare(on, tell = true) {
  if (on === prep.on) return;
  // What this page plays stops: it was for the other mode.
  if (run.id) stop();
  if (on) {
    const r = send({ type: 'command', cmd: { type: 'blindStart' } });
    if (r === null) return;
    prep.startRef = r;
  } else {
    if (tell && connected) send({ type: 'command', cmd: { type: 'blindEnd' } });
    prep.startRef = null;
  }
  prep.on = on;
  prep.state = null;
  prep.visual = null;
  document.body.classList.toggle('prepare', on);
  $('liveBtn').setAttribute('aria-pressed', String(!on));
  $('prepBtn').setAttribute('aria-pressed', String(on));
  drawStage();
  renderTransport();
}
$('liveBtn').addEventListener('click', () => setPrepare(false));
$('prepBtn').addEventListener('click', () => setPrepare(true));

// ---- Playback ----

/** Where the open timeline is now: the recording's position, or the page's own count while it runs without one. */
function position() {
  const t = current();
  if (run.id && !run.audio) return Math.min(run.length, run.basePos + (performance.now() / 1000 - run.baseAt));
  if (usableAudio(t)) return audio.currentTime || 0;
  return playPos;
}

/** ▶ Start: the recording plays here from the play position, and the server runs the timeline with it. */
async function start() {
  const t = current();
  if (!t || run.id || adding) return;
  if (!connected) {
    toast('Not connected to Light Runner. Try again in a moment.', true);
    return;
  }
  const length = lengthOf(t);
  const withAudio = usableAudio(t);
  let at = position();
  if (at >= length - 0.05) at = 0;
  run = { ...idleRun(), id: t.id, prepare: prep.on, audio: withAudio, length, basePos: at, baseAt: performance.now() / 1000 };
  if (withAudio) {
    // Asked for at once, in the tap: Safari plays sound only when a tap starts it.
    audio.currentTime = at;
    audio.play().catch((err) => {
      if (run.id !== t.id || err?.name === 'AbortError') return;
      toast("This browser won't play the recording here. The lights carry on without it.", true);
    });
  }
  renderTransport();
  // The server runs what it has saved: any edit waiting is saved first.
  const saved = await flushSaves();
  if (run.id !== t.id) return;
  if (!saved) {
    endRun('The timeline could not be saved, so it did not start.');
    return;
  }
  const from = withAudio ? audio.currentTime : at;
  run.basePos = from;
  run.baseAt = performance.now() / 1000;
  run.startRef = send({ type: 'timelineStart', id: t.id, at: from, prepare: prep.on });
  if (run.startRef === null) endRun(null);
}

/** ■ Stop: the sound pauses and the timeline stops where it is (the stage stays as it is). */
function stop() {
  const t = current();
  if (run.id) {
    if (connected) socket.send(JSON.stringify({ type: 'timelineStop', id: run.id, prepare: run.prepare, ref: ++ref }));
    endRun(null);
  } else if (t && liveState?.timeline?.id === t.id) {
    // Running live from another page: Stop works from here too.
    send({ type: 'timelineStop', id: t.id });
  }
}

/** What this page played has ended (Stop, the server stopped it, a problem): the sound pauses, the page is idle. */
function endRun(message) {
  if (!run.id) return;
  const pos = position();
  const withAudio = run.audio;
  run = idleRun();
  if (withAudio) audio.pause();
  else playPos = pos;
  renderTransport();
  if (message) toast(message, true);
}

/** Tells the server where the recording is: only while this page plays a recording it started. */
function report() {
  if (!run.id || !run.confirmed || !run.audio || run.ended || !connected) return;
  socket.send(JSON.stringify({ type: 'timelinePosition', id: run.id, pos: audio.currentTime || 0, playing: !audio.paused }));
}
setInterval(report, REPORT_EVERY);
for (const e of ['play', 'pause', 'seeked']) audio.addEventListener(e, report);
audio.addEventListener('ended', () => {
  if (!run.id || !run.audio) return;
  // Played out: the server goes on by itself to the timeline's end (later blocks, the lights' offset).
  if (run.confirmed && connected) {
    socket.send(JSON.stringify({ type: 'timelinePosition', id: run.id, pos: audio.duration || run.length, playing: false }));
  }
  run.ended = true;
  renderTransport();
});
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  audioBroken = true;
  if (run.id && run.audio) {
    // The lights carry on with the page's own count.
    run.basePos = audio.currentTime || run.basePos;
    run.baseAt = performance.now() / 1000;
    run.audio = false;
  }
  toast("This browser can't play the recording. The timeline still runs, without sound.", true);
  renderTransport();
});

/** Moves the play position (a tap on the ruler or the waveform); while this page plays, the lights go there too. */
function seek(t) {
  const tl = current();
  if (!tl) return;
  t = Math.max(0, Math.min(viewLength(tl), t));
  if (usableAudio(tl)) {
    audio.currentTime = Math.min(t, tl.recording.duration);
    if (run.ended && t < tl.recording.duration - 0.1 && run.id) {
      // Back from the end while the lights still run: the sound plays on from there.
      run.ended = false;
      audio.play().catch(() => {});
    }
  }
  playPos = t;
  if (run.id && !run.audio) {
    run.basePos = Math.min(t, run.length);
    run.baseAt = performance.now() / 1000;
    if (run.confirmed && connected) socket.send(JSON.stringify({ type: 'timelinePosition', id: run.id, pos: run.basePos, playing: true }));
  }
  tick();
}

$('startBtn').addEventListener('click', () => void start());
$('stopBtn').addEventListener('click', stop);

// ---- The list of timelines ----

let listSign = '';
function renderList() {
  const list = $('list');
  const liveId = liveState?.timeline?.id ?? null;
  // The live state comes twice a second while a timeline runs: the list is only built again when it changed.
  const sign = JSON.stringify([openId, liveId, timelines.map((t) => [t.id, t.name, t.recording?.duration])]);
  if (sign === listSign) return;
  listSign = sign;
  list.replaceChildren(...timelines.map((t) => {
    const b = el('button', 'tl-item');
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.setAttribute('aria-current', String(t.id === openId));
    b.append(el('b', null, t.name || 'Untitled'));
    const sub = el('small', null, t.recording ? formatLength(t.recording.duration) : 'No recording');
    if (t.id === liveId) {
      sub.textContent += ' · ';
      sub.append(el('span', 'running', '● Running live'));
    }
    b.append(sub);
    b.addEventListener('click', () => open(t.id));
    return b;
  }));
  $('empty').hidden = timelines.length > 0;
}

/** Opens a timeline (null: none). What this page played stops. */
function open(id) {
  if (run.id && run.id !== id) stop();
  openId = id;
  const t = current();
  if (t) history.replaceState(null, '', `#${encodeURIComponent(t.id)}`);
  for (const part of ['transport', 'lanesCard', 'markersCard', 'stageCard', 'openTools']) $(part).hidden = !t;
  $('nameField').value = t?.name ?? '';
  // Its recording: the waveform and loudness kept with it, the sound from the Mac.
  peaks = t?.recording?.peaks ? decodeBytes(t.recording.peaks) : null;
  loudness = t?.recording?.loudness ? decodeBytes(t.recording.loudness) : null;
  audioBroken = false;
  const src = t?.recording && onMac.has(t.recording.id) ? `/api/recordings/file?id=${encodeURIComponent(t.recording.id)}` : '';
  if ((audio.getAttribute('src') ?? '') !== src) {
    audio.pause();
    if (src) audio.setAttribute('src', src);
    else audio.removeAttribute('src');
    audio.load();
  }
  playPos = 0;
  fitted = true;
  view = { pxPerSec: 10, scroll: 0 };
  renderList();
  renderTransport();
  renderLanes();
  renderMarkers();
  drawStage();
}

$('newBtn').addEventListener('click', async () => {
  const names = new Set(timelines.map((t) => t.name));
  let n = timelines.length + 1;
  while (names.has(`Timeline ${n}`)) n++;
  const t = newTimeline(`Timeline ${n}`, timelines.map((x) => x.id));
  try {
    await waitForSaves();
    await call('PUT', '/api/timeline', t);
  } catch (err) {
    toast(`The timeline was not added: ${err.message}`, true);
    return;
  }
  timelines.push(t);
  open(t.id);
  $('nameField').focus();
  $('nameField').select();
});

$('nameField').addEventListener('input', () => {
  const t = current();
  if (!t) return;
  t.name = $('nameField').value;
  $('tName').textContent = t.name || 'Untitled';
  renderList();
  scheduleSave(t.id);
});
$('nameField').addEventListener('change', () => {
  const t = current();
  if (t && !t.name.trim()) {
    t.name = 'Untitled';
    $('nameField').value = t.name;
    $('tName').textContent = t.name;
    renderList();
    scheduleSave(t.id);
  }
});

$('deleteBtn').addEventListener('click', async () => {
  const t = current();
  if (!t) return;
  const also = t.recording && !timelines.some((x) => x !== t && x.recording?.id === t.recording.id) ? ' Its recording is deleted from the Mac too.' : '';
  if (!confirm(`Delete the timeline "${t.name || 'Untitled'}"?${also}`)) return;
  if (run.id === t.id) stop();
  dirty.delete(t.id);
  try {
    await waitForSaves();
    await call('DELETE', `/api/timeline?id=${encodeURIComponent(t.id)}`);
  } catch (err) {
    toast(`The timeline was not deleted: ${err.message}`, true);
    return;
  }
  const at = timelines.indexOf(t);
  timelines = timelines.filter((x) => x !== t);
  if (also) await removeRecording(t.recording.id);
  open(timelines[Math.min(at, timelines.length - 1)]?.id ?? null);
  toast('Timeline deleted');
});

// ---- Saving: each edit is saved after a short pause, one timeline at a time ----

/** Timelines with edits not saved yet. */
const dirty = new Set();
let saveTimer = 0;
let retryTimer = 0;
let saving = null;

function scheduleSave(id) {
  dirty.add(id);
  setSaveNote('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSaves(), SAVE_DELAY);
}

async function waitForSaves() {
  while (saving) await saving;
}

/** Saves every edited timeline now. True when everything is saved. */
async function flushSaves() {
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  await waitForSaves();
  if (!dirty.size) return true;
  const ids = [...dirty];
  dirty.clear();
  let problem = null;
  saving = (async () => {
    for (const id of ids) {
      const t = timelines.find((x) => x.id === id);
      if (!t) continue;
      try {
        await call('PUT', '/api/timeline', t);
      } catch (err) {
        problem = err.message;
        dirty.add(id);
      }
    }
  })();
  await saving;
  saving = null;
  if (problem) {
    setSaveNote(`Not saved: ${problem}`, true);
    // Tried again by itself in a while (the server may be back).
    retryTimer = setTimeout(() => void flushSaves(), 5000);
    return false;
  }
  if (dirty.size) return flushSaves();
  setSaveNote('Saved');
  return true;
}

function setSaveNote(text, bad = false) {
  const note = $('saveNote');
  note.textContent = text;
  note.classList.toggle('bad', bad);
}

window.addEventListener('beforeunload', (e) => {
  if (dirty.size || saving) e.preventDefault();
});
// Leaving the page (or the iPad putting it away): what is waiting is sent at once.
window.addEventListener('pagehide', () => {
  for (const id of dirty) {
    const t = timelines.find((x) => x.id === id);
    if (t) fetch('/api/timeline', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t), keepalive: true }).catch(() => {});
  }
  dirty.clear();
});

// ---- The recording: decoded here, its loudness and waveform worked out once, the file kept on the Mac ----

$('addRec').addEventListener('click', () => {
  if (adding) return;
  $('recFile').value = '';
  $('recFile').click();
});
$('recFile').addEventListener('change', () => {
  const file = $('recFile').files?.[0];
  if (file) void addRecording(file);
});

function busy(text) {
  adding = text !== null;
  $('recBusy').hidden = !adding;
  $('recBusy').textContent = text ?? '';
  renderTransport();
}

async function addRecording(file) {
  const t = current();
  if (!t || adding) return;
  if (run.id) stop();
  const fail = (text) => {
    busy(null);
    toast(text, true);
  };
  if (!AUDIO_FILE.test(file.name) && !/^audio\//.test(file.type)) return fail('Light Runner plays mp3, m4a, aac or wav recordings.');
  if (file.size === 0) return fail('That file is empty.');
  if (file.size > MAX_BYTES) return fail('That recording is too big. Light Runner keeps recordings up to 100 MB.');

  // Read first: a file this browser can't read is never uploaded.
  busy('Reading the recording…');
  let decoded;
  try {
    decoded = await decodeFile(file);
  } catch {
    return fail("This browser can't read that file as sound. Use an mp3, m4a or wav file.");
  }
  if (!(decoded.duration > 0) || !decoded.length) return fail('That recording has no sound in it.');

  busy('Working out how loud it is…');
  await nextFrame();
  let track;
  try {
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, k) => decoded.getChannelData(k));
    const mono = mixToMono(channels);
    track = {
      loudness: encodeBytes(loudnessTrack(mono, decoded.sampleRate)),
      peaks: encodeBytes(normalisePeaks(peaksTrack(mono, barsFor(decoded.duration)))),
    };
  } catch {
    return fail('That recording is too long for this browser to work through. Try it on a laptop.');
  }

  busy('Uploading… 0 %');
  let up;
  try {
    up = await upload(file, (pct) => busy(`Uploading… ${pct} %`));
  } catch (err) {
    return fail(err.message);
  }
  // Deleted meanwhile: nothing to add it to.
  if (!timelines.includes(t)) {
    await removeRecording(up.id);
    return busy(null);
  }
  const before = t.recording;
  t.recording = { id: up.id, name: up.name, duration: Math.round(decoded.duration * 1000) / 1000, ...track };
  try {
    await waitForSaves();
    dirty.delete(t.id);
    await call('PUT', '/api/timeline', t);
  } catch (err) {
    // Nothing half-saved: the timeline keeps what it had, the file goes again.
    t.recording = before;
    await removeRecording(up.id);
    return fail(`The recording was not added: ${err.message}`);
  }
  onMac.add(up.id);
  // The recording it had before, when no timeline uses it any more.
  if (before && before.id !== up.id && !timelines.some((x) => x.recording?.id === before.id)) await removeRecording(before.id);
  busy(null);
  if (openId === t.id) open(t.id);
  else renderList();
  toast('Recording added');
}

/** Decodes an audio file with Web Audio (the promise form, or the callbacks older Safari has). */
async function decodeFile(file) {
  const data = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  } finally {
    try {
      await ctx.close();
    } catch {
      // already closed
    }
  }
}

/** Uploads the file as it is (streamed by the server into the data folder), with progress. */
function upload(file, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/recordings?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.floor((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status === 401) showLogin();
      if (xhr.status >= 200 && xhr.status < 300 && data.id) resolve(data);
      else reject(new Error(data.error || `The upload did not work (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error(NOT_ANSWERING));
    xhr.send(file);
  });
}

/** Deletes a recording file from the Mac; one another timeline still uses stays (the server says so). */
async function removeRecording(id) {
  try {
    await call('DELETE', `/api/recordings?id=${encodeURIComponent(id)}`);
    onMac.delete(id);
  } catch {
    // in use, or already gone
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---- The top bar of the open timeline ----

function renderTransport() {
  const t = current();
  if (!t) return;
  $('tName').textContent = t.name || 'Untitled';
  const rec = t.recording;
  const missing = rec && !onMac.has(rec.id);
  $('recChip').hidden = !rec;
  $('recChip').classList.toggle('missing', Boolean(missing));
  if (rec) $('recName').textContent = `${rec.name} · ${missing ? 'not on this Mac' : formatLength(rec.duration)}`;
  $('addRec').textContent = !rec ? 'Add the recording' : missing ? 'Add it again' : 'Change';
  $('addRec').classList.toggle('ds-btn--quiet', Boolean(rec) && !missing);
  $('addRec').disabled = adding;
  $('len').textContent = `/ ${formatLength(lengthOf(t))}`;
  const mine = run.id === t.id;
  $('startBtn').setAttribute('aria-pressed', String(mine));
  $('startBtn').disabled = adding || mine || !connected;
  const liveHere = liveState?.timeline?.id === t.id;
  $('stopBtn').disabled = !mine && !liveHere;
  renderRunNote();
}

function renderRunNote() {
  const t = current();
  const note = $('runNote');
  let text = '';
  const live = liveState?.timeline ?? null;
  if (run.id && run.prepare) text = run.ended ? 'Prepare: the recording has played; the stage view runs on to the end.' : 'Prepare: playing on the stage view only. The real lights stay as they are.';
  else if (run.id) text = run.ended ? 'Live: the recording has played; the lights run on to the end.' : run.audio ? 'Live: the lights follow this recording.' : 'Live: the lights run on Light Runner\'s clock.';
  else if (live && t && live.id === t.id) text = `Running live from another page · ${formatTime(livePos())}`;
  else if (live) text = `"${live.name}" is running live.`;
  else if (prep.on) text = 'Prepare: Start plays it on the stage view only.';
  if (note.textContent !== text) note.textContent = text;
  note.classList.toggle('prep', Boolean(run.id && run.prepare) || (!run.id && prep.on));
}

/** Where the live timeline is now, from the last live state. */
function livePos() {
  const tl = liveState?.timeline;
  if (!tl) return 0;
  return Math.min(tl.duration, tl.pos + (tl.playing ? (performance.now() - liveAt) / 1000 : 0));
}

// ---- The lanes: ruler, waveform, layers, markers, playhead ----

const lanes = $('lanes');
const track = $('track');
const ruler = $('ruler');
const wave = $('wave');
const playhead = $('playhead');

/** The layers shown: Whole stage, then one per group in the show's order, then any layer whose group is gone. */
function layerRows(t) {
  const rows = [{ group: STAGE, name: 'Whole stage', note: 'every group' }];
  for (const g of show.groups) rows.push({ group: g.id, name: g.name, note: g.kind === 'smoke' ? 'smoke' : `${g.fixtures.length} ${g.fixtures.length === 1 ? 'light' : 'lights'}` });
  for (const layer of t.layers) {
    if (layer.group !== STAGE && !show.groups.some((g) => g.id === layer.group)) rows.push({ group: layer.group, name: layer.group, note: 'group missing', missing: true });
  }
  return rows;
}

function renderLanes() {
  const t = current();
  if (!t) return;
  const length = viewLength(t);
  const width = lanes.clientWidth || 600;
  if (fitted) view = { pxPerSec: fitZoom(length, width), scroll: 0 };
  track.style.width = `${Math.max(width, length * view.pxPerSec)}px`;

  const labels = [el('div', 'spacer')];
  const recLabel = el('div', 'lane-label rec');
  recLabel.append(el('b', null, 'Recording'), el('small', null, t.recording ? t.recording.name : 'none yet'));
  labels.push(recLabel);
  const rows = [];
  for (const row of layerRows(t)) {
    const label = el('div', `lane-label${row.missing ? ' missing' : ''}`);
    label.append(el('b', null, row.name), el('small', null, row.note));
    labels.push(label);
    const lane = el('div', 'row-lane');
    const layer = t.layers.find((l) => l.group === row.group);
    for (const span of blockSpans(layer?.blocks ?? [], length)) lane.append(blockEl(row, span));
    rows.push(lane);
  }
  $('labels').replaceChildren(...labels);
  $('rows').replaceChildren(...rows);
  renderMarkerLines();
  lanes.scrollLeft = view.scroll;
  view.scroll = lanes.scrollLeft;
  drawCanvases();
  updateZoomButtons();
  tick();
}

/** A block, drawn (Task 6 makes them editable): its words, its colour mixed down, its rise as a dark fade at the front. */
function blockEl(row, span) {
  const { block } = span;
  const d = describeBlock(row.group, block);
  const b = el('div', `block${d.missing ? ' missing' : ''}`);
  b.style.left = `${span.start * view.pxPerSec}px`;
  b.style.width = `${Math.max(4, (span.end - span.start) * view.pxPerSec)}px`;
  if (d.colour && !d.missing) b.style.background = `color-mix(in srgb, ${d.colour} 26%, #141D30)`;
  if (block.rise > 0) {
    const ramp = el('div', 'ramp');
    ramp.style.width = `${Math.min(100, (block.rise / Math.max(0.1, span.end - span.start)) * 100)}%`;
    b.append(ramp);
  }
  const label = el('div', 'label', d.text);
  label.append(el('small', null, `${formatTime(block.start)}${block.rise ? ` · rise ${block.rise} s` : ''}`));
  b.append(label);
  b.title = d.text;
  return b;
}

function describeBlock(group, block) {
  const what = block.what;
  const pct = (v) => `${Math.round(v * 100)} %`;
  const preset = (id) => show.presets.find((p) => p.id === id);
  const swatch = (id) => {
    const g = layout?.groups?.find((x) => x.id === group);
    const p = g?.presets?.find((x) => x.id === id) ?? g?.hidden?.find((x) => x.id === id);
    return p?.swatch ?? preset(id)?.swatch ?? null;
  };
  switch (what.kind) {
    case 'dark': return { text: 'Dark', colour: '#05080f' };
    case 'full': return { text: 'Everything full', colour: '#E3A646' };
    case 'level': return { text: `Level ${pct(what.level)}` };
    case 'look': {
      const look = show.looks.find((l) => l.id === what.look);
      return look ? { text: look.name, colour: look.swatch ?? null } : { text: 'Look missing', missing: true };
    }
    case 'colour': {
      const p = preset(what.preset);
      return p ? { text: `${p.name} · ${pct(what.level)}`, colour: swatch(what.preset) } : { text: 'Colour missing', missing: true };
    }
    case 'effect': {
      const p = preset(what.preset);
      return p ? { text: `${p.name} (effect)`, colour: swatch(what.preset) } : { text: 'Effect missing', missing: true };
    }
    case 'follow': return { text: `Follow the voice · ${pct(what.low)}–${pct(what.high)}`, colour: '#B0A6F5' };
    default: return { text: 'Block' };
  }
}

/** The dashed marker lines across the lanes, each with its text (a tap goes to its row in Markers). */
function renderMarkerLines() {
  const t = current();
  if (!t) return;
  const rows = markerRows(t.markers, view.pxPerSec);
  $('markerLines').replaceChildren(...t.markers.map((m, i) => {
    const line = el('div', 'marker-line');
    line.style.left = `${m.t * view.pxPerSec}px`;
    const label = el('button', null, m.text || '◆');
    label.type = 'button';
    label.style.top = `${26 + rows[i] * 22}px`;
    label.title = `${formatTime(m.t)} ${m.text}`;
    label.addEventListener('click', () => {
      seek(m.t);
      const field = $('markerList').querySelector(`[data-marker="${i}"] input`);
      field?.focus({ preventScroll: true });
      field?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    line.append(label);
    return line;
  }));
}

/** The ruler and the waveform are drawn for what is in view; they stay in place while the lanes scroll. */
function sizeCanvas(c, w, h) {
  const dpr = window.devicePixelRatio || 1;
  c.style.width = `${w}px`;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

let colours = null;
function readColours() {
  const s = getComputedStyle(document.body);
  const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  colours = { muted: v('--ds-muted', '#97A4BA'), mark: v('--ds-mark', '#68758F'), edge: v('--ds-edge', 'rgba(148,163,184,.14)'), font: s.fontFamily };
}

function drawCanvases() {
  const t = current();
  if (!t) return;
  if (!colours) readColours();
  const w = lanes.clientWidth;
  const length = viewLength(t);

  const rc = sizeCanvas(ruler, w, 24);
  rc.font = `11px ${colours.font}`;
  rc.textBaseline = 'top';
  rc.fillStyle = colours.muted;
  rc.strokeStyle = colours.mark;
  rc.lineWidth = 1;
  for (const tick of rulerTicks(view, w, length)) {
    const x = Math.round(tick.x) + 0.5;
    rc.beginPath();
    rc.moveTo(x, 17);
    rc.lineTo(x, 24);
    rc.stroke();
    rc.fillText(tick.label, x + 3, 4);
  }

  const h = 70, mid = h / 2;
  const wc = sizeCanvas(wave, w, h);
  const rec = t.recording;
  if (!rec || !peaks?.length) {
    wc.font = `13px ${colours.font}`;
    wc.fillStyle = colours.muted;
    wc.textBaseline = 'middle';
    wc.fillText(rec ? 'No waveform' : 'No recording yet. Add the recording to see it here.', 12, mid);
    return;
  }
  const n = peaks.length, d = rec.duration;
  wc.fillStyle = '#4a5876';
  for (let x = 0; x < w; x += 2) {
    const t0 = (x + view.scroll) / view.pxPerSec;
    if (t0 >= d) break;
    const t1 = (x + 2 + view.scroll) / view.pxPerSec;
    const i0 = Math.floor((t0 / d) * n);
    const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((t1 / d) * n)));
    let top = 0;
    for (let i = i0; i < i1; i++) if (peaks[i] > top) top = peaks[i];
    const amp = (top / 255) * (mid - 4);
    wc.fillRect(x, mid - amp, 1.5, Math.max(1, amp * 2));
  }
  // The loudness Follow the voice uses: a faint violet line.
  if (loudness?.length) {
    wc.strokeStyle = 'rgba(176, 166, 245, 0.55)';
    wc.lineWidth = 1.5;
    wc.beginPath();
    let started = false;
    for (let x = 0; x < w; x += 2) {
      const tt = (x + view.scroll) / view.pxPerSec;
      if (tt >= d) break;
      const v = loudness[Math.min(loudness.length - 1, Math.floor(tt * LOUDNESS_RATE))] / 255;
      const y = h - 3 - v * (h - 8);
      if (started) wc.lineTo(x, y);
      else wc.moveTo(x, y);
      started = true;
    }
    wc.stroke();
  }
}

let drawQueued = false;
lanes.addEventListener('scroll', () => {
  view.scroll = lanes.scrollLeft;
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    drawCanvases();
  });
});
new ResizeObserver(() => {
  if (!current()) return;
  renderLanes();
  drawStage();
}).observe(lanes);

// The user moved the lanes by hand: the view stops following the playhead for a while.
let handScrollAt = 0;
for (const e of ['wheel', 'touchstart', 'pointerdown']) lanes.addEventListener(e, () => (handScrollAt = performance.now()), { passive: true });

// A tap on the waveform moves the play position; a drag scrolls (the browser's own).
wave.addEventListener('click', (ev) => {
  const t = current();
  if (!t) return;
  seek(xToTime(ev.clientX - lanes.getBoundingClientRect().left, view, viewLength(t)));
});

// The ruler: a tap moves the play position, a drag moves it along (it is set where the finger lets go).
let scrub = null;
const rulerTime = (ev) => xToTime(ev.clientX - lanes.getBoundingClientRect().left, view, viewLength(current()));
ruler.addEventListener('pointerdown', (ev) => {
  if (!current()) return;
  ruler.setPointerCapture(ev.pointerId);
  scrub = rulerTime(ev);
  tick();
});
ruler.addEventListener('pointermove', (ev) => {
  if (scrub === null) return;
  scrub = rulerTime(ev);
  tick();
});
ruler.addEventListener('pointerup', (ev) => {
  if (scrub === null) return;
  scrub = null;
  seek(rulerTime(ev));
});
ruler.addEventListener('pointercancel', () => {
  scrub = null;
  tick();
});

// ---- Zoom ----

function zoomBy(factor, anchorX) {
  const t = current();
  if (!t) return;
  const w = lanes.clientWidth;
  const length = viewLength(t);
  if (anchorX === undefined) {
    const x = timeToX(position(), view);
    anchorX = x >= 0 && x <= w ? x : w / 2;
  }
  view = zoomed(view, factor, anchorX, w, length);
  fitted = view.pxPerSec <= fitZoom(length, w) + 1e-9;
  renderLanes();
}

function updateZoomButtons() {
  const t = current();
  if (!t) return;
  $('zoomOut').disabled = fitted;
  $('zoomIn').disabled = view.pxPerSec >= MAX_ZOOM - 1e-9;
}

$('zoomIn').addEventListener('click', () => zoomBy(2));
$('zoomOut').addEventListener('click', () => zoomBy(0.5));
// A trackpad pinch (or ctrl + wheel) zooms where the pointer is.
lanes.addEventListener('wheel', (ev) => {
  if (!ev.ctrlKey || !current()) return;
  ev.preventDefault();
  zoomBy(Math.exp(-ev.deltaY / 200), ev.clientX - lanes.getBoundingClientRect().left);
}, { passive: false });

// ---- Markers ----

$('markBtn').addEventListener('click', () => {
  const t = current();
  if (!t) return;
  const at = Math.round(position() * 10) / 10;
  t.markers.push({ t: at, text: nextMarkerText(t.markers) });
  t.markers.sort((a, b) => a.t - b.t);
  scheduleSave(t.id);
  renderMarkers();
  renderMarkerLines();
  if (viewLength(t) * view.pxPerSec > track.offsetWidth) renderLanes();
});

function renderMarkers() {
  const t = current();
  if (!t) return;
  const list = $('markerList');
  list.replaceChildren(...t.markers.map((m, i) => {
    const row = el('div', 'marker-row');
    row.dataset.marker = String(i);
    const when = el('button', 'ds-btn ds-btn--quiet when', `◆ ${formatTime(m.t)}`);
    when.type = 'button';
    when.title = 'Go there';
    when.addEventListener('click', () => seek(m.t));
    const text = el('input', 'ds-field');
    text.type = 'text';
    text.value = m.text;
    text.maxLength = 120;
    text.setAttribute('aria-label', `Marker at ${formatTime(m.t)}`);
    text.addEventListener('input', () => {
      m.text = text.value;
      renderMarkerLines();
      scheduleSave(t.id);
    });
    const del = el('button', 'ds-btn ds-btn--quiet', 'Delete');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete the marker at ${formatTime(m.t)}`);
    del.addEventListener('click', () => {
      t.markers.splice(t.markers.indexOf(m), 1);
      scheduleSave(t.id);
      renderMarkers();
      renderMarkerLines();
    });
    row.append(when, text, del);
    return row;
  }));
  $('noMarkers').hidden = t.markers.length > 0;
}

// ---- The stage view ----

const stageCanvas = $('stage');
const stageCtx = stageCanvas.getContext('2d');
const NO_VISUAL = new Uint8Array(0);
let stageLabel = null;

function drawStage() {
  if (!layout || $('stageCard').hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const w = stageCanvas.clientWidth, h = stageCanvas.clientHeight;
  if (!w || !h) return;
  if (stageCanvas.width !== Math.round(w * dpr) || stageCanvas.height !== Math.round(h * dpr)) {
    stageCanvas.width = Math.round(w * dpr);
    stageCanvas.height = Math.round(h * dpr);
  }
  const ctx = stageCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // In Prepare it is the draft, moving like the stage would: dark until its first frame.
  drawStagePicture(ctx, w, h, layout, prep.on ? prep.visual ?? NO_VISUAL : visual, (g) => liveState?.groups?.[g]?.level ?? 0);
  if (!stageLabel) {
    const s = getComputedStyle(document.body);
    stageLabel = { font: `600 10px ${s.fontFamily}`, prep: s.getPropertyValue('--ds-violet').trim() || '#B0A6F5', live: s.getPropertyValue('--ds-muted').trim() || '#97A4BA' };
  }
  ctx.font = stageLabel.font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.9px';
  ctx.fillStyle = prep.on ? stageLabel.prep : stageLabel.live;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';
  ctx.fillText(prep.on ? 'DRAFT' : 'LIVE', w - 8, h - 6);
  ctx.textAlign = 'start';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

// ---- Every frame: the play position, the playhead, the view following it ----

let lastShown = '';
function tick() {
  const t = current();
  if (!t) return;
  const pos = scrub ?? position();
  const text = formatTime(pos);
  if (text !== lastShown) {
    $('pos').textContent = text;
    lastShown = text;
  }
  playhead.style.transform = `translateX(${pos * view.pxPerSec}px)`;
  // While it plays, the view keeps the playhead in sight (unless the lanes were just moved by hand).
  const playing = run.id && (run.audio ? !audio.paused : true);
  if (playing && scrub === null && performance.now() - handScrollAt > 3000) {
    const next = followScroll(view.scroll, pos, lanes.clientWidth, view.pxPerSec, viewLength(t));
    if (Math.abs(next - view.scroll) > 1) lanes.scrollLeft = next;
  }
}

function frame() {
  tick();
  if (!run.id && liveState?.timeline) renderRunNote();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Keys on a laptop: Space starts and stops, M drops a marker ----

document.addEventListener('keydown', (ev) => {
  const target = ev.target;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || !current() || $('main').hidden) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement || target instanceof HTMLSelectElement) return;
  if (ev.key === ' ') {
    ev.preventDefault();
    if (run.id) stop();
    else void start();
  } else if (ev.key === 'm' || ev.key === 'M') {
    $('markBtn').click();
  }
});

// ---- Toast ----

let toastTimer = 0;
/** A short message: a problem (`bad`), or a plain confirmation. */
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = bad ? 'ds-toast ds-toast--bad' : 'ds-toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}

startClock($('clock'));
startPage().catch((err) => toast(err.message, true));
