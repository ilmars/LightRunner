// Auto-follow and sections on stage, through the App: the presentation app's slides make the lights follow, a tap
// by hand pauses it, and moving between sections of one song changes only colours and levels. A fake planning
// service and a fake socket stand in, so nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { FakePlanning } from '../src/planning/fake.ts';
import type { WebSocketLike } from '../src/planning/live.ts';
import { ensureSectionLook, sectionsOf, type LiveSlide, type PlannedService, type Show } from '../../packages/shared/src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const SERVICE = 'svc-a';

const item = (key: string, kind: PlannedService['items'][number]['kind'], name: string, extra: object = {}) => ({ key, kind, name, ...extra });

function planned(): FakePlanning {
  const fake = new FakePlanning();
  fake.accountList = [{ id: 'acc1', name: 'Church' }];
  fake.types = [{ id: 'type1', name: 'Sunday service' }];
  fake.plannedServices = [{
    id: SERVICE, type: 'type1', title: 'Sunday service', start: '2099-01-04T08:00:00',
    items: [
      item('c1', 'header', 'Slavēšana'),
      item('c2', 'song', 'Song One', { songId: S1, sections: [{ kind: 'verse', slides: ['v1', 'v2'] }, { kind: 'chorus', slides: ['ch1', 'ch2'] }] }),
      item('c3', 'verse', 'Psalm 23'),
      item('c4', 'song', 'Song Two', { songId: S2, sections: [{ kind: 'verse', slides: ['w1'] }, { kind: 'chorus', slides: ['x1'] }] }),
    ],
  }];
  return fake;
}

class FakeSocket implements WebSocketLike {
  closed = false;
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  send(): void {}
  close(): void {
    this.closed = true;
  }
  /** What Pusher sends: the data is a JSON string. */
  receive(event: string, data: unknown, channel?: string): void {
    this.onmessage!({ data: JSON.stringify({ event, ...(channel ? { channel } : {}), data: JSON.stringify(data) }) });
  }
}

const PRESENTER = 'ABC123';

/** The live connection's newest socket goes through Pusher's handshake and a presentation computer joins: the state is open. */
async function presenterOpen(app: App, sockets: FakeSocket[]): Promise<FakeSocket> {
  const ws = await waitFor(() => sockets.at(-1)?.onmessage && sockets.at(-1), 'a live socket');
  ws.receive('pusher:connection_established', { socket_id: '1.2', activity_timeout: 120 });
  ws.receive('pusher_internal:subscription_succeeded', { presence: { hash: { [PRESENTER]: { client: 'weDesktop', machineName: 'Stage Mac' } } } }, 'presence-acc1');
  await sleep(20);
  ws.receive('pusher_internal:subscription_succeeded', {}, `private-acc1.${PRESENTER}`);
  await waitFor(() => app.state?.follow?.live.state === 'open', 'the presentation app open');
  return ws;
}

interface Tablet {
  command: (cmd: unknown) => Promise<string | null>;
  /** Sends any message with a ref (a timeline Start) and gives the error of its result, or null. */
  send: (msg: Record<string, unknown>) => Promise<string | null>;
  /** The last draft state this tablet was sent. */
  draft: () => any;
  close: () => void;
}

interface Rig {
  app: App;
  fake: FakePlanning;
  dir: string;
  sockets: FakeSocket[];
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  tablet: () => Promise<Tablet>;
  /** The looks of the loaded songs, by item key. */
  songs: Record<string, string>;
}

