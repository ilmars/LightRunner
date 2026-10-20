import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSocket } from 'node:dgram';
import { App } from '../src/app.ts';
import { listenOsc, oscAction, parseOsc, type OscArg, type OscMessage } from '../src/osc.ts';
import type { DeviceAction } from '../../packages/shared/src/devices.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Building OSC packets the way a sender would ----

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]); // always at least one NUL
const str = (s: string) => pad(Buffer.from(s, 'latin1'));
const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const float = (n: number) => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b; };

/** Arguments are written as `i:3`, `f:0.5`, `s:text`, `T` or `F`. */
function message(address: string, ...args: string[]): Buffer {
  const tags = args.map((a) => a[0]).join('');
  const data = args.map((a) => (a[0] === 'i' ? int(Number(a.slice(2))) : a[0] === 'f' ? float(Number(a.slice(2))) : a[0] === 's' ? str(a.slice(2)) : Buffer.alloc(0)));
  return Buffer.concat([str(address), str(`,${tags}`), ...data]);
}
function bundle(...elements: Buffer[]): Buffer {
  return Buffer.concat([str('#bundle'), Buffer.alloc(8), ...elements.flatMap((e) => [int(e.length), e])]);
}

// ---- The parser ----

test('parseOsc reads a message with every type tag', () => {
  const buf = message('/test/all', 'i:-7', 'f:0.5', 's:hello', 'T', 'F');
  assert.deepEqual(parseOsc(buf), [{
    address: '/test/all',
    args: [{ type: 'i', value: -7 }, { type: 'f', value: 0.5 }, { type: 's', value: 'hello' }, { type: 'b', value: true }, { type: 'b', value: false }],
  }]);
});

test('parseOsc handles padding: strings of every length, and a message with no arguments', () => {
  for (const address of ['/a', '/ab', '/abc', '/abcd', '/abcde']) {
    const parsed = parseOsc(message(address, 's:x', 's:xyz', 's:wxyz'));
    assert.equal(parsed?.[0].address, address);
    assert.deepEqual(parsed?.[0].args.map((a) => a.value), ['x', 'xyz', 'wxyz']);
  }
  assert.deepEqual(parseOsc(message('/lightrunner/next')), [{ address: '/lightrunner/next', args: [] }]);
  // An old sender with no type tag string at all.
  assert.deepEqual(parseOsc(str('/lightrunner/next')), [{ address: '/lightrunner/next', args: [] }]);
});

test('parseOsc reads a bundle, including a bundle inside a bundle, in order', () => {
  const buf = bundle(message('/one', 'i:1'), bundle(message('/two', 'i:2'), message('/three')), message('/four', 'f:4'));
  assert.deepEqual(parseOsc(buf)?.map((m) => m.address), ['/one', '/two', '/three', '/four']);
});

test('parseOsc gives null for packets that are cut short or not OSC', () => {
  const full = message('/lightrunner/group/2/level', 'f:0.5', 's:abc');
  for (let n = 0; n < full.length; n++) {
    const cut = full.subarray(0, n);
    // A cut that happens to end exactly after the address is a message with no type tags; anything else is null.
    const parsed = parseOsc(cut);
    if (parsed) assert.deepEqual(parsed[0].args, [], `cut at ${n}`);
  }
  assert.equal(parseOsc(full.subarray(0, full.length - 1)), null);
  assert.equal(parseOsc(Buffer.alloc(0)), null);
  assert.equal(parseOsc(Buffer.from('hello world!')), null, 'does not start with a slash');
  assert.equal(parseOsc(Buffer.concat([str('/x'), str('i')])), null, 'type tags must start with a comma');
  assert.equal(parseOsc(Buffer.concat([str('/x'), str(',q'), int(1)])), null, 'a type tag it cannot size');
  assert.equal(parseOsc(Buffer.from('/unterminated')), null);
  // A bundle whose element claims more bytes than there are.
  const b = bundle(message('/one', 'i:1'));
  assert.equal(parseOsc(b.subarray(0, b.length - 2)), null);
  assert.equal(parseOsc(Buffer.concat([str('#bundle'), Buffer.alloc(8), int(-4), Buffer.alloc(4)])), null);
  assert.equal(parseOsc(Buffer.concat([str('#bundle'), Buffer.alloc(4)])), null, 'no time tag');
  // A bundle nested too deep.
  let deep = message('/x');
  for (let i = 0; i < 20; i++) deep = bundle(deep);
  assert.equal(parseOsc(deep), null);
});

