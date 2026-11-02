// Planning through the App: the setting, the login, the services list and Load service. A fake stands in for the
// planning service, so nothing here touches the network; every cookie and id is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { FakePlanning } from '../src/planning/fake.ts';
import type { PlannedService } from '../../packages/shared/src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COOKIE = 'made-up-cookie-value-123';
const RUN_OUT = 'The planning login has run out. Paste a new one in Settings.';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

const item = (key: string, kind: PlannedService['items'][number]['kind'], name: string, songId?: string, tempo?: number) =>
  ({ key, kind, name, ...(songId ? { songId } : {}), ...(tempo ? { tempo } : {}) });

/** Two coming services, an empty one and a past one, all of the one service type. */
function planned(): FakePlanning {
  const fake = new FakePlanning();
  fake.accountList = [{ id: 'acc1', name: 'Church' }, { id: 'acc2', name: 'Other' }];
  fake.types = [{ id: 'type1', name: 'Sunday service' }, { id: 'type2', name: 'Youth' }];
  fake.plannedServices = [
    {
      id: 'svc-a', type: 'type1', title: 'Sunday service', start: '2099-01-04T08:00:00',
      items: [item('c1', 'header', 'Ievads'), item('c2', 'song', 'Song One', S1, 90), item('c3', 'verse', 'Psalm 23'), item('c4', 'song', 'Song Two', S2), item('c5', 'slides', 'Welcome')],
    },
    {
      id: 'svc-b', type: 'type1', title: 'Sunday service', start: '2099-01-11T08:00:00',
      // Song Three is planned twice.
      items: [item('d1', 'song', 'Song Two', S2), item('d2', 'song', 'Song Three', S3), item('d3', 'song', 'Song Three', S3)],
    },
    { id: 'svc-empty', type: 'type1', title: 'Sunday service', start: '2099-01-18T08:00:00', items: [] },
    { id: 'svc-past', type: 'type1', title: 'Sunday service', start: '2020-01-05T08:00:00', items: [item('e1', 'song', 'Old song', S1)] },
    { id: 'svc-youth', type: 'type2', title: 'Youth', start: '2099-01-09T18:00:00', items: [item('f1', 'song', 'Song One', S1)] },
  ];
  return fake;
}

interface Rig {
  app: App;
  fake: FakePlanning;
  dir: string;
  lines: string[];
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** A tablet (an operator, with no PIN set): sends a command and gives the error, or null. */
  tablet: () => Promise<{ command: (cmd: unknown) => Promise<string | null>; layouts: any[]; close: () => void }>;
}

