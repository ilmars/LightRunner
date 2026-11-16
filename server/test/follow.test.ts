// Auto-follow and sections on stage, through the App: the presentation app's slides make the lights follow, a tap
// by hand pauses it, and moving between sections of one song changes only colours and levels. A fake planning
// service and a fake socket stand in, so nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { FakePlanning } from '../src/planning/fake.ts';
import type { WebSocketLike } from '../src/planning/live.ts';
import { ensureSectionLook, type LiveSlide, type PlannedService, type Show } from '../../packages/shared/src/index.ts';

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
}

interface Tablet {
  command: (cmd: unknown) => Promise<string | null>;
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
      const command = (cmd: unknown) => new Promise<string | null>((resolve) => {
        const mine = ++ref;
        socket.on('message', function on(data, binary) {
          if (binary) return;
          const msg = JSON.parse(String(data));
          if (msg.type === 'result' && msg.ref === mine) {
            socket.off('message', on);
            resolve(msg.error);
          }
        });
        socket.send(JSON.stringify({ type: 'command', ref: mine, cmd }));
      });
      return { command, draft: () => draft, close: () => socket.close() };
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

test('Auto-follow switched off follows nothing; switched on, the slide on screen now starts at once', () => withFollow(async ({ app, songs }) => {
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
}, { shape: chorusLook }));

// ---- The connection and the switch ----

test('Planning off: no follow state and the connection stops; on again, it starts', () => withFollow(async ({ app, call, sockets }) => {
  await waitFor(() => sockets.length === 1, 'a live connection');
  assert.ok(app.state!.follow);
  assert.equal(app.state!.follow!.live.state, 'connecting');
  assert.equal((await call('PUT', '/api/settings', { planning: { enabled: false } })).status, 200);
  await waitFor(() => app.state?.follow === null, 'no follow state');
  assert.equal(sockets[0]!.closed, true);
  assert.equal((await call('PUT', '/api/settings', { planning: { enabled: true, account: 'acc1', serviceType: 'type1' } })).status, 200);
  await waitFor(() => sockets.length === 2, 'a new live connection');
  await waitFor(() => app.state?.follow?.live.state === 'connecting', 'connecting');
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
