import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSocket } from 'node:dgram';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { artDmx, ArtNetOutput } from '../src/output/artnet.ts';
import { enttecPacket } from '../src/output/enttec.ts';
import { isLocalAddress } from '../src/net.ts';
import { Store, BACKUPS_KEPT } from '../src/store.ts';
import { parseShow } from '../../packages/shared/src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const tempDir = () => mkdtempSync(join(tmpdir(), 'light-runner-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeApp(dataDir: string) {
  return new App({ port: 0, host: '127.0.0.1', dataDir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} });
}

async function api(app: App, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
}

test('ArtDmx packet layout', () => {
  const data = new Uint8Array(512);
  data[0] = 255;
  const p = artDmx(0x123, data, 7);
  assert.equal(p.subarray(0, 8).toString('latin1'), 'Art-Net\0');
  assert.equal(p.readUInt16LE(8), 0x5000);
  assert.equal(p.readUInt16BE(10), 14);
  assert.equal(p[12], 7);
  assert.equal(p[14], 0x23); // SubUni
  assert.equal(p[15], 0x01); // Net
  assert.equal(p.readUInt16BE(16), 512);
  assert.equal(p[18], 255);
  assert.equal(p.length, 530);
});

test('Art-Net output sends a packet per universe', async () => {
  const rx = createSocket('udp4');
  await new Promise<void>((r) => rx.bind(0, '127.0.0.1', r));
  const { port } = rx.address();
  const got = new Promise<Buffer>((r) => rx.once('message', r));
  const out = new ArtNetOutput('127.0.0.1', port);
  await sleep(50);
  out.send(new Map([[0, new Uint8Array(512).fill(9)]]));
  const packet = await got;
  assert.equal(packet[18], 9);
  assert.equal(out.status, 'ok');
  out.close();
  rx.close();
});

test('ENTTEC packet layout', () => {
  const p = enttecPacket(new Uint8Array(512).fill(3));
  assert.deepEqual([p[0], p[1], p[2], p[3], p[4], p[5]], [0x7e, 6, 513 & 255, 513 >> 8, 0, 3]);
  assert.equal(p[p.length - 1], 0xe7);
});

test('only local network addresses are allowed', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.20.1.1', 'fe80::1']) assert.ok(isLocalAddress(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '2001:db8::1', undefined]) assert.ok(!isLocalAddress(a), String(a));
});