async function startApp(dir: string, fake: FakePlanning, sockets: FakeSocket[]): Promise<App> {
  const app = new App({
    port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {}, planning: fake,
    liveOpen: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  await app.start();
  await waitFor(() => app.state, 'the first state');
  return app;
}

/** Planning on, a service loaded, and its songs given known looks. `shape` changes the show before it is set. */
async function withFollow(fn: (rig: Rig) => Promise<void>, opts: { dir?: string; load?: boolean; shape?: (show: Show, songs: Record<string, string>) => Show } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'light-runner-follow-'));
  const fake = planned();
  fake.login = 'made-up-login';
  const sockets: FakeSocket[] = [];
  const app = await startApp(dir, fake, sockets);
  const ws: WebSocket[] = [];
  try {
    const url = `http://127.0.0.1:${app.port}`;
    const call: Rig['call'] = async (method, path, body) => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() as any };
    };
    const tablet: Rig['tablet'] = async () => {
      const socket = new WebSocket(`${url.replace('http', 'ws')}/ws`);
      ws.push(socket);
      let draft: any = null;
      socket.on('message', (data, binary) => {
        if (binary) return;
        const msg = JSON.parse(String(data));
        if (msg.type === 'draftState') draft = msg.state;
      });
      await new Promise((r) => socket.once('open', r));
      let ref = 0;
      const send = (message: Record<string, unknown>) => new Promise<string | null>((resolve) => {
        const mine = ++ref;
        socket.on('message', function on(data, binary) {
          if (binary) return;
          const msg = JSON.parse(String(data));
          if (msg.type === 'result' && msg.ref === mine) {
            socket.off('message', on);
            resolve(msg.error);
          }
        });
        socket.send(JSON.stringify({ ...message, ref: mine }));
      });
      const command = (cmd: unknown) => send({ type: 'command', cmd });
      return { command, send, draft: () => draft, close: () => socket.close() };
    };
    const songs: Record<string, string> = {};
    if (opts.load !== false) {
      const r = await call('PUT', '/api/settings', { planning: { enabled: true, account: 'acc1', serviceType: 'type1' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await app.command({ type: 'loadService', id: SERVICE }, 'operator'), null);
      let show = (await call('GET', '/api/show')).body as Show;
      for (const i of show.operator.service!.items) if (i.kind === 'song') songs[i.key] = i.look!;
      // Known looks: Song One is "worship" (no pulpit), Song Two is "word".
      const copy = (to: string, from: string) => {
        const look = show.looks.find((l) => l.id === to)!;
        const source = show.looks.find((l) => l.id === from)!;
        look.groups = structuredClone(source.groups);
        delete look.tempo;
        delete look.timeline;
      };
      copy(songs.c2!, 'worship');
      copy(songs.c4!, 'word');
      show.looks.find((l) => l.id === songs.c2)!.tempo = 80;
      if (opts.shape) show = opts.shape(show, songs);
      await app.setShow(show);
    }
    await fn({ app, fake, dir, sockets, call, tablet, songs });
  } finally {
    for (const s of ws) s.close();
    await app.stop();
    if (!opts.dir) rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor<T>(get: () => T | null | undefined | false, what = 'a condition', ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** The chorus of Song One gets a look of its own: the back wall amber and the audience blue. */
function chorusLook(show: Show, songs: Record<string, string>): Show {
  const made = ensureSectionLook(show, { song: songs.c2!, kind: 'chorus' });
  const look = made.show.looks.find((l) => l.id === made.id)!;
  look.groups = look.groups.map((e) =>
    e.group === 'back-wall' ? { ...e, preset: 'back-amber' } : e.group === 'audience' ? { ...e, preset: 'aud-blue' } : e);
  return made.show;
}

/** Song One also runs a timeline that drives the audience. */
function withTimeline(show: Show, songs: Record<string, string>): Show {
  show = chorusLook(show, songs);
  show.timelines.push({
    id: 'song-one-tl', name: 'Song One', markers: [], offsetMs: 0, loop: true,
    // Ten minutes long, so it is still running while the test looks.
    layers: [{ group: 'audience', blocks: [
      { id: 'b1', start: 0, rise: 0, what: { kind: 'colour', preset: 'aud-warm', level: 1 } },
      { id: 'b2', start: 600, rise: 0, what: { kind: 'colour', preset: 'aud-warm', level: 1 } },
    ] }],
  });
  show.looks.find((l) => l.id === songs.c2)!.timeline = 'song-one-tl';
  return show;
}

const slide = (cue: string, id: string | null, name = 'Song One'): LiveSlide => ({ service: SERVICE, cue, slide: id, name });
const presetOf = (app: App, group: string) => app.state!.groups[group]?.preset;

async function followOn(app: App) {
  assert.equal(await app.command({ type: 'autoFollow', on: true }, 'operator'), null);
  await waitFor(() => app.state?.follow?.on === true, 'Auto-follow on');
}

// ---- Following ----

test("a song's slide starts its look with the operator's Fade", () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  assert.equal(await app.command({ type: 'fadeTime', value: 2 }, 'operator'), null);
  await app.liveSlide(slide('c2', null));
  const state = await waitFor(() => app.state?.look === songs.c2 && app.state, 'Song One on stage');
  assert.ok(state.lookFadeLeft > 0, `fade left ${state.lookFadeLeft}`);
  assert.equal(state.section, null);
  assert.equal(state.follow?.on, true);
  assert.deepEqual(state.follow?.note, { item: 'Song One', section: null, kind: 'look' });
}));

test("a chorus slide starts the chorus's colours and levels; the song, its tempo and its running timeline carry on", () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'v1'));
  await waitFor(() => app.state?.look === songs.c2 && app.state.timeline, 'Song One and its timeline');
  assert.deepEqual(app.state!.section, { song: songs.c2, kind: 'verse', changed: false });
  const run = app.state!.timeline!.run;
  assert.equal(await app.command({ type: 'tempo', bpm: 99 }, 'operator'), null);
  await waitFor(() => app.state?.tempo === 99, 'the tapped tempo');
  assert.equal(app.state!.follow?.on, true, 'a tempo does not pause it');

  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => presetOf(app, 'back-wall') === 'back-amber', "the chorus's back wall");
  const state = app.state!;
  assert.deepEqual(state.section, { song: songs.c2, kind: 'chorus', changed: false });
  assert.equal(state.look, songs.c2, 'the song stays the look on stage');
  assert.equal(state.tempo, 99, 'the tempo carries on');
  assert.equal(state.timeline?.run, run, 'the timeline keeps running from where it was');
  assert.equal(presetOf(app, 'audience'), 'aud-warm', 'the group the timeline drives stays the timeline\'s');
  assert.equal(presetOf(app, 'front-wash'), 'front-warm');
  assert.deepEqual(state.follow?.note, { item: 'Song One', section: 'chorus', kind: 'look' });

  // Another slide of the same chorus changes nothing.
  await app.liveSlide(slide('c2', 'ch2'));
  assert.equal(app.state!.timeline?.run, run);
  assert.deepEqual(app.state!.follow?.note, { item: 'Song One', section: 'chorus', kind: 'nothing' });
}, { shape: withTimeline }));

test("a section of a song not on stage starts the song first, then the section", () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.look === songs.c2 && presetOf(app, 'back-wall') === 'back-amber' && app.state.timeline, 'Song One, chorus');
  assert.equal(app.state!.tempo, 80, "the song's own tempo");
  assert.deepEqual(app.state!.section, { song: songs.c2, kind: 'chorus', changed: false });
  // The timeline the song started keeps the audience.
  await sleep(100);
  assert.equal(presetOf(app, 'audience'), 'aud-warm');
}, { shape: withTimeline }));

