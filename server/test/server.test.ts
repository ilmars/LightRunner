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

function makeApp(dataDir: string, heartbeatMs?: number) {
  return new App({ port: 0, host: '127.0.0.1', dataDir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {}, heartbeatMs });
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
async function tablet(app: App, opts: { autoPong?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, opts);
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

async function withApp(fn: (app: App, dir: string) => Promise<void>, heartbeatMs?: number) {
  const dir = tempDir();
  const app = makeApp(dir, heartbeatMs);
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

test('Save after an Any colour pick clears changed and keeps the colour running', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupColour', group: 'back-wall', colour: '#12ab34', fade: 0 }), null);
  await waitFor(() => t.state()?.lookChanged, 2000, 'the look to show as changed');
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  await waitFor(() => t.state()?.lookChanged === false, 2000, 'the look to no longer show as changed');
  const saved = savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')!;
  assert.ok(!saved.preset.startsWith('live:'), 'Save stores a custom preset');
  assert.equal(t.state().groups['back-wall'].preset, saved.preset);
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

test('Save, add and Save as quick look work after Basic lights', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const [, one, two] = t.order();
  assert.equal(await t.send({ type: 'safe' }), null);
  await waitFor(() => t.state()?.look === 'safe');
  assert.equal(await t.send({ type: 'saveItem', id: one }), null);
  assert.equal(await t.send({ type: 'saveItem', id: two }), null);
  assert.equal(await t.send({ type: 'addSong', after: two }), null);
  assert.equal(await t.send({ type: 'saveQuickLook', name: 'Calm', tab: 'plain', groups: ['back-wall'] }), null);
  const show = parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8')));
  const basic = show.presets.filter((p) => p.name === 'Basic light');
  assert.equal(basic.length, show.groups.length, 'one Basic light preset per group, reused by every save');
  assert.ok(basic.every((p) => p.custom));
  const presetsOf = (id: string) => show.looks.find((l) => l.id === id)!.groups.map((e) => e.preset).sort();
  assert.deepEqual(presetsOf(one!), basic.map((p) => p.id).sort());
  assert.deepEqual(presetsOf(two!), presetsOf(one!));
}));

test('Save is refused while Blackout is on', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'blackout' }), null);
  const refused = 'Blackout is on. Bring the lights back, then save.';
  assert.equal(await t.send({ type: 'saveItem', id: song }), refused);
  assert.equal(await t.send({ type: 'addSong', after: song }), refused);
  assert.equal(await t.send({ type: 'saveQuickLook', name: 'Dark', tab: 'plain', groups: ['back-wall'] }), refused);
  assert.equal(await t.send({ type: 'renameItem', id: song, name: 'Opening' }), null, 'other edits still work');
}));

test('operator edits make one backup, and a programmer save allows one more', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  const start = app.store.backups().length;
  assert.equal(await t.send({ type: 'renameItem', id: song, name: 'Opening' }), null);
  assert.equal(await t.send({ type: 'renameItem', id: song, name: 'Welcome' }), null);
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(app.store.backups().length, start + 1);
  assert.equal((await api(app, 'PUT', '/api/settings', { showName: 'Sunday' })).status, 200);
  assert.equal(app.store.backups().length, start + 2);
  assert.equal(await t.send({ type: 'renameItem', id: song, name: 'Opening' }), null);
  assert.equal(await t.send({ type: 'moveItem', id: song, to: 3 }), null);
  assert.equal(app.store.backups().length, start + 3);
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

const presetsOf = (layout: any, group: string) => layout.groups.find((g: any) => g.id === group).presets as { id: string; name: string; swatch: string }[];
const savedPresets = (dir: string) => parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).presets;

test('Add to colours lists a live colour, the group adopts it, and Undo takes it back', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupColour', group: 'back-wall', colour: '#12ab34', fade: 0 }), null);
  await waitFor(() => t.state()?.groups['back-wall'].preset === 'live:back-wall:#12ab34', 2000, 'the live colour to run');
  const listed = presetsOf(t.layout(), 'back-wall').length;

  assert.equal(await t.send({ type: 'addColour', group: 'back-wall', colour: '#12AB34', name: ' Meadow ', allGroups: false }), null);
  const added = presetsOf(t.layout(), 'back-wall').find((p) => p.name === 'Meadow')!;
  assert.ok(added, 'the layout lists the new colour');
  assert.equal(added.swatch, '#12ab34');
  assert.equal(presetsOf(t.layout(), 'back-wall').length, listed + 1);
  await waitFor(() => t.state()?.groups['back-wall'].preset === added.id, 2000, 'the group to run the new preset');
  assert.ok(savedPresets(dir).some((p) => p.id === added.id && !p.custom), 'the show on disk has it as a normal preset');
  // Adding it is one Undo step: the group's change to the new preset adds none of its own.
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.ok(!presetsOf(t.layout(), 'back-wall').some((p) => p.id === added.id), 'Undo removes it from the list');
  assert.ok(!savedPresets(dir).some((p) => p.id === added.id));
  await waitFor(() => t.state()?.groups['back-wall'].preset === 'live:back-wall:#12ab34', 2000, 'the group to carry on as the live colour');
  // Saving still works afterwards: no group names a preset that is gone.
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
}));

