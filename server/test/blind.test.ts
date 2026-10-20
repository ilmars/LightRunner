import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { BlindSession } from '../src/blind.ts';
import { Engine } from '../../packages/engine/src/index.ts';
import { parseShow } from '../../packages/shared/src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const tempDir = () => mkdtempSync(join(tmpdir(), 'light-runner-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REAL_STAGE_ONLY = 'That works on the real stage only.';
const BLIND_OFF = 'Prepare is off.';
const BLIND_PROBLEM = 'Prepare stopped because of a problem. The lights were not changed.';
const TOO_MANY = 'Too many tablets are preparing.';

function makeApp(dataDir: string, log: (msg: string) => void = () => {}) {
  return new App({ port: 0, host: '127.0.0.1', dataDir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log });
}

async function api(app: App, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
}

async function waitFor<T>(get: () => T | null | undefined | false, ms = 2000, what = 'a condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A tablet on the WebSocket: sends commands and keeps the live state, the draft's state and both pictures. */
async function tablet(app: App) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const seen: any[] = [];
  const visuals: Buffer[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) visuals.push(data as Buffer);
    else seen.push(JSON.parse(String(data)));
  });
  await new Promise((r) => ws.once('open', r));
  let ref = 0;
  const latest = (type: string, key = type) => seen.findLast((m) => m.type === type)?.[key];
  return {
    ws,
    seen,
    visuals,
    state: () => latest('state'),
    draft: () => latest('draftState', 'state'),
    draftVisuals: () => seen.filter((m) => m.type === 'draftVisual').map((m) => Buffer.from(m.data, 'base64')),
    layout: () => latest('layout'),
    order: () => latest('layout').runningOrder.map((l: any) => l.id) as string[],
    /** Sends a command and resolves with its error (null when it worked). */
    async send(cmd: unknown): Promise<string | null> {
      const mine = ++ref;
      ws.send(JSON.stringify({ type: 'command', ref: mine, cmd }));
      const reply = await waitFor(() => seen.find((m) => m.type === 'result' && m.ref === mine), 3000, `the reply to ${JSON.stringify(cmd)}`);
      return reply.error;
    },
  };
}

async function withApp(fn: (app: App, dir: string) => Promise<void>, log?: (msg: string) => void) {
  const dir = tempDir();
  const app = makeApp(dir, log);
  try {
    await app.start();
    await fn(app, dir);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const savedShow = (dir: string) => parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8')));
const savedLook = (dir: string, id: string) => savedShow(dir).looks.find((l) => l.id === id);

/** A tablet with the worship look settled on stage. */
async function onWorship(app: App) {
  const t = await tablet(app);
  await waitFor(t.layout);
  assert.equal(await t.send({ type: 'look', id: 'worship', fade: 0 }), null);
  await waitFor(() => t.state()?.look === 'worship', 2000, 'worship on stage');
  return t;
}

test('a draft change reaches only that tablet, never the stage or another tablet', () => withApp(async (app) => {
  const a = await onWorship(app);
  const b = await tablet(app);
  assert.equal(await a.send({ type: 'blindStart' }), null);
  // The draft starts as a copy of the stage.
  const first = await waitFor(() => a.draft(), 2000, 'the first draft state');
  assert.equal(first.look, 'worship');
  assert.equal(first.groups['back-wall'].preset, 'back-purple');

  assert.equal(await a.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 } }), null);
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'groupLevel', group: 'audience', value: 0.4 } }), null);
  await waitFor(() => a.draft()?.groups['back-wall'].preset === 'back-amber', 2000, 'the draft to run amber');
  const draft = a.draft();
  assert.equal(draft.groups.audience.level, 0.4);
  assert.equal(draft.lookChanged, true);
  assert.equal(draft.canUndo, true);

  await sleep(300);
  // The stage, and what every tablet is told about it, is unchanged.
  for (const t of [a, b]) {
    assert.equal(t.state().groups['back-wall'].preset, 'back-purple');
    assert.equal(t.state().groups.audience.level, 1);
    assert.equal(t.state().lookChanged, false);
  }
  assert.equal(app.state?.groups['back-wall'].preset, 'back-purple');

  // The draft's picture goes to this tablet at the visualiser's rate, in the live picture's shape.
  const frames = a.draftVisuals();
  assert.ok(frames.length >= 3, `draft frames: ${frames.length}`);
  assert.equal(frames.at(-1)!.length, a.visuals.at(-1)!.length);
  assert.notDeepEqual(frames.at(-1), a.visuals.at(-1), 'the draft picture shows the draft, not the stage');

  // The other tablet never hears of the draft.
  assert.ok(!b.seen.some((m) => m.type === 'draftState' || m.type === 'draftVisual'));

  // What stays live is copied from the stage: Master here.
  assert.equal(await a.send({ type: 'master', value: 0.5 }), null);
  await waitFor(() => a.state()?.master === 0.5, 2000, 'Master to dim the stage');
  await waitFor(() => a.draft()?.master === 0.5, 2000, "the draft's Master to follow");
  assert.equal(a.draft().output, a.state().output);
  assert.equal(a.draft().outputProblem, a.state().outputProblem);
}));