test('the section command does the same as following, and pauses Auto-follow', () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', null));
  await waitFor(() => app.state?.look === songs.c2 && app.state.timeline, 'Song One');
  const run = app.state!.timeline!.run;
  await app.command({ type: 'tempo', bpm: 101 }, 'operator');
  assert.equal(await app.command({ type: 'section', song: songs.c2, kind: 'chorus' }, 'operator'), null);
  await waitFor(() => presetOf(app, 'back-wall') === 'back-amber', "the chorus's back wall");
  const state = app.state!;
  assert.deepEqual(state.section, { song: songs.c2, kind: 'chorus', changed: false });
  assert.equal(state.look, songs.c2);
  assert.equal(state.tempo, 101);
  assert.equal(state.timeline?.run, run);
  assert.equal(presetOf(app, 'audience'), 'aud-warm');
  assert.equal(state.follow?.on, false, 'a tap by hand pauses Auto-follow');

  // Paused: a slide changes nothing.
  await app.liveSlide(slide('c4', null, 'Song Two'));
  await sleep(60);
  assert.equal(app.state!.look, songs.c2);

  // Wrong sections are refused in plain words and change nothing.
  assert.match((await app.command({ type: 'section', song: songs.c2, kind: 'bridge' }, 'operator'))!, /no bridge/);
  assert.match((await app.command({ type: 'section', song: 'worship', kind: 'chorus' }, 'operator'))!, /isn't a song/);
}, { shape: withTimeline }));

test('Auto-follow switched off follows nothing; switched on, the slide on screen now starts at once', () => withFollow(async ({ app, songs, sockets }) => {
  await presenterOpen(app, sockets);
  await followOn(app);
  assert.equal(await app.command({ type: 'autoFollow', on: false }, 'operator'), null);
  await waitFor(() => app.state?.follow?.on === false, 'off');
  const before = app.state!.look;
  await app.liveSlide(slide('c4', null, 'Song Two'));
  await sleep(60);
  assert.equal(app.state!.look, before);
  assert.notEqual(before, songs.c4);
  assert.equal(await app.command({ type: 'autoFollow', on: true }, 'operator'), null);
  await waitFor(() => app.state?.look === songs.c4, 'Song Two on stage once switched on');
  assert.equal(app.state!.follow?.on, true);
  assert.equal(app.state!.canUndo, true);
}));

test('what starts something by hand pauses Auto-follow; Master, colours, levels, Flash, Undo, Fade and tempo do not', () => withFollow(async ({ app, songs, tablet }) => {
  const t = await tablet();
  const pauses: [string, () => Promise<string | null>][] = [
    ['look', () => app.command({ type: 'look', id: songs.c2! }, 'operator')],
    ['quickLook', () => app.command({ type: 'quickLook', id: 'prayer' }, 'operator')],
    ['section', () => app.command({ type: 'section', song: songs.c2!, kind: 'verse' }, 'operator')],
    ['safe', () => app.command({ type: 'safe' }, 'operator')],
    ['blackout', () => app.command({ type: 'blackout' }, 'operator')],
    ['blindGo', async () => (await t.command({ type: 'blindStart' })) ?? t.command({ type: 'blindGo' })],
    ['device next', () => app.device({ kind: 'next' }, 'test')],
  ];
  for (const [name, run] of pauses) {
    await followOn(app);
    assert.equal(await run(), null, name);
    await waitFor(() => app.state?.follow?.on === false, `${name} pausing Auto-follow`);
  }
  await app.command({ type: 'look', id: songs.c2! }, 'operator');
  const stays: [string, unknown][] = [
    ['master', { type: 'master', value: 0.8 }],
    ['groupLevel', { type: 'groupLevel', group: 'back-wall', value: 0.5 }],
    ['groupPreset', { type: 'groupPreset', group: 'back-wall', preset: 'back-amber' }],
    ['flash', { type: 'flash', groups: ['back-wall'], on: true }],
    ['flash off', { type: 'flash', groups: ['back-wall'], on: false }],
    ['undo', { type: 'undo' }],
    ['fadeTime', { type: 'fadeTime', value: 3 }],
    ['tempo', { type: 'tempo', bpm: 70 }],
  ];
  await followOn(app);
  for (const [name, cmd] of stays) {
    assert.equal(await app.command(cmd, 'operator'), null, name);
    await sleep(30);
    assert.equal(app.state!.follow?.on, true, `${name} leaves Auto-follow on`);
  }
  t.close();
}));

test("a tablet preparing doesn't pause Auto-follow, and a followed slide leaves its draft alone", () => withFollow(async ({ app, songs, tablet }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  const t = await tablet();
  assert.equal(await t.command({ type: 'blindStart' }), null);
  assert.equal(await t.command({ type: 'draft', cmd: { type: 'look', id: 'prayer' } }), null);
  await waitFor(() => t.draft()?.look === 'prayer', 'the draft on prayer');
  assert.equal(app.state!.follow?.on, true);
  const draftBefore = JSON.stringify(Object.entries(t.draft().groups).map(([g, v]: [string, any]) => [g, v.preset, v.level]));
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.look === songs.c2 && presetOf(app, 'back-wall') === 'back-amber', 'the chorus live');
  await sleep(150);
  const draft = t.draft();
  assert.equal(draft.look, 'prayer');
  assert.equal(JSON.stringify(Object.entries(draft.groups).map(([g, v]: [string, any]) => [g, v.preset, v.level])), draftBefore);
  assert.equal(draft.section, null, "the draft has no section: it is prayer's");
  assert.equal(draft.follow?.on, true, 'the pill shows the live Auto-follow');

  // A section in Prepare acts on the draft and doesn't pause Auto-follow.
  assert.equal(await t.command({ type: 'section', song: songs.c4!, kind: 'chorus' }), null);
  await waitFor(() => t.draft()?.look === songs.c4 && t.draft()?.section?.kind === 'chorus', "the draft on Song Two's chorus");
  assert.deepEqual(t.draft().section, { song: songs.c4, kind: 'chorus', changed: false });
  assert.equal(app.state!.look, songs.c2, 'the stage is untouched');
  assert.deepEqual(app.state!.section, { song: songs.c2, kind: 'chorus', changed: false });
  assert.equal(app.state!.follow?.on, true);

  // Go: the draft's section is the section on stage.
  assert.equal(await t.command({ type: 'blindGo' }), null);
  await waitFor(() => app.state?.look === songs.c4 && app.state.section?.song === songs.c4, "Song Two's chorus on stage");
  assert.deepEqual(app.state!.section, { song: songs.c4, kind: 'chorus', changed: false });
  assert.equal(app.state!.follow?.on, false, 'Go pauses Auto-follow');
  t.close();
}, { shape: chorusLook }));

