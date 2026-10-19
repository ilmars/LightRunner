import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { parseShow, type Show } from '../../packages/shared/src/index.ts';
import { App } from '../src/app.ts';
import { operatorLayout } from '../src/layout.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The demo show with a hazer in a smoke group "Haze", and a look that (as an import might) lists it. */
function hazeShow(): Show {
  const show = parseShow(JSON.parse(readFileSync(join(root, 'server/seed/demo-show.json'), 'utf8')));
  show.fixtures.push({ id: 'hazer', name: 'Hazer', profile: 'generic-dimmer', universe: 0, address: 60, x: 0.5, y: 0.1 });
  show.groups.push({ id: 'haze', name: 'Haze', kind: 'smoke', fixtures: ['hazer'] });
  show.operator.groups.push('haze');
  show.presets.push({ id: 'haze-on', name: 'On', group: 'haze', swatch: '#ffffff', layers: [{ kind: 'static', colour: { hex: '#ffffff' }, intensity: 1 }], fade: 3 });
  show.looks.find((l) => l.id === 'worship')!.groups.push({ group: 'haze', preset: 'haze-on', level: 1 });
  return parseShow(show);
}

test('the operator layout says which groups are smoke, and looks give them no colour', () => {
  const show = hazeShow();
  const layout = operatorLayout(show, show.fixtures.map((f) => f.id));
  assert.deepEqual(layout.groups.map((g) => [g.id, g.kind]), [
    ['front-wash', 'light'], ['back-wall', 'light'], ['audience', 'light'], ['pulpit', 'light'], ['haze', 'smoke'],
  ]);
  const worship = layout.looks.find((l) => l.id === 'worship')!;
  assert.equal(worship.colours[4], null);
  assert.equal(worship.levels[4], null);
});

// ---- On the server: a held Puff never outlives the tablet holding it ----

async function waitFor<T>(get: () => T | null | undefined | false, ms = 2000, what = 'a condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function tablet(app: App, opts: { autoPong?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, opts);
  const seen: any[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) seen.push(JSON.parse(String(data)));
  });
  await new Promise((r) => ws.once('open', r));
  let ref = 0;
  return {
    ws,
    state: () => seen.findLast((m) => m.type === 'state')?.state,
    async send(cmd: unknown): Promise<string | null> {
      const mine = ++ref;
      ws.send(JSON.stringify({ type: 'command', ref: mine, cmd }));
      const reply = await waitFor(() => seen.find((m) => m.type === 'result' && m.ref === mine), 3000, `the reply to ${JSON.stringify(cmd)}`);
      return reply.error;
    },
  };
}

/** Runs `fn` against a server in `dir` whose show (from the start) has the hazer. */
async function withHazeApp(dir: string, fn: (app: App) => Promise<void>, heartbeatMs?: number) {
  const seedPath = join(dir, 'haze-seed.json');
  writeFileSync(seedPath, JSON.stringify(hazeShow()));
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {}, heartbeatMs });
  try {
    await app.start();
    await fn(app);
  } finally {
    await app.stop();
  }
}

/** A fresh data folder for `fn`, removed afterwards. */
async function inTempDir(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a Puff stops when the tablet holding it disconnects', () => inTempDir((dir) => withHazeApp(dir, async (app) => {
  const watch = await tablet(app);
  const holder = await tablet(app);
  assert.equal(await holder.send({ type: 'flash', groups: ['haze'], on: true }), null);
  await waitFor(() => String(watch.state()?.flashing) === 'haze', 2000, 'the Puff to start');
  holder.ws.close();
  await waitFor(() => watch.state()?.flashing.length === 0, 500, 'the Puff to stop');
})));

test("another tablet's Flash of several groups doesn't keep a Puff on when the puffing tablet goes", () => inTempDir((dir) => withHazeApp(dir, async (app) => {
  const watch = await tablet(app);
  const flasher = await tablet(app);
  const puffer = await tablet(app);
  // The engine leaves Haze out of this flash, so this tablet isn't holding it.
  assert.equal(await flasher.send({ type: 'flash', groups: ['back-wall', 'haze'], on: true }), null);
  assert.equal(await puffer.send({ type: 'flash', groups: ['haze'], on: true }), null);
  await waitFor(() => String(watch.state()?.flashing.slice().sort()) === 'back-wall,haze', 2000, 'the flash and the Puff');
  puffer.ws.close();
  await waitFor(() => String(watch.state()?.flashing) === 'back-wall', 500, 'the Puff to stop while the flash stays');
})));

test('a Puff stops when the tablet holding it stops answering', () => inTempDir((dir) => withHazeApp(dir, async (app) => {
  const watch = await tablet(app);
  const silent = await tablet(app, { autoPong: false });
  assert.equal(await silent.send({ type: 'flash', groups: ['haze'], on: true }), null);
  await waitFor(() => String(watch.state()?.flashing) === 'haze', 2000, 'the Puff to start');
  // Checks every 50 ms: dropped after two missed answers.
  await waitFor(() => watch.state()?.flashing.length === 0, 1000, "the silent tablet's Puff to stop");
}, 50)));

test('after a server restart the smoke is off and the lights come back', () => inTempDir(async (dir) => {
  await withHazeApp(dir, async (app) => {
    const t = await tablet(app);
    assert.equal(await t.send({ type: 'look', id: 'worship', fade: 0 }), null);
    assert.equal(await t.send({ type: 'groupLevel', group: 'haze', value: 0.7 }), null);
    await waitFor(() => t.state()?.groups.haze.level === 0.7, 2000, 'the smoke level');
    t.ws.close();
  });
  await withHazeApp(dir, async (app) => {
    const t = await tablet(app);
    const state = await waitFor(() => t.state(), 2000, 'the state');
    assert.equal(state.look, 'worship');
    assert.equal(state.groups.haze.level, 0);
    t.ws.close();
  });
}));