test('Blind refuses what works on the real stage only, and needs Blind on', () => withApp(async (app) => {
  const show = (await api(app, 'GET', '/api/show')).body;
  show.groups.find((g: any) => g.id === 'pulpit').kind = 'smoke';
  assert.equal((await api(app, 'PUT', '/api/show', show)).status, 200);
  const t = await onWorship(app);

  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: 'back-amber' } }), BLIND_OFF);
  assert.equal(await t.send({ type: 'blindGo' }), BLIND_OFF);
  assert.equal(await t.send({ type: 'blindEnd' }), null, 'leaving Blind when it is off is harmless');

  assert.equal(await t.send({ type: 'blindStart' }), null);
  await waitFor(() => t.draft(), 2000, 'the draft');
  const live = [
    { type: 'master', value: 0.5 },
    { type: 'speed', value: 1.5 },
    { type: 'flash', groups: ['back-wall'], on: true },
    { type: 'blackout' },
    { type: 'manual', target: { group: 'back-wall' }, colour: '#ff0000' },
    { type: 'release', target: { group: 'back-wall' } },
    { type: 'releaseAll' },
    { type: 'fadeTime', value: 2 },
    { type: 'groupLevel', group: 'pulpit', value: 0.5 },
    { type: 'applyStage', stage: { look: null, groups: {}, levels: {} } },
  ];
  for (const cmd of live) assert.equal(await t.send({ type: 'draft', cmd }), REAL_STAGE_ONLY, cmd.type);
  // A light group's dimmer is the draft's.
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupLevel', group: 'audience', value: 0.5 } }), null);
  // A whole stage is only ever sent by Go.
  assert.equal(await t.send({ type: 'applyStage', stage: { look: null, groups: {}, levels: {} } }), 'Use Prepare and Go to send a whole stage.');
  assert.match(await t.send({ type: 'draft', cmd: { type: 'saveItem', id: 'worship' } }) ?? '', /^invalid command/);
  assert.match(await t.send({ type: 'draft', cmd: { type: 'draft', cmd: { type: 'safe' } } }) ?? '', /^invalid command/);

  // Nothing above reached the stage.
  await sleep(200);
  assert.equal(t.state().master, 1);
  assert.equal(t.state().look, 'worship');
  assert.deepEqual(t.state().flashing, []);
}));

