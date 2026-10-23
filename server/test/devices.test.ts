import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeApp(dataDir: string, deviceFlashMs?: number) {
  return new App({ port: 0, host: '127.0.0.1', dataDir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {}, deviceFlashMs });
}

async function withApp(fn: (app: App) => Promise<void>, deviceFlashMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-'));
  const app = makeApp(dir, deviceFlashMs);
  try {
    await app.start();
    // start() is done once it listens; the engine's first state comes a moment later (slow on some machines).
    await waitFor(() => app.state, 10000, 'the first state');
    await fn(app);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function api(app: App, method: string, path: string) {
  const res = await fetch(`http://127.0.0.1:${app.port}${path}`, { method });
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

const post = async (app: App, path: string) => {
  const r = await api(app, 'POST', path);
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body, { ok: true });
};
const layoutOf = async (app: App) => (await api(app, 'GET', '/api/layout')).body;

test('item, next, Basic lights and Back to look from the HTTP routes', () => withApp(async (app) => {
  const layout = await layoutOf(app);
  const order: string[] = layout.runningOrder.map((l: any) => l.id);
  assert.equal(order[0], layout.basicLights);

  await post(app, '/api/item/2');
  await waitFor(() => app.state?.look === order[1], 2000, 'item 2 on stage');
  await post(app, '/api/next');
  await waitFor(() => app.state?.look === order[2], 2000, 'Next to start item 3');
  await post(app, '/api/item/1');
  await waitFor(() => app.state?.look === 'safe', 2000, 'Basic lights on stage');
  await post(app, '/api/next');
  await waitFor(() => app.state?.look === order[1], 2000, 'Next after Basic lights');

  await post(app, '/api/group/1/colour/2');
  const g = layout.groups[0];
  await waitFor(() => app.state?.groups[g.id]?.preset === g.presets[1].id, 2000, 'the second colour to run');
  await waitFor(() => app.state?.lookChanged, 2000, 'the look to show as changed');
  await post(app, '/api/back-to-look');
  await waitFor(() => app.state?.lookChanged === false, 2000, 'Back to look to clear changed');

  await post(app, '/api/safe');
  await waitFor(() => app.state?.look === 'safe', 2000, 'safe');
}));

test('Next carries on after Blackout and refuses at the end of the list', () => withApp(async (app) => {
  const order: string[] = (await layoutOf(app)).runningOrder.map((l: any) => l.id);
  await post(app, `/api/item/${order.length}`);
  await waitFor(() => app.state?.look === order.at(-1), 2000, 'the last item on stage');
  const end = await api(app, 'POST', '/api/next');
  assert.equal(end.status, 400);
  assert.equal(end.body.error, 'End of the list.');

  await post(app, '/api/item/2');
  await waitFor(() => app.state?.look === order[1], 2000, 'item 2');
  await post(app, '/api/blackout');
  await waitFor(() => app.state?.look === 'blackout', 2000, 'Blackout');
  await post(app, '/api/next');
  await waitFor(() => app.state?.look === order[2], 2000, 'Next to carry on after Blackout');
}));

test('Undo, Blackout, level, colour and Master from the HTTP routes', () => withApp(async (app) => {
  const layout = await layoutOf(app);
  const [g1, g2] = layout.groups;
  await post(app, '/api/item/2');
  await waitFor(() => app.state?.look === layout.runningOrder[1].id, 2000, 'item 2');

  // A number is a position, anything else a group id.
  await post(app, '/api/group/2/level/40');
  await waitFor(() => app.state?.groups[g2.id]?.level === 0.4, 2000, 'group 2 at 40 %');
  await post(app, `/api/group/${g1.id}/level/30`);
  await waitFor(() => app.state?.groups[g1.id]?.level === 0.3, 2000, 'group 1 at 30 % by id');

  await post(app, '/api/master/50');
  await waitFor(() => app.state?.master === 0.5, 2000, 'Master at 50 %');
  await post(app, '/api/master/up');
  await waitFor(() => Math.abs((app.state?.master ?? 0) - 0.6) < 1e-9, 2000, 'Master up');
  await post(app, '/api/master/down');
  await post(app, '/api/master/down');
  await waitFor(() => Math.abs((app.state?.master ?? 0) - 0.4) < 1e-9, 2000, 'Master down twice');

  await post(app, '/api/group/2/colour/1');
  await waitFor(() => app.state?.groups[g2.id]?.preset === g2.presets[0].id, 2000, 'colour 1');
  await post(app, '/api/undo');
  await waitFor(() => app.state?.groups[g2.id]?.preset !== g2.presets[0].id, 2000, 'Undo to take the colour back');

  await post(app, '/api/blackout');
  await waitFor(() => app.state?.look === 'blackout', 2000, 'Blackout');
}));

test('the HTTP routes answer a position that is not there with the plain message', () => withApp(async (app) => {
  const refuse = async (method: string, path: string, message: string) => {
    const r = await api(app, method, path);
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error, message, path);
  };
  await refuse('POST', '/api/item/17', 'There is no song 17.');
  await refuse('POST', '/api/item/two', 'There is no song two.');
  await refuse('POST', '/api/group/7/colour/1', 'There is no group 7.');
  await refuse('POST', '/api/group/2/colour/9', 'Group 2 has no colour 9.');
  await refuse('POST', '/api/group/7/level/50', 'There is no group 7.');
  await refuse('POST', '/api/flash/9/on', 'There is no group 9.');
  await refuse('POST', '/api/flash/nope/off', 'There is no group nope.');
  await refuse('POST', '/api/group/1/level/150', 'value must be 0-100');
  await refuse('POST', '/api/master/150', 'value must be 0-100');
}));

test('flash from HTTP by position, id and all, with on and off', () => withApp(async (app) => {
  const layout = await layoutOf(app);
  const ids: string[] = layout.groups.map((g: any) => g.id);
  await post(app, '/api/flash/2/on');
  await waitFor(() => String(app.state?.flashing) === ids[1], 2000, 'group 2 flashing');
  await post(app, '/api/flash/2/off');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'group 2 flash off');

  await post(app, `/api/flash/${ids[0]}/on`);
  await waitFor(() => String(app.state?.flashing) === ids[0], 2000, 'group 1 flashing by id');
  await post(app, `/api/flash/${ids[0]}/off`);
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'flash off');

  await post(app, '/api/flash/all/on');
  await waitFor(() => app.state?.flashing.length === ids.length, 2000, 'every group flashing');
  await post(app, '/api/flash/all/off');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'every flash off');
}));