// ---- Addresses to device actions ----

const msg = (address: string, ...args: OscArg[]): OscMessage => ({ address, args });
const i = (value: number): OscArg => ({ type: 'i', value });
const f = (value: number): OscArg => ({ type: 'f', value });
const b = (value: boolean): OscArg => ({ type: 'b', value });
const act = (address: string, ...args: OscArg[]): DeviceAction | null => oscAction(msg(address, ...args));

test('every address maps to its device action', () => {
  assert.deepEqual(act('/lightrunner/item', i(3)), { kind: 'item', n: 3 });
  assert.deepEqual(act('/lightrunner/item', f(3)), { kind: 'item', n: 3 }, 'a sender that only has floats');
  assert.deepEqual(act('/lightrunner/next'), { kind: 'next' });
  assert.deepEqual(act('/lightrunner/back'), { kind: 'backToLook' });
  assert.deepEqual(act('/lightrunner/undo'), { kind: 'undo' });
  assert.deepEqual(act('/lightrunner/basic'), { kind: 'basic' });
  assert.deepEqual(act('/lightrunner/blackout'), { kind: 'blackout' });
  assert.deepEqual(act('/lightrunner/group/2/level', f(0.5)), { kind: 'groupLevel', group: 2, value: 0.5 });
  assert.deepEqual(act('/lightrunner/group/2/level', i(50)), { kind: 'groupLevel', group: 2, value: 0.5 }, 'an integer is a percentage');
  assert.deepEqual(act('/lightrunner/group/2/level', i(0)), { kind: 'groupLevel', group: 2, value: 0 });
  assert.deepEqual(act('/lightrunner/group/2/level', i(100)), { kind: 'groupLevel', group: 2, value: 1 });
  assert.deepEqual(act('/lightrunner/group/2/level', f(1)), { kind: 'groupLevel', group: 2, value: 1 }, 'a float 1 is full');
  assert.deepEqual(act('/lightrunner/group/2/colour', i(4)), { kind: 'groupColour', group: 2, colour: 4 });
  assert.deepEqual(act('/lightrunner/flash/2', i(1)), { kind: 'flash', group: 2, on: true });
  assert.deepEqual(act('/lightrunner/flash/2', i(0)), { kind: 'flash', group: 2, on: false });
  assert.deepEqual(act('/lightrunner/flash/2', b(true)), { kind: 'flash', group: 2, on: true });
  assert.deepEqual(act('/lightrunner/flash/2', b(false)), { kind: 'flash', group: 2, on: false });
  assert.deepEqual(act('/lightrunner/flash/2', f(1)), { kind: 'flash', group: 2, on: true });
  assert.deepEqual(act('/lightrunner/flash/all', i(1)), { kind: 'flash', group: 'all', on: true });
  assert.deepEqual(act('/lightrunner/flash/ALL', b(false)), { kind: 'flash', group: 'all', on: false });
  assert.deepEqual(act('/lightrunner/master', f(0.8)), { kind: 'master', value: 0.8 });
  assert.deepEqual(act('/lightrunner/master', f(Math.fround(0.7))), { kind: 'master', value: 0.7 }, 'a 32-bit 0.7 is not 0.699999988');
  assert.deepEqual(act('/lightrunner/master', i(80)), { kind: 'master', value: 0.8 });
  assert.deepEqual(act('/lightrunner/master/up'), { kind: 'masterStep', by: 0.1 });
  assert.deepEqual(act('/lightrunner/master/down'), { kind: 'masterStep', by: -0.1 });
});