test('Add to colours: names, every group, duplicates, Blackout and the PIN', () => withApp(async (app, dir) => {
  assert.equal((await api(app, 'POST', '/api/pin', { next: '1234' })).status, 200);
  const t = await tablet(app);
  await waitFor(t.layout);
  const before = Object.fromEntries(t.layout().groups.map((g: any) => [g.id, g.presets.length]));

  // No name: "Colour 1"; adding it to every colour group gives each its own.
  assert.equal(await t.send({ type: 'addColour', group: 'audience', colour: '#aa5500', name: '', allGroups: true }), null);
  for (const g of t.layout().groups) {
    assert.equal(g.presets.length, before[g.id] + 1, g.id);
    assert.ok(g.presets.some((p: any) => p.name === 'Colour 1' && p.swatch === '#aa5500'), g.id);
  }
  // The same colour again is refused and adds no Undo step.
  assert.equal(await t.send({ type: 'addColour', group: 'audience', colour: '#AA5500', name: 'x', allGroups: true }), 'every group already has that colour');
  assert.equal(await t.send({ type: 'addColour', group: 'audience', colour: '#aa5500', name: 'x', allGroups: false }), 'that colour is already in the list');
  assert.equal(await t.send({ type: 'addColour', group: 'nope', colour: '#aa5501', name: 'x', allGroups: false }), 'the show has no group "nope"');
  assert.match((await t.send({ type: 'addColour', group: 'audience', colour: 'red', name: 'x', allGroups: false }))!, /^invalid command/);
  assert.match((await t.send({ type: 'addColour', group: 'audience', colour: '#aa5501', name: 'x' }))!, /^invalid command/);

  // Allowed during Blackout: a colour doesn't depend on the stage.
  assert.equal(await t.send({ type: 'blackout' }), null);
  await waitFor(() => t.state()?.look === 'blackout', 2000, 'Blackout');
  assert.equal(await t.send({ type: 'addColour', group: 'audience', colour: '#0a0b0c', name: 'Night', allGroups: false }), null);
  assert.ok(presetsOf(t.layout(), 'audience').some((p) => p.name === 'Night'));

  // The newest Undo step is Night; Blackout stays on.
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.ok(!presetsOf(t.layout(), 'audience').some((p) => p.name === 'Night'));
  assert.equal(t.state().look, 'blackout');
}));