test('Save, Add song and Save as quick look in Blind store the draft, not the stage', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  await waitFor(() => t.state()?.look === song, 2000, 'the song on stage');
  const liveWall = t.state().groups['back-wall'].preset;
  const liveTempo = t.state().tempo;

  assert.equal(await t.send({ type: 'blindStart' }), null);
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 } }), null);
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupLevel', group: 'audience', value: 0.3 } }), null);
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'tempo', bpm: 90 } }), null);
  assert.notEqual(liveTempo, 90);

  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  const look = savedLook(dir, song)!;
  assert.deepEqual(look.groups.find((e) => e.group === 'back-wall'), { group: 'back-wall', preset: 'back-amber', level: 1 });
  assert.equal(look.groups.find((e) => e.group === 'audience')!.level, 0.3);
  assert.equal(look.tempo, 90);

  assert.equal(await t.send({ type: 'addSong', after: song }), null);
  const added = await waitFor(() => t.order().length > 0 && t.order()[2] !== undefined && savedLook(dir, t.order()[2]!), 2000, 'the new song');
  assert.equal(added.groups.find((e) => e.group === 'back-wall')!.preset, 'back-amber');

  assert.equal(await t.send({ type: 'saveQuickLook', name: 'Amber wall', tab: 'plain', groups: ['back-wall'] }), null);
  const quick = savedShow(dir).looks.find((l) => l.name === 'Amber wall')!;
  assert.equal(quick.groups.find((e) => e.group === 'back-wall')!.preset, 'back-amber');

  // The stage still runs what it ran; the draft is still the draft.
  await sleep(150);
  assert.equal(t.state().groups['back-wall'].preset, liveWall);
  assert.equal(t.state().tempo, liveTempo);
  assert.equal(t.draft().groups['back-wall'].preset, 'back-amber');
}));

test('Prepare: a song started in the draft is what Save stores, Live drops it, and the other tablet never sees it', () => withApp(async (app, dir) => {
  const a = await onWorship(app);
  const b = await tablet(app);
  await waitFor(b.state);
  const song = a.order().find((id) => id !== 'worship' && id !== a.layout().basicLights)!;
  const before = savedLook(dir, song)!;
  const worshipBefore = savedLook(dir, 'worship')!;

  // Prepare on, then a running-order tap: the draft starts the song, the stage keeps worship.
  assert.equal(await a.send({ type: 'blindStart' }), null);
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'look', id: song, fade: 0 } }), null);
  await waitFor(() => a.draft()?.look === song, 2000, 'the draft on the song');
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 } }), null);
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'groupLevel', group: 'audience', value: 0.35 } }), null);
  await waitFor(() => a.draft()?.groups.audience.level === 0.35, 2000, 'the draft change');

  // Save to the song stores the draft in it, without touching the lights.
  assert.equal(await a.send({ type: 'saveItem', id: song }), null);
  const saved = savedLook(dir, song)!;
  assert.equal(saved.groups.find((e) => e.group === 'back-wall')!.preset, 'back-amber');
  assert.equal(saved.groups.find((e) => e.group === 'audience')!.level, 0.35);
  assert.notDeepEqual(saved.groups, before.groups);
  assert.deepEqual(savedLook(dir, 'worship')!.groups, worshipBefore.groups, 'the song on stage is not changed');
  await sleep(150);
  for (const t of [a, b]) {
    assert.equal(t.state().look, 'worship');
    assert.equal(t.state().groups['back-wall'].preset, 'back-purple');
    assert.equal(t.state().groups.audience.level, 1);
  }

  // Live drops the draft: no Go, no more draft states, the stage as it was.
  assert.equal(await a.send({ type: 'blindEnd' }), null);
  assert.equal(app.drafts, 0);
  assert.equal(await a.send({ type: 'blindGo' }), BLIND_OFF);
  const drafts = a.seen.filter((m) => m.type === 'draftState').length;
  await sleep(200);
  assert.equal(a.seen.filter((m) => m.type === 'draftState').length, drafts, 'no more draft states');
  assert.equal(b.state().look, 'worship');
  assert.equal(b.state().groups['back-wall'].preset, 'back-purple');

  // The other tablet never heard of the draft.
  assert.ok(!b.seen.some((m) => m.type === 'draftState' || m.type === 'draftVisual' || m.type === 'draftEnded'));
}));