async function withPlanning(fn: (rig: Rig) => Promise<void>, fake = planned()) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-planning-'));
  const lines: string[] = [];
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: (m) => lines.push(m), planning: fake });
  const sockets: WebSocket[] = [];
  try {
    await app.start();
    await waitFor(() => app.state, 'the first state');
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
      const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
      sockets.push(ws);
      const layouts: any[] = [];
      ws.on('message', (data, binary) => {
        if (binary) return;
        const msg = JSON.parse(String(data));
        if (msg.type === 'layout') layouts.push(msg.layout);
      });
      await new Promise((r) => ws.once('open', r));
      let ref = 0;
      const command = (cmd: unknown) => new Promise<string | null>((resolve) => {
        const mine = ++ref;
        ws.on('message', function on(data, binary) {
          if (binary) return;
          const msg = JSON.parse(String(data));
          if (msg.type === 'result' && msg.ref === mine) {
            ws.off('message', on);
            resolve(msg.error);
          }
        });
        ws.send(JSON.stringify({ type: 'command', ref: mine, cmd }));
      });
      return { command, layouts, close: () => ws.close() };
    };
    await fn({ app, fake, dir, lines, call, tablet });
  } finally {
    for (const ws of sockets) ws.close();
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor<T>(get: () => T | null | undefined | false, what = 'a condition', ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Planning on, with the church's account and service type, and a login. */
async function enable(rig: Rig, planning: Record<string, unknown> = { enabled: true, account: 'acc1', serviceType: 'type1' }) {
  const r = await rig.call('PUT', '/api/settings', { planning });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  rig.fake.login = COOKIE;
}

const layoutOf = async (rig: Rig) => (await rig.call('GET', '/api/layout')).body;
const orderOf = async (rig: Rig) => (await layoutOf(rig)).runningOrder.map((l: any) => l.id) as string[];
const call0 = async (rig: Rig) => ({ looks: (await rig.call('GET', '/api/looks')).body.looks.map((l: any) => l.id) as string[] });
const names = async (rig: Rig) => (await layoutOf(rig)).runningOrder.map((l: any) => l.name) as string[];

/** What each group shows on stage: its colour and level (not the fade's progress). */
const lights = (rig: Rig) => Object.fromEntries(Object.entries(rig.app.state!.groups).map(([g, v]: [string, any]) => [g, { preset: v.preset, level: v.level }]));

// ---- The setting ----

test('Planning is off by default and the layout says so', () => withPlanning(async (rig) => {
  const { call, fake } = rig;
  assert.deepEqual((await layoutOf(rig)).planning, { enabled: false });
  const settings = (await call('GET', '/api/settings')).body;
  assert.deepEqual(settings.planning, { enabled: false });
  // Off: no connection to anything, and nothing to offer.
  fake.login = COOKIE;
  assert.deepEqual((await call('GET', '/api/planning')).body, { loggedIn: true, problem: null, accounts: [], serviceTypes: [] });
  assert.equal((await call('GET', '/api/planning/services')).status, 503);
  assert.deepEqual(fake.calls, [], 'nothing was asked while off');
  // A login can still be saved while off (the Settings switch is a draft until Save); the pickers fill at once.
  const login = await call('PUT', '/api/planning/login', { cookie: COOKIE });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body, { loggedIn: true, problem: null, accounts: fake.accountList, serviceTypes: fake.types });
  assert.deepEqual(fake.calls, ['setLogin', 'accounts', 'serviceTypes acc1']);
  assert.deepEqual((await call('GET', '/api/planning')).body, { loggedIn: true, problem: null, accounts: [], serviceTypes: [] }, 'a plain GET still asks nothing');
}));

test('switching Planning on in Settings is kept, checked, and sent to the pages as a new layout', () => withPlanning(async (rig) => {
  const { call, tablet } = rig;
  const t = await tablet();
  await waitFor(() => t.layouts.length > 0, 'the first layout');
  const before = t.layouts.length;
  const on = await call('PUT', '/api/settings', { planning: { enabled: true, account: 'acc1', serviceType: 'type1' } });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.planning, { enabled: true, account: 'acc1', serviceType: 'type1' });
  await waitFor(() => t.layouts.length > before, 'the new layout');
  assert.deepEqual(t.layouts.at(-1).planning, { enabled: true });
  assert.deepEqual((await layoutOf(rig)).planning, { enabled: true });
  assert.deepEqual((await call('GET', '/api/settings')).body.planning, { enabled: true, account: 'acc1', serviceType: 'type1' });
  // Other settings leave it alone; nonsense is refused in plain words.
  assert.equal((await call('PUT', '/api/settings', { gamma: 2.4 })).body.planning.enabled, true);
  assert.equal((await call('PUT', '/api/settings', { planning: { enabled: 'yes' } })).status, 400);
  const nope = await call('PUT', '/api/settings', { planning: { enabled: true, newSongLook: 'no-such-look' } });
  assert.equal(nope.status, 400);
  assert.match(nope.body.error, /look/);
  assert.equal((await call('PUT', '/api/settings', { planning: { enabled: true, newSongLook: 'worship' } })).body.planning.newSongLook, 'worship');
  t.close();
}));

test('the programmer routes need the PIN; the services list does not', () => withPlanning(async (rig) => {
  const { call } = rig;
  await enable(rig);
  const pin = await fetch(`http://127.0.0.1:${rig.app.port}/api/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ next: '2468' }) });
  assert.equal(pin.status, 200);
  assert.equal((await call('GET', '/api/planning')).status, 401);
  assert.equal((await call('PUT', '/api/planning/login', { cookie: COOKIE })).status, 401);
  assert.equal((await call('GET', '/api/planning/services')).status, 200);
}));

// ---- The login ----

test('the login never reaches the show or an export', () => withPlanning(async (rig) => {
  const { call, fake, dir, lines } = rig;
  await enable(rig);
  fake.login = null;
  assert.equal((await call('GET', '/api/planning')).body.loggedIn, false);
  const put = await call('PUT', '/api/planning/login', { cookie: COOKIE });
  assert.equal(put.status, 200);
  assert.equal(put.body.loggedIn, true);
  assert.deepEqual(put.body.accounts.map((a: any) => a.id), ['acc1', 'acc2']);
  assert.deepEqual(put.body.serviceTypes.map((t: any) => t.id), ['type1', 'type2']);
  assert.equal(fake.login, COOKIE, 'the planning side got it');

  const seen = [
    JSON.stringify(put.body),
    JSON.stringify((await call('GET', '/api/planning')).body),
    JSON.stringify((await call('GET', '/api/settings')).body),
    await (await fetch(`http://127.0.0.1:${rig.app.port}/api/show`)).text(),
    JSON.stringify(await layoutOf(rig)),
    lines.join('\n'),
  ];
  for (const text of seen) assert.ok(!text.includes(COOKIE), 'the cookie is in a response or a log line');
  // Nor in anything the App saved: the show, its backups, the runtime file.
  const files = (path: string): string[] => readdirSync(path).flatMap((n) => (statSync(join(path, n)).isDirectory() ? files(join(path, n)) : [join(path, n)]));
  for (const file of files(dir)) assert.ok(!readFileSync(file, 'utf8').includes(COOKIE), `${file} holds the cookie`);

  // A refused login says why, and a bad body is refused too.
  fake.failWith = 'That login was not accepted. Sign in again.';
  const refused = await call('PUT', '/api/planning/login', { cookie: 'another-made-up-one' });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: 'That login was not accepted. Sign in again.' });
  fake.failWith = undefined;
  assert.equal((await call('PUT', '/api/planning/login', {})).status, 400);
  assert.equal((await call('PUT', '/api/planning/login', { cookie: 7 })).status, 400);
}));