test('a colour added with Add to colours survives a restart, still adopted by the group', async () => {
  const dir = tempDir();
  try {
    const first = makeApp(dir);
    await first.start();
    const t = await tablet(first);
    await waitFor(t.layout);
    assert.equal(await t.send({ type: 'groupColour', group: 'back-wall', colour: '#12ab34', fade: 0 }), null);
    assert.equal(await t.send({ type: 'addColour', group: 'back-wall', colour: '#12ab34', name: 'Meadow', allGroups: false }), null);
    const id = presetsOf(t.layout(), 'back-wall').find((p) => p.name === 'Meadow')!.id;
    await waitFor(() => t.state()?.groups['back-wall'].preset === id, 2000, 'the group to run the new preset');
    await first.stop();

    const second = makeApp(dir);
    await second.start();
    try {
      const u = await tablet(second);
      await waitFor(u.layout);
      await waitFor(() => u.state(), 2000, 'the state');
      assert.ok(presetsOf(u.layout(), 'back-wall').some((p) => p.id === id && p.name === 'Meadow'));
      assert.equal(u.state().groups['back-wall'].preset, id);
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const presetOf = (layout: any, group: string, id: string) => presetsOf(layout, group).find((p) => p.id === id);
const plainOf = (p: any) => (p ? { id: p.id, name: p.name, swatch: p.swatch } : p);

test('Edit colour renames and recolours, the stage follows, and Undo restores it', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  assert.equal(await t.send({ type: 'addColour', group: 'back-wall', colour: '#12ab34', name: 'Meadow', allGroups: true }), null);
  const mine = presetsOf(t.layout(), 'back-wall').find((p) => p.name === 'Meadow')!.id;
  const other = presetsOf(t.layout(), 'audience').find((p) => p.name === 'Meadow')!.id;
  assert.equal(await t.send({ type: 'groupPreset', group: 'back-wall', preset: mine, fade: 0 }), null);
  await waitFor(() => t.state()?.groups['back-wall'].preset === mine, 2000, 'the colour to run');

  // Only this group, then the same name in every group.
  assert.equal(await t.send({ type: 'editColour', preset: mine, name: ' Pasture ', colour: '#406080', sameName: false }), null);
  assert.deepEqual(plainOf(presetOf(t.layout(), 'back-wall', mine)), { id: mine, name: 'Pasture', swatch: '#406080' });
  assert.equal(presetOf(t.layout(), 'audience', other)!.name, 'Meadow');
  assert.equal(t.state().groups['back-wall'].preset, mine, 'the stage keeps the same preset');
  assert.ok(savedPresets(dir).some((p) => p.id === mine && p.name === 'Pasture' && !p.custom));
  assert.equal(await t.send({ type: 'editColour', preset: other, name: 'Field', sameName: true }), null);
  assert.equal(presetOf(t.layout(), 'audience', other)!.name, 'Field');
  assert.equal(presetOf(t.layout(), 'back-wall', mine)!.name, 'Pasture'); // not the same name any more

  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(presetOf(t.layout(), 'audience', other)!.name, 'Meadow');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.deepEqual(plainOf(presetOf(t.layout(), 'back-wall', mine)), { id: mine, name: 'Meadow', swatch: '#12ab34' });

  // Refused edits say so in plain words.
  assert.equal(await t.send({ type: 'editColour', preset: mine, name: '  ', sameName: false }), 'a name is needed');
  assert.equal(await t.send({ type: 'editColour', preset: 'nope', name: 'x', sameName: false }), 'that colour is not in the list');
  assert.match((await t.send({ type: 'editColour', preset: mine, colour: 'blue', sameName: false }))!, /^invalid command/);
  assert.match((await t.send({ type: 'editColour', preset: mine, name: 'x' }))!, /^invalid command/);
}));

test('Delete colour removes an unused one, refuses a used or lit one, and Undo brings it back', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  assert.equal(await t.send({ type: 'addColour', group: 'back-wall', colour: '#12ab34', name: 'Meadow', allGroups: false }), null);
  const mine = presetsOf(t.layout(), 'back-wall').find((p) => p.name === 'Meadow')!.id;

  // Lit now: kept.
  assert.equal(await t.send({ type: 'groupPreset', group: 'back-wall', preset: mine, fade: 0 }), null);
  await waitFor(() => t.state()?.groups['back-wall'].preset === mine, 2000, 'the colour to run');
  const lit = 'That colour is on stage now. Pick another colour for the group first.';
  assert.equal(await t.send({ type: 'deleteColour', preset: mine }), lit);
  // Also while Blackout holds it dark.
  assert.equal(await t.send({ type: 'blackout' }), null);
  await waitFor(() => t.state()?.look === 'blackout', 2000, 'Blackout');
  assert.equal(await t.send({ type: 'deleteColour', preset: mine }), lit);
  assert.equal(await t.send({ type: 'look', id: t.order()[1], fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupPreset', group: 'back-wall', preset: 'back-amber', fade: 0 }), null);

  assert.equal(await t.send({ type: 'deleteColour', preset: mine }), null);
  assert.equal(presetOf(t.layout(), 'back-wall', mine), undefined);
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.ok(presetOf(t.layout(), 'back-wall', mine), 'Undo brings it back');

  // A colour a look uses is refused with the names of the looks.
  const error = await t.send({ type: 'deleteColour', preset: 'back-purple' });
  assert.match(error!, /^Used in .+\. Change those first\.$/);
  assert.ok(presetOf(t.layout(), 'back-wall', 'back-purple'));
  assert.equal(await t.send({ type: 'deleteColour', preset: 'nope' }), 'that colour is not in the list');
}));

test('an Off colour cannot be given a colour over the wire, but can be renamed in every group', async () => {
  const dir = tempDir();
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath: join(root, 'shows/stage-l1.json'), webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} });
  try {
    await app.start();
    const t = await tablet(app);
    await waitFor(t.layout);
    const off = (group: string) => presetsOf(t.layout(), group).find((p) => p.name === 'Izslēgts')!;
    assert.equal(await t.send({ type: 'editColour', preset: off('key-lights').id, colour: '#ff0000', sameName: true }), "Off can't be given a colour; add a new colour instead.");
    assert.equal(off('front-lights').swatch, '#000000');
    assert.equal(await t.send({ type: 'editColour', preset: off('key-lights').id, name: 'Dark', sameName: true }), null);
    for (const g of ['front-lights', 'key-lights', 'background']) {
      assert.equal(presetsOf(t.layout(), g).find((p) => p.name === 'Dark')!.swatch, '#000000', g);
    }
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withRig(fn: (app: App, dir: string) => Promise<void>) {
  const dir = tempDir();
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath: join(root, 'shows/stage-l1.json'), webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} });
  try {
    await app.start();
    await fn(app, dir);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const rigPresets = (layout: any, name: string) => layout.groups.flatMap((g: any) => g.presets.filter((p: any) => p.name === name).map((p: any) => ({ ...p, group: g.id })));

test('the layout gives each colour its level, fade and shared reach', () => withRig(async (app) => {
  const t = await tablet(app);
  const layout = await waitFor(t.layout);
  const zils = rigPresets(layout, 'Zils');
  assert.deepEqual(zils.map((p: any) => p.group), ['key-lights', 'background', 'drum-cage', 'b8-side-bar']);
  const union = new Set<string>();
  for (const p of zils) for (const name of p.usedBy) union.add(name);
  for (const p of zils) {
    assert.equal(p.level, 1);
    assert.equal(p.fade, 3);
    assert.equal(p.shared.groups, 4);
    assert.deepEqual([...p.shared.usedBy].sort(), [...union].sort());
  }
  assert.ok(union.size > 0, 'the rig uses Zils in a look');
  // Off has a level of 0 and no palette entry.
  const off = rigPresets(layout, 'Izslēgts')[0];
  assert.equal(off.level, 0);
  assert.equal(off.shared, null);
  assert.equal(await t.send({ type: 'editColour', preset: zils[0].id, level: 0.5, fade: 7, sameName: false }), null);
  const after = rigPresets(t.layout(), 'Zils');
  assert.equal(after[0].level, 0.5);
  assert.equal(after[0].fade, 7);
  assert.equal(after[1].level, 1);
  assert.equal(after[0].shared.groups, 4);
  assert.match((await t.send({ type: 'editColour', preset: zils[0].id, level: 0.01, sameName: false }))!, /^invalid command/);
  assert.match((await t.send({ type: 'editColour', preset: zils[0].id, fade: 601, sameName: false }))!, /^invalid command/);
}));

test('an editColour with shared is one Undo step', () => withRig(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const swatches = () => rigPresets(t.layout(), 'Zils').map((p: any) => p.swatch);
  const before = swatches();
  assert.equal(await t.send({ type: 'editColour', preset: rigPresets(t.layout(), 'Zils')[0].id, colour: '#103a7c', shared: true, sameName: false }), null);
  assert.deepEqual(swatches(), ['#103a7c', '#103a7c', '#103a7c', '#103a7c']);
  const saved = parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8')));
  assert.equal(saved.palettes.find((p) => p.id === 'lightkey')!.colours[7]!.hex, '#103a7c');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.deepEqual(swatches(), before);
  const undone = parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8')));
  assert.equal(undone.palettes.find((p) => p.id === 'lightkey')!.colours[7]!.hex, '#0000ff');
}));

test('colours can be edited and deleted during Blackout, with no PIN',() => withApp(async (app) => {
  assert.equal((await api(app, 'POST', '/api/pin', { next: '1234' })).status, 200);
  const t = await tablet(app);
  await waitFor(t.layout);
  assert.equal(await t.send({ type: 'addColour', group: 'audience', colour: '#0a0b0c', name: 'Night', allGroups: false }), null);
  const id = presetsOf(t.layout(), 'audience').find((p) => p.name === 'Night')!.id;
  assert.equal(await t.send({ type: 'blackout' }), null);
  await waitFor(() => t.state()?.look === 'blackout', 2000, 'Blackout');
  assert.equal(await t.send({ type: 'editColour', preset: id, name: 'Late', sameName: false }), null);
  assert.equal(presetOf(t.layout(), 'audience', id)!.name, 'Late');
  assert.equal(await t.send({ type: 'deleteColour', preset: id }), null);
  assert.equal(presetOf(t.layout(), 'audience', id), undefined);
}));

test('a tablet that stops answering is dropped and its Flash goes out',() => withApp(async (app) => {
  const watch = await tablet(app);
  const silent = await tablet(app, { autoPong: false });
  assert.equal(await silent.send({ type: 'flash', groups: ['back-wall'], on: true }), null);
  await waitFor(() => watch.state()?.flashing.length === 1, 2000, 'the flash to start');
  // Checks every 50 ms: dropped after two missed answers, while the answering tablet stays.
  await waitFor(() => watch.state()?.flashing.length === 0, 1000, "the silent tablet's flash to stop");
  assert.equal(watch.ws.readyState, WebSocket.OPEN);
  await waitFor(() => silent.ws.readyState === WebSocket.CLOSED, 1000, 'the silent tablet to be dropped');
}, 50));

/** Starts a song, picks Any colour on the back wall, saves it, then takes the Save back with Undo. */
async function saveThenUndo(t: Awaited<ReturnType<typeof tablet>>, dir: string) {
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupColour', group: 'back-wall', colour: '#12ab34', fade: 0 }), null);
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  const custom = savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')!.preset;
  await waitFor(() => t.state()?.groups['back-wall'].preset === custom, 2000, 'the stage to run the saved preset');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.notEqual(savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')?.preset, custom);
  return { song, custom };
}

test('Undo of a Save keeps the hidden preset the stage is running, so Save works again', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  const { song, custom } = await saveThenUndo(t, dir);
  assert.equal(t.state().groups['back-wall'].preset, custom);
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  assert.equal(savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')?.preset, custom);
}));

test('after Undo of a Save, a restart still lights the group in the same colour', async () => {
  const dir = tempDir();
  const a = makeApp(dir);
  const b = makeApp(dir);
  try {
    await a.start();
    const t = await tablet(a);
    const { custom } = await saveThenUndo(t, dir);
    await sleep(100);
    t.ws.close();
    await a.stop();

    await b.start();
    await sleep(80);
    const state = (await api(b, 'GET', '/api/state')).body;
    assert.equal(state.groups['back-wall'].preset, custom);
    const preset = parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).presets.find((p) => p.id === custom);
    assert.equal(preset?.swatch, '#12ab34');
    assert.deepEqual(preset?.layers[0], { kind: 'static', colour: { hex: '#12ab34' }, intensity: 1 });
  } finally {
    await a.stop();
    await b.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Compare with a file that removes Basic lights leaves a Basic lights first, and Settings no longer moves it', () => withApp(async (app) => {
  const before = (await api(app, 'GET', '/api/layout')).body;
  const safe = before.basicLights;
  const incoming = (await api(app, 'GET', '/api/show')).body;
  incoming.looks = incoming.looks.filter((l: any) => l.id !== safe);
  incoming.operator.runningOrder = incoming.operator.runningOrder.filter((id: string) => id !== safe);
  delete incoming.operator.safeLook;
  const preview = await api(app, 'POST', '/api/import/preview', incoming);
  assert.equal(preview.status, 200);
  assert.ok(preview.body.items.some((i: any) => i.kind === 'look' && i.id === safe && i.change === 'removed'));
  const applied = await api(app, 'POST', '/api/import/apply', { token: preview.body.token, picks: [{ kind: 'look', id: safe, change: 'removed' }] });
  assert.equal(applied.status, 200);
  const layout = (await api(app, 'GET', '/api/layout')).body;
  assert.ok(layout.basicLights);
  assert.equal(layout.runningOrder[0].id, layout.basicLights);
  assert.equal(layout.runningOrder[0].name, 'Basic lights');
  assert.equal(layout.runningOrder.filter((l: any) => l.id === layout.basicLights).length, 1);
  assert.deepEqual(layout.runningOrder.slice(1).map((l: any) => l.id), before.runningOrder.slice(1).map((l: any) => l.id));

  // The Settings page can't point Basic lights at another look any more.
  const song = layout.runningOrder[1].id;
  assert.equal((await api(app, 'PUT', '/api/settings', { safeLook: song })).status, 200);
  assert.equal((await api(app, 'GET', '/api/layout')).body.basicLights, layout.basicLights);
}));