test('a button release (0 or False) does nothing on a trigger address; a press or a bare message acts', () => {
  const triggers: [string, DeviceAction][] = [
    ['next', { kind: 'next' }], ['back', { kind: 'backToLook' }], ['undo', { kind: 'undo' }], ['basic', { kind: 'basic' }],
    ['blackout', { kind: 'blackout' }], ['master/up', { kind: 'masterStep', by: 0.1 }], ['master/down', { kind: 'masterStep', by: -0.1 }],
  ];
  for (const [path, action] of triggers) {
    const a = `/lightrunner/${path}`;
    assert.equal(act(a, i(0)), null, `${a} 0`);
    assert.equal(act(a, f(0)), null, `${a} 0.0`);
    assert.equal(act(a, b(false)), null, `${a} F`);
    assert.deepEqual(act(a, i(1)), action, `${a} 1`);
    assert.deepEqual(act(a, f(1)), action, `${a} 1.0`);
    assert.deepEqual(act(a, b(true)), action, `${a} T`);
    assert.deepEqual(act(a), action, `${a} with no argument`);
  }
});

test('the /lightrunner prefix is not case sensitive, and a trailing slash is allowed', () => {
  assert.deepEqual(act('/LightRunner/Next'), { kind: 'next' });
  assert.deepEqual(act('/LIGHTRUNNER/group/3/LEVEL', f(0.25)), { kind: 'groupLevel', group: 3, value: 0.25 });
  assert.deepEqual(act('/lightrunner/next/'), { kind: 'next' });
});

test('levels outside 0 to 1 (or 0 to 100) are held to the range', () => {
  assert.deepEqual(act('/lightrunner/group/1/level', f(1.5)), { kind: 'groupLevel', group: 1, value: 1 });
  assert.deepEqual(act('/lightrunner/group/1/level', f(-0.2)), { kind: 'groupLevel', group: 1, value: 0 });
  assert.deepEqual(act('/lightrunner/master', i(250)), { kind: 'master', value: 1 });
  assert.deepEqual(act('/lightrunner/master', i(-5)), { kind: 'master', value: 0 });
});

test('unknown addresses and bad arguments map to nothing', () => {
  for (const a of ['/next', '/other/next', '/lightrunner', '/lightrunner/', '/lightrunner/nope', '/lightrunner/next/now', '/lightrunnerx/next',
    '/lightrunner/group/level', '/lightrunner/group/x/level', '/lightrunner/group/2', '/lightrunner/group/2/level/extra',
    '/lightrunner/group/-1/level', '/lightrunner/group/1.5/level', '/lightrunner/flash', '/lightrunner/flash/x', '/lightrunner/master/sideways']) {
    assert.equal(act(a, f(0.5)), null, a);
  }
  // Right address, wrong or missing argument.
  assert.equal(act('/lightrunner/item'), null);
  assert.equal(act('/lightrunner/item', { type: 's', value: '3' }), null);
  assert.equal(act('/lightrunner/group/1/level'), null);
  assert.equal(act('/lightrunner/group/1/level', { type: 's', value: '0.5' }), null);
  assert.equal(act('/lightrunner/group/1/level', f(NaN)), null);
  assert.equal(act('/lightrunner/group/1/colour'), null);
  assert.equal(act('/lightrunner/flash/1'), null);
  assert.equal(act('/lightrunner/master'), null);
  assert.equal(act('/lightrunner/master', b(true)), null);
});

// ---- The UDP listener ----

async function freePort(): Promise<number> {
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function send(port: number, ...packets: Buffer[]) {
  const s = createSocket('udp4');
  try {
    for (const p of packets) await new Promise<void>((resolve, reject) => s.send(p, port, '127.0.0.1', (err) => (err ? reject(err) : resolve())));
  } finally {
    s.close();
  }
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

/** Whether a UDP port can be bound now (so nothing listens on it). */
async function portIsFree(port: number): Promise<boolean> {
  const s = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => { s.once('error', reject); s.bind(port, '0.0.0.0', () => resolve()); });
    return true;
  } catch {
    return false;
  } finally {
    s.close();
  }
}