test('without a fake, the real client is used, and it makes no call while Planning is off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-planning-'));
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} });
  return (async () => {
    try {
      await app.start();
      const res = await fetch(`http://127.0.0.1:${app.port}/api/planning`);
      assert.deepEqual(await res.json(), { loggedIn: false, problem: null, accounts: [], serviceTypes: [] });
    } finally {
      await app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
});

test('Settings lists the account and its service types; a run-out login is told as the problem', () => withPlanning(async (rig) => {
  const { call, fake } = rig;
  await enable(rig);
  const view = (await call('GET', '/api/planning')).body;
  assert.deepEqual(view, { loggedIn: true, problem: null, accounts: fake.accountList, serviceTypes: fake.types });
  assert.ok(fake.calls.includes('serviceTypes acc1'), 'the chosen account');
  // Without a chosen account, the first one.
  await call('PUT', '/api/settings', { planning: { enabled: true } });
  fake.calls.length = 0;
  await call('GET', '/api/planning');
  assert.ok(fake.calls.includes('serviceTypes acc1'), fake.calls.join('; '));
  // Not logged in: nothing is asked.
  fake.login = null;
  fake.calls.length = 0;
  assert.deepEqual((await call('GET', '/api/planning')).body, { loggedIn: false, problem: null, accounts: [], serviceTypes: [] });
  assert.deepEqual(fake.calls, []);
}));

// ---- The services list ----

test('the services list counts songs that have a look and new ones', () => withPlanning(async (rig) => {
  const { call, fake, tablet } = rig;
  await enable(rig);
  let list = (await call('GET', '/api/planning/services')).body;
  assert.equal(list.type, 'Sunday service');
  assert.deepEqual(list.services.map((s: any) => s.id), ['svc-a', 'svc-b', 'svc-empty', 'svc-past'], 'coming ones, nearest first, then the last one past');
  const row = (id: string) => list.services.find((s: any) => s.id === id);
  // Nothing is remembered yet: every song is new.
  assert.deepEqual([row('svc-a').songs, row('svc-a').withLook, row('svc-a').newSongs], [2, 0, 2]);
  assert.deepEqual([row('svc-a').items, row('svc-a').start], [5, '2099-01-04T08:00:00']);
  assert.ok(fake.calls.includes('services acc1 type1'));

  const t = await tablet();
  assert.equal(await t.command({ type: 'loadService', id: 'svc-a' }), null);
  list = (await call('GET', '/api/planning/services')).body;
  assert.deepEqual([row('svc-a').withLook, row('svc-a').newSongs], [2, 0]);
  // Song Two has a look now; Song Three, planned twice, is one new song.
  assert.deepEqual([row('svc-b').songs, row('svc-b').withLook, row('svc-b').newSongs], [3, 1, 1]);
  assert.deepEqual([row('svc-empty').songs, row('svc-empty').withLook, row('svc-empty').newSongs], [0, 0, 0]);
  t.close();

  // The account is the chosen one, else the first; the type is the chosen one, else the first.
  await call('PUT', '/api/settings', { planning: { enabled: true, account: 'acc2', serviceType: 'type2' } });
  list = (await call('GET', '/api/planning/services')).body;
  assert.equal(list.type, 'Youth');
  assert.deepEqual(list.services.map((s: any) => s.id), ['svc-youth']);
  assert.ok(fake.calls.includes('services acc2 type2'));
  await call('PUT', '/api/settings', { planning: { enabled: true } });
  list = (await call('GET', '/api/planning/services')).body;
  assert.equal(list.type, 'Sunday service');
  assert.ok(fake.calls.includes('services acc1 type1'));
}));

// ---- Load service ----

test('loadService fills the running order and is one Undo step', () => withPlanning(async (rig) => {
  const { call, tablet } = rig;
  await enable(rig);
  const t = await tablet();
  const order = await orderOf(rig);
  const rows = (await layoutOf(rig)).rows;
  assert.equal((await layoutOf(rig)).service, undefined);
  assert.equal(await t.command({ type: 'loadService', id: 'svc-a' }), null);

  const layout = await layoutOf(rig);
  assert.deepEqual(layout.runningOrder.map((l: any) => l.name), ['Basic lights', 'Song One', 'Song Two']);
  assert.equal(layout.runningOrder[1].tempo, 90);
  assert.deepEqual(layout.service, { title: 'Sunday service', start: '2099-01-04T08:00:00' });
  assert.equal(layout.rows.filter((r: any) => r.kind === 'look').length, 3);
  assert.ok(layout.rows.some((r: any) => r.kind === 'verses'));
  assert.equal(layout.runningOrder[0].id, order[0], 'Basic lights stays first');

  // One Undo step takes the whole load back, the running order and the loaded service.
  assert.equal(await t.command({ type: 'undo' }), null);
  assert.deepEqual(await orderOf(rig), order);
  const back = await layoutOf(rig);
  assert.equal(back.service, undefined);
  assert.deepEqual(back.rows, rows);
  // ... and the show can be loaded again afterwards (a load leaves the Undo list in order).
  assert.equal(await t.command({ type: 'loadService', id: 'svc-b' }), null);
  assert.deepEqual(await names(rig), ['Basic lights', 'Song Two', 'Song Three']);
  assert.equal(await t.command({ type: 'undo' }), null);
  assert.deepEqual(await orderOf(rig), order);
  t.close();
  assert.equal((await call('GET', '/api/layout')).status, 200);
}));

test('a load frees the controller keys of the songs it takes away', () => withPlanning(async (rig) => {
  const { app, tablet } = rig;
  await enable(rig);
  const t = await tablet();
  const old = (await orderOf(rig))[1]!;
  const key = { device: 'nanoKONTROL2', type: 'note', channel: 1, number: 41 };
  assert.equal(await app.command({ type: 'setKey', key, does: { kind: 'song', id: old } }, 'programmer'), null);
  assert.ok((await layoutOf(rig)).keys.songs[old], 'the song has its key');
  assert.equal(await t.command({ type: 'loadService', id: 'svc-a' }), null);
  assert.ok(!(await orderOf(rig)).includes(old), 'the old song left the running order');
  assert.equal((await layoutOf(rig)).keys.songs[old], undefined, 'its key is freed');
  t.close();
}));

test('loadService is refused while Planning is off, and a failed fetch leaves the show as it was', () => withPlanning(async (rig) => {
  const { fake, tablet } = rig;
  const t = await tablet();
  const order = await orderOf(rig);
  assert.equal(await t.command({ type: 'loadService', id: 'svc-a' }), 'Planning is off.');
  assert.deepEqual(fake.calls, [], 'nothing was asked of the planning service');
  assert.deepEqual(await orderOf(rig), order);

  await enable(rig);
  const missing = await t.command({ type: 'loadService', id: 'svc-gone' });
  assert.equal(missing, 'That service was not found in the planning service.');
  assert.deepEqual(await orderOf(rig), order);
  assert.equal((await layoutOf(rig)).service, undefined);
  assert.match((await t.command({ type: 'loadService', id: 'a'.repeat(65) }))!, /^invalid command/);
  t.close();
}));

test('a login that runs out never touches the lights or the running order', () => withPlanning(async (rig) => {
  const { app, fake, call, tablet } = rig;
  await enable(rig);
  const t = await tablet();
  assert.equal(await t.command({ type: 'loadService', id: 'svc-a' }), null);
  assert.equal(await t.command({ type: 'look', id: (await orderOf(rig))[1] }), null);
  await sleep(100);
  const order = await orderOf(rig);
  const stage = { look: app.state!.look, ...lights(rig) };
  const layout = await layoutOf(rig);

  fake.failWith = RUN_OUT;
  const view = await call('GET', '/api/planning');
  assert.equal(view.status, 200);
  assert.equal(view.body.problem, RUN_OUT);
  assert.equal(view.body.loggedIn, true);
  assert.deepEqual([view.body.accounts, view.body.serviceTypes], [[], []]);
  const list = await call('GET', '/api/planning/services');
  assert.equal(list.status, 503);
  assert.deepEqual(list.body, { error: RUN_OUT });
  assert.equal(await t.command({ type: 'loadService', id: 'svc-b' }), RUN_OUT);

  await sleep(100);
  assert.deepEqual(await orderOf(rig), order);
  assert.deepEqual(await layoutOf(rig), layout, 'the page is as it was');
  assert.deepEqual({ look: app.state!.look, ...lights(rig) }, stage);
  t.close();
}));

test('loading never changes the lights', () => withPlanning(async (rig) => {
  const { app, tablet } = rig;
  await enable(rig);
  const t = await tablet();
  // The stage shows a song of the old running order: one the load will take away.
  const old = (await orderOf(rig))[1]!;
  assert.equal(await t.command({ type: 'look', id: old, fade: 0 }), null);
  await sleep(150);
  const stage = { look: app.state!.look, ...lights(rig) };
  assert.equal(stage.look, old);
  assert.equal(await t.command({ type: 'loadService', id: 'svc-a' }), null);
  await sleep(150);
  assert.ok(!(await orderOf(rig)).includes(old));
  assert.ok(!(await call0(rig)).looks.includes(old), 'its look is gone from the show');
  assert.deepEqual({ look: app.state!.look, ...lights(rig) }, stage, 'the stage keeps what it shows');

  // The same during Blackout: it stays on, and the stage is not brought back.
  assert.equal(await t.command({ type: 'look', id: (await orderOf(rig))[1], fade: 0 }), null);
  assert.equal(await t.command({ type: 'blackout' }), null);
  await sleep(150);
  const dark = { look: app.state!.look, ...lights(rig) };
  assert.equal(dark.look, 'blackout');
  assert.equal(await t.command({ type: 'loadService', id: 'svc-b' }), null);
  await sleep(150);
  assert.deepEqual(await names(rig), ['Basic lights', 'Song Two', 'Song Three']);
  assert.deepEqual({ look: app.state!.look, ...lights(rig) }, dark);
  t.close();
}));

test('an empty service is refused', () => withPlanning(async (rig) => {
  const { tablet } = rig;
  await enable(rig);
  const t = await tablet();
  const order = await orderOf(rig);
  assert.equal(await t.command({ type: 'loadService', id: 'svc-empty' }), 'Nothing is planned in this service yet.');
  assert.deepEqual(await orderOf(rig), order);
  assert.equal((await layoutOf(rig)).service, undefined);
  t.close();
}));

test('a load in Prepare (a draft) still loads, and the draft carries on', () => withPlanning(async (rig) => {
  const { tablet } = rig;
  await enable(rig);
  const t = await tablet();
  assert.equal(await t.command({ type: 'blindStart' }), null);
  assert.equal(await t.command({ type: 'loadService', id: 'svc-a' }), null);
  assert.deepEqual(await names(rig), ['Basic lights', 'Song One', 'Song Two']);
  assert.equal(await t.command({ type: 'blindEnd' }), null);
  t.close();
}));

// ---- The Patch page ----

test('a Patch save keeps the live service and the looks the planner remembers', () => withPlanning(async (rig) => {
  const { app, tablet } = rig;
  await enable(rig);
  const t = await tablet();
  const url = `http://127.0.0.1:${app.port}`;
  // The Patch page loads the show before the load, and saves it after.
  const old = await fetch(`${url}/api/show`);
  const oldShow = await old.json() as any;
  assert.equal(oldShow.operator.service, undefined);
  assert.equal(await t.command({ type: 'loadService', id: 'svc-a' }), null);
  const live = await fetch(`${url}/api/show`);
  const revision = live.headers.get('x-show-revision')!;
  const liveShow = await live.json() as any;
  assert.ok(liveShow.operator.service && liveShow.operator.remembered);
  // It has loaded the show again (so its revision is current), but still holds the old operator part.
  const { service: _s, remembered: _r, ...operator } = liveShow.operator;
  const saved = await fetch(`${url}/api/show?source=patch`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-show-revision': revision }, body: JSON.stringify({ ...liveShow, operator }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const after = await (await fetch(`${url}/api/show`)).json() as any;
  assert.deepEqual(after.operator.service, liveShow.operator.service);
  assert.deepEqual(after.operator.remembered, liveShow.operator.remembered);
  assert.equal((await layoutOf(rig)).service?.title, 'Sunday service');
  t.close();
}));