test('a Flash held over HTTP is put out after the time limit', () => withApp(async (app) => {
  await post(app, '/api/flash/1/on');
  await waitFor(() => app.state?.flashing.length === 1, 2000, 'group 1 flashing');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the held flash to be put out');
}, 150));

test('letting go of a Flash early keeps no timer that puts out a later one', () => withApp(async (app) => {
  await post(app, '/api/flash/1/on');
  await post(app, '/api/flash/1/off');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'flash off');
  await sleep(100);
  await post(app, '/api/flash/1/on');
  await waitFor(() => app.state?.flashing.length === 1, 2000, 'flashing again');
  await sleep(100); // 200 ms since the first press, 100 ms since the second: still held
  assert.equal(app.state?.flashing.length, 1);
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the second flash to time out');
}, 150));

test('releaseDevice puts out what that source holds, and spares what another source holds', () => withApp(async (app) => {
  await waitFor(() => app.state, 2000, 'the first state');
  assert.equal(await app.device({ kind: 'flash', group: 1, on: true }, 'apc'), null);
  assert.equal(await app.device({ kind: 'flash', group: 2, on: true }, 'apc'), null);
  assert.equal(await app.device({ kind: 'flash', group: 2, on: true }, 'osc'), null);
  await waitFor(() => app.state?.flashing.length === 2, 2000, 'two groups flashing');

  app.releaseDevice('apc');
  await waitFor(() => app.state?.flashing.length === 1, 2000, "the APC's flash to stop");
  const layout = await layoutOf(app);
  assert.equal(String(app.state?.flashing), layout.groups[1].id, 'group 2 stays on: OSC holds it');
  app.releaseDevice('osc');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'every flash to stop');
}));

test('a device Flash spares groups a tablet holds, and a tablet leaving spares groups a device holds', () => withApp(async (app) => {
  const layout = await layoutOf(app);
  const g1 = layout.groups[0].id;
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'command', ref: 1, cmd: { type: 'flash', groups: [g1], on: true } }));
  await waitFor(() => app.state?.flashing.length === 1, 2000, 'the tablet flash');
  assert.equal(await app.device({ kind: 'flash', group: 1, on: true }, 'apc'), null);

  // The device lets go, but the tablet still holds the group.
  assert.equal(await app.device({ kind: 'flash', group: 1, on: false }, 'apc'), null);
  await sleep(100);
  assert.equal(app.state?.flashing.length, 1);

  assert.equal(await app.device({ kind: 'flash', group: 1, on: true }, 'apc'), null);
  ws.close();
  await sleep(100);
  assert.equal(app.state?.flashing.length, 1, 'the device still holds it');
  app.releaseDevice('apc');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the flash to stop');
}));