test('the show is saved with backups, and a corrupt show falls back to the newest good backup', () => {
  const dir = tempDir();
  try {
    const store = new Store(dir, seedPath);
    const first = store.loadShow();
    assert.equal(first.source, 'seed');
    for (let n = 0; n < BACKUPS_KEPT + 5; n++) store.saveShow({ ...first.show, name: `Save ${n}` });
    assert.equal(store.backups().length, BACKUPS_KEPT);
    writeFileSync(join(dir, 'show.json'), '{ broken');
    const loaded = store.loadShow();
    assert.equal(loaded.source, 'backup');
    assert.equal(loaded.show.name, `Save ${BACKUPS_KEPT + 3}`);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the API runs looks, reports state and refuses manual for operators by default', async () => {
  const dir = tempDir();
  const app = makeApp(dir);
  try {
    await app.start();
    assert.equal((await api(app, 'POST', '/api/look/worship')).status, 200);
    await sleep(80);
    let state = (await api(app, 'GET', '/api/state')).body;
    assert.equal(state.look, 'worship');
    assert.equal(state.groups['back-wall'].preset, 'back-purple');

    assert.equal((await api(app, 'POST', '/api/group/back-wall/preset/back-amber?fade=1')).status, 200);
    assert.equal((await api(app, 'POST', '/api/master/80')).status, 200);
    await sleep(80);
    state = (await api(app, 'GET', '/api/state')).body;
    assert.equal(state.groups['back-wall'].changed, true);
    assert.equal(state.master, 0.8);

    assert.equal((await api(app, 'POST', '/api/look/nope')).status, 404);
    assert.equal((await api(app, 'POST', '/api/master/150')).status, 400);
    const manual = await api(app, 'POST', '/api/group/back-wall/manual', { colour: '#ff0000', intensity: 50 });
    assert.equal(manual.status, 400);
    assert.match(manual.body.error, /manual control is not enabled/);

    const looks = (await api(app, 'GET', '/api/looks')).body;
    assert.ok(looks.looks.some((l: any) => l.id === 'worship' && l.colour));
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WebSocket clients get layout, state and visualiser frames, and can send commands', async () => {
  const dir = tempDir();
  const app = makeApp(dir);
  try {
    await app.start();
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const seen: any[] = [];
    let binary = 0;
    ws.on('message', (data, isBinary) => (isBinary ? binary++ : seen.push(JSON.parse(String(data)))));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'command', ref: 1, cmd: { type: 'safe' } }));
    await sleep(300);
    assert.ok(seen.some((m) => m.type === 'layout' && m.layout.fixtures.length === 13));
    assert.ok(seen.some((m) => m.type === 'result' && m.ref === 1 && m.error === null));
    assert.ok(seen.some((m) => m.type === 'state' && m.state.look === 'safe'));
    assert.ok(binary >= 3, `visual frames: ${binary}`);
    ws.close();
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the layout lists the running order, quick looks and white-only groups', async () => {
  const dir = tempDir();
  const app = makeApp(dir);
  try {
    await app.start();
    const { status, body: layout } = await api(app, 'GET', '/api/layout');
    assert.equal(status, 200);
    assert.ok(layout.basicLights);
    assert.equal(layout.runningOrder[0].id, layout.basicLights);
    assert.ok(layout.runningOrder.length > 1);
    assert.ok(layout.quickLooks.length > 0);
    assert.ok(layout.quickLooks.every((l: any) => ['plain', 'colours', 'effects'].includes(l.tab)));
    assert.equal(layout.runningOrder[0].levels.length, layout.groups.length);
    assert.ok(layout.looks.length > 0, 'the old looks list stays for the HTTP API');
    const custom = new Set(parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).presets.filter((p) => p.custom).map((p) => p.id));
    for (const g of layout.groups) {
      assert.equal(typeof g.whiteOnly, 'boolean');
      assert.ok(g.presets.every((p: any) => !custom.has(p.id)));
    }
    // The Neewer-style CCT front lights have no colour channels; the RGB bars do.
    assert.ok(layout.groups.some((g: any) => g.whiteOnly === false));
    // The migrated show is saved, so the running order survives a restart.
    assert.ok(parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).operator.runningOrder.length > 0);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a show imported without a running order gets one in the layout', async () => {
  const dir = tempDir();
  const app = makeApp(dir);
  try {
    await app.start();
    const show = (await api(app, 'GET', '/api/show')).body;
    show.operator.runningOrder = [];
    show.operator.quickLooks = [];
    show.operator.safeLook = undefined;
    show.looks = show.looks.filter((l: any) => l.name !== 'Basic lights' && !/^Song \d$/.test(l.name));
    assert.equal((await api(app, 'PUT', '/api/show', show)).status, 200);
    const { body: layout } = await api(app, 'GET', '/api/layout');
    assert.ok(layout.basicLights);
    assert.equal(layout.runningOrder[0].id, layout.basicLights);
    assert.ok(layout.runningOrder.length > 1);
    const saved = parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8')));
    assert.ok(saved.operator.runningOrder.length > 1);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart restores the last look, master and group presets', async () => {
  const dir = tempDir();
  try {
    const a = makeApp(dir);
    await a.start();
    await api(a, 'POST', '/api/look/word');
    await api(a, 'POST', '/api/group/audience/preset/aud-blue');
    await api(a, 'POST', '/api/master/60');
    await sleep(100);
    await a.stop();
    const saved = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
    assert.equal(saved.look, 'word');

    const b = makeApp(dir);
    const started = Date.now();
    await b.start();
    await sleep(80);
    const state = (await api(b, 'GET', '/api/state')).body;
    assert.ok(Date.now() - started < 5000);
    assert.equal(state.look, 'word');
    assert.equal(state.master, 0.6);
    assert.equal(state.groups.audience.preset, 'aud-blue');
    assert.equal(state.groups.audience.progress, 1);
    await b.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the demo show is valid', () => {
  parseShow(JSON.parse(readFileSync(seedPath, 'utf8')));
});

// ---- Operator edits to the show, and the one Undo list ----

async function waitFor<T>(get: () => T | null | undefined | false, ms = 2000, what = 'a condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A tablet on the WebSocket: sends commands and keeps the latest state and layout. */
async function tablet(app: App) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const seen: any[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) seen.push(JSON.parse(String(data)));
  });
  await new Promise((r) => ws.once('open', r));
  let ref = 0;
  const latest = (type: string) => seen.findLast((m) => m.type === type)?.[type];
  return {
    ws,
    state: () => latest('state'),
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

async function withApp(fn: (app: App, dir: string) => Promise<void>) {
  const dir = tempDir();
  const app = makeApp(dir);
  try {
    await app.start();
    await fn(app, dir);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const savedLook = (dir: string, id: string) =>
  parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).looks.find((l) => l.id === id);

test('Save to an item stores the stage, then the item is no longer changed', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupLevel', group: 'audience', value: 0.4 }), null);
  await waitFor(() => t.state()?.lookChanged, 2000, 'the look to show as changed');

  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  await waitFor(() => t.state()?.lookChanged === false, 2000, 'the look to no longer show as changed');
  assert.equal(t.state().look, song);
  const look = savedLook(dir, song)!;
  assert.deepEqual(look.groups.find((e) => e.group === 'back-wall'), { group: 'back-wall', preset: 'back-amber', level: 1 });
  assert.deepEqual(look.groups.find((e) => e.group === 'audience'), { group: 'audience', preset: 'aud-blue', level: 0.4 });
  const item = t.layout().runningOrder.find((l: any) => l.id === song);
  assert.ok(item.colours.includes('#ff8a1f'), 'the layout shows the saved colours');

  // Quick looks are made with "Save stage as quick look", never overwritten by Save.
  const quick = t.layout().quickLooks[0].id;
  assert.equal(await t.send({ type: 'saveItem', id: quick }), 'only running-order items can be saved');
}));