test('Go sends the draft to the stage with the Fade setting, as one Undo step, and ends Blind', () => withApp(async (app) => {
  const a = await onWorship(app);
  const b = await tablet(app);
  assert.equal(await a.send({ type: 'fadeTime', value: 1 }), null);
  assert.equal(await a.send({ type: 'blindStart' }), null);
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 } }), null);
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'groupColour', group: 'front-wash', colour: '#12ab34', fade: 0 } }), null);
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'groupLevel', group: 'audience', value: 0.4 } }), null);
  await waitFor(() => a.draft()?.groups.audience.level === 0.4, 2000, 'the draft');

  assert.equal(await a.send({ type: 'blindGo' }), null);
  // It fades with the operator's Fade setting (1 s), not at once.
  const fading = await waitFor(() => b.state()?.groups['back-wall'].preset === 'back-amber' && b.state(), 2000, 'Go to reach the stage');
  assert.ok(fading.groups['back-wall'].progress < 1, `progress ${fading.groups['back-wall'].progress}`);
  await waitFor(() => b.state()?.groups['back-wall'].progress === 1, 3000, 'the fade to settle');
  const sent = b.state();
  assert.equal(sent.groups['front-wash'].preset, 'live:front-wash:#12ab34');
  assert.equal(sent.groups.audience.level, 0.4);
  assert.equal(sent.look, 'worship');
  assert.equal(sent.lookChanged, true);

  // Blind is over for that tablet.
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'safe' } }), BLIND_OFF);
  const drafts = a.seen.filter((m) => m.type === 'draftState').length;
  await sleep(200);
  assert.equal(a.seen.filter((m) => m.type === 'draftState').length, drafts, 'no more draft states');

  // One Undo, from any tablet, takes the whole change back.
  assert.equal(await b.send({ type: 'undo' }), null);
  await waitFor(() => b.state()?.groups['back-wall'].preset === 'back-purple', 2000, 'Undo to bring back purple');
  await waitFor(() => b.state()?.groups.audience.level === 1, 2000, 'Undo to bring back the dimmer');
  assert.notEqual(b.state().groups['front-wash'].preset, 'live:front-wash:#12ab34');
  assert.equal(b.state().lookChanged, false);
}));

test('a tablet that closes or leaves Blind drops its draft, and nothing changes on stage', () => withApp(async (app) => {
  const watch = await onWorship(app);
  const a = await tablet(app);
  assert.equal(await a.send({ type: 'blindStart' }), null);
  assert.equal(await a.send({ type: 'draft', cmd: { type: 'look', id: 'prayer', fade: 0 } }), null);
  await waitFor(() => a.draft()?.look === 'prayer', 2000, 'the draft on prayer');
  assert.equal(app.drafts, 1);

  a.ws.close();
  await waitFor(() => app.drafts === 0, 2000, 'the draft to be dropped');
  await sleep(200);
  assert.equal(watch.state().look, 'worship');
  assert.equal(watch.state().groups['back-wall'].preset, 'back-purple');

  // blindEnd throws the draft away too.
  assert.equal(await watch.send({ type: 'blindStart' }), null);
  assert.equal(await watch.send({ type: 'draft', cmd: { type: 'look', id: 'prayer', fade: 0 } }), null);
  assert.equal(app.drafts, 1);
  assert.equal(await watch.send({ type: 'blindEnd' }), null);
  assert.equal(app.drafts, 0);
  assert.equal(await watch.send({ type: 'blindGo' }), BLIND_OFF);
  await sleep(200);
  assert.equal(watch.state().look, 'worship');
}));

test('Undo in a draft undoes the draft only, and a second Blind start makes a fresh draft', () => withApp(async (app) => {
  const t = await onWorship(app);
  assert.equal(await t.send({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 }), null);
  await waitFor(() => t.state()?.groups['back-wall'].preset === 'back-amber', 2000, 'amber on stage');

  assert.equal(await t.send({ type: 'blindStart' }), null);
  const fresh = await waitFor(() => t.draft(), 2000, 'the draft');
  assert.equal(fresh.canUndo, false, "the draft has no steps of its own yet");
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 } }), null);
  await waitFor(() => t.draft()?.groups.audience.preset === 'aud-blue', 2000, 'the draft to run blue');
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'undo' } }), null);
  await waitFor(() => t.draft()?.groups.audience.preset === 'aud-low', 2000, "draft Undo to bring back worship's audience");
  assert.equal(t.draft().groups['back-wall'].preset, 'back-amber', "the stage's own step is not the draft's");
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'undo' } }), 'nothing to undo');
  await sleep(150);
  assert.equal(t.state().groups['back-wall'].preset, 'back-amber');
  assert.equal(t.state().canUndo, true);

  // Starting Blind again throws the draft away and copies the stage afresh.
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'look', id: 'prayer', fade: 0 } }), null);
  await waitFor(() => t.draft()?.look === 'prayer', 2000, 'the draft on prayer');
  assert.equal(await t.send({ type: 'blindStart' }), null);
  await waitFor(() => t.draft()?.look === 'worship', 2000, 'a fresh draft of the stage');
  assert.equal(t.draft().groups['back-wall'].preset, 'back-amber');
  assert.equal(app.drafts, 1);
}));