test('the listener runs actions in the order they arrive, logs a bad address once a minute, and survives garbage', async () => {
  const ran: DeviceAction[] = [];
  const logs: string[] = [];
  const server = await listenOsc(0, async (a) => { ran.push(a); return a.kind === 'item' ? 'There is no song 99.' : null; }, (m) => logs.push(m), '127.0.0.1');
  try {
    await send(server.port,
      Buffer.from([1, 2, 3, 4, 5]), Buffer.alloc(0), Buffer.from('not osc at all'),
      bundle(message('/lightrunner/flash/1', 'i:1'), message('/lightrunner/flash/1', 'i:0')),
      message('/lightrunner/bogus'), message('/lightrunner/bogus'), message('/lightrunner/other'),
      Buffer.from([0x2f, 0x78, 0, 0, 0x2c]),
      message('/lightrunner/item', 'i:99'), message('/lightrunner/item', 'i:99'));
    await waitFor(() => ran.length === 4, 2000, 'four actions');
    assert.deepEqual(ran.map((a) => a.kind), ['flash', 'flash', 'item', 'item']);
    assert.deepEqual(ran.slice(0, 2).map((a) => (a as any).on), [true, false]);
    assert.equal(logs.filter((l) => l.includes('/lightrunner/bogus')).length, 1, 'the same address is logged once');
    assert.equal(logs.filter((l) => l.includes('/lightrunner/other')).length, 1, 'another address is logged too');
    assert.equal(logs.filter((l) => l.includes('There is no song 99.')).length, 1, 'a refusal is logged once as well');
    assert.ok(logs.length <= 5, `${logs.length} log lines: ${logs.join(' | ')}`);
  } finally {
    await server.close();
  }
  assert.ok(await portIsFree(server.port), 'closing frees the port');
});

test('closing a listener twice does not throw', async () => {
  const server = await listenOsc(0, async () => null, () => {}, '127.0.0.1');
  await server.close();
  await server.close(); // already closed
  assert.ok(await portIsFree(server.port));
});

test('a port that is taken makes listenOsc fail with plain words', async () => {
  const taken = createSocket('udp4');
  await new Promise<void>((r) => taken.bind(0, '0.0.0.0', r));
  try {
    await assert.rejects(() => listenOsc(taken.address().port, async () => null, () => {}), /already in use/);
  } finally {
    taken.close();
  }
});

// ---- Through the app ----