test('Save during a fade stores where the fade is going', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 30 }), null);
  assert.equal(await t.send({ type: 'groupPreset', group: 'audience', preset: 'aud-blue', fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupLevel', group: 'audience', value: 0.3 }), null);
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  assert.ok(t.state().groups['back-wall'].progress < 1, 'the back wall is still fading');
  const look = savedLook(dir, song)!;
  assert.equal(look.groups.find((e) => e.group === 'back-wall')?.preset, 'back-amber');
  assert.equal(look.groups.find((e) => e.group === 'audience')?.level, 0.3);
}));

test('Add, rename, move and delete edit the running order, and Undo takes each back', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const start = t.order();
  const song = start[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);

  assert.equal(await t.send({ type: 'addSong', after: song }), null);
  const added = t.order()[2]!;
  assert.ok(!start.includes(added));
  const name = (id: string) => t.layout().runningOrder.find((l: any) => l.id === id)?.name;
  assert.equal(name(added), 'Song 6');

  assert.equal(await t.send({ type: 'renameItem', id: added, name: '  Amazing grace ' }), null);
  assert.equal(name(added), 'Amazing grace');
  assert.equal(await t.send({ type: 'moveItem', id: added, to: 5 }), null);
  assert.equal(t.order().indexOf(added), 5);
  assert.equal(await t.send({ type: 'deleteItem', id: added }), null);
  assert.ok(!t.order().includes(added));

  // Refused edits leave the show, and the Undo list, alone.
  assert.equal(await t.send({ type: 'renameItem', id: song, name: '   ' }), 'a name is needed');
  assert.equal(await t.send({ type: 'deleteItem', id: start[0] }), "Basic lights can't be deleted");
  assert.equal(await t.send({ type: 'moveItem', id: added, to: 2 }), `"${added}" isn't in the running order`);
  assert.match((await t.send({ type: 'moveItem', id: song, to: 1.5 }))!, /^invalid command/);
  assert.match((await t.send({ type: 'renameItem', id: song }))!, /^invalid command/);

  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(t.order().indexOf(added), 5);
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(t.order().indexOf(added), 2);
  assert.equal(name(added), 'Amazing grace');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(name(added), 'Song 6');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.deepEqual(t.order(), start);
  await sleep(60);
  assert.equal(t.state().look, song, 'undoing show edits leaves the stage alone');
}));

test('Undo goes back through stage changes and show edits in the order they happened', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const [, one, two] = t.order();
  assert.equal(await t.send({ type: 'look', id: one, fade: 0 }), null);
  await waitFor(() => t.state()?.look === one);
  const before = t.state().groups['back-wall'].preset;
  assert.notEqual(before, 'back-amber');
  assert.equal(await t.send({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 }), null);
  assert.equal(await t.send({ type: 'saveItem', id: one }), null);
  assert.equal(await t.send({ type: 'look', id: two, fade: 0 }), null);
  await waitFor(() => t.state()?.look === two);

  assert.equal(await t.send({ type: 'undo' }), null); // the look change
  await waitFor(() => t.state()?.look === one, 2000, 'the first song back on stage');
  assert.equal(savedLook(dir, one!)!.groups.find((e) => e.group === 'back-wall')?.preset, 'back-amber');

  assert.equal(await t.send({ type: 'undo' }), null); // the Save
  assert.equal(savedLook(dir, one!)!.groups.find((e) => e.group === 'back-wall')?.preset, before);
  await sleep(60);
  assert.equal(t.state().groups['back-wall'].preset, 'back-amber', 'the stage stays as it is');
  assert.ok(t.state().canUndo);

  assert.equal(await t.send({ type: 'undo' }), null); // the preset change
  await waitFor(() => t.state()?.groups['back-wall'].preset === before, 2000, 'the back wall back as it was');
  assert.equal(await t.send({ type: 'undo' }), null); // the first look
  await waitFor(() => t.state()?.canUndo === false, 2000, 'Undo to have nothing left');
  assert.equal(await t.send({ type: 'undo' }), 'nothing to undo');
}));