test('App.device answers a refusal and runs the command otherwise', () => withApp(async (app) => {
  await waitFor(() => app.state, 2000, 'the first state');
  assert.equal(await app.device({ kind: 'item', n: 99 }, 'osc'), 'There is no song 99.');
  assert.equal(await app.device({ kind: 'groupColour', group: 1, colour: 99 }, 'osc'), 'Group 1 has no colour 99.');
  assert.equal(await app.device({ kind: 'item', n: 2 }, 'osc'), null);
  const layout = await layoutOf(app);
  await waitFor(() => app.state?.look === layout.runningOrder[1].id, 2000, 'item 2');
}));

test('GET /api/companion is a flat status', () => withApp(async (app) => {
  const layout = await layoutOf(app);
  const order = layout.runningOrder;
  const name = (id: string) => order.find((l: any) => l.id === id).name;

  await waitFor(() => app.state, 2000, 'the first state');
  let c = (await api(app, 'GET', '/api/companion')).body;
  assert.equal(c.look, null);
  assert.equal(c.lookName, '');
  assert.equal(c.next, order[1].id, 'a fresh stage: the first song');
  assert.equal(c.nextName, order[1].name);
  assert.equal(c.blackout, false);
  assert.equal(c.flashing, false);
  assert.equal(c.items.length, order.length);
  assert.deepEqual(c.items.map((i: any) => i.n), order.map((_: any, k: number) => k + 1));
  assert.ok(c.items.every((i: any) => i.onStage === false));

  await post(app, '/api/item/3');
  await post(app, '/api/group/2/level/40');
  await post(app, '/api/master/70');
  await post(app, '/api/flash/1/on');
  await waitFor(() => { const s = app.state; return !!s && s.look === order[2].id && s.master === 0.7 && s.flashing.length === 1 && s.groups[layout.groups[1].id]?.level === 0.4; }, 2000, 'the stage to settle');
  c = (await api(app, 'GET', '/api/companion')).body;
  assert.equal(c.look, order[2].id);
  assert.equal(c.lookName, name(order[2].id));
  assert.equal(c.next, order[3].id);
  assert.equal(c.nextName, name(order[3].id));
  assert.equal(typeof c.changed, 'boolean');
  assert.equal(c.flashing, true);
  assert.equal(c.master, 70);
  assert.equal(typeof c.tempo, 'number');
  assert.deepEqual(c.items.filter((i: any) => i.onStage).map((i: any) => i.n), [3]);
  assert.equal(c.items[2].name, name(order[2].id));
  assert.equal(c.groups.length, layout.groups.filter((g: any) => g.kind !== 'smoke').length);
  assert.deepEqual(Object.keys(c.groups[0]).sort(), ['colour', 'level', 'n', 'name']);
  assert.equal(c.groups[0].n, 1);
  assert.equal(c.groups[1].name, layout.groups[1].name);
  assert.equal(c.groups[1].level, 40);
  assert.equal(typeof c.groups[0].colour, 'string');
  assert.ok(Number.isInteger(c.groups[0].level));

  await post(app, '/api/flash/1/off');
  await post(app, '/api/blackout');
  await waitFor(() => app.state?.look === 'blackout', 2000, 'Blackout');
  c = (await api(app, 'GET', '/api/companion')).body;
  assert.equal(c.look, 'blackout');
  assert.equal(c.lookName, 'Blackout');
  assert.equal(c.blackout, true);
  assert.equal(c.next, order[3].id, 'Next carries on from the item before Blackout');

  await post(app, '/api/item/1');
  await waitFor(() => app.state?.look === 'safe', 2000, 'Basic lights');
  c = (await api(app, 'GET', '/api/companion')).body;
  assert.equal(c.look, 'safe');
  assert.equal(c.lookName, order[0].name);
  assert.deepEqual(c.items.filter((i: any) => i.onStage).map((i: any) => i.n), [1]);
}));