test("a section's changed turns true when one of its groups is changed, and false again with a new section", () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus' && presetOf(app, 'back-wall') === 'back-amber', 'the chorus');
  assert.equal(app.state!.section!.changed, false);
  assert.equal(await app.command({ type: 'groupLevel', group: 'back-wall', value: 0.3 }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true, 'changed');
  await app.liveSlide(slide('c2', 'v1'));
  await waitFor(() => app.state?.section?.kind === 'verse' && app.state.groups['back-wall']!.level === 1, "the verse, with the song's level");
  await sleep(60);
  assert.equal(app.state!.section!.changed, false);
  // A song by hand clears the section.
  assert.equal(await app.command({ type: 'look', id: songs.c4! }, 'operator'), null);
  await waitFor(() => app.state?.section === null, 'no section');
  // So does a quick look by hand.
  assert.equal(await app.command({ type: 'section', song: songs.c2!, kind: 'chorus' }, 'operator'), null);
  await waitFor(() => app.state?.section?.kind === 'chorus', 'the chorus by hand');
  assert.equal(await app.command({ type: 'quickLook', id: 'prayer' }, 'operator'), null);
  await waitFor(() => app.state?.section === null, 'no section after a quick look');
}, { shape: chorusLook }));

/** Runs `tap` while the follower waits for the stage the second time (the first is followDecision's, the second the section start's). */
function tapDuringSectionStart(app: App, tap: () => Promise<unknown>): void {
  const inside = app as any;
  const stage = inside.stage.bind(inside);
  let calls = 0;
  inside.stage = async () => {
    const runtime = await stage();
    if (++calls === 2) {
      inside.stage = stage;
      await tap();
    }
    return runtime;
  };
}

test('a tap while a section is starting wins: the song already on stage', () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', null));
  await waitFor(() => app.state?.look === songs.c2, 'Song One');
  tapDuringSectionStart(app, () => app.command({ type: 'blackout' }, 'operator'));
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.look === 'blackout', 'Blackout');
  await sleep(100);
  assert.equal(app.state!.section, null);
  assert.equal(presetOf(app, 'back-wall'), '__blackout', "the chorus's colours never land on top of Blackout");
  assert.equal(app.state!.follow?.on, false);
}, { shape: chorusLook }));

test('a tap while a section is starting wins: another song on stage', () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c4', null, 'Song Two'));
  await waitFor(() => app.state?.look === songs.c4, 'Song Two');
  tapDuringSectionStart(app, () => app.command({ type: 'blackout' }, 'operator'));
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.look === 'blackout', 'Blackout');
  await sleep(150);
  assert.equal(app.state!.look, 'blackout', 'Song One never starts after the tap');
  assert.equal(app.state!.timeline, null, "nor does Song One's timeline");
  assert.equal(app.state!.section, null);
}, { shape: withTimeline }));

test('Undo brings back the section that was on stage with the lights', () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'v1'));
  await waitFor(() => app.state?.section?.kind === 'verse', 'the verse');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus' && presetOf(app, 'back-wall') === 'back-amber', 'the chorus');
  // Undo of the chorus: the verse again, as it was.
  assert.equal(await app.command({ type: 'undo' }, 'operator'), null);
  await waitFor(() => app.state?.section?.kind === 'verse' && presetOf(app, 'back-wall') === 'back-purple', 'the verse back');
  await sleep(60);
  assert.deepEqual(app.state!.section, { song: songs.c2, kind: 'verse', changed: false });
  assert.equal(app.state!.follow?.on, true, 'Undo does not pause Auto-follow');
  // The verse is what is on stage now, so a chorus slide starts the chorus again.
  await app.liveSlide(slide('c2', 'ch2'));
  await waitFor(() => app.state?.section?.kind === 'chorus' && presetOf(app, 'back-wall') === 'back-amber', 'the chorus again');
}, { shape: chorusLook }));

test('Undo of a section that started its song: one step back is the song, two the section before', () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c4', 'x1', 'Song Two'));
  await waitFor(() => app.state?.look === songs.c4 && app.state.section?.kind === 'chorus', "Song Two's chorus");
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.look === songs.c2 && app.state.section?.song === songs.c2, "Song One's chorus");
  assert.equal(await app.command({ type: 'undo' }, 'operator'), null);
  await waitFor(() => app.state?.section === null && presetOf(app, 'back-wall') === 'back-purple', 'Song One without a section');
  assert.equal(app.state!.look, songs.c2);
  assert.equal(await app.command({ type: 'undo' }, 'operator'), null);
  await waitFor(() => app.state?.look === songs.c4 && app.state.section?.song === songs.c4, "Song Two's chorus back");
  await sleep(60);
  assert.deepEqual(app.state!.section, { song: songs.c4, kind: 'chorus', changed: false });
}, { shape: chorusLook }));

test('a timeline started live from the Timeline page pauses Auto-follow', () => withFollow(async ({ app, tablet }) => {
  await followOn(app);
  const t = await tablet();
  assert.equal(await t.send({ type: 'timelineStart', id: 'song-one-tl', at: 0 }), null);
  await waitFor(() => app.state?.timeline?.id === 'song-one-tl', 'the timeline running');
  assert.equal(app.state!.follow?.on, false);
  t.close();
}, { shape: withTimeline }));

