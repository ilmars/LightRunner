import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { liveMarker, probePort, readMarker, writeMarker } from '../src/marker.ts';
import { isThisComputer } from '../src/net.ts';

// One server per data folder: the server.json marker, and the launcher's stop.

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const tempDir = () => mkdtempSync(join(tmpdir(), 'light-runner-marker-'));

function makeApp(dataDir: string, extra: { host?: string; onStopRequest?: () => void; claimData?: boolean; log?: (m: string) => void } = {}) {
  return new App({
    port: 0, host: extra.host ?? '127.0.0.1', dataDir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' },
    log: extra.log ?? (() => {}), claimData: extra.claimData ?? true, onStopRequest: extra.onStopRequest, version: '9.8.7',
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** A raw request, so the test chooses the address, the Host header and the rest. */
function send(address: string, port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the server writes server.json once listening and removes it when it stops', async () => {
  const dir = tempDir();
  const app = makeApp(dir);
  try {
    assert.equal(existsSync(join(dir, 'server.json')), false);
    await app.start();
    const marker = readMarker(dir)!;
    assert.equal(marker.pid, process.pid);
    assert.equal(marker.port, app.port);
    assert.match(marker.token, /^[0-9a-f]{64}$/);
    assert.ok(!Number.isNaN(Date.parse(marker.startedAt)));
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'server.json')).mode & 0o777, 0o600);
    assert.equal(existsSync(join(dir, 'server.json.tmp')), false);
    await app.stop();
    assert.equal(existsSync(join(dir, 'server.json')), false);
  } finally {
    await app.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a server without claimData (tests, tools) writes no marker', async () => {
  const dir = tempDir();
  const app = makeApp(dir, { claimData: false });
  try {
    await app.start();
    assert.equal(existsSync(join(dir, 'server.json')), false);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second server on the same data folder refuses before it starts the engine', async () => {
  const dir = tempDir();
  const first = makeApp(dir);
  const logs: string[] = [];
  const second = makeApp(dir, { log: (m) => logs.push(m) });
  try {
    await first.start();
    const marker = readMarker(dir)!;
    await assert.rejects(second.start(), (err: Error & { code?: string; port?: number }) => {
      assert.equal(err.code, 'ALREADY_RUNNING');
      assert.equal(err.port, first.port);
      return true;
    });
    // It never loaded the show or started its engine, and left the first one's marker alone.
    assert.deepEqual(logs, []);
    assert.deepEqual(readMarker(dir), marker);
    assert.equal((await fetch(`http://127.0.0.1:${first.port}/api/state`)).status, 200);
  } finally {
    await first.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a marker left behind by a server that is gone is ignored and replaced', async () => {
  const dir = tempDir();
  const deadPort = await freePort();
  // This process is alive, but nothing answers on the port; and a pid that isn't running.
  for (const pid of [process.pid, 2 ** 22 + 12345]) {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ pid, port: deadPort, token: 'a'.repeat(64), startedAt: '2026-10-01T10:00:00.000Z' }));
    const app = makeApp(dir);
    try {
      await app.start();
      const marker = readMarker(dir)!;
      assert.equal(marker.port, app.port);
      assert.notEqual(marker.token, 'a'.repeat(64));
    } finally {
      await app.stop();
    }
  }
  // A broken marker is ignored too.
  writeFileSync(join(dir, 'server.json'), '{ broken');
  const app = makeApp(dir);
  try {
    await app.start();
    assert.equal(readMarker(dir)!.port, app.port);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/state says it is Light Runner and which version', async () => {
  const dir = tempDir();
  const app = makeApp(dir, { claimData: false });
  try {
    await app.start();
    const res = await fetch(`http://127.0.0.1:${app.port}/api/state`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-light-runner'), '9.8.7');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the launcher can stop the server with the marker’s token, from this computer only', async () => {
  const dir = tempDir();
  let asked = 0;
  const app = makeApp(dir, { onStopRequest: () => asked++ });
  try {
    await app.start();
    const { port, token } = readMarker(dir)!;
    const host = `127.0.0.1:${port}`;
    const stop = (headers: Record<string, string>, method = 'POST') => send('127.0.0.1', port, method, '/api/launcher/stop', headers);

    assert.equal((await stop({ host })).status, 401, 'no token');
    assert.equal((await stop({ host, authorization: `Bearer ${'0'.repeat(64)}` })).status, 401, 'wrong token');
    assert.equal((await stop({ host, authorization: `Bearer ${token.slice(0, 10)}` })).status, 401, 'part of the token');
    assert.equal((await stop({ host, authorization: token })).status, 401, 'not a bearer token');
    assert.equal((await stop({ host: `evil.example:${port}`, authorization: `Bearer ${token}` })).status, 403, 'another host name');
    assert.equal((await stop({ host, origin: 'http://evil.example', authorization: `Bearer ${token}` })).status, 403, 'from a web page');
    assert.equal((await stop({ host, authorization: `Bearer ${token}` }, 'GET')).status, 405);
    assert.equal(asked, 0);

    const ok = await stop({ host: `localhost:${port}`, authorization: `Bearer ${token}` });
    assert.equal(ok.status, 202);
    assert.equal(ok.headers['access-control-allow-origin'], undefined);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(asked, 1);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stop is refused from another computer on the network, even with the token', async (t) => {
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
  if (!lan) { t.skip('this computer has no network address'); return; }
  const dir = tempDir();
  let asked = 0;
  const app = makeApp(dir, { host: '0.0.0.0', onStopRequest: () => asked++ });
  try {
    await app.start();
    const { port, token } = readMarker(dir)!;
    // The connection comes from this computer's network address, as one from an iPad would.
    const res = await send(lan.address, port, 'POST', '/api/launcher/stop', { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` });
    assert.equal(res.status, 403);
    assert.equal(asked, 0);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a launcher stop (no claimData or no onStopRequest) the route does not exist', async () => {
  const dir = tempDir();
  const app = makeApp(dir, { claimData: false, onStopRequest: () => {} });
  try {
    await app.start();
    const res = await send('127.0.0.1', app.port, 'POST', '/api/launcher/stop', { host: `127.0.0.1:${app.port}`, authorization: `Bearer ${'0'.repeat(64)}` });
    assert.equal(res.status, 404);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the marker holds only the pid, the port, the token and when it started', async () => {
  const dir = tempDir();
  const app = makeApp(dir);
  try {
    await app.start();
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'))).sort(), ['pid', 'port', 'startedAt', 'token']);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/state gives the server’s pid, and only the marker’s pid makes a marker live', async () => {
  const dir = tempDir();
  // A Light Runner answering on the marker's port, but not the process in the marker (a pid used again).
  const other = makeApp(tempDir(), { claimData: false });
  try {
    await other.start();
    const res = await fetch(`http://127.0.0.1:${other.port}/api/state`);
    assert.equal(res.headers.get('x-light-runner-pid'), String(process.pid));
    assert.equal(await probePort(other.port), 'light-runner');
    assert.equal(await probePort(other.port, { pid: process.pid }), 'light-runner');
    assert.equal(await probePort(other.port, { pid: process.ppid }), 'other');

    // process.ppid is alive (it started these tests) but isn't the server on that port.
    const stale = { pid: process.ppid, port: other.port, token: 'b'.repeat(64), startedAt: '2026-10-01T10:00:00.000Z' };
    writeFileSync(join(dir, 'server.json'), JSON.stringify(stale));
    assert.equal(await liveMarker(dir), null);
    const mine = { ...stale, pid: process.pid };
    writeFileSync(join(dir, 'server.json'), JSON.stringify(mine));
    assert.deepEqual(await liveMarker(dir), mine);

    // So a server on this folder starts, and replaces the marker.
    writeFileSync(join(dir, 'server.json'), JSON.stringify(stale));
    const app = makeApp(dir);
    try {
      await app.start();
      assert.equal(readMarker(dir)!.port, app.port);
    } finally {
      await app.stop();
    }
  } finally {
    await other.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing the marker tries again when Windows holds the file for a moment', () => {
  const dir = tempDir();
  const marker = { pid: process.pid, port: 8123, token: 'c'.repeat(64), startedAt: '2026-10-01T10:00:00.000Z' };
  try {
    let calls = 0;
    writeMarker(dir, marker, (from, to) => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
      renameSync(from, to);
    });
    assert.equal(calls, 3);
    assert.deepEqual(readMarker(dir), marker);

    // It gives up after three tries, and at once on another error, leaving no half-written file.
    for (const code of ['EPERM', 'ENOSPC']) {
      calls = 0;
      assert.throws(() => writeMarker(dir, marker, () => { calls++; throw Object.assign(new Error(code), { code }); }), { code });
      assert.equal(calls, code === 'EPERM' ? 3 : 1);
      assert.equal(existsSync(join(dir, 'server.json.tmp')), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/state says how many pages are open on other computers (not this one’s)', async (t) => {
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
  if (!lan) { t.skip('this computer has no network address'); return; }
  const dir = tempDir();
  const app = makeApp(dir, { host: '0.0.0.0', claimData: false });
  const open = (address: string) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://${address}:${app.port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  const count = async () => (await fetch(`http://127.0.0.1:${app.port}/api/state`)).headers.get('x-light-runner-remote-pages');
  try {
    await app.start();
    assert.equal(await count(), '0');
    const here = await open('127.0.0.1');
    assert.equal(await count(), '0', 'a page on this computer is not an iPad');
    // A browser on the server computer itself, opened on its network address, isn't an iPad either. (One from
    // another computer is counted: see isThisComputer.)
    const own = await open(lan.address);
    assert.equal(await count(), '0', 'a page on this computer’s own network address is not an iPad');
    own.close();
    here.close();
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page is from this computer when it comes from loopback or one of its own network addresses', () => {
  const interfaces = {
    'Wi-Fi': [
      { address: '192.168.0.195', family: 'IPv4', internal: false },
      { address: 'fe80::1c2a:3b4c:5d6e:7f80', family: 'IPv6', internal: false, scopeid: 12 },
    ],
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  } as unknown as ReturnType<typeof networkInterfaces>;
  for (const own of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1', '192.168.0.195', '::ffff:192.168.0.195', 'fe80::1c2a:3b4c:5d6e:7f80', 'fe80::1c2a:3b4c:5d6e:7f80%12']) {
    assert.equal(isThisComputer(own, interfaces), true, own);
  }
  for (const other of ['192.168.0.42', '::ffff:192.168.0.42', '10.0.0.5', 'fe80::1', '', undefined]) {
    assert.equal(isThisComputer(other, interfaces), false, String(other));
  }
});