test('a slider drag after a Save is one Undo step, so two Undos put the show back', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  const before = savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')?.preset;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'groupColour', group: 'back-wall', colour: '#12ab34', fade: 0 }), null);
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  const custom = savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')!.preset;
  await waitFor(() => t.state()?.groups['back-wall'].preset === custom, 2000, 'the stage to run the saved preset');
  // The drag: a first send, then 30 that continue it.
  assert.equal(await t.send({ type: 'groupColour', group: 'back-wall', colour: '#12ab34', white: 0.01, fade: 0.2 }), null);
  for (let k = 2; k <= 31; k++) {
    assert.equal(await t.send({ type: 'groupColour', group: 'back-wall', colour: '#12ab34', white: k / 100, fade: 0.2, continues: true }), null);
  }
  await waitFor(() => t.state()?.groups['back-wall'].preset === 'live:back-wall:#12ab34:w31', 2000, 'the last send of the drag');
  assert.equal(await t.send({ type: 'undo' }), null);
  await waitFor(() => t.state()?.groups['back-wall'].preset === custom, 2000, 'Undo to bring back the saved preset');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')?.preset, before, 'the second Undo takes back the Save');
}));

test('the rig: the layout says which groups have white, amber and UV, and Any colour with amber reaches the key lights', async () => {
  const dir = tempDir();
  const app = new App({
    port: 0, host: '127.0.0.1', dataDir: dir, seedPath: join(root, 'shows/stage-l1.json'), webDir: join(root, 'web'),
    output: { kind: 'none' }, log: () => {},
  });
  try {
    await app.start();
    const t = await tablet(app);
    const layout = await waitFor(t.layout);
    const extras = (id: string) => layout.groups.find((g: any) => g.id === id).extras;
    assert.deepEqual(extras('key-lights'), { white: true, amber: true, uv: true });
    assert.deepEqual(extras('front-lights'), { white: false, amber: false, uv: false });
    assert.deepEqual(extras('background'), { white: true, amber: false, uv: false });
    assert.deepEqual(extras('drum-cage'), { white: false, amber: false, uv: false });
    const preset = layout.groups.find((g: any) => g.id === 'key-lights').presets[0];
    assert.match(preset.light.hex, /^#[0-9a-f]{6}$/);
    // The engine's Basic light (#ffd2a0, half white, at 80 %) as an Any colour pick would make it.
    assert.deepEqual(layout.basicLight, { hex: '#cca880', white: 0.4, amber: 0, uv: 0 });

    // Visualiser frames: one RGB triple per segment, fixtures in layout order.
    const segments = (id: string) => layout.fixtures.find((f: any) => f.id === id).segments;
    assert.deepEqual(['p1', 'b1', 'b3', 'l1', 'b8'].map(segments), [1, 3, 8, 1, 4]);
    assert.ok(layout.fixtures.every((f: any) => f.reversed === false));
    // Each group's line, and the ready-made effects on the coloured groups with more than one segment.
    const group = (id: string) => layout.groups.find((g: any) => g.id === id);
    assert.deepEqual(['front-lights', 'key-lights', 'background', 'drum-cage', 'b8-side-bar'].map((id) => group(id).segments), [4, 6, 32, 1, 4]);
    const effectNames = (id: string) => group(id).presets.filter((p: any) => p.effect).map((p: any) => p.name);
    assert.equal(effectNames('background').length, 9);
    assert.deepEqual(effectNames('key-lights'), ['Colour fade', 'Breathe', 'Wave']);
    assert.deepEqual(effectNames('front-lights'), []);
    assert.deepEqual(group('background').presets.find((p: any) => p.name === 'Wave').effect.colours, [{ hex: '#ff0000' }, { hex: '#ff5a00' }, { hex: '#ffc800' }]);
    let frame: Uint8Array | null = null;
    t.ws.on('message', (data, isBinary) => { if (isBinary) frame = new Uint8Array(data as Buffer); });
    const b1At = layout.fixtures.findIndex((f: any) => f.id === 'b1');
    const b1 = layout.fixtures.slice(0, b1At).reduce((n: number, f: any) => n + f.segments, 0) * 3;
    assert.equal(await t.send({ type: 'groupColour', group: 'key-lights', colour: '#000000', amber: 1, fade: 0 }), null);
    await waitFor(() => t.state()?.groups['key-lights'].preset === 'live:key-lights:#000000:a100', 2000, 'the live colour');
    frame = null;
    const vis = await waitFor(() => frame && Array.from(frame.subarray(b1, b1 + 3)), 2000, 'a visualiser frame');
    assert.deepEqual(vis, [255, 0xbf, 0]);
    // Levels are 0..1.
    assert.match(await t.send({ type: 'groupColour', group: 'key-lights', colour: '#000000', amber: 2 }) ?? '', /^invalid command/);
    t.ws.close();
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Preview edits change a song and never the stage, even the song on stage', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  await waitFor(() => t.state()?.look === song, 2000, 'the song on stage');
  const was = t.state().groups.audience.preset;
  const saved = savedLook(dir, song)!.groups.find((e) => e.group === 'audience');
  assert.notEqual(saved?.preset, 'aud-blue');

  assert.equal(await t.send({ type: 'itemGroup', item: song, group: 'audience', preset: 'aud-blue', level: 0.4 }), null);
  const entry = savedLook(dir, song)!.groups.find((e) => e.group === 'audience');
  assert.equal(entry?.preset, 'aud-blue');
  assert.equal(entry?.level, 0.4);
  await sleep(60);
  assert.equal(t.state().groups.audience.preset, was, 'the stage stays as it is');
  assert.equal(t.state().lookChanged, true);
  assert.equal(t.state().canUndo, true);

  assert.equal(await t.send({ type: 'undo' }), null);
  assert.deepEqual(savedLook(dir, song)!.groups.find((e) => e.group === 'audience'), saved);
}));

test('the layout gives each item its entries, and the preview picture is served', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const layout = t.layout();
  const item = layout.runningOrder[1];
  assert.equal(item.entries.length, layout.groups.length);
  assert.ok(item.entries.some((e: any) => e && e.preset && e.name && e.swatch));
  assert.deepEqual(item.entries.map((e: any) => e?.swatch ?? null), item.colours);

  const ok = await api(app, 'GET', `/api/looks/${item.id}/visual`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.visual.length, layout.fixtures.reduce((n: number, f: any) => n + f.segments, 0) * 3);
  const missing = await api(app, 'GET', '/api/looks/no-such-look/visual');
  assert.equal(missing.status, 404);
}));