// ---- The connection and the switch ----

for (const [how, away] of [
  ['the presentation computer leaves', (ws: FakeSocket) => ws.receive('pusher_internal:member_removed', { user_id: PRESENTER }, 'presence-acc1')],
  ['the connection closes', (ws: FakeSocket) => ws.onclose!()],
] as const) {
  test(`switching on after ${how} starts nothing, not the slide it last showed`, () => withFollow(async ({ app, songs, sockets }) => {
    const ws = await presenterOpen(app, sockets);
    await app.liveSlide(slide('c4', null, 'Song Two'));
    away(ws);
    await waitFor(() => app.state?.follow?.live.state !== 'open', 'no longer open');
    const before = app.state!.look;
    assert.notEqual(before, songs.c4);
    await followOn(app);
    await sleep(60);
    assert.equal(app.state!.look, before, 'nothing started');
  }));
}

test('a reconnect during a section, on a slide of no section, changes nothing when the same slide comes again', () => withFollow(async ({ app, songs, sockets }) => {
  const ws = await presenterOpen(app, sockets);
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus' && presetOf(app, 'back-wall') === 'back-amber' && app.state.timeline, 'the chorus and the timeline');
  // An untitled slide of the same song: no section.
  await app.liveSlide(slide('c2', 'untitled'));
  assert.equal(app.state!.follow?.note?.kind, 'nothing');
  const run = app.state!.timeline!.run;
  const canUndo = app.state!.canUndo;
  // The Wi-Fi blips: the connection closes and comes back, and the presentation app sends its slide again.
  ws.onclose!();
  await waitFor(() => app.state?.follow?.live.state !== 'open', 'no longer open');
  await waitFor(() => sockets.length === 2, 'a new live socket');
  await presenterOpen(app, sockets);
  await app.liveSlide(slide('c2', 'untitled'));
  await sleep(100);
  const state = app.state!;
  assert.equal(state.look, songs.c2);
  assert.deepEqual(state.section, { song: songs.c2, kind: 'chorus', changed: false });
  assert.equal(state.timeline?.run, run, 'the timeline did not start again');
  assert.equal(presetOf(app, 'back-wall'), 'back-amber');
  assert.equal(state.follow?.note?.kind, 'nothing');
  assert.equal(state.canUndo, canUndo);
}, { shape: withTimeline }));

test('switching on before the presentation app is open starts nothing', () => withFollow(async ({ app, songs }) => {
  await app.liveSlide(slide('c4', null, 'Song Two'));
  const before = app.state!.look;
  await followOn(app);
  await sleep(60);
  assert.equal(app.state!.look, before);
  assert.notEqual(before, songs.c4);
}));

test('Planning off: no follow state, the connection stops and Auto-follow pauses; on again, it connects', () => withFollow(async ({ app, call, sockets }) => {
  await waitFor(() => sockets.length === 1, 'a live connection');
  await followOn(app);
  assert.ok(app.state!.follow);
  assert.equal(app.state!.follow!.live.state, 'connecting');
  assert.equal((await call('PUT', '/api/settings', { planning: { enabled: false } })).status, 200);
  await waitFor(() => app.state?.follow === null, 'no follow state');
  assert.equal(sockets[0]!.closed, true);
  assert.equal((await call('PUT', '/api/settings', { planning: { enabled: true, account: 'acc1', serviceType: 'type1' } })).status, 200);
  await waitFor(() => sockets.length === 2, 'a new live connection');
  await waitFor(() => app.state?.follow?.live.state === 'connecting', 'connecting');
  assert.equal(app.state!.follow!.on, false, 'Auto-follow is off when Planning comes back on');
}));

test('Planning on but no account to be found: the follow state says so', () => withFollow(async ({ app, call, fake, sockets }) => {
  fake.accountList = [];
  assert.equal((await call('PUT', '/api/settings', { planning: { enabled: true } })).status, 200);
  await waitFor(() => app.state?.follow?.live.problem, 'a problem');
  assert.match(app.state!.follow!.live.problem!, /No planning account/);
  assert.equal(app.state!.follow!.live.state, 'closed');
  assert.equal(sockets.length, 0);
}, { load: false }));