test('a draft follows show edits, and a session runs on the clock it is given', () => withApp(async (app, dir) => {
  const show = savedShow(dir);
  const runtime = { look: 'worship', groups: {}, levels: {}, master: 1, speed: 1 };
  const session = new BlindSession(show, runtime, { beats: 123.5, seconds: 61.75 }, 10);
  assert.deepEqual(session.engine.stageClock(), { beats: 123.5, seconds: 61.75 });

  const t = await onWorship(app);
  assert.equal(await t.send({ type: 'blindStart' }), null);
  await waitFor(() => t.draft(), 2000, 'the draft');
  // A colour added while in Blind can be used in the draft straight away.
  assert.equal(await t.send({ type: 'addColour', group: 'back-wall', colour: '#123456', name: 'Navy', allGroups: false }), null);
  const navy = savedShow(dir).presets.find((p) => p.name === 'Navy' && p.group === 'back-wall')!;
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: navy.id, fade: 0 } }), null);
  await waitFor(() => t.draft()?.groups['back-wall'].preset === navy.id, 2000, 'the draft to run the new colour');
}));

test('a draft picks up the live stage clock, so an effect on stage looks the same in the draft', () => withApp(async (app) => {
  const t = await onWorship(app);
  const wave = {
    kind: 'effect', effect: 'wave', colours: [{ hex: '#ff0000' }, { hex: '#0000ff' }], speed: { beats: 16 },
    direction: 'ltr', waves: 3, size: 0.5, edge: 'soft', intensity: 1,
  };
  assert.equal(await t.send({ type: 'groupEffect', group: 'back-wall', effect: wave, fade: 0 }), null);
  // Long enough for the stage clock to be well away from a fresh engine's.
  await sleep(1500);
  assert.equal(await t.send({ type: 'blindStart' }), null);
  await waitFor(() => t.draftVisuals().length >= 3, 2000, 'draft frames');
  const live = t.visuals.at(-1)!;
  const draft = t.draftVisuals().at(-1)!;
  let diff = 0;
  for (let i = 0; i < live.length; i++) diff += Math.abs(live[i]! - draft[i]!);
  // In step, the two pictures differ by a few levels at most (they are up to a frame or two apart); a draft on
  // its own clock is a good part of a wave off (about 28 levels on average here).
  assert.ok(diff / live.length < 8, `mean difference ${diff / live.length}`);
}));

test('Save in Blind works for a draft made during Blackout: lit groups keep their colours, the rest are Off', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'blackout' }), null);
  await waitFor(() => t.state()?.look === 'blackout', 2000, 'Blackout on stage');
  const refused = 'Blackout is on. Bring the lights back, then save.';
  assert.equal(await t.send({ type: 'saveItem', id: song }), refused, 'outside Blind, Save is still refused');

  assert.equal(await t.send({ type: 'blindStart' }), null);
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 } }), null);
  await waitFor(() => t.draft()?.groups['back-wall'].preset === 'back-amber', 2000, 'the draft to run amber');
  assert.equal(t.draft().look, 'blackout');

  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  const show = savedShow(dir);
  const look = show.looks.find((l) => l.id === song)!;
  const nameOf = (id: string) => show.presets.find((p) => p.id === id)?.name;
  assert.equal(look.groups.find((e) => e.group === 'back-wall')!.preset, 'back-amber');
  for (const g of ['front-wash', 'audience', 'pulpit']) assert.equal(nameOf(look.groups.find((e) => e.group === g)!.preset), 'Off', g);

  assert.equal(await t.send({ type: 'addSong', after: song }), null);
  const added = await waitFor(() => t.order()[2] !== undefined && savedLook(dir, t.order()[2]!), 2000, 'the new song');
  assert.equal(added.groups.find((e) => e.group === 'back-wall')!.preset, 'back-amber');
  assert.equal(await t.send({ type: 'saveQuickLook', name: 'Amber wall', tab: 'plain', groups: ['back-wall'] }), null);
  assert.equal(savedShow(dir).looks.find((l) => l.name === 'Amber wall')!.groups[0]!.preset, 'back-amber');

  // The stage stays in Blackout.
  await sleep(150);
  assert.equal(t.state().look, 'blackout');
}));