// ---- Live effects, the song's tempo and the effects list ----

/** A wave as the Effects tab sends it: every setting, colours as plain hex. */
const liveWave = (over: Record<string, unknown> = {}) => ({
  kind: 'effect', effect: 'wave', colours: [{ hex: '#12ab34' }, { hex: '#3456cd', white: 0.2 }], speed: { beats: 4 },
  direction: 'ltr', waves: 3, size: 0.5, edge: 'soft', intensity: 1, ...over,
});

test('a live effect runs, Undo takes it back, and Save keeps it as a hidden effect the stage then runs', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  await waitFor(() => t.state()?.look === song, 2000, 'the song on stage');
  const was = t.state().groups['back-wall'].preset;

  assert.equal(await t.send({ type: 'groupEffect', group: 'back-wall', effect: liveWave(), fade: 0 }), null);
  const running = await waitFor(() => /^fx:back-wall:\d+$/.test(t.state()?.groups['back-wall'].preset ?? '') && t.state().groups['back-wall'], 2000, 'the live effect');
  assert.deepEqual(running.effect, liveWave());
  assert.equal(running.live, null);
  assert.equal(t.state().lookChanged, true);
  assert.equal(t.state().groups.audience.effect, null);

  assert.equal(await t.send({ type: 'undo' }), null);
  await waitFor(() => t.state()?.groups['back-wall'].preset === was, 2000, 'Undo to bring back the song\'s preset');
  assert.equal(t.state().groups['back-wall'].effect, null);

  assert.equal(await t.send({ type: 'groupEffect', group: 'back-wall', effect: liveWave({ edge: 'hard' }), fade: 0 }), null);
  await waitFor(() => t.state()?.groups['back-wall'].effect?.edge === 'hard', 2000, 'the second live effect');
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  await waitFor(() => t.state()?.lookChanged === false, 2000, 'the look to no longer show as changed');
  const entry = savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')!;
  const saved = parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).presets.find((p) => p.id === entry.preset)!;
  assert.equal(saved.custom, true);
  assert.equal(saved.name, 'Custom effect');
  assert.deepEqual(saved.layers, [liveWave({ edge: 'hard' })]);
  assert.equal(saved.swatch, '#12ab34');
  // The stage runs the saved preset now (the same effect, carrying on).
  assert.equal(t.state().groups['back-wall'].preset, entry.preset);
  assert.equal(t.state().groups['back-wall'].effect, null);
  // Starting the song again runs the saved effect.
  assert.equal(await t.send({ type: 'safe' }), null);
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  await waitFor(() => t.state()?.look === song && t.state().groups['back-wall'].preset === entry.preset, 2000, 'the song with its effect');
}));

