// Timeline page for the programmer: the show's timelines, a recording with its waveform, markers, and playback.
// The browser that presses Start plays the sound; it tells the server where the recording is about 4 times a second
// and the server runs the lights in step (or, in Prepare, this page's own draft on the stage view only).
// The page edits its copy of the show's timelines and saves one timeline at a time (PUT /api/timeline) after a pause.

import { NOT_ANSWERING, request, showProblem, startClock } from '/shared/appbar.js';
import { LOUDNESS_RATE, decodeBytes, encodeBytes, loudnessTrack, peaksTrack } from '/shared/loudness.js';
import { drawStagePicture, shown } from '/shared/stagedraw.js';
import { keepStageSize, stageGrip, stageViewSwitch, storedStageSize } from '/shared/stagecard.js';
import { fitStageLength } from '/shared/stageview.js';
import {
  MAX_ZOOM, MIN_RISE, barsFor, blockMissing, blockSpans, clampEnd, dragBlock, fitZoom, followScroll, formatLength, formatRise,
  formatTime, hitTest, lookFade, markerRows, mixToMono, moveBlock, newBlockId, newBlockStart, newTimeline, nextMarkerText,
  addableGroups, dragIntent, normalisePeaks, parseTime, shownLayers, riseAfterLookChange, rulerTicks, shownRise, timeToX, viewLength, xToTime, zoomed,
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
 * said yes, with the Start's run `number` (a later Start anywhere has another); `audio` when the recording plays here
 * (else the page counts the time itself from basePos at baseAt); `ended` once the recording played out (the server goes
 * on by itself to the timeline's end); `detached` when Blackout, Basic lights, a song, Go or Back to saved took the
 * lights: the sound plays on (cutting the spoken word mid-service is worse) and Lights follow again starts them again.
 * Stop on another page (the operator page's) stops the sound here too.
 * `following`: the Start of Lights follow again is on its way. `recDuration`: the recording's length. `lastNumber`: the
 * run number it had when it was taken over (a late word from the server about that run still counts).
 */
let run = idleRun();
function idleRun() {
  return {
    id: null, prepare: false, startRef: null, confirmed: false, number: null, audio: false, ended: false, detached: false,
    following: false, basePos: 0, baseAt: 0, length: 0, recDuration: 0, lastNumber: null,
  };
}
/** A Stop pressed while the connection was down: sent when it is back (and the live timeline isn't shown as someone else's meanwhile). */
let pendingStop = null;
/** Where the recording was when it stalled for data (the lights hold there until it plays on), or null. */
let stalledAt = null;

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

/**
 * Something was refused for the PIN (a Start, the recording's next part) or the connection came back (the Mac may have
 * restarted): if this browser's session has ended, the PIN form shows. Nothing stops: a recording playing here plays
 * on, and a live timeline goes on by itself on the server until the PIN is in. One check at a time.
 */
let sessionCheck = null;
function checkSession() {
  sessionCheck ??= call('GET', '/api/session')
    .then((session) => {
      if (session.loggedIn) return false;
      showLogin();
      return true;
    }, () => false)
    .finally(() => { sessionCheck = null; });
  return sessionCheck;
}

/**
 * The recording stopped because the server refused its next part for the PIN: once the PIN is in, it plays on from
 * where the lights are (the same file; the page counted the time meanwhile).
 */
let audioRefused = false;
function resumeRefusedAudio() {
  if (!audioRefused) return;
  audioRefused = false;
  const t = current();
  if (!usableAudio(t)) return;
  const at = position();
  audio.load();
  audio.currentTime = at;
  if (run.id && !run.ended && t && run.id === t.id && run.recDuration > at) {
    run.audio = true;
    audio.play().catch(() => {});
  }
  renderTransport();
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
    resumeRefusedAudio();
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
  show = showParts(full);
  // Edits not saved yet (the server restarted, or the PIN was asked again) are kept and saved now; the rest is the server's.
  const kept = timelines.filter((t) => dirty.has(t.id) || sending.has(t.id));
  const fresh = (full.timelines ?? []).map((t) => kept.find((k) => k.id === t.id) ?? t);
  timelines = [...fresh, ...kept.filter((k) => !fresh.includes(k))];
  // Undo only for what is still this page's own copy: a snapshot of a timeline read again from the server is stale.
  undoStack = undoStack.filter((s) => kept.some((k) => k.id === s.id));
  onMac = new Set(list.map((r) => r.id));
  $('main').hidden = false;
  const wanted = decodeURIComponent(location.hash.slice(1));
  open(timelines.some((t) => t.id === wanted) ? wanted : timelines[0]?.id ?? null);
  if (!socket) connect();
  if (dirty.size) void flushSaves();
}

/** What the page needs of the show: its groups, looks and colours (the timelines are kept apart, as edited here). */
function showParts(full) {
  return { groups: full.groups ?? [], looks: full.looks ?? [], presets: full.presets ?? [] };
}

/** The show's groups, looks and colours again (Patch or an operator changed them); the timelines here stay as edited. */
let refreshTimer = 0;
function refreshShow() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const full = await call('GET', '/api/show');
      show = showParts(full);
      renderLanes();
      renderDetails();
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
    if (socket !== ws) return;
    setConnected(true);
    // Back after a blip: the server hears at once which run this page plays (if that run ended meanwhile, it says why).
    report();
    // Back after the server restarted: this browser may need the PIN again (its Start, reports and recording would be refused).
    void checkSession();
    // A Stop pressed while the connection was down goes now (only for that Start: a later one stays).
    if (pendingStop) {
      ws.send(JSON.stringify({ type: 'timelineStop', id: pendingStop.id, ...(pendingStop.run !== null ? { run: pendingStop.run } : {}), ref: ++ref }));
      const sent = pendingStop;
      setTimeout(() => { if (pendingStop === sent) pendingStop = null; }, 5000);
    }
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
      const sign = JSON.stringify([msg.layout.groups, msg.layout.looks, msg.layout.members]);
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
    } else if (msg.type === 'timelineEnded') {
      onTimelineEnded(msg);
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
    // A Start that was never answered: not started (Start shows again).
    else if (run.id && !run.confirmed && run.startRef !== null && !run.following) endRun('The connection was lost before the timeline started. Press Start again.');
    else if (run.following) {
      run.following = false;
      run.startRef = null;
      run.detached = true;
    }
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
    if (msg.error && msg.needsPin) void checkSession();
    if (msg.error) {
      if (run.following) {
        // Lights follow again didn't work: the sound plays on, the lights stay where they are.
        run.following = false;
        run.detached = true;
        renderTransport();
        toast(msg.error, true);
      } else {
        endRun(msg.error);
      }
      return;
    }
    run.following = false;
    run.confirmed = true;
    run.number = typeof msg.run === 'number' ? msg.run : null;
    report();
    renderTransport();
    return;
  }
  if (msg.error) toast(msg.error, true);
}

/**
 * The server says why this page's live run ended, before the live state shows it gone. 'stop' (Stop on another page,
 * the operator page's): the sound stops too. 'taken' (Blackout, Basic lights, a song, Go, Back to saved) and 'end' are
 * left to onLiveState: the sound plays on with Lights follow again, or the run ends as it played out.
 */
function onTimelineEnded(msg) {
  // Its own run, or the one it was taken off just now (back after a blip, the live state came before the reason).
  const mine = run.confirmed && !run.detached ? run.number : run.detached && !run.following ? run.lastNumber : null;
  if (!run.id || run.prepare || mine === null || msg.run !== mine) return;
  if (msg.reason === 'stop') endRun(stoppedWords() && 'Stop was pressed on another page: the timeline and its recording stopped.');
}

/** True when `tl` (a live or draft state's timeline) is this page's own run. */
const isOurs = (tl) => Boolean(tl && tl.id === run.id && (run.number === null || tl.run === run.number));

/**
 * The live state. The live timeline this page plays isn't there any more: another Start (on any page) replaced it, so
 * the sound stops here; or it came to its end; or Blackout, Basic lights, a song, Go or Back to saved took the lights,
 * and then the recording plays on and the page offers Lights follow again (a Stop elsewhere ended it already, with
 * its sound: onTimelineEnded).
 */
function onLiveState() {
  const tl = liveState?.timeline ?? null;
  if (pendingStop && !(tl && tl.id === pendingStop.id && (pendingStop.run === null || tl.run === pendingStop.run))) pendingStop = null;
  if (run.id && !run.prepare && run.confirmed && !run.detached && !isOurs(tl)) {
    if (tl) endRun('Another page started a timeline, so this one stopped here.');
    else if (run.ended || position() >= run.length - 0.5) endRun(null);
    else if (run.audio) detach();
    else endRun(stoppedWords());
  } else if (run.id && !run.prepare && run.detached && tl) {
    // Taken over, and then a timeline was started elsewhere: that one has the lights; the sound here stops.
    endRun('Another page started a timeline, so this one stopped here.');
  }
  renderList();
  renderTransport();
}

/** The lights were taken over while the recording plays here: it plays on; no more reports until Lights follow again. */
function detach() {
  run.detached = true;
  run.confirmed = false;
  run.lastNumber = run.number;
  run.number = null;
  renderTransport();
}

/** Lights follow again: the live timeline starts again where the recording is. */
function followAgain() {
  if (!run.id || !run.detached || run.following) return;
  const r = send({ type: 'timelineStart', id: run.id, at: audio.currentTime || 0 });
  if (r === null) return;
  run.detached = false;
  run.following = true;
  run.startRef = r;
  run.ended = false;
  renderTransport();
}
$('followBtn').addEventListener('click', followAgain);

/** This page's draft: the same for its Prepare timeline (it stops here, whatever stopped it). */
function onDraftState() {
  const tl = prep.state?.timeline ?? null;
  if (run.id && run.prepare && run.confirmed && !isOurs(tl)) endRun(stoppedWords());
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
  fitStageToPanel();
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
  run = { ...idleRun(), id: t.id, prepare: prep.on, audio: withAudio, length, recDuration: t.recording?.duration ?? 0, basePos: at, baseAt: performance.now() / 1000 };
  stalledAt = null;
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
    // Taken over (detached): the lights aren't this page's any more; only the sound stops.
    if (!run.detached || run.following) {
      const msg = { type: 'timelineStop', id: run.id, prepare: run.prepare, ...(run.number !== null ? { run: run.number } : {}) };
      if (connected) socket.send(JSON.stringify({ ...msg, ref: ++ref }));
      // Not lost while the connection is down: sent when it is back (a Prepare one went with the connection).
      else if (!run.prepare) pendingStop = { id: run.id, run: run.number };
    }
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

/**
 * Where the recording is, for the server. At its end, the later of the browser's length and the one worked out when it
 * was added (an mp3's length can differ a little between browsers): the server must see it reached the end.
 */
const soundPos = () => (audio.ended ? Math.max(audio.duration || 0, run.recDuration) : audio.currentTime || 0);

/** Tells the server where the recording is: only while this page plays a recording it started (and the lights are its). */
function report() {
  if (!run.id || !run.confirmed || !run.audio || run.ended || run.detached || !connected) return;
  // Stalled for data: the lights hold until the sound plays on (they never run ahead and then step back).
  if (stalledAt !== null && audio.currentTime > stalledAt + 0.25) stalledAt = null;
  const playing = !audio.paused && stalledAt === null;
  socket.send(JSON.stringify({ type: 'timelinePosition', id: run.id, pos: soundPos(), playing, ...(run.number !== null ? { run: run.number } : {}) }));
}
setInterval(report, REPORT_EVERY);
for (const e of ['play', 'pause', 'seeked']) audio.addEventListener(e, report);
for (const e of ['waiting', 'stalled']) {
  audio.addEventListener(e, () => {
    if (!run.id || audio.paused) return;
    stalledAt = audio.currentTime;
    report();
  });
}
audio.addEventListener('playing', () => {
  stalledAt = null;
  report();
});
audio.addEventListener('ended', () => {
  if (!run.id || !run.audio) return;
  // Taken over: nothing more to follow; the page is idle.
  if (run.detached) {
    endRun(null);
    return;
  }
  // Played out: the server goes on by itself to the timeline's end (later blocks, the lights' offset).
  if (run.confirmed && connected) {
    socket.send(JSON.stringify({ type: 'timelinePosition', id: run.id, pos: soundPos(), playing: false, ...(run.number !== null ? { run: run.number } : {}) }));
  }
  run.ended = true;
  renderTransport();
});
audio.addEventListener('error', async () => {
  if (!audio.getAttribute('src')) return;
  if (run.id && run.audio) {
    // The lights carry on with the page's own count.
    run.basePos = audio.currentTime || run.basePos;
    run.baseAt = performance.now() / 1000;
    run.audio = false;
  }
  renderTransport();
  // Refused for the PIN (this browser's session ended): the PIN form shows, and the sound plays on once it is in.
  const src = audio.getAttribute('src');
  if (await checkSession()) {
    if (audio.getAttribute('src') === src) audioRefused = true;
    return;
  }
  audioBroken = true;
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
    if (run.confirmed && connected) socket.send(JSON.stringify({ type: 'timelinePosition', id: run.id, pos: run.basePos, playing: true, ...(run.number !== null ? { run: run.number } : {}) }));
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
  sel = { group: null, block: null };
  for (const part of ['transport', 'lanesCard', 'blockCard', 'markersCard', 'stageCard', 'openTools']) $(part).hidden = !t;
  $('nameField').value = t?.name ?? '';
  $('offsetField').value = String(t?.offsetMs ?? 0);
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
  renderDetails();
  renderMarkers();
  fitStageToPanel();
  drawStage();
}

$('newBtn').addEventListener('click', async () => {
  const names = new Set(timelines.map((t) => t.name));
  let n = timelines.length + 1;
  while (names.has(`Timeline ${n}`)) n++;
  const t = newTimeline(`Timeline ${n}`, timelines.map((x) => x.id), lightGroups().map((g) => g.id));
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

// Lights earlier / later: in milliseconds, −500 to 500 (positive: the lights wait for sound that reaches the room late).
// Typed (a minus sign of either kind), or − / + by 10 ms (the iPad's number keys have no minus).
function setOffset(ms) {
  const t = current();
  if (!t) return;
  const v = Math.round(Math.min(500, Math.max(-500, ms)));
  $('offsetField').value = String(v);
  if (v !== (t.offsetMs ?? 0)) edit('offset', (tl) => { tl.offsetMs = v; });
}
$('offsetField').addEventListener('change', () => {
  const t = current();
  if (!t) return;
  const text = $('offsetField').value.trim().replace(/^[−–]/, '-');
  const v = Number(text);
  if (text === '' || !Number.isFinite(v)) {
    $('offsetField').value = String(t.offsetMs ?? 0);
    return;
  }
  setOffset(v);
});
$('offsetLess').addEventListener('click', () => setOffset((current()?.offsetMs ?? 0) - 10));
$('offsetMore').addEventListener('click', () => setOffset((current()?.offsetMs ?? 0) + 10));

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
  undoStack = undoStack.filter((s) => s.id !== t.id);
  if (also) await removeRecording(t.recording.id);
  open(timelines[Math.min(at, timelines.length - 1)]?.id ?? null);
  toast('Timeline deleted');
});

// ---- Saving: each edit is saved after a short pause, one timeline at a time ----

/** Timelines with edits not saved yet. */
const dirty = new Set();
/** Timelines being sent now (kept, like the edited ones, if the page reads the show again meanwhile). */
const sending = new Set();
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
  for (const id of ids) sending.add(id);
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
      } finally {
        sending.delete(id);
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
  const was = note.classList.contains('bad');
  note.textContent = text;
  note.classList.toggle('bad', bad);
  // Said where the person is working too: in the layers' bar while it lasts, and once as a message.
  const lane = $('laneSave');
  lane.hidden = !bad;
  lane.textContent = bad ? `${text.replace(/\.$/, '')}. Your changes are kept here and saved when Light Runner answers.` : '';
  lane.title = lane.textContent;
  if (bad && !was) toast(lane.textContent, true);
}

window.addEventListener('beforeunload', (e) => {
  if (dirty.size || saving) e.preventDefault();
});
// Leaving the page (or the iPad putting it away): what is waiting is sent at once. The browser lets a request outlive the
// page (keepalive) only up to 64 KB in all; a bigger one goes as a plain request (it may not finish). Each stays waiting
// until the server has it, in case the page comes back.
window.addEventListener('pagehide', () => {
  let kept = 0;
  for (const id of [...dirty]) {
    const t = timelines.find((x) => x.id === id);
    if (!t) continue;
    const body = JSON.stringify(t);
    const size = new TextEncoder().encode(body).length;
    const keepalive = kept + size <= 60 * 1024;
    if (keepalive) kept += size;
    fetch('/api/timeline', { method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive })
      .then((res) => { if (res.ok) dirty.delete(id); })
      .catch(() => {});
  }
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

/**
 * Decodes an audio file with Web Audio, resampled to 8 kHz: plenty for the waveform and the loudness, and an iPad keeps a
 * long recording in memory (a full-rate stereo decode of 15 minutes is over 300 MB). The length stays exact. A browser
 * that won't make an 8 kHz context gets 22.05 kHz, then its own rate. The promise form, or the callbacks older Safari has.
 */
async function decodeFile(file) {
  const data = await file.arrayBuffer();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let ctx = null;
  for (const rate of [8000, 22050]) {
    try {
      ctx = new Offline(1, 1, rate);
      break;
    } catch {
      // this browser won't take that rate
    }
  }
  const own = !ctx;
  if (own) ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  } finally {
    if (own) {
      try {
        await ctx.close();
      } catch {
        // already closed
      }
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
  $('startBtn').setAttribute('aria-pressed', String(mine && !run.detached));
  $('startBtn').disabled = adding || mine || !connected;
  const liveHere = liveState?.timeline?.id === t.id;
  $('stopBtn').disabled = !mine && !liveHere;
  $('takenOver').hidden = !(mine && (run.detached || run.following));
  $('followBtn').disabled = run.following || !connected;
  renderRunNote();
}

function renderRunNote() {
  const t = current();
  const note = $('runNote');
  let text = '';
  const live = liveState?.timeline ?? null;
  if (run.id && (run.detached || run.following)) text = '';
  else if (run.id && run.prepare) text = run.ended ? 'Prepare: the recording has played; the stage view runs on to the end.' : 'Prepare: playing on the stage view only. The real lights stay as they are.';
  else if (run.id) text = run.ended ? 'Live: the recording has played; the lights run on to the end.' : run.audio ? 'Live: the lights follow this recording.' : 'Live: the lights run on Light Runner\'s clock.';
  else if (live && t && live.id === t.id) text = pendingStop?.id === live.id ? 'Stopping…' : `Running live from another page · ${formatTime(livePos())}`;
  else if (live) text = `"${live.name}" is running live.`;
  else if (prep.on) text = 'Prepare: Start plays it on the stage view only.';
  if (note.textContent !== text) {
    note.textContent = text;
    note.title = text;
  }
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

/** The light groups, in the show's order. Smoke groups have no layer yet (Puff blocks come later). */
const lightGroups = () => show.groups.filter((g) => g.kind !== 'smoke');
const layerOf = (t, group) => t?.layers.find((l) => l.group === group) ?? null;
const groupName = (group) => (group === STAGE ? 'Whole stage' : show.groups.find((g) => g.id === group)?.name ?? group);
const groupGone = (group) => group !== STAGE && !show.groups.some((g) => g.id === group);

/**
 * The layers shown: Whole stage, then the timeline's own group layers in the show's order, then any whose group is gone
 * (its blocks are skipped; they can be deleted, or the layer removed). Made once with the timeline; ＋ Layer adds more.
 */
function layerRows(t) {
  return shownLayers(t, show.groups).map(({ group, missing }) => {
    if (group === STAGE) return { group, name: 'Whole stage', note: 'every group' };
    if (missing) return { group, name: group, note: 'group missing', missing: true };
    const g = show.groups.find((x) => x.id === group);
    return { group, name: g.name, note: `${g.fixtures.length} ${g.fixtures.length === 1 ? 'light' : 'lights'}` };
  });
}

function renderLanes() {
  const t = current();
  if (!t) return;
  // While a block is dragged the zoom stays as it is (the timeline's length may change under the finger).
  const dragging = press?.dragging === true;
  const length = dragging ? press.length : viewLength(t);
  const width = lanes.clientWidth || 600;
  if (fitted && !dragging) view = { pxPerSec: fitZoom(length, width), scroll: 0 };
  track.style.width = `${Math.max(width, length * view.pxPerSec)}px`;
  renderRows();
  renderMarkerLines();
  lanes.scrollLeft = view.scroll;
  view.scroll = lanes.scrollLeft;
  drawCanvases();
  updateZoomButtons();
  renderLayerMenu();
  tick();
}

/** The layer labels and the layers with their blocks (again after every edit). */
function renderRows() {
  const t = current();
  if (!t) return;
  const recLabel = el('div', 'lane-label rec');
  recLabel.append(el('b', null, 'Recording'), el('small', null, t.recording ? t.recording.name : 'none yet'));
  const labels = [el('div', 'spacer'), recLabel];
  const rows = [];
  for (const row of layerRows(t)) {
    labels.push(labelEl(row));
    rows.push(laneEl(t, row));
  }
  $('labels').replaceChildren(...labels);
  $('rows').replaceChildren(...rows);
}

/** One layer drawn again (while its block is dragged: the other layers stay as they are). */
function renderLane(group) {
  const t = current();
  const row = t && layerRows(t).find((r) => r.group === group);
  const old = rowsEl.querySelector(`.row-lane[data-group="${CSS.escape(group)}"]`);
  if (!row || !old) return renderRows();
  old.replaceWith(laneEl(t, row));
}

/** A layer's name (it chooses the layer) and its ＋ (a block at the play position). */
function labelEl(row) {
  const isSel = sel.group === row.group;
  const label = el('div', `lane-label${row.missing ? ' missing' : ''}${isSel ? ' sel' : ''}`);
  const name = el('button', 'lane-name');
  name.type = 'button';
  name.title = `Choose the ${row.name} layer`;
  name.append(el('b', null, row.name), el('small', null, row.note));
  name.addEventListener('click', () => select(row.group, null));
  label.append(name);
  if (!row.missing) {
    const add = el('button', 'lane-add', '＋');
    add.type = 'button';
    add.title = `Add a block on ${row.name} at the play position`;
    add.setAttribute('aria-label', add.title);
    add.addEventListener('click', () => addBlockAt(row.group, position()));
    label.append(add);
  }
  return label;
}

function laneEl(t, row) {
  const isSel = sel.group === row.group;
  const lane = el('div', `row-lane${isSel && !sel.block ? ' sel' : ''}`);
  lane.dataset.group = row.group;
  const spans = blockSpans(layerOf(t, row.group)?.blocks ?? [], press?.dragging ? press.length : viewLength(t));
  spans.forEach((span, k) => {
    lane.append(blockEl(row, span));
    // The chosen block's edges: handles a finger can hold (44 px), drawn as small grips.
    if (span.block.id === sel.block) {
      lane.append(gripEl(span.start, 'start'));
      if (span.block.end !== undefined || k === spans.length - 1) lane.append(gripEl(span.end, 'end'));
    }
  });
  return lane;
}

function gripEl(t, part) {
  const g = el('div', `grip grip-${part}`);
  // Kept inside the track, so a block that runs to the end doesn't make the layers scroll.
  const right = parseFloat(track.style.width) || Infinity;
  g.style.left = `${Math.min(t * view.pxPerSec, right - 22)}px`;
  g.setAttribute('aria-hidden', 'true');
  return g;
}

/** A block: its words, its colour mixed down (darker for a lower level), its rise as a dark fade at the front. */
function blockEl(row, span) {
  const { block } = span;
  const d = describeBlock(row.group, block);
  const b = el('div', `block${d.missing ? ' missing' : ''}${block.id === sel.block ? ' sel' : ''}`);
  b.dataset.id = block.id;
  b.style.left = `${span.start * view.pxPerSec}px`;
  b.style.width = `${Math.max(4, (span.end - span.start) * view.pxPerSec)}px`;
  if (d.fill && !d.missing) b.style.background = d.fill;
  const ramp = el('div', 'ramp');
  ramp.style.width = `${Math.min(100, (shownRise(block.rise) / Math.max(0.1, span.end - span.start)) * 100)}%`;
  b.append(ramp);
  const label = el('div', 'label');
  const name = el('span', 'name');
  if (d.dot && !d.missing) {
    const dot = el('span', 'dot');
    dot.style.background = shown(d.dot);
    name.append(dot);
  }
  name.append(d.text);
  label.append(name, el('small', null, `${formatTime(block.start)} · rise ${formatRise(block.rise)}`));
  b.append(label);
  b.title = `${d.text}, from ${formatTime(block.start)}`;
  return b;
}

/**
 * A colour on a block: a third of it greyed (so a saturated blue or red is quiet), then mixed into the panel's navy at
 * 8 % to 26 % by level, so no block is bright and a lower level looks darker.
 */
const fillOf = (colour, level = 1) => `color-mix(in srgb, color-mix(in srgb, ${shown(colour)} 66%, var(--ds-muted)) ${Math.round(8 + 18 * Math.min(1, Math.max(0, level)))}%, var(--ds-surface))`;
/** A level, a look without a swatch: the light text tone. Follow the voice with no colour of its own: the muted grey-blue. */
const NEUTRAL = 'var(--ds-muted-on)';
const VOICE = 'var(--ds-muted)';
/** Dark: the deepest ground. */
const DARK = 'var(--ds-bg-deep)';

const isEffect = (p) => p.layers?.some((l) => l.kind === 'effect');
/** A group's colours and effects, as its lists on the operator page have them. */
const coloursOf = (group) => show.presets.filter((p) => p.group === group && !p.custom && !isEffect(p));
const effectsOf = (group) => show.presets.filter((p) => p.group === group && !p.custom && isEffect(p));
const presetOf = (id) => show.presets.find((p) => p.id === id) ?? null;
const lookOf = (id) => show.looks.find((l) => l.id === id) ?? null;

/** The swatch of a colour or effect: as the operator page shows it (an effect by its first colour). */
function swatchOf(id) {
  for (const g of layout?.groups ?? []) {
    const p = g.presets?.find((x) => x.id === id) ?? g.hidden?.find((x) => x.id === id);
    if (p) return p.swatch ?? p.effect?.colours?.[0]?.hex ?? null;
  }
  const p = presetOf(id);
  const first = p?.layers?.[0];
  return p?.swatch ?? first?.colour?.hex ?? first?.colours?.[0]?.hex ?? null;
}

/** A look's swatch, else the colour of its first group. */
function lookSwatch(look) {
  if (look.swatch) return look.swatch;
  for (const e of look.groups) {
    const s = swatchOf(e.preset);
    if (s) return s;
  }
  return null;
}

const pct = (v) => `${Math.round(v * 100)} %`;
function speedText(speed) {
  if (!speed) return '';
  return 'beats' in speed ? `${speed.beats} ${speed.beats === 1 ? 'beat' : 'beats'} a round` : `${speed.seconds} s a round`;
}

/** How a block is drawn and named: its words, the colour of its dot and its fill, and whether something it needs is gone. */
function describeBlock(group, block) {
  const what = block.what;
  const missing = blockMissing(group, what, show);
  const gone = (text) => ({ text, missing: true });
  if (missing && groupGone(group)) return gone('Group missing');
  switch (what.kind) {
    case 'dark': return { text: 'Dark', fill: DARK };
    case 'full': return { text: 'Everything full', fill: fillOf('var(--ds-text)', 1) };
    case 'level': return missing ? gone('Not for Whole stage') : { text: `Level ${pct(what.level)}`, fill: fillOf(NEUTRAL, what.level) };
    case 'look': {
      if (missing) return gone(group === STAGE ? 'Look missing' : 'Look: only on Whole stage');
      const look = lookOf(what.look);
      const sw = lookSwatch(look);
      return { text: look.name, dot: sw, fill: fillOf(sw ?? NEUTRAL, 0.8) };
    }
    case 'colour': {
      if (missing) return gone(group === STAGE ? 'Not for Whole stage' : 'Colour missing');
      const sw = swatchOf(what.preset);
      return { text: `${presetOf(what.preset).name} · ${pct(what.level)}`, dot: sw, fill: fillOf(sw ?? NEUTRAL, what.level) };
    }
    case 'effect': {
      if (missing) return gone(group === STAGE ? 'Not for Whole stage' : 'Effect missing');
      const sw = swatchOf(what.preset);
      const level = what.level ?? 1;
      return { text: `${presetOf(what.preset).name} (effect) · ${pct(level)}`, dot: sw, fill: fillOf(sw ?? NEUTRAL, 0.7 * level) };
    }
    case 'follow': {
      if (missing) return gone(group === STAGE ? 'Not for Whole stage' : 'Follow the voice: colour missing');
      const sw = what.preset ? swatchOf(what.preset) : null;
      const colour = what.preset ? ` · ${presetOf(what.preset).name}` : '';
      return { text: `Follow the voice${colour} · ${Math.round(what.low * 100)}–${pct(what.high)}`, dot: sw ?? VOICE, fill: fillOf(sw ?? VOICE, 0.45) };
    }
    default: return gone('Unknown block');
  }
}

// ---- Choosing, changing and Undo ----

/** What is chosen: a layer (`group`), and maybe one of its blocks (`block`, an id). */
let sel = { group: null, block: null };

/** The chosen block and its layer, or null. */
function chosen(t = current()) {
  const layer = layerOf(t, sel.group);
  const block = layer?.blocks.find((b) => b.id === sel.block);
  return block ? { layer, block } : null;
}

function select(group, block) {
  sel = { group, block };
  renderRows();
  renderDetails();
  updateBlockButtons();
}

/** Changes to the layers and blocks (and Lights earlier / later), newest last; Undo puts the one before back. */
let undoStack = [];
let undoKey = null;
let undoAt = 0;

/** Keeps the open timeline as it is now, for Undo. Edits with the same `key` within 2 s are one step (typing a number). */
function remember(key) {
  const t = current();
  if (!t) return;
  const now = performance.now();
  if (key && key === undoKey && now - undoAt < 2000) {
    undoAt = now;
    return;
  }
  undoKey = key;
  undoAt = now;
  undoStack.push({ id: t.id, layers: structuredClone(t.layers), offsetMs: t.offsetMs ?? 0, sel: { ...sel } });
  if (undoStack.length > 100) undoStack.shift();
  updateBlockButtons();
}

/** One edit of the open timeline: remembered for Undo, saved after a pause, drawn again. */
function edit(key, change) {
  const t = current();
  if (!t) return;
  remember(key);
  change(t);
  for (const layer of t.layers) layer.blocks.sort((a, b) => a.start - b.start);
  scheduleSave(t.id);
  renderLanes();
  renderDetails();
  renderTransport();
}

function undo() {
  const t = current();
  if (!t) return;
  let k = undoStack.length - 1;
  while (k >= 0 && undoStack[k].id !== t.id) k--;
  if (k < 0) return;
  const [step] = undoStack.splice(k, 1);
  undoKey = null;
  t.layers = step.layers;
  t.offsetMs = step.offsetMs;
  $('offsetField').value = String(t.offsetMs);
  sel = step.sel;
  if (!layerOf(t, sel.group)) sel = { group: null, block: null };
  else if (sel.block && !chosen(t)) sel.block = null;
  scheduleSave(t.id);
  renderLanes();
  renderDetails();
  renderTransport();
}
$('undoBtn').addEventListener('click', undo);

function updateBlockButtons() {
  const t = current();
  $('undoBtn').disabled = !t || !undoStack.some((s) => s.id === t.id);
}

/** ＋ Layer: a light group whose layer was removed gets it back. */
function renderLayerMenu() {
  const t = current();
  const menu = $('addLayer');
  if (!t) return;
  const free = addableGroups(t, show.groups).map((id) => show.groups.find((g) => g.id === id));
  const first = el('option', null, '＋ Layer');
  first.value = '';
  menu.replaceChildren(first, ...free.map((g) => {
    const o = el('option', null, g.name);
    o.value = g.id;
    return o;
  }));
  menu.value = '';
  menu.disabled = !free.length;
  menu.title = free.length ? 'Add a group\'s layer' : 'Every group has its layer';
  updateBlockButtons();
}
$('addLayer').addEventListener('change', () => {
  const group = $('addLayer').value;
  if (!group) return;
  edit(null, (t) => {
    t.layers.push({ group, blocks: [] });
    sel = { group, block: null };
  });
});

/** What a new block on a layer is: Everything full on Whole stage; the group's first colour at full on a group. */
function newWhat(group) {
  if (group === STAGE) return { kind: 'full' };
  const colour = coloursOf(group)[0];
  return colour ? { kind: 'colour', preset: colour.id, level: 1 } : { kind: 'level', level: 1 };
}

/** The rise a block starts with: a look's or a colour's own fade (what the operator page would use), else 3 s. */
function riseFor(what) {
  if (what.kind === 'look') return lookFade(lookOf(what.look), show.presets);
  if (what.kind === 'colour' || what.kind === 'effect') return Math.max(MIN_RISE, presetOf(what.preset)?.fade ?? 3);
  if (what.kind === 'follow') return MIN_RISE;
  return 3;
}

/** Adds a block at `at` seconds on a layer (snapped to `targets` or a tenth); a block that starts there is chosen instead. */
function addBlockAt(group, at, targets = []) {
  const t = current();
  if (!t || groupGone(group)) return;
  const blocks = layerOf(t, group)?.blocks ?? [];
  const start = newBlockStart(blocks, at, targets, view.pxPerSec);
  if (start === null) {
    const there = blocks.reduce((best, b) => (!best || Math.abs(b.start - at) < Math.abs(best.start - at) ? b : best), null);
    if (there) select(group, there.id);
    return;
  }
  const what = newWhat(group);
  edit(null, (tl) => {
    let layer = layerOf(tl, group);
    if (!layer) {
      layer = { group, blocks: [] };
      tl.layers.push(layer);
    }
    const block = { id: newBlockId(tl), start, rise: riseFor(what), what };
    layer.blocks.push(block);
    sel = { group, block: block.id };
  });
}

function deleteChosen() {
  const c = chosen();
  if (!c) return;
  edit(null, () => {
    c.layer.blocks.splice(c.layer.blocks.indexOf(c.block), 1);
    sel = { group: sel.group, block: null };
  });
  toast('Block deleted. Undo brings it back.');
}

// ---- Dragging blocks and their edges; a tap chooses a block or adds one ----

const rowsEl = $('rows');
/** The press on the layers now: where it began, what it is on, and the drag once it is one. */
let press = null;
/** A drag's next position waits for the next frame (one redraw a frame, however fast the pointer moves). */
let dragFrame = 0;

const trackX = (ev) => ev.clientX - track.getBoundingClientRect().left;
const isFinger = (ev) => ev.pointerType === 'touch' || ev.pointerType === 'pen';

/** The blocks of a layer as spans, for hit-testing: an end has a handle when it is the block's own, or the last block's. */
function spansOf(t, group) {
  const spans = blockSpans(layerOf(t, group)?.blocks ?? [], viewLength(t));
  return spans.map((s, k) => ({ id: s.block.id, start: s.start, end: s.end, endEdge: s.block.end !== undefined || k === spans.length - 1 }));
}

/** Where a dragged time snaps to: markers, the play position, the recording's end, other blocks' starts and ends. */
function snapTargets(t, except) {
  const out = t.markers.map((m) => m.t);
  out.push(position());
  if (t.recording) out.push(t.recording.duration);
  for (const layer of t.layers) {
    for (const b of layer.blocks) {
      if (b.id === except) continue;
      out.push(b.start);
      if (b.end !== undefined) out.push(b.end);
    }
  }
  return out;
}

const hitOpts = (finger) => ({ selected: sel.block, handlePx: finger ? 0 : 12, selectedHandlePx: 44 });

rowsEl.addEventListener('pointerdown', (ev) => {
  const t = current();
  const lane = ev.target instanceof Element ? ev.target.closest('.row-lane') : null;
  if (!t || !lane || (ev.pointerType === 'mouse' && ev.button !== 0) || press) return;
  // A number or time being typed is taken first (as leaving the field would).
  if ($('blockBody').contains(document.activeElement)) document.activeElement.blur();
  const group = lane.dataset.group;
  const finger = isFinger(ev);
  const x = trackX(ev);
  const hit = hitTest(spansOf(t, group), x, view.pxPerSec, hitOpts(finger));
  // A finger drags only the chosen block (elsewhere it scrolls the layers); a mouse drags any block.
  const canDrag = Boolean(hit) && !groupGone(group) && (!finger || hit.id === sel.block);
  press = { id: ev.pointerId, group, x0: ev.clientX, y0: ev.clientY, x, hit, canDrag, finger, moved: false, dragging: false, dx: 0 };
  if (canDrag) {
    try {
      rowsEl.setPointerCapture(ev.pointerId);
    } catch {
      // a pointer the browser no longer has: the drag still follows it over the layers
    }
    if (!finger) ev.preventDefault();
  }
});

rowsEl.addEventListener('pointermove', (ev) => {
  if (!press) {
    if (ev.pointerType === 'mouse') hoverCursor(ev);
    return;
  }
  if (ev.pointerId !== press.id) return;
  const dx = ev.clientX - press.x0;
  const dy = ev.clientY - press.y0;
  if (!press.dragging) {
    if (Math.hypot(dx, dy) > (press.finger ? 10 : 5)) press.moved = true;
    const intent = press.canDrag ? dragIntent(dx, dy, press.finger) : null;
    // Up or down first: the page scrolls (the chosen block lets the browser have a vertical swipe).
    if (intent === 'scroll') press.canDrag = false;
    if (intent !== 'drag') return;
    startDrag();
    if (!press.dragging) return;
  }
  press.dx = dx;
  if (!dragFrame) dragFrame = requestAnimationFrame(applyDrag);
});

rowsEl.addEventListener('pointerup', (ev) => {
  if (!press || ev.pointerId !== press.id) return;
  if (press.dragging) {
    applyDrag();
    press = null;
    return endDrag();
  }
  const p = press;
  press = null;
  if (!p.moved) tap(p);
});

rowsEl.addEventListener('pointercancel', (ev) => {
  if (!press || ev.pointerId !== press.id) return;
  const dragging = press.dragging;
  if (dragging) applyDrag();
  press = null;
  if (dragging) endDrag();
});

function startDrag() {
  const t = current();
  const block = layerOf(t, press.group)?.blocks.find((b) => b.id === press.hit.id);
  if (!block) {
    press.canDrag = false;
    return;
  }
  remember(null);
  press.dragging = true;
  press.orig = { start: block.start, end: block.end };
  press.length = viewLength(t);
  press.targets = snapTargets(t, block.id);
  document.body.classList.add('dragging');
  if (sel.block !== block.id) {
    // Chosen by the drag itself (a mouse): every layer once, for the old block's grips and the layer's name.
    sel = { group: press.group, block: block.id };
    renderRows();
    renderDetails();
  }
}

/** The block where the pointer has it now: worked out from where it was when the drag began, so snapping never creeps. */
function applyDrag() {
  cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  if (!press?.dragging) return;
  const t = current();
  const layer = layerOf(t, press.group);
  const block = layer?.blocks.find((b) => b.id === press.hit.id);
  if (!block) return;
  const blocks = layer.blocks.map((b) => (b === block ? { ...b, start: press.orig.start, end: press.orig.end } : b));
  const times = dragBlock(blocks, block.id, press.hit.part, press.dx / view.pxPerSec, { targets: press.targets, pxPerSec: view.pxPerSec, length: press.length });
  if (times.start === block.start && times.end === block.end) return;
  block.start = times.start;
  if (times.end === undefined) delete block.end;
  else block.end = times.end;
  // Only the dragged layer and the details: the rest of the page stays as it is until the drag ends.
  renderLane(press.group);
  renderDetails();
}

function endDrag() {
  document.body.classList.remove('dragging');
  const t = current();
  if (!t) return;
  for (const layer of t.layers) layer.blocks.sort((a, b) => a.start - b.start);
  scheduleSave(t.id);
  renderLanes();
  renderDetails();
  renderTransport();
}

/** A tap: on a block, chooses it (a second tap or a double-click only chooses it too); on empty space, adds a block there. */
function tap(p) {
  const t = current();
  if (!t) return;
  if (p.hit) {
    if (sel.block !== p.hit.id) select(p.group, p.hit.id);
    return;
  }
  addBlockAt(p.group, Math.min(viewLength(t), Math.max(0, p.x / view.pxPerSec)), snapTargets(t, null));
}

/** With a mouse: the pointer shows what a press would do (move, an edge, add). */
function hoverCursor(ev) {
  const t = current();
  const lane = ev.target instanceof Element ? ev.target.closest('.row-lane') : null;
  if (!t || !lane) return;
  const hit = hitTest(spansOf(t, lane.dataset.group), trackX(ev), view.pxPerSec, hitOpts(false));
  lane.style.cursor = !hit ? 'copy' : hit.part === 'move' ? 'grab' : 'ew-resize';
}

// ---- The chosen block's details ----

const KINDS_GROUP = [['colour', 'Colour'], ['level', 'Level'], ['effect', 'Effect'], ['follow', 'Follow the voice']];
const KINDS_STAGE = [['look', 'Look'], ['dark', 'Dark'], ['full', 'Everything full']];
const SPEEDS = [{ beats: 1 }, { beats: 2 }, { beats: 4 }, { beats: 8 }, { beats: 16 }, { beats: 32 }, { seconds: 4 }, { seconds: 8 }, { seconds: 15 }, { seconds: 30 }, { seconds: 60 }];
const speedKey = (s) => (s ? ('beats' in s ? `b${s.beats}` : `s${s.seconds}`) : '');

/** A labelled part of the details: a label over a control, and a hint under it. */
function part(labelText, control, hint, cls = '') {
  const f = el('label', `f ${cls}`.trim());
  f.append(el('span', 'f-label', labelText), control);
  if (hint) f.append(el('small', 'f-hint', hint));
  return f;
}

function option(value, text, selected = false, disabled = false) {
  const o = el('option', null, text);
  o.value = value;
  o.selected = selected;
  o.disabled = disabled;
  return o;
}

function selectEl(options, onChange, label) {
  const s = el('select', 'ds-field');
  s.append(...options);
  s.setAttribute('aria-label', label);
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** A number field (a level in %, a rise in seconds) applied when it is left or Enter is pressed. */
function numberEl(value, { min, max, step, unit, label }, onChange) {
  const wrap = el('span', 'num');
  const input = el('input', 'ds-field');
  input.type = 'number';
  input.inputMode = 'decimal';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(v)) {
      input.value = String(value);
      return;
    }
    const next = Math.min(max, Math.max(min, v));
    if (next === value) {
      input.value = String(value);
      return;
    }
    onChange(next);
  });
  wrap.append(input, el('span', 'unit', unit));
  return wrap;
}

/** A time field (m:ss.t); empty means `emptyMeans` (null when it can't be empty). */
function timeEl(value, placeholder, label, onChange) {
  const input = el('input', 'ds-field');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = value === undefined ? '' : formatTime(value);
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => {
    const text = input.value.trim();
    const v = text === '' ? undefined : parseTime(text);
    if (v === null) {
      input.value = value === undefined ? '' : formatTime(value);
      toast('Type a time as m:ss.t, like 1:05.5, or seconds.', true);
      return;
    }
    onChange(v);
  });
  return input;
}

function headButton(text, onClick, cls = 'ds-btn ds-btn--quiet') {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function renderDetails() {
  const t = current();
  const head = $('blockHead');
  const body = $('blockBody');
  if (!t) return;
  // Something chosen that is gone (Undo, an edit elsewhere): nothing chosen.
  if (sel.group && !layerOf(t, sel.group)) sel = { group: null, block: null };
  if (sel.block && !chosen(t)) sel.block = null;
  updateBlockButtons();
  // Built again after every change: the field that had the focus (Enter in it) gets it back.
  const focused = body.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
  buildDetails(t, head, body);
  if (focused) body.querySelector(`[aria-label="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function buildDetails(t, head, body) {
  const c = chosen(t);
  if (!sel.group) {
    head.replaceChildren(el('span', 'ds-caps', 'Block'));
    body.replaceChildren(el('p', 'hint', 'Tap a block to change it. Tap empty space on a layer to add a block there, or a layer’s ＋ to add one at the play position.'));
    return;
  }
  const name = groupName(sel.group);
  if (!c) {
    const layer = layerOf(t, sel.group);
    const gone = groupGone(sel.group);
    const empty = !layer.blocks.length;
    const remove = headButton('Remove layer', () => {
      edit(null, (tl) => {
        tl.layers = tl.layers.filter((l) => l.group !== sel.group);
        sel = { group: null, block: null };
      });
    });
    remove.disabled = sel.group === STAGE || (!empty && !gone);
    const add = headButton('＋ Block at play position', () => addBlockAt(sel.group, position()));
    add.disabled = gone;
    head.replaceChildren(el('span', 'ds-caps', `Layer · ${name}`), el('span', 'grow'), add, remove);
    const words = gone
      ? 'This group was deleted from the show, so its blocks are skipped. Delete them, or remove the layer.'
      : sel.group === STAGE
        ? 'Whole stage blocks set every group at once: a look, Dark or Everything full. A later block on a group\'s own layer wins for that group.'
        : empty ? 'No blocks on this layer. Remove layer takes it away (＋ Layer brings it back).' : 'To remove this layer, delete its blocks first.';
    body.replaceChildren(el('p', 'hint', words));
    return;
  }

  const { layer, block } = c;
  const what = block.what;
  const group = layer.group;
  const onStage = group === STAGE;
  const gone = groupGone(group);
  const missing = blockMissing(group, what, show);

  const toPlay = headButton('Start at play position', () => edit(null, () => Object.assign(block, moveBlock(layer.blocks, block.id, position()))));
  toPlay.disabled = gone;
  head.replaceChildren(el('span', 'ds-caps', `Block · ${name}`), el('span', 'grow'), toPlay, headButton('Delete', deleteChosen));

  const parts = [];
  const set = (key, change) => edit(key, () => change(block));

  if (gone) {
    body.replaceChildren(el('p', 'hint warn', 'This block\'s group was deleted from the show, so it is skipped. Delete it, or remove the layer.'));
    return;
  }

  // What: the kind, then which colour, effect or look.
  const kinds = onStage ? KINDS_STAGE : KINDS_GROUP;
  const kindOptions = kinds.map(([k, text]) => {
    const unusable = (k === 'colour' && !coloursOf(group).length) || (k === 'effect' && !effectsOf(group).length) || (k === 'look' && !show.looks.length);
    return option(k, text + (unusable ? (k === 'look' ? ' (the show has none)' : ' (this group has none)') : ''), what.kind === k, unusable);
  });
  if (!kinds.some(([k]) => k === what.kind)) kindOptions.unshift(option(what.kind, `${what.kind} (not for this layer)`, true, true));
  const kindSel = selectEl(kindOptions, (k) => set(null, (b) => {
    const next = whatFor(k, group, b.what);
    if (!next) return;
    if (next.kind === 'look') b.rise = lookFade(lookOf(next.look), show.presets);
    b.what = next;
  }), 'What the block does');
  const whatBox = el('span', 'what');
  whatBox.append(kindSel);

  const pick = (list, current, lost, onPick, label) => {
    const opts = list.map((p) => option(p.id, p.name, p.id === current));
    if (current && !list.some((p) => p.id === current)) opts.unshift(option(current, lost, true, true));
    return selectEl(opts, onPick, label);
  };
  if (what.kind === 'colour') {
    whatBox.append(dotBox(swatchOf(what.preset)), pick(coloursOf(group), what.preset, 'Deleted colour', (id) => set(null, (b) => { b.what = { ...b.what, preset: id }; }), 'Colour'));
  } else if (what.kind === 'effect') {
    whatBox.append(dotBox(swatchOf(what.preset)), pick(effectsOf(group), what.preset, 'Deleted effect', (id) => set(null, (b) => { b.what = { ...b.what, kind: 'effect', preset: id }; }), 'Effect'));
  } else if (what.kind === 'look') {
    const look = lookOf(what.look);
    whatBox.append(dotBox(look ? lookSwatch(look) : null), pick(show.looks, what.look, 'Deleted look', (id) => set(null, (b) => {
      const before = lookFade(lookOf(b.what.look), show.presets);
      b.rise = riseAfterLookChange(b.rise, before, lookFade(lookOf(id), show.presets));
      b.what = { kind: 'look', look: id };
    }), 'Look'));
  }
  parts.push(part('What', whatBox, null, 'wide'));

  if (what.kind === 'colour' || what.kind === 'level' || what.kind === 'effect') {
    parts.push(part('Level', numberEl(Math.round((what.level ?? 1) * 100), { min: 0, max: 100, step: 1, unit: '%', label: 'Level' }, (v) => set(null, (b) => { b.what = { ...b.what, level: v / 100 }; }))));
  }
  if (what.kind === 'effect') {
    const own = presetOf(what.preset)?.layers?.find((l) => l.kind === 'effect')?.speed;
    const opts = [option('', `Its own speed${own ? ` (${speedText(own)})` : ''}`, !what.speed)];
    const list = what.speed && !SPEEDS.some((s) => speedKey(s) === speedKey(what.speed)) ? [what.speed, ...SPEEDS] : SPEEDS;
    for (const s of list) opts.push(option(speedKey(s), speedText(s), speedKey(s) === speedKey(what.speed)));
    parts.push(part('Speed', selectEl(opts, (key) => set(null, (b) => {
      const s = list.find((x) => speedKey(x) === key);
      const { speed: _drop, ...rest } = b.what;
      b.what = s ? { ...rest, speed: s } : rest;
    }), 'Speed')));
  }
  if (what.kind === 'follow') {
    parts.push(part('Low', numberEl(Math.round(what.low * 100), { min: 0, max: 100, step: 1, unit: '%', label: 'Low level' }, (v) => set(null, (b) => { b.what = { ...b.what, low: v / 100 }; })), 'When it is quiet'));
    parts.push(part('High', numberEl(Math.round(what.high * 100), { min: 0, max: 100, step: 1, unit: '%', label: 'High level' }, (v) => set(null, (b) => { b.what = { ...b.what, high: v / 100 }; })), 'When it is loud'));
    const opts = [option('', 'Its colour at the time', what.preset === undefined), ...coloursOf(group).map((p) => option(p.id, p.name, p.id === what.preset))];
    if (what.preset !== undefined && !coloursOf(group).some((p) => p.id === what.preset)) opts.splice(1, 0, option(what.preset, 'Deleted colour', true, true));
    parts.push(part('Colour', selectEl(opts, (id) => set(null, (b) => {
      const { preset: _drop, ...rest } = b.what;
      b.what = id ? { ...rest, preset: id } : rest;
    }), 'Colour while it follows the voice')));
  }

  parts.push(part('Starts at', timeEl(block.start, '0:00.0', 'Starts at', (v) => {
    if (v === undefined) return renderDetails();
    edit(null, () => Object.assign(block, moveBlock(layer.blocks, block.id, v)));
  })));
  parts.push(part('Rise', numberEl(tenthOf(shownRise(block.rise)), { min: MIN_RISE, max: 600, step: 0.5, unit: 's', label: 'Rise' }, (v) => set(null, (b) => { b.rise = tenthOf(v); })), 'At least 1.5 s: the lights never change faster'));
  const spans = blockSpans(layer.blocks, viewLength(t));
  const span = spans.find((s) => s.block === block);
  const isLast = spans.at(-1)?.block === block;
  const untilWords = isLast ? `the end (${formatTime(span.end)})` : `the next block (${formatTime(span.end)})`;
  const until = timeEl(block.end, untilWords, 'Until', (v) => edit(null, () => {
    const end = v === undefined ? undefined : clampEnd(layer.blocks, block.id, v);
    if (end === undefined) delete block.end;
    else block.end = end;
  }));
  parts.push(part('Until', until, block.end === undefined ? (isLast ? 'Empty: until the end' : 'Empty: until the next block') : 'Clear it for "until the next block"'));

  const grid = el('div', 'insp');
  grid.append(...parts);
  const nodes = [grid];
  if (missing) nodes.unshift(el('p', 'hint warn', missingWords(what)));
  body.replaceChildren(...nodes);
}

const tenthOf = (v) => Math.round(v * 10) / 10;

function dotBox(hex) {
  const d = el('span', 'dot');
  if (hex) d.style.background = shown(hex);
  else d.classList.add('none');
  return d;
}

function missingWords(what) {
  const thing = { colour: 'colour', effect: 'effect', look: 'look', follow: 'colour' }[what.kind] ?? 'kind of block';
  return `This block's ${thing} is not in the show any more (deleted, or not for this layer), so the block is skipped. Choose another, or delete the block.`;
}

/** The block's what when its kind is changed to `kind`: keeping its level and colour where they fit; null when it can't. */
function whatFor(kind, group, old) {
  const level = old.level ?? (old.kind === 'follow' ? old.high : 1);
  const colours = coloursOf(group);
  const keep = old.preset && colours.some((p) => p.id === old.preset) ? old.preset : undefined;
  switch (kind) {
    case 'colour': {
      const id = keep ?? colours[0]?.id;
      return id ? { kind, preset: id, level } : null;
    }
    case 'level': return { kind, level };
    case 'effect': {
      const fx = effectsOf(group);
      const id = old.kind === 'effect' && fx.some((p) => p.id === old.preset) ? old.preset : fx[0]?.id;
      return id ? { kind, preset: id, level } : null;
    }
    case 'follow': return { kind, low: 0.1, high: 1, ...(keep ? { preset: keep } : {}) };
    case 'look': {
      const look = old.kind === 'look' && lookOf(old.look) ? old.look : show.looks[0]?.id;
      return look ? { kind, look } : null;
    }
    case 'dark':
    case 'full': return { kind };
    default: return null;
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

// Hide / Show: the stage view folds away to a small button (in Prepare it floats over the layers' right ends).
let stageHidden = false;
try {
  stageHidden = localStorage.getItem('lr-timeline-stage') === 'hidden';
} catch {
  // no storage here: shown
}
function showStageView(on) {
  stageHidden = !on;
  document.body.classList.toggle('stage-hidden', stageHidden);
  $('stageToggle').textContent = on ? 'Hide' : 'Show the stage view';
  $('stageToggle').setAttribute('aria-expanded', String(on));
  try {
    localStorage.setItem('lr-timeline-stage', on ? 'shown' : 'hidden');
  } catch {
    // not kept: fine
  }
  drawStage();
}
$('stageToggle').addEventListener('click', () => {
  showStageView(stageHidden);
  fitStageToPanel();
});
showStageView(!stageHidden);

// From above or from the audience: one choice per browser (the operator page's too), on the picture itself.
const stageView = stageViewSwitch($('stageWrap'), () => drawStage());

// Bigger or smaller by the grip at its corner: from 300 × 124 up to the panel's width (Hide keeps its place beside
// it) and most of the window's height, never much taller than wide. In Prepare it is always the small one (the styles), and a phone keeps the
// whole width.
const STAGE_MIN = { w: 300, h: 124 };
const stageWrap = $('stageWrap');
const narrowQuery = window.matchMedia('(max-width: 760px)');
function stageLimits() {
  const card = $('stageCard'), cs = getComputedStyle(card);
  const inner = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const maxW = inner - $('stageToggle').offsetWidth - parseFloat(cs.columnGap || '14');
  return { maxW: Math.max(STAGE_MIN.w, maxW), maxH: Math.max(STAGE_MIN.h, window.innerHeight - 160), inner };
}
/** Sets the picture's size (each within its limits); `null` puts it back to its own size. */
function setStageSize(want) {
  if (!want) {
    stageWrap.style.removeProperty('--stage-w');
    stageCanvas.style.removeProperty('--stage-h');
  } else {
    const { maxW, maxH } = stageLimits();
    if (want.w != null && !narrowQuery.matches) stageWrap.style.setProperty('--stage-w', `${Math.round(fitStageLength(want.w, STAGE_MIN.w, maxW))}px`);
    // Never much taller than wide (a phone's narrow picture stays a picture of the stage).
    const tallest = Math.min(maxH, stageWrap.offsetWidth * 0.8);
    if (want.h != null) stageCanvas.style.setProperty('--stage-h', `${Math.round(fitStageLength(want.h, STAGE_MIN.h, tallest))}px`);
  }
  // A wide picture puts the legend under it, so the words keep their room.
  const { inner } = stageLimits();
  $('stageCard').classList.toggle('wide', stageWrap.offsetWidth + 14 + $('stageToggle').offsetWidth + 14 + 280 > inner);
}
stageGrip($('stageGrip'), {
  axes: 'xy',
  start: () => ({ w: stageWrap.offsetWidth, h: stageCanvas.clientHeight }),
  apply: (size) => setStageSize(size),
  done: () => {
    keepStageSize('timeline', { w: stageWrap.offsetWidth, h: stageCanvas.clientHeight });
    // Drawn properly at the final size (while dragging, the last picture was stretched).
    drawStage();
  },
  reset: () => {
    setStageSize(null);
    keepStageSize('timeline', null);
  },
});
/** The kept size, again within today's panel (the window may have changed). */
function fitStageToPanel() {
  if ($('stageCard').hidden || stageHidden) return;
  const kept = storedStageSize('timeline');
  setStageSize(kept.w || kept.h ? kept : null);
}
window.addEventListener('resize', fitStageToPanel);
narrowQuery.addEventListener('change', fitStageToPanel);
// Drawn again at its new size, whatever changed it.
new ResizeObserver(() => drawStage()).observe(stageCanvas);

function drawStage() {
  if (!layout || $('stageCard').hidden || stageHidden) return;
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
  drawStagePicture(ctx, w, h, layout, prep.on ? prep.visual ?? NO_VISUAL : visual, (g) => liveState?.groups?.[g]?.level ?? 0, { view: stageView.view, resizing: $('stageGrip').classList.contains('dragging') });
  if (!stageLabel) {
    const s = getComputedStyle(document.body);
    stageLabel = { font: `600 10px ${s.fontFamily}`, prep: s.getPropertyValue('--ds-violet').trim() || '#B0A6F5', live: s.getPropertyValue('--ds-muted').trim() || '#97A4BA' };
  }
  ctx.font = stageLabel.font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.9px';
  ctx.fillStyle = prep.on ? stageLabel.prep : stageLabel.live;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';
  // Left of the resize grip at the corner (in Prepare there is no grip).
  ctx.fillText(prep.on ? 'DRAFT' : 'LIVE', prep.on ? w - 8 : w - 34, h - 6);
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
  if (!current() || $('main').hidden) return;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  // Ctrl/⌘ Z: Undo of the layers and blocks (in a field, the field's own).
  if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && (ev.key === 'z' || ev.key === 'Z') && !typing) {
    ev.preventDefault();
    undo();
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey || typing) return;
  // Delete or Backspace deletes the chosen block; Escape chooses nothing.
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && chosen()) {
    ev.preventDefault();
    deleteChosen();
    return;
  }
  if (ev.key === 'Escape' && sel.group) {
    select(null, null);
    return;
  }
  if (target instanceof HTMLButtonElement) return;
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