/** The service still answers: a stage command from the tablet and an HTTP GET. */
async function stillServing(app: App, t: Awaited<ReturnType<typeof tablet>>) {
  assert.equal(await t.send({ type: 'look', id: 'prayer', fade: 0 }), null);
  await waitFor(() => t.state()?.look === 'prayer', 2000, 'prayer on stage');
  const show = await api(app, 'GET', '/api/show');
  assert.equal(show.status, 200);
  assert.ok(show.body.groups.length > 0);
}

const ended = (t: Awaited<ReturnType<typeof tablet>>) => t.seen.filter((m) => m.type === 'draftEnded');

test("a problem in a draft's frame ends that draft only; the service keeps running", (ctx) => {
  const logged: string[] = [];
  return withApp(async (app) => {
    const a = await onWorship(app);
    const b = await onWorship(app);
    assert.equal(await a.send({ type: 'blindStart' }), null);
    assert.equal(await b.send({ type: 'blindStart' }), null);
    await waitFor(() => a.draft() && b.draft(), 2000, 'both drafts');
    // Only a's draft breaks.
    const aSession = (app as any).blind.get([...(app as any).blind.keys()][0]) as BlindSession;
    const visual = BlindSession.prototype.visual;
    ctx.mock.method(BlindSession.prototype, 'visual', function (this: BlindSession, now: number) {
      if (this === aSession) throw new Error('test: the draft broke');
      return visual.call(this, now);
    });
    const msg = await waitFor(() => ended(a)[0], 2000, 'a to be told');
    assert.equal(msg.reason, BLIND_PROBLEM);
    assert.equal(app.drafts, 1, "b's draft keeps going");
    assert.equal(ended(b).length, 0);
    assert.ok(logged.some((m) => m.includes('test: the draft broke')), 'the problem is logged');
    assert.equal(await a.send({ type: 'draft', cmd: { type: 'safe' } }), BLIND_OFF);
    // The lights were not touched.
    assert.equal(a.state().look, 'worship');
    assert.equal(a.state().lookChanged, false);
    await stillServing(app, a);
  }, (m) => logged.push(m));
});

test('a problem while running a draft command answers it and ends the draft', (ctx) => withApp(async (app) => {
  const t = await onWorship(app);
  assert.equal(await t.send({ type: 'blindStart' }), null);
  ctx.mock.method(BlindSession.prototype, 'apply', () => { throw new Error('test: apply broke'); });
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 } }), BLIND_PROBLEM);
  assert.equal(ended(t).length, 1);
  assert.equal(app.drafts, 0);
  await sleep(100);
  assert.equal(t.state().groups['back-wall'].preset, 'back-purple', 'the lights were not changed');
  await stillServing(app, t);
}));

test('a problem making a draft refuses the start, and the service keeps running', (ctx) => withApp(async (app) => {
  const t = await onWorship(app);
  // Only this thread's engines are stubbed: the drafts'. The live engine runs on the worker.
  ctx.mock.method(Engine.prototype, 'restore', () => { throw new Error('test: restore broke'); });
  assert.equal(await t.send({ type: 'blindStart' }), BLIND_PROBLEM);
  assert.equal(app.drafts, 0);
  await stillServing(app, t);
}));