test('an effect slider drag is one Undo step', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  await waitFor(() => t.state()?.look === song, 2000, 'the song on stage');
  const was = t.state().groups['back-wall'].preset;
  assert.equal(await t.send({ type: 'groupEffect', group: 'back-wall', effect: liveWave({ size: 0.1 }), fade: 0.2 }), null);
  for (let k = 2; k <= 20; k++) {
    assert.equal(await t.send({ type: 'groupEffect', group: 'back-wall', effect: liveWave({ size: k / 20 }), fade: 0.2, continues: true }), null);
  }
  await waitFor(() => t.state()?.groups['back-wall'].effect?.size === 1, 2000, 'the last send of the drag');
  assert.equal(await t.send({ type: 'undo' }), null);
  await waitFor(() => t.state()?.groups['back-wall'].preset === was, 2000, 'one Undo to take the whole drag back');
}));

test('a restart with a live effect running brings the same effect back', async () => {
  const dir = tempDir();
  const a = makeApp(dir);
  const b = makeApp(dir);
  try {
    await a.start();
    const t = await tablet(a);
    await waitFor(t.layout);
    assert.equal(await t.send({ type: 'groupEffect', group: 'back-wall', effect: liveWave({ effect: 'chase' }), fade: 0 }), null);
    const id = (await waitFor(() => t.state()?.groups['back-wall'].effect && t.state().groups['back-wall'], 2000, 'the live effect')).preset;
    await sleep(100);
    t.ws.close();
    await a.stop();
    const runtime = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
    assert.deepEqual(runtime.effects, { [id]: liveWave({ effect: 'chase' }) });

    await b.start();
    await sleep(80);
    const state = (await api(b, 'GET', '/api/state')).body;
    assert.equal(state.groups['back-wall'].preset, id);
    assert.deepEqual(state.groups['back-wall'].effect, liveWave({ effect: 'chase' }));
    // It can still be saved after the restart.
    const song = (await api(b, 'GET', '/api/layout')).body.runningOrder[1].id;
    const u = await tablet(b);
    assert.equal(await u.send({ type: 'saveItem', id: song }), null);
    const entry = savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')!;
    assert.deepEqual(parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).presets.find((p) => p.id === entry.preset)!.layers, [liveWave({ effect: 'chase' })]);
    u.ws.close();
  } finally {
    await a.stop();
    await b.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Save stores the stage tempo in the song, and itemTempo changes the song and not the stage', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const [, song, other] = t.order();
  assert.equal(await t.send({ type: 'look', id: song, fade: 0 }), null);
  assert.equal(await t.send({ type: 'tempo', bpm: 133 }), null);
  assert.equal(await t.send({ type: 'saveItem', id: song }), null);
  assert.equal(savedLook(dir, song!)!.tempo, 133);
  await waitFor(() => t.layout().runningOrder.find((l: any) => l.id === song).tempo === 133, 2000, 'the layout to show the tempo');
  assert.equal(t.layout().runningOrder.find((l: any) => l.id === other).tempo, null);

  assert.equal(await t.send({ type: 'itemTempo', item: other, bpm: 72 }), null);
  assert.equal(savedLook(dir, other!)!.tempo, 72);
  await sleep(60);
  assert.equal(t.state().tempo, 133, 'the stage keeps its tempo');
  assert.equal(t.state().canUndo, true);
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(savedLook(dir, other!)!.tempo, undefined);
  assert.match(await t.send({ type: 'itemTempo', item: other, bpm: 300 }) ?? '', /^invalid command/);
  assert.equal(await t.send({ type: 'itemTempo', item: 'walk-in', bpm: 100 }), 'only running-order items can be changed here');
  // Starting the song sets its tempo.
  assert.equal(await t.send({ type: 'itemTempo', item: other, bpm: 88 }), null);
  assert.equal(await t.send({ type: 'look', id: other, fade: 0 }), null);
  await waitFor(() => t.state()?.tempo === 88, 2000, 'the song\'s tempo');
}));