test('Auto-follow starts off, and once switched on it is still on after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-follow-'));
  try {
    await withFollow(async ({ app }) => {
      assert.equal(app.state!.follow?.on, false, 'off on a fresh data folder');
      await followOn(app);
    }, { dir });
    await withFollow(async ({ app }) => {
      assert.equal(app.state!.follow?.on, true, 'still on after a restart');
      assert.equal(await app.command({ type: 'autoFollow', on: false }, 'operator'), null);
    }, { dir, load: false });
    await withFollow(async ({ app }) => {
      assert.equal(app.state!.follow?.on, false, 'off stays off');
    }, { dir, load: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Saving a change for a section ----

const looksOf = async (call: Rig['call']) => ((await call('GET', '/api/show')).body as Show);
const entry = (show: Show, look: string, group: string) => show.looks.find((l) => l.id === look)!.groups.find((e) => e.group === group)!;

/** The chorus of Song One on stage (no look of its own), then its audience level and back wall colour changed by hand. */
async function changedChorus(app: App, songs: Record<string, string>) {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus', 'the chorus');
  assert.equal(await app.command({ type: 'groupLevel', group: 'audience', value: 0.3 }, 'operator'), null);
  assert.equal(await app.command({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber' }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true && presetOf(app, 'back-wall') === 'back-amber', 'the changes');
}

test("Save for this section gives the chorus a look of its own with the change; the song's look stays; one Undo step", () => withFollow(async ({ app, songs, call }) => {
  await changedChorus(app, songs);
  const before = await looksOf(call);
  assert.equal(await app.command({ type: 'saveSection', scope: 'section' }, 'operator'), null);
  const show = await looksOf(call);
  const own = sectionsOf(show, songs.c2!).find((s) => s.kind === 'chorus')!.look;
  assert.ok(own, 'the chorus has a look of its own');
  assert.equal(entry(show, own!, 'audience').level, 0.3);
  assert.equal(entry(show, own!, 'back-wall').preset, 'back-amber');
  assert.deepEqual(show.looks.find((l) => l.id === songs.c2)!.groups, before.looks.find((l) => l.id === songs.c2)!.groups, "the song's look is unchanged");
  assert.equal(sectionsOf(show, songs.c2!).find((s) => s.kind === 'verse')!.look, null);
  await waitFor(() => app.state?.section?.changed === false, 'no longer changed');
  // One Undo step takes the saved look back.
  assert.equal(await app.command({ type: 'undo' }, 'operator'), null);
  const undone = await looksOf(call);
  assert.equal(sectionsOf(undone, songs.c2!).find((s) => s.kind === 'chorus')!.look, null);
  assert.ok(!undone.looks.some((l) => l.id === own));
}));

test('Save for the whole song writes the song look; the stage then matches it', () => withFollow(async ({ app, songs, call }) => {
  await changedChorus(app, songs);
  assert.equal(await app.command({ type: 'saveSection', scope: 'song' }, 'operator'), null);
  const show = await looksOf(call);
  assert.equal(entry(show, songs.c2!, 'audience').level, 0.3);
  assert.equal(entry(show, songs.c2!, 'back-wall').preset, 'back-amber');
  assert.equal(sectionsOf(show, songs.c2!).find((s) => s.kind === 'chorus')!.look, null, 'the chorus follows the song and has no look of its own');
  await waitFor(() => app.state?.section?.changed === false, 'no longer changed');
}));

test('Save for a section with nothing changed writes nothing; with no section on stage it says so', () => withFollow(async ({ app, songs, call }) => {
  assert.equal(await app.command({ type: 'look', id: songs.c2! }, 'operator'), null);
  await waitFor(() => app.state?.look === songs.c2, 'the song');
  assert.equal(await app.command({ type: 'saveSection', scope: 'section' }, 'operator'), 'No section is on stage.');
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus', 'the chorus');
  const before = await looksOf(call);
  assert.equal(await app.command({ type: 'saveSection', scope: 'section' }, 'operator'), null);
  assert.deepEqual(await looksOf(call), before);
}));

test("Save to the song while its section is on stage saves into the section's own look; another look works as before", () => withFollow(async ({ app, songs, call }) => {
  await changedChorus(app, songs);
  const before = await looksOf(call);
  assert.equal(await app.command({ type: 'saveItem', id: songs.c2! }, 'operator'), null);
  const show = await looksOf(call);
  const own = sectionsOf(show, songs.c2!).find((s) => s.kind === 'chorus')!.look!;
  assert.ok(own);
  assert.equal(entry(show, own, 'audience').level, 0.3);
  assert.deepEqual(show.looks.find((l) => l.id === songs.c2)!.groups, before.looks.find((l) => l.id === songs.c2)!.groups, "the song's look is unchanged");
  assert.equal(show.looks.find((l) => l.id === own)!.tempo, undefined);
  await waitFor(() => app.state?.section?.changed === false, 'no longer changed');
  // Another look is saved as today.
  assert.equal(await app.command({ type: 'saveItem', id: songs.c4! }, 'operator'), null);
  const after = await looksOf(call);
  assert.equal(entry(after, songs.c4!, 'audience').level, 0.3);
}));

test("in Prepare, Save for this section uses the draft's section; a draft Undo clears it", () => withFollow(async ({ app, songs, tablet, call }) => {
  const t = await tablet();
  assert.equal(await t.command({ type: 'blindStart' }), null);
  assert.equal(await t.command({ type: 'saveSection', scope: 'section' }), 'No section is on stage.');
  assert.equal(await t.command({ type: 'section', song: songs.c4!, kind: 'chorus' }), null);
  await waitFor(() => t.draft()?.section?.kind === 'chorus', "the draft's chorus");
  assert.equal(await t.command({ type: 'draft', cmd: { type: 'groupLevel', group: 'audience', value: 0.3 } }), null);
  await waitFor(() => t.draft()?.section?.changed === true, 'changed in the draft');
  assert.equal(await t.command({ type: 'saveSection', scope: 'section' }), null);
  const show = await looksOf(call);
  const own = sectionsOf(show, songs.c4!).find((s) => s.kind === 'chorus')!.look!;
  assert.ok(own);
  assert.equal(entry(show, own, 'audience').level, 0.3);
  await waitFor(() => t.draft()?.section?.changed === false, "the draft's section matches its look");
  // Undo in the draft puts back the lights, not a section the lights no longer show.
  assert.equal(await t.command({ type: 'draft', cmd: { type: 'undo' } }), null);
  await waitFor(() => t.draft() && t.draft().section === null, "no section in the draft after its Undo");
  t.close();
}));

async function chorusOn(app: App) {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus', 'the chorus');
}

test('Save for this section with an Any colour: the stage matches it (changed false), and Undo of the save makes it changed again', () => withFollow(async ({ app, songs, call }) => {
  await chorusOn(app);
  assert.equal(await app.command({ type: 'groupColour', group: 'back-wall', colour: '#123456', white: 0.4, fade: 0 }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true, 'changed');
  assert.equal(await app.command({ type: 'saveSection', scope: 'section' }, 'operator'), null);
  const show = await looksOf(call);
  const own = sectionsOf(show, songs.c2!).find((s) => s.kind === 'chorus')!.look!;
  assert.ok(show.presets.find((p) => p.id === entry(show, own, 'back-wall').preset)!.custom);
  await waitFor(() => app.state?.section?.changed === false, 'matches after the save');
  assert.ok(presetOf(app, 'back-wall')!.startsWith('live:'), 'the stage keeps its live colour');
  assert.equal(await app.command({ type: 'undo' }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true, 'changed again after Undo');
}));

test('Save for this section with a live effect: the stage matches it (changed false), and Undo of the save makes it changed again', () => withFollow(async ({ app }) => {
  await chorusOn(app);
  const wave = { kind: 'effect' as const, effect: 'wave' as const, colours: [{ hex: '#ff0000' }, { hex: '#0000ff' }], speed: { beats: 16 }, direction: 'ltr' as const, waves: 3, size: 0.5, edge: 'soft' as const, intensity: 1 };
  assert.equal(await app.command({ type: 'groupEffect', group: 'back-wall', effect: wave, fade: 0 } as any, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true, 'changed');
  assert.equal(await app.command({ type: 'saveSection', scope: 'section' }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === false, 'matches after the save');
  assert.ok(presetOf(app, 'back-wall')!.startsWith('fx:'));
  assert.equal(await app.command({ type: 'undo' }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true, 'changed again after Undo');
}));

test('Save to the song with a section and a running timeline saves the whole stage except the groups the timeline drives', () => withFollow(async ({ app, songs, call }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'v1'));
  await waitFor(() => app.state?.look === songs.c2 && app.state.timeline, 'Song One and its timeline');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus' && presetOf(app, 'back-wall') === 'back-amber', 'the chorus');
  assert.equal(presetOf(app, 'audience'), 'aud-warm', 'the timeline drives it');
  assert.equal(await app.command({ type: 'groupLevel', group: 'back-wall', value: 0.3 }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true, 'changed');
  const before = await looksOf(call);
  const own = sectionsOf(before, songs.c2!).find((s) => s.kind === 'chorus')!.look!;
  assert.equal(await app.command({ type: 'saveItem', id: songs.c2! }, 'operator'), null);
  const show = await looksOf(call);
  assert.equal(entry(show, own, 'back-wall').level, 0.3);
  assert.equal(entry(show, own, 'audience').preset, 'aud-blue', 'the timeline group keeps what the chorus had');
  assert.equal(entry(show, own, 'front-wash').preset, entry(before, own, 'front-wash').preset);
  await waitFor(() => app.state?.section?.changed === false, 'no longer changed');
}, { shape: withTimeline }));

// ---- Back to saved during a section ----

test("Back to saved during a section puts back the section's look on its groups; the song, tempo, timeline, section and Auto-follow stay; one Undo step", () => withFollow(async ({ app, songs }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'v1'));
  await waitFor(() => app.state?.look === songs.c2 && app.state.timeline, 'Song One and its timeline');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus' && presetOf(app, 'back-wall') === 'back-amber', 'the chorus');
  const run = app.state!.timeline!.run;
  const front = presetOf(app, 'front-wash');
  assert.equal(await app.command({ type: 'tempo', bpm: 99 }, 'operator'), null);
  assert.equal(await app.command({ type: 'groupLevel', group: 'back-wall', value: 0.3 }, 'operator'), null);
  assert.equal(await app.command({ type: 'groupPreset', group: 'back-wall', preset: 'back-purple' }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true && presetOf(app, 'back-wall') === 'back-purple', 'changed');

  assert.equal(await app.command({ type: 'backToLook' }, 'operator'), null);
  await waitFor(() => app.state?.groups['back-wall']!.level === 1 && presetOf(app, 'back-wall') === 'back-amber', "the chorus's look again");
  await sleep(60);
  const state = app.state!;
  assert.deepEqual(state.section, { song: songs.c2, kind: 'chorus', changed: false });
  assert.equal(state.look, songs.c2);
  assert.equal(presetOf(app, 'front-wash'), front);
  assert.equal(state.tempo, 99, 'the tempo is untouched');
  assert.equal(state.timeline?.run, run, 'the timeline keeps running');
  assert.equal(presetOf(app, 'audience'), 'aud-warm', "the group the timeline drives stays the timeline's");
  assert.equal(state.follow?.on, true, 'Back to saved does not pause Auto-follow');

  // One Undo step: the change by hand again, still in the chorus.
  assert.equal(await app.command({ type: 'undo' }, 'operator'), null);
  await waitFor(() => app.state?.groups['back-wall']!.level === 0.3 && presetOf(app, 'back-wall') === 'back-purple', 'the change back');
  await sleep(60);
  assert.deepEqual(app.state!.section, { song: songs.c2, kind: 'chorus', changed: true });
}, { shape: withTimeline }));

test("Back to saved during a section with no look of its own puts back the song's look on its groups", () => withFollow(async ({ app, songs }) => {
  await changedChorus(app, songs);
  assert.equal(await app.command({ type: 'backToLook' }, 'operator'), null);
  await waitFor(() => presetOf(app, 'back-wall') === 'back-purple' && app.state?.groups.audience!.level === 1, "the song's colours and levels");
  await sleep(60);
  assert.deepEqual(app.state!.section, { song: songs.c2, kind: 'chorus', changed: false });
}));

test("in Prepare, Back to saved during the draft's section puts back the section's look in the draft; the section stays", () => withFollow(async ({ app, songs, tablet }) => {
  const t = await tablet();
  assert.equal(await t.command({ type: 'blindStart' }), null);
  assert.equal(await t.command({ type: 'section', song: songs.c2!, kind: 'chorus' }), null);
  await waitFor(() => t.draft()?.section?.kind === 'chorus' && t.draft()?.groups['back-wall']?.preset === 'back-amber', "the draft's chorus");
  assert.equal(await t.command({ type: 'draft', cmd: { type: 'groupLevel', group: 'back-wall', value: 0.3 } }), null);
  await waitFor(() => t.draft()?.section?.changed === true, 'changed in the draft');
  assert.equal(await t.command({ type: 'draft', cmd: { type: 'backToLook' } }), null);
  await waitFor(() => t.draft()?.groups['back-wall']?.level === 1, "the chorus's level in the draft");
  assert.deepEqual(t.draft().section, { song: songs.c2, kind: 'chorus', changed: false });
  assert.equal(t.draft().groups['back-wall'].preset, 'back-amber');
  assert.equal(t.draft().look, songs.c2);
  assert.notEqual(app.state!.look, songs.c2, 'the stage is untouched');
  t.close();
}, { shape: chorusLook }));

// ---- A restart ----

test("the section on stage is still on stage after a restart; it is dropped when its song is no longer a loaded song", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-follow-'));
  try {
    let song = '';
    await withFollow(async ({ app, songs }) => {
      song = songs.c2!;
      await chorusOn(app);
      await waitFor(() => presetOf(app, 'back-wall') === 'back-amber', "the chorus's colours");
    }, { dir, shape: chorusLook });
    await withFollow(async ({ app }) => {
      const state = await waitFor(() => app.state?.section && app.state, 'the section restored');
      assert.equal(state.look, song);
      assert.deepEqual(state.section, { song, kind: 'chorus', changed: false });
      // A change by hand shows against the chorus's look, not the song's.
      assert.equal(await app.command({ type: 'groupLevel', group: 'back-wall', value: 0.3 }, 'operator'), null);
      await waitFor(() => app.state?.section?.changed === true, 'changed');
      assert.equal(await app.command({ type: 'groupLevel', group: 'back-wall', value: 1 }, 'operator'), null);
      await waitFor(() => app.state?.section?.changed === false, 'not changed');
    }, { dir, load: false });
    // The song is no longer one of the loaded service's.
    const path = join(dir, 'show.json');
    const show = JSON.parse(readFileSync(path, 'utf8')) as Show;
    show.operator.service!.items = show.operator.service!.items.filter((i) => i.look !== song);
    writeFileSync(path, JSON.stringify(show));
    await withFollow(async ({ app }) => {
      await sleep(100);
      assert.equal(app.state!.look, song);
      assert.equal(app.state!.section, null);
    }, { dir, load: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- A timeline started live during a section ----

/** The chorus look, and a timeline that drives the audience but is no song's. */
function looseTimeline(show: Show, songs: Record<string, string>): Show {
  show = withTimeline(show, songs);
  delete show.looks.find((l) => l.id === songs.c2)!.timeline;
  return show;
}

test("a timeline started live during a section takes its groups from the section: no save bar, and This section leaves them out", () => withFollow(async ({ app, songs, tablet, call }) => {
  await chorusOn(app);
  await waitFor(() => presetOf(app, 'audience') === 'aud-blue', "the chorus's audience");
  assert.equal(app.state!.timeline, null);
  const t = await tablet();
  assert.equal(await t.send({ type: 'timelineStart', id: 'song-one-tl', at: 0 }), null);
  await waitFor(() => presetOf(app, 'audience') === 'aud-warm', 'the timeline driving the audience');
  await sleep(60);
  assert.deepEqual(app.state!.section, { song: songs.c2, kind: 'chorus', changed: false }, 'no save bar for what the timeline does');
  assert.equal(await app.command({ type: 'groupLevel', group: 'back-wall', value: 0.3 }, 'operator'), null);
  await waitFor(() => app.state?.section?.changed === true, 'changed by hand');
  assert.equal(await app.command({ type: 'saveSection', scope: 'section' }, 'operator'), null);
  const show = await looksOf(call);
  const own = sectionsOf(show, songs.c2!).find((s) => s.kind === 'chorus')!.look!;
  assert.equal(entry(show, own, 'back-wall').level, 0.3);
  assert.equal(entry(show, own, 'audience').preset, 'aud-blue', "the timeline's colour is not saved into the chorus");
  t.close();
}, { shape: looseTimeline }));

// ---- Clearing the planned service ----

test('clearing the service drops the section on stage; a slide is then not in the running order; one Undo step brings it back', () => withFollow(async ({ app }) => {
  await followOn(app);
  await app.command({ type: 'fadeTime', value: 0 }, 'operator');
  await app.liveSlide(slide('c2', 'ch1'));
  await waitFor(() => app.state?.section?.kind === 'chorus' && presetOf(app, 'back-wall') === 'back-amber', 'the chorus');
  assert.equal(await app.command({ type: 'clearService' }, 'operator'), null);
  await waitFor(() => app.state?.section === null, 'no section after the clear');
  // The lights are not touched: the chorus's colours stay.
  assert.equal(presetOf(app, 'back-wall'), 'back-amber');
  await app.liveSlide(slide('c2', 'ch2'));
  await waitFor(() => app.state?.follow?.note?.kind === 'not-in-order', 'not in the running order');
  assert.equal(app.state!.follow?.on, true);
  // Undo takes the service back.
  assert.equal(await app.command({ type: 'undo' }, 'operator'), null);
  const show = (await (await fetch(`http://127.0.0.1:${app.port}/api/show`)).json()) as Show;
  assert.ok(show.operator.service, 'the service is back');
}, { shape: chorusLook }));

test("in Prepare, clearing the service drops the draft's section", () => withFollow(async ({ app, songs, tablet }) => {
  const t = await tablet();
  assert.equal(await t.command({ type: 'blindStart' }), null);
  assert.equal(await t.command({ type: 'section', song: songs.c4!, kind: 'chorus' }), null);
  await waitFor(() => t.draft()?.section?.kind === 'chorus', "the draft's chorus");
  assert.equal(await t.command({ type: 'clearService' }), null);
  await waitFor(() => t.draft() && t.draft().section === null, 'no section in the draft');
  t.close();
}));
