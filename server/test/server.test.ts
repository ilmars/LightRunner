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