async function withApp(fn: (app: App, call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>, dir = mkdtempSync(join(tmpdir(), 'light-runner-osc-'))) {
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    await app.start();
    await waitFor(() => app.state, 2000, 'the first state');
    await fn(app, call);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('OSC is off until it is switched on in Settings', () => withApp(async (app, call) => {
  const s = (await call('GET', '/api/settings')).body;
  assert.deepEqual(s.osc, { enabled: false, port: 8000 });
  assert.equal(s.oscProblem, null);
  assert.equal(app.state?.look, null);
}));

test('switched on, OSC drives the live stage; switched off, the port closes and a held Flash goes out', () => withApp(async (app, call) => {
  const port = await freePort();
  const layout = (await call('GET', '/api/layout')).body;
  const order: string[] = layout.runningOrder.map((l: any) => l.id);

  const on = await call('PUT', '/api/settings', { osc: { enabled: true, port } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(on.body.osc, { enabled: true, port });
  assert.equal(on.body.oscProblem, null);
  assert.ok(!(await portIsFree(port)), 'the port is open');

  await send(port, message('/lightrunner/next'), message('/lightrunner/master', 'f:0.5'));
  await waitFor(() => app.state?.look === order[1] && app.state?.master === 0.5, 2000, 'Next and Master 50 %');

  await send(port, message('/lightrunner/item', 'i:3'), message('/lightrunner/group/2/level', 'i:40'));
  await waitFor(() => app.state?.look === order[2] && app.state?.groups[layout.groups[1].id]?.level === 0.4, 2000, 'item 3 and group 2 at 40 %');

  await send(port, message('/lightrunner/flash/1', 'i:1'));
  await waitFor(() => app.state?.flashing.length === 1, 2000, 'group 1 flashing');
  await send(port, message('/lightrunner/blackout'));
  await waitFor(() => app.state?.look === 'blackout', 2000, 'Blackout');

  // Garbage in between changes nothing and breaks nothing.
  await send(port, Buffer.from([0xff, 0xfe, 0xfd]), Buffer.alloc(0), message('/lightrunner/next/never/heard/of'), message('/lightrunner/group/9/level', 'f:1'));
  await send(port, message('/lightrunner/master', 'f:0.7'));
  await waitFor(() => app.state?.master === 0.7, 2000, 'Master 70 % after the garbage');

  const off = await call('PUT', '/api/settings', { osc: { enabled: false, port } });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.osc, { enabled: false, port });
  assert.ok(await portIsFree(port), 'the port is closed');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the held Flash to go out when OSC is switched off');
}));

test('changing the port moves the listener', () => withApp(async (app, call) => {
  const [a, b] = [await freePort(), await freePort()];
  await call('PUT', '/api/settings', { osc: { enabled: true, port: a } });
  assert.ok(!(await portIsFree(a)));
  await call('PUT', '/api/settings', { osc: { enabled: true, port: b } });
  assert.ok(await portIsFree(a), 'the old port is closed');
  assert.ok(!(await portIsFree(b)), 'the new port is open');
  await send(b, message('/lightrunner/master', 'f:0.3'));
  await waitFor(() => app.state?.master === 0.3, 2000, 'Master on the new port');
  // Saving something else leaves it listening where it is.
  await call('PUT', '/api/settings', { gamma: 2 });
  assert.ok(!(await portIsFree(b)));
}));

test('a taken port is reported and the app carries on', () => withApp(async (app, call) => {
  const taken = createSocket('udp4');
  await new Promise<void>((r) => taken.bind(0, '0.0.0.0', r));
  try {
    const port = taken.address().port;
    const r = await call('PUT', '/api/settings', { osc: { enabled: true, port } });
    assert.equal(r.status, 200);
    assert.match(r.body.oscProblem, /already in use/);
    assert.equal((await call('GET', '/api/settings')).body.oscProblem, r.body.oscProblem);
  } finally {
    taken.close();
  }
  // Switching it off clears the problem.
  const off = await call('PUT', '/api/settings', { osc: { enabled: false, port: 8000 } });
  assert.equal(off.body.oscProblem, null);
  assert.equal(app.state !== null, true);
}));

test('OSC settings that are not a port are refused', () => withApp(async (_app, call) => {
  for (const osc of [{ enabled: true, port: 80 }, { enabled: true, port: 70000 }, { enabled: true, port: 8000.5 }, { enabled: 'yes', port: 8000 }, 'on']) {
    const r = await call('PUT', '/api/settings', { osc });
    assert.equal(r.status, 400, JSON.stringify(osc));
  }
  assert.deepEqual((await call('GET', '/api/settings')).body.osc, { enabled: false, port: 8000 });
}));

test('OSC starts again with the app when it was left on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-osc-'));
  const port = await freePort();
  const make = () => new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} });
  try {
    const first = make();
    await first.start();
    await fetch(`http://127.0.0.1:${first.port}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ osc: { enabled: true, port } }) });
    await first.stop();
    assert.ok(await portIsFree(port), 'stopping the app closes the port');

    // Same data folder, new App: the setting was saved with the show.
    const again = make();
    try {
      await again.start();
      await waitFor(() => again.state, 2000, 'the first state');
      assert.ok(!(await portIsFree(port)), 'listening again after a restart');
      await send(port, message('/lightrunner/master', 'f:0.4'));
      await waitFor(() => again.state?.master === 0.4, 2000, 'Master after the restart');
    } finally {
      await again.stop();
    }
    assert.ok(await portIsFree(port), 'stopping the app closes the port');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