test('itemTempo edits of one song within 3 s are one Undo step; another song or another edit splits them', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  const [, song, other] = t.order();
  for (const bpm of [100, 104, 108]) assert.equal(await t.send({ type: 'itemTempo', item: song, bpm }), null);
  assert.equal(savedLook(dir, song!)!.tempo, 108);
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(savedLook(dir, song!)!.tempo, undefined, 'one Undo takes back the whole run');
  await sleep(60);
  assert.equal(t.state().canUndo, false);

  // Another song starts a new step, and so does a different edit in between.
  assert.equal(await t.send({ type: 'itemTempo', item: song, bpm: 90 }), null);
  assert.equal(await t.send({ type: 'itemTempo', item: other, bpm: 95 }), null);
  assert.equal(await t.send({ type: 'itemTempo', item: other, bpm: 96 }), null);
  assert.equal(await t.send({ type: 'renameItem', id: song, name: 'Renamed' }), null);
  assert.equal(await t.send({ type: 'itemTempo', item: song, bpm: 91 }), null);
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(savedLook(dir, song!)!.tempo, 90);
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.notEqual(savedLook(dir, song!)!.name, 'Renamed');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(savedLook(dir, other!)!.tempo, undefined, 'the other song\'s two edits are one step');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(savedLook(dir, song!)!.tempo, undefined);
}));

test('the effects list: add, edit, rename and delete over the wire, and the layout shows effects', () => withApp(async (app, dir) => {
  const t = await tablet(app);
  const layout = await waitFor(t.layout);
  const backWall = layout.groups.find((g: any) => g.id === 'back-wall');
  assert.equal(backWall.segments, 6);
  assert.equal(layout.groups.find((g: any) => g.id === 'pulpit').segments, 1);
  // The ready-made effects, with their colours as plain hex.
  const ready = backWall.presets.filter((p: any) => p.effect);
  assert.deepEqual(ready.map((p: any) => p.name), ['Colour fade', 'Breathe', 'Wave']);
  assert.deepEqual(ready[0].effect.colours.map((c: any) => c.hex), ['#1f3bff', '#7a2bff', '#ff8a1f']);
  assert.ok(backWall.presets.filter((p: any) => !p.effect).every((p: any) => p.effect === null && p.light));
  assert.equal(ready[0].canRecolour, false);

  assert.equal(await t.send({ type: 'addEffect', group: 'back-wall', name: 'Rolling', effect: liveWave() }), null);
  const added = await waitFor(() => t.layout().groups.find((g: any) => g.id === 'back-wall').presets.find((p: any) => p.name === 'Rolling'), 2000, 'the new effect');
  assert.deepEqual(added.effect, liveWave());
  assert.equal(await t.send({ type: 'editEffect', preset: added.id, effect: liveWave({ waves: 1 }) }), null);
  await waitFor(() => t.layout().groups.find((g: any) => g.id === 'back-wall').presets.find((p: any) => p.id === added.id).effect.waves === 1, 2000, 'the edit');
  assert.equal(await t.send({ type: 'editEffect', preset: 'back-amber', effect: liveWave() }), 'that is not an effect');
  assert.equal(await t.send({ type: 'editColour', preset: added.id, name: 'Slow roll', sameName: false }), null);
  // On stage it stays.
  assert.equal(await t.send({ type: 'groupPreset', group: 'back-wall', preset: added.id, fade: 0 }), null);
  assert.equal(await t.send({ type: 'deleteColour', preset: added.id }), 'That effect is on stage now. Pick something else for the group first.');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.equal(await t.send({ type: 'deleteColour', preset: added.id }), null);
  await waitFor(() => !t.layout().groups.find((g: any) => g.id === 'back-wall').presets.some((p: any) => p.id === added.id), 2000, 'the delete');
  assert.equal(await t.send({ type: 'undo' }), null);
  assert.ok(parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).presets.some((p) => p.id === added.id && p.name === 'Slow roll'));

  // Preview: an effect for a song's group, kept as a hidden preset; the stage stays.
  const song = t.order()[1]!;
  assert.equal(await t.send({ type: 'itemGroup', item: song, group: 'back-wall', effect: liveWave({ effect: 'meteor' }) }), null);
  const entry = savedLook(dir, song)!.groups.find((e) => e.group === 'back-wall')!;
  const hidden = parseShow(JSON.parse(readFileSync(join(dir, 'show.json'), 'utf8'))).presets.find((p) => p.id === entry.preset)!;
  assert.equal(hidden.custom, true);
  assert.deepEqual(hidden.layers, [liveWave({ effect: 'meteor' })]);
  const item = await waitFor(() => t.layout().runningOrder.find((l: any) => l.id === song && l.entries[1]?.effect), 2000, 'the item entry');
  assert.equal(item.entries[1].effect.effect, 'meteor');
  assert.equal(await t.send({ type: 'itemGroup', item: song, group: 'back-wall', effect: liveWave(), preset: 'back-amber' }), 'pick a colour, a preset or an effect, not more than one');
}));