test('a show edit enables Undo straight away', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(() => t.state() && t.layout());
  assert.equal(t.state().canUndo, false);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'renameItem', id: song, name: 'Opening' }), null);
  // The new state is sent before the reply, without waiting for the engine.
  assert.equal(t.state().canUndo, true);
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(t.state().canUndo, false);
}));

test("Undo doesn't take back an operator edit from before a programmer change", () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'renameItem', id: song, name: 'Opening' }), null);
  assert.equal((await api(app, 'PUT', '/api/settings', { showName: 'Sunday' })).status, 200);
  await waitFor(() => t.state()?.canUndo === false, 2000, 'Undo to have nothing left');
  assert.equal(await t.send({ type: 'undo' }), 'nothing to undo');
  assert.equal((await api(app, 'GET', '/api/settings')).body.showName, 'Sunday');
}));

test('deleting the item on stage leaves the stage alone and nothing breaks', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const [, one, two] = t.order();
  assert.equal(await t.send({ type: 'look', id: two, fade: 0 }), null);
  await waitFor(() => t.state()?.look === two);
  assert.equal(await t.send({ type: 'deleteItem', id: two }), null);
  assert.ok(!t.order().includes(two!));
  await sleep(80);
  assert.equal(t.state().look, two);
  assert.equal(await t.send({ type: 'look', id: one, fade: 0 }), null);
  await waitFor(() => t.state()?.look === one, 2000, 'the first song on stage');
}));

test('Flash stops when the tablet that held it disconnects', () => withApp(async (app) => {
  const watch = await tablet(app);
  const a = await tablet(app);
  const b = await tablet(app);
  assert.equal(await a.send({ type: 'flash', groups: ['back-wall', 'audience'], on: true }), null);
  assert.equal(await a.send({ type: 'flash', groups: ['audience'], on: false }), null);
  assert.equal(await b.send({ type: 'flash', groups: ['audience'], on: true }), null);
  await waitFor(() => watch.state()?.flashing.length === 2, 2000, 'two groups flashing');

  a.ws.close();
  await waitFor(() => String(watch.state()?.flashing) === 'audience', 200, "the first tablet's flash to stop");
  b.ws.close();
  await waitFor(() => watch.state()?.flashing.length === 0, 200, 'every flash to stop');
}));

test('show edits are open to operators without the PIN', () => withApp(async (app, dir) => {
  assert.equal((await api(app, 'POST', '/api/pin', { next: '1234' })).status, 200);
  assert.equal((await api(app, 'GET', '/api/settings')).status, 401);
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  assert.equal(await t.send({ type: 'addSong', after: song }), null);
  assert.equal(await t.send({ type: 'renameItem', id: song, name: 'Opening' }), null);
  assert.equal(await t.send({ type: 'moveItem', id: song, to: 3 }), null);
  assert.equal(await t.send({ type: 'deleteItem', id: song }), null);
  assert.equal(await t.send({ type: 'saveQuickLook', name: 'Warm wall', tab: 'colours', groups: ['back-wall'] }), null);
  const quick = t.layout().quickLooks.find((q: any) => q.name === 'Warm wall');
  assert.equal(quick?.tab, 'colours');
  assert.deepEqual(savedLook(dir, quick.id)!.groups.map((e) => e.group), ['back-wall']);
  assert.match((await t.send({ type: 'saveQuickLook', name: 'None', tab: 'plain', groups: [] }))!, /^invalid command/);
  assert.match((await t.send({ type: 'saveQuickLook', name: 'Odd', tab: 'nope', groups: ['audience'] }))!, /^invalid command/);
  // The PIN is still set after all those saves.
  assert.equal((await api(app, 'GET', '/api/settings')).status, 401);
}));