test('a problem as a draft takes a show edit ends that draft, and the edit still goes through', (ctx) => withApp(async (app, dir) => {
  const t = await onWorship(app);
  assert.equal(await t.send({ type: 'blindStart' }), null);
  await waitFor(() => t.draft(), 2000, 'the draft');
  ctx.mock.method(BlindSession.prototype, 'setShow', () => { throw new Error('test: setShow broke'); });
  const layouts = t.seen.filter((m) => m.type === 'layout').length;
  assert.equal(await t.send({ type: 'addColour', group: 'back-wall', colour: '#123456', name: 'Navy', allGroups: false }), null);
  assert.ok(savedShow(dir).presets.some((p) => p.name === 'Navy'), 'the colour is saved');
  assert.ok(t.seen.filter((m) => m.type === 'layout').length > layouts, 'every device is sent the new layout');
  assert.equal(ended(t).length, 1);
  assert.equal(app.drafts, 0);
  await stillServing(app, t);
}));

test('leaving Blind while its start waits for the stage makes no draft', () => withApp(async (app) => {
  const t = await onWorship(app);
  // The stage takes a while to answer, so the end arrives first.
  const liveStage = (app as any).liveStage.bind(app);
  (app as any).liveStage = async () => { await sleep(150); return liveStage(); };
  const start = t.send({ type: 'blindStart' });
  assert.equal(await t.send({ type: 'blindEnd' }), null);
  assert.equal(await start, null);
  await sleep(200);
  assert.equal(app.drafts, 0);
  assert.ok(!t.seen.some((m) => m.type === 'draftState'), 'no draft was ever sent');

  // A newer start wins over an older one still on its way, and Blind then works.
  const first = t.send({ type: 'blindStart' });
  const second = t.send({ type: 'blindStart' });
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.equal(app.drafts, 1);
  assert.equal(t.seen.filter((m) => m.type === 'draftState').length, 1, 'one draft, from the newer start');
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'look', id: 'prayer', fade: 0 } }), null);
  await waitFor(() => t.draft()?.look === 'prayer', 2000, 'the draft on prayer');
}));

test('at most six tablets are in Blind at once', () => withApp(async (app) => {
  const tablets = await Promise.all(Array.from({ length: 7 }, () => tablet(app)));
  for (const t of tablets.slice(0, 6)) assert.equal(await t.send({ type: 'blindStart' }), null);
  assert.equal(app.drafts, 6);
  const seventh = tablets[6]!;
  assert.equal(await seventh.send({ type: 'blindStart' }), TOO_MANY);
  assert.equal(app.drafts, 6);
  // A tablet already in Blind can still start afresh.
  assert.equal(await tablets[0]!.send({ type: 'blindStart' }), null);
  assert.equal(app.drafts, 6);
  // Once one leaves, there is room again.
  assert.equal(await tablets[1]!.send({ type: 'blindEnd' }), null);
  assert.equal(await seventh.send({ type: 'blindStart' }), null);
  assert.equal(app.drafts, 6);
}));

test('Update from the stage in Blind stores the draft, not the stage', () => withApp(async (app, dir) => {
  const t = await onWorship(app);
  const quick = t.layout().quickLooks[0];
  const liveWall = t.state().groups['back-wall'].preset;
  assert.equal(await t.send({ type: 'blindStart' }), null);
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 } }), null);
  assert.equal(await t.send({ type: 'draft', cmd: { type: 'groupLevel', group: 'audience', value: 0.3 } }), null);
  await waitFor(() => t.draft()?.groups['back-wall'].preset === 'back-amber', 2000, 'the draft to run amber');
  assert.notEqual(liveWall, 'back-amber');

  assert.equal(await t.send({ type: 'editQuickLook', look: quick.id, fromStage: true }), null);
  const entries = savedLook(dir, quick.id)!.groups;
  assert.equal(entries.find((e) => e.group === 'back-wall')!.preset, 'back-amber');
  assert.equal(entries.find((e) => e.group === 'audience')!.level, 0.3);
  // Rename, move and delete are fine in Blind too, and the stage keeps running what it ran.
  assert.equal(await t.send({ type: 'editQuickLook', look: quick.id, name: 'Draft look' }), null);
  assert.equal(await t.send({ type: 'moveQuickLook', look: quick.id, to: 3 }), null);
  assert.equal(await t.send({ type: 'deleteQuickLook', look: quick.id }), null);
  assert.equal(savedLook(dir, quick.id), undefined);
  await sleep(150);
  assert.equal(t.state().groups['back-wall'].preset, liveWall);
}));