test('smoke machines refuse effects', () => withApp(async (app) => {
  const show = (await api(app, 'GET', '/api/show')).body;
  show.groups.find((g: any) => g.id === 'pulpit').kind = 'smoke';
  assert.equal((await api(app, 'PUT', '/api/show', show)).status, 200);
  const t = await tablet(app);
  await waitFor(t.layout);
  assert.equal(await t.send({ type: 'groupEffect', group: 'pulpit', effect: liveWave(), fade: 0 }), '"pulpit" is a smoke machine: use its slider or Puff');
  assert.equal(await t.send({ type: 'addEffect', group: 'pulpit', name: 'x', effect: liveWave() }), "smoke machines can't run effects");
  // Effect colours are plain hex over the wire.
  assert.match(await t.send({ type: 'groupEffect', group: 'back-wall', effect: liveWave({ colours: [{ palette: 'x', index: 0 }] }) }) ?? '', /^invalid command/);
}));

test('the effect editor gets an effect as moving frames for a group, at the live tempo, without touching the stage', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  assert.equal(await t.send({ type: 'tempo', bpm: 60 }), null);
  await waitFor(() => t.state()?.tempo === 60, 2000, 'the tempo');
  const before = t.state().groups['back-wall'].preset;

  const ok = await api(app, 'POST', '/api/effect-preview', { group: 'back-wall', effect: liveWave() });
  assert.equal(ok.status, 200);
  const { fps, count, segments, fixtures, rate, tempo, speed, frames } = ok.body;
  assert.deepEqual(fixtures, [1, 1, 1, 1, 1, 1]);
  assert.equal(segments, 6);
  assert.equal(tempo, 60);
  assert.equal(speed, 1);
  // 4 beats at 60 bpm: a quarter of a cycle a second, so two cycles make the 8 s loop.
  assert.equal(rate, 0.25);
  assert.equal(count, 160);
  assert.ok(Math.abs(fps - 20) < 1e-9);
  const bytes = Buffer.from(frames, 'base64');
  assert.equal(bytes.length, count * segments * 3);
  assert.ok(bytes.some((b) => b > 0), 'the wave is lit');
  await sleep(60);
  assert.equal(t.state().groups['back-wall'].preset, before, 'nothing goes on stage');

  // Plain words for a group that can't run one, and 400 for a body that isn't an effect.
  const show = (await api(app, 'GET', '/api/show')).body;
  show.groups.find((g: any) => g.id === 'pulpit').kind = 'smoke';
  assert.equal((await api(app, 'PUT', '/api/show', show)).status, 200);
  const smoke = await api(app, 'POST', '/api/effect-preview', { group: 'pulpit', effect: liveWave() });
  assert.deepEqual([smoke.status, smoke.body.error], [400, "smoke machines can't run effects"]);
  const unknown = await api(app, 'POST', '/api/effect-preview', { group: 'nope', effect: liveWave() });
  assert.deepEqual([unknown.status, unknown.body.error], [404, 'unknown group "nope"']);
  for (const body of [{}, { group: 'back-wall' }, { group: 'back-wall', effect: liveWave({ effect: 'spin' }) }, { group: 'back-wall', effect: liveWave({ colours: [{ palette: 'x', index: 0 }] }) }]) {
    const bad = await api(app, 'POST', '/api/effect-preview', body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.equal(typeof bad.body.error, 'string');
  }
}));

test('a WebSocket message that is valid JSON but not an object is ignored, and the server keeps serving', () => withApp(async (app) => {
  const t = await tablet(app);
  await waitFor(t.layout);
  for (const frame of ['null', '5', '"x"', 'true', '[]']) t.ws.send(frame);
  assert.equal(await t.send({ type: 'master', value: 0.5 }), null);
  assert.equal((await api(app, 'GET', '/api/state')).status, 200);
}));
