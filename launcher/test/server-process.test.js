import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerProcess, probePort } from '../src/server-process.js';

// The server process with a fake spawn: the child is driven by the test (its messages, log lines and exit).

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    /** @type {unknown[]} */
    this.sent = [];
    this.killed = false;
    this.pid = 4242;
    this.connected = true;
    /** @type {number | null} */
    this.exitCode = null;
    /** @type {string | null} */
    this.signalCode = null;
  }
  send(message, callback) {
    this.sent.push(message);
    callback?.(null);
    return true;
  }
  kill() {
    this.killed = true;
    this.exit(null, 'SIGTERM');
    return true;
  }
  /** The child ends: its pipes close, then 'exit' and 'close' as Node sends them. */
  exit(code, signal = null) {
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }
  ready(port) {
    this.emit('message', { type: 'ready', port });
  }
}

function fakeSpawn() {
  /** @type {{ command: string, args: string[], options: any, child: FakeChild }[]} */
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls, last: () => calls[calls.length - 1].child };
}

const free = async () => 'none';

function make(extra = {}) {
  const fake = fakeSpawn();
  const sp = new ServerProcess({
    nodePath: '/app/node', appDir: '/app/app', dataDir: '/data/Light Runner',
    spawn: fake.spawn, probe: free, restartDelayMs: 10, env: { HOME: '/home/someone', LIGHT_RUNNER_OUTPUT: 'none' },
    ...extra,
  });
  /** @type {string[]} */
  const seen = [];
  sp.onChange((s) => seen.push(s.status));
  return { sp, fake, seen };
}

/** Resolves when the server process reaches the status (or fails the test after a while). */
function until(sp, status, ms = 3000) {
  return new Promise((resolve, reject) => {
    if (sp.status === status) return resolve(undefined);
    const timer = setTimeout(() => { off(); reject(new Error(`still '${sp.status}', not '${status}'`)); }, ms);
    const off = sp.onChange((s) => {
      if (s.status === status) { clearTimeout(timer); off(); resolve(undefined); }
    });
  });
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('start runs the server on the bundled Node with the port and data folder, and it is running once it says so', async () => {
  const { sp, fake, seen } = make();
  assert.equal(sp.status, 'stopped');
  await sp.start({ port: 8080, testMode: false });
  assert.equal(fake.calls.length, 1);
  const { command, args, options } = fake.calls[0];
  assert.equal(command, '/app/node');
  assert.deepEqual(args, [join('/app/app', 'server', 'src', 'main.ts')]);
  assert.equal(options.cwd, '/app/app');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.equal(options.env.PORT, '8080');
  assert.equal(options.env.LIGHT_RUNNER_DATA, '/data/Light Runner');
  assert.equal(options.env.HOME, '/home/someone');
  // Test mode off means off, whatever the launcher itself was started with.
  assert.equal('LIGHT_RUNNER_OUTPUT' in options.env, false);
  assert.equal(sp.status, 'starting');
  fake.last().ready(8080);
  assert.equal(sp.status, 'running');
  assert.equal(sp.port, 8080);
  assert.deepEqual(seen, ['starting', 'running']);
});

test('test mode tells the server not to send to the lights', async () => {
  const { sp, fake } = make({ env: {} });
  await sp.start({ port: 8085, testMode: true });
  assert.equal(fake.calls[0].options.env.LIGHT_RUNNER_OUTPUT, 'none');
  assert.equal(fake.calls[0].options.env.PORT, '8085');
});

test('stop asks the server to save and stop, and does not start it again', async () => {
  const { sp, fake, seen } = make();
  await sp.start({ port: 8080, testMode: false });
  const child = fake.last();
  child.ready(8080);
  const stopped = sp.stop();
  assert.deepEqual(child.sent, [{ type: 'shutdown' }]);
  child.exit(0);
  await stopped;
  assert.equal(sp.status, 'stopped');
  assert.equal(child.killed, false);
  await tick(30);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(seen, ['starting', 'running', 'stopped']);
});

test('stop ends a server that does not stop by itself after the wait', async () => {
  const { sp, fake } = make({ stopTimeoutMs: 40 });
  await sp.start({ port: 8080, testMode: false });
  const child = fake.last();
  child.ready(8080);
  await sp.stop();
  assert.equal(child.killed, true);
  assert.equal(sp.status, 'stopped');
  assert.equal(fake.calls.length, 1);
});

test('the port taken by another program: failed with port-in-use, never started again by itself', async () => {
  const { sp, fake, seen } = make();
  await sp.start({ port: 8080, testMode: false });
  const child = fake.last();
  child.stderr.write('2026-10-22T10:00:00.000Z could not start: Port 8080 is already in use\n');
  child.emit('message', { type: 'error', code: 'port-in-use', message: 'Port 8080 is already in use' });
  child.exit(2);
  await until(sp, 'failed');
  assert.equal(sp.code, 'port-in-use');
  assert.equal(sp.message, 'Port 8080 is already in use');
  await tick(50);
  assert.equal(fake.calls.length, 1);
  assert.equal(sp.status, 'failed');
  assert.deepEqual(seen, ['starting', 'failed']);
  // Starting again on another port works.
  await sp.start({ port: 8090, testMode: false });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].options.env.PORT, '8090');
  assert.equal(sp.code, null);
});

test('a crash restarts the server once; a second crash leaves it failed with the last lines of its log', async () => {
  const { sp, fake, seen } = make();
  await sp.start({ port: 8080, testMode: false });
  fake.last().ready(8080);
  fake.last().stderr.write('TypeError: something broke\n    at first crash\n');
  fake.last().exit(1);
  await until(sp, 'starting');
  await tick(30);
  assert.equal(fake.calls.length, 2, 'started again once');
  assert.equal(fake.calls[1].options.env.PORT, '8080');
  fake.last().ready(8080);
  assert.equal(sp.status, 'running');
  fake.last().stderr.write('RangeError: broke again\n    at second crash\n');
  fake.last().exit(1);
  await until(sp, 'failed');
  await tick(50);
  assert.equal(fake.calls.length, 2, 'not started a third time');
  assert.equal(sp.status, 'failed');
  assert.equal(sp.code, 'crashed');
  assert.deepEqual(seen, ['starting', 'running', 'starting', 'running', 'failed']);
  const log = sp.lastLines.join('\n');
  assert.match(log, /something broke/);
  assert.match(log, /broke again/);
  assert.match(log, /second crash/);
  // Start (the button) tries again, and it may be restarted once more after that.
  await sp.start({ port: 8080, testMode: false });
  assert.equal(fake.calls.length, 3);
  fake.last().ready(8080);
  fake.last().exit(1);
  await until(sp, 'starting');
  await tick(30);
  assert.equal(fake.calls.length, 4);
});

test('a server that crashes while starting is restarted once too', async () => {
  const { sp, fake } = make();
  await sp.start({ port: 8080, testMode: false });
  fake.last().exit(1);
  await tick(40);
  assert.equal(fake.calls.length, 2);
  fake.last().exit(1);
  await until(sp, 'failed');
  assert.equal(sp.code, 'crashed');
});

test('a server that could not start for another reason is failed, with its words, and not restarted', async () => {
  const { sp, fake } = make();
  await sp.start({ port: 8080, testMode: false });
  fake.last().emit('message', { type: 'error', code: 'start-failed', message: "EACCES: permission denied, mkdir '/data/Light Runner'" });
  fake.last().exit(2);
  await until(sp, 'failed');
  await tick(40);
  assert.equal(fake.calls.length, 1);
  assert.equal(sp.code, 'start-failed');
  assert.match(sp.message, /permission denied/);
});

test('a server stopped by someone else (exit 0) is stopped, not restarted', async () => {
  const { sp, fake } = make();
  await sp.start({ port: 8080, testMode: false });
  fake.last().ready(8080);
  fake.last().exit(0);
  await until(sp, 'stopped');
  await tick(40);
  assert.equal(fake.calls.length, 1);
});

test('a Node that cannot be run is failed with start-failed, not restarted', async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    child.pid = undefined;
    calls.push(child);
    setImmediate(() => {
      child.emit('error', Object.assign(new Error('spawn /app/node ENOENT'), { code: 'ENOENT' }));
      child.emit('close', -4058, null);
    });
    return child;
  };
  const sp = new ServerProcess({ nodePath: '/app/node', appDir: '/app/app', dataDir: '/data', spawn, probe: free, restartDelayMs: 10 });
  await sp.start({ port: 8080, testMode: false });
  await until(sp, 'failed');
  await tick(40);
  assert.equal(calls.length, 1);
  assert.equal(sp.code, 'start-failed');
  assert.match(sp.message, /ENOENT/);
});

test('start while it is starting or running does not start a second server', async () => {
  const { sp, fake } = make();
  await sp.start({ port: 8080, testMode: false });
  await sp.start({ port: 8080, testMode: false });
  fake.last().ready(8080);
  await sp.start({ port: 8080, testMode: false });
  assert.equal(fake.calls.length, 1);
});

test('stop while waiting to restart after a crash cancels the restart', async () => {
  const { sp, fake } = make({ restartDelayMs: 100 });
  await sp.start({ port: 8080, testMode: false });
  fake.last().ready(8080);
  fake.last().exit(1);
  await until(sp, 'starting');
  await sp.stop();
  assert.equal(sp.status, 'stopped');
  await tick(150);
  assert.equal(fake.calls.length, 1);
});

test('the last 30 lines of the log are kept, whole lines, from both outputs', async () => {
  const { sp, fake } = make();
  await sp.start({ port: 8080, testMode: false });
  const child = fake.last();
  for (let i = 1; i <= 40; i++) child.stdout.write(`line ${i}\r\n`);
  child.stderr.write('half a ');
  child.stderr.write('line\nnext');
  await tick();
  assert.equal(sp.lastLines.length, 30);
  assert.equal(sp.lastLines[0], 'line 12');
  assert.equal(sp.lastLines[28], 'line 40');
  assert.equal(sp.lastLines[29], 'half a line');
  child.exit(0);
  await until(sp, 'stopped');
  // What was left without a line end is kept when the server ends.
  assert.ok(sp.lastLines.includes('next'), sp.lastLines.join('|'));
});

test('stop while it was never started does nothing', async () => {
  const { sp, fake, seen } = make();
  await sp.stop();
  assert.equal(sp.status, 'stopped');
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(seen, []);
});

// The port check before starting, against small local HTTP servers.

/** @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler */
function httpServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: /** @type {any} */ (server.address()).port }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {any} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

const lightRunnerState = { look: 'basic', lookProgress: 1, lookFadeLeft: 0, lastLook: null, lookChanged: false, canUndo: false, fadeTime: null, groups: {}, master: 1, speed: 1, tempo: 120 };

test('a Light Runner already running on the port is used, not started again', async () => {
  const { server, port } = await httpServer((req, res) => {
    if (req.url === '/api/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(lightRunnerState)); }
    else { res.statusCode = 404; res.end(); }
  });
  try {
    assert.equal(await probePort(port), 'light-runner');
    const { sp, fake, seen } = make({ probe: undefined });
    await sp.start({ port, testMode: false });
    assert.equal(sp.status, 'running-elsewhere');
    assert.equal(sp.port, port);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(seen, ['starting', 'running-elsewhere']);
    // Stop can't stop a server it didn't start.
    await sp.stop();
    assert.equal(sp.status, 'running-elsewhere');
  } finally {
    server.close();
  }
});

test('another program answering on the port: failed with port-in-use, nothing started', async () => {
  const { server, port } = await httpServer((req, res) => { res.statusCode = 404; res.setHeader('content-type', 'text/html'); res.end('<h1>Companion</h1>'); });
  try {
    assert.equal(await probePort(port), 'other');
    const { sp, fake, seen } = make({ probe: undefined });
    await sp.start({ port, testMode: false });
    assert.equal(sp.status, 'failed');
    assert.equal(sp.code, 'port-in-use');
    assert.equal(sp.message, `Port ${port} is already in use by another program`);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(seen, ['starting', 'failed']);
  } finally {
    server.close();
  }
});

test('JSON that is not Light Runner’s state is another program', async () => {
  const { server, port } = await httpServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  try {
    assert.equal(await probePort(port), 'other');
  } finally {
    server.close();
  }
});

test('a free port starts the server', async () => {
  const port = await freePort();
  assert.equal(await probePort(port), 'none');
  const { sp, fake } = make({ probe: undefined });
  await sp.start({ port, testMode: false });
  assert.equal(fake.calls.length, 1);
  assert.equal(sp.status, 'starting');
});


/** A raw TCP server: `onSocket` decides what it does with each connection. */
async function tcpServer(onSocket) {
  const sockets = [];
  const tcp = createTcpServer((s) => { sockets.push(s); onSocket(s); });
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {any} */ (tcp.address());
  return { port, close: () => { for (const s of sockets) s.destroy(); tcp.close(); } };
}

test('a program that takes the connection and never answers is busy, and nothing is started', async () => {
  const tcp = await tcpServer(() => {});
  try {
    const started = Date.now();
    assert.equal(await probePort(tcp.port, { timeoutMs: 100 }), 'busy');
    assert.ok(Date.now() - started < 2000);
    const { sp, fake } = make({ probe: (port) => probePort(port, { timeoutMs: 100 }) });
    await sp.start({ port: tcp.port, testMode: false });
    assert.equal(sp.status, 'failed');
    assert.equal(sp.code, 'port-in-use');
    assert.equal(sp.message, `Port ${tcp.port} is in use by a program that is not answering`);
    assert.equal(fake.calls.length, 0);
  } finally {
    tcp.close();
  }
});

test('a program that takes the connection and drops it is another program', async () => {
  const tcp = await tcpServer((s) => s.destroy());
  try {
    assert.equal(await probePort(tcp.port), 'other');
  } finally {
    tcp.close();
  }
});

test('Light Runner is known by its x-light-runner header first', async () => {
  const { server, port } = await httpServer((req, res) => { res.setHeader('x-light-runner', '0.2.0'); res.end('not even JSON'); });
  try {
    assert.equal(await probePort(port), 'light-runner');
  } finally {
    server.close();
  }
});

// The data folder's marker (server.json).

function dataDirWith(marker) {
  const dir = mkdtempSync(join(tmpdir(), 'lr-launcher-marker-'));
  if (marker) writeFileSync(join(dir, 'server.json'), JSON.stringify(marker));
  return dir;
}

const TOKEN = 'ab'.repeat(32);

test('a Light Runner running on this data folder is found by its marker, whatever port was asked', async () => {
  const dir = dataDirWith({ pid: process.pid, port: 9123, token: TOKEN, startedAt: '2026-10-22T08:00:00.000Z' });
  try {
    const asked = [];
    const { sp, fake, seen } = make({ dataDir: dir, probe: async (port) => { asked.push(port); return port === 9123 ? 'light-runner' : 'none'; } });
    await sp.start({ port: 8080, testMode: false });
    assert.equal(sp.status, 'running-elsewhere');
    assert.equal(sp.port, 9123);
    assert.deepEqual(asked, [9123]);
    assert.equal(fake.calls.length, 0);
    // Start again does nothing while it runs elsewhere.
    await sp.start({ port: 8080, testMode: false });
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(asked, [9123]);
    assert.deepEqual(seen, ['starting', 'running-elsewhere']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a marker left behind (nothing answers, or its process is gone) is passed over', async () => {
  for (const pid of [process.pid, 2 ** 22 + 12345]) {
    const dir = dataDirWith({ pid, port: 9123, token: TOKEN, startedAt: '2026-10-22T08:00:00.000Z' });
    try {
      const { sp, fake } = make({ dataDir: dir, probe: async (port) => (pid === process.pid || port !== 9123 ? 'none' : 'light-runner') });
      await sp.start({ port: 8080, testMode: false });
      assert.equal(fake.calls.length, 1, `pid ${pid}`);
      assert.equal(fake.calls[0].options.env.PORT, '8080');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a Light Runner on this data folder that is not answering is reported, nothing started', async () => {
  const dir = dataDirWith({ pid: process.pid, port: 9123, token: TOKEN, startedAt: '2026-10-22T08:00:00.000Z' });
  try {
    const { sp, fake } = make({ dataDir: dir, probe: async (port) => (port === 9123 ? 'busy' : 'none') });
    await sp.start({ port: 8080, testMode: false });
    assert.equal(sp.status, 'failed');
    assert.equal(sp.code, 'not-answering');
    assert.equal(sp.port, 9123);
    assert.match(sp.message, /already running on port 9123 but is not answering/);
    assert.equal(fake.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a server that says Light Runner is already running on this data folder is shown as running elsewhere', async () => {
  const { sp, fake } = make();
  await sp.start({ port: 8080, testMode: false });
  fake.last().emit('message', { type: 'error', code: 'already-running', port: 9123, message: 'Light Runner is already running on this computer (port 9123), with the same data folder' });
  fake.last().exit(2);
  await until(sp, 'running-elsewhere');
  assert.equal(sp.port, 9123);
  await tick(40);
  assert.equal(fake.calls.length, 1);
});

// Restarts, stopping and listeners.

test('a server that ran well for a while gets its one restart back; a crash loop still gets one', async () => {
  let now = 0;
  const { sp, fake } = make({ now: () => now, stableMs: 600_000 });
  await sp.start({ port: 8080, testMode: false });
  fake.last().ready(8080);
  now = 20 * 60_000;
  fake.last().exit(1);
  await tick(40);
  assert.equal(fake.calls.length, 2, 'restarted after the first crash');
  fake.last().ready(8080);
  now += 30 * 60_000;
  fake.last().exit(1);
  await tick(40);
  assert.equal(fake.calls.length, 3, 'up 30 minutes: restarted again');
  fake.last().ready(8080);
  now += 5_000;
  fake.last().exit(1);
  await until(sp, 'failed');
  await tick(40);
  assert.equal(fake.calls.length, 3, 'up 5 s: not restarted again');
  assert.equal(sp.code, 'crashed');
});

test('stop gives up when the server cannot be ended, instead of waiting for ever', async () => {
  const { sp, fake } = make({ stopTimeoutMs: 30, killWaitMs: 30 });
  await sp.start({ port: 8080, testMode: false });
  const child = fake.last();
  child.kill = () => { throw new Error('kill failed'); };
  child.ready(8080);
  const started = Date.now();
  await sp.stop();
  assert.ok(Date.now() - started < 1000);
  assert.equal(sp.status, 'failed');
  assert.equal(sp.code, 'stop-failed');
  // A close that comes much later changes nothing.
  child.emit('close', 0, null);
  assert.equal(sp.status, 'failed');
});

test('stop of a server that has already ended (no close yet) finishes at once', async () => {
  const { sp, fake } = make({ stopTimeoutMs: 5000 });
  await sp.start({ port: 8080, testMode: false });
  const child = fake.last();
  child.ready(8080);
  child.exitCode = 0;
  const started = Date.now();
  await sp.stop();
  assert.ok(Date.now() - started < 1000);
  assert.equal(sp.status, 'stopped');
});

test('requestStop asks the server to stop at once, without waiting (the computer is shutting down)', async () => {
  const { sp, fake } = make();
  assert.equal(sp.requestStop(), false);
  await sp.start({ port: 8080, testMode: false });
  const child = fake.last();
  child.ready(8080);
  assert.equal(sp.requestStop(), true);
  assert.deepEqual(child.sent, [{ type: 'shutdown' }]);
  child.exit(0);
  await until(sp, 'stopped');
  await tick(40);
  assert.equal(fake.calls.length, 1);
});

test('a listener that throws does not stop the others hearing', async () => {
  const { sp, fake, seen } = make();
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const off = sp.onChange(() => { throw new Error('window gone'); });
    const later = [];
    sp.onChange((s) => later.push(s.status));
    await sp.start({ port: 8080, testMode: false });
    fake.last().ready(8080);
    off();
    assert.deepEqual(seen, ['starting', 'running']);
    assert.deepEqual(later, ['starting', 'running']);
    assert.equal(errors.length, 2);
  } finally {
    console.error = consoleError;
  }
});

// Stopping a Light Runner this launcher didn't start, with the marker's token.

/** A stand-in for a running Light Runner: answers /api/state and, with the token, POST /api/launcher/stop. */
async function fakeLightRunner({ token = TOKEN, goesQuiet = true, pid = process.pid } = {}) {
  const asked = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/api/state') {
      res.setHeader('x-light-runner', '0.2.0');
      res.setHeader('x-light-runner-pid', String(pid));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(lightRunnerState));
    }
    if (req.method === 'POST' && req.url === '/api/launcher/stop') {
      asked.push({ authorization: req.headers.authorization, host: req.headers.host });
      const ok = req.headers.authorization === `Bearer ${token}`;
      res.statusCode = ok ? 202 : 401;
      res.end(JSON.stringify(ok ? { stopping: true } : { error: 'wrong token' }));
      if (ok && goesQuiet) setTimeout(() => { server.close(); for (const s of sockets) s.destroy(); }, 50);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {any} */ (server.address());
  return { port, asked, close: () => { server.close(); for (const s of sockets) s.destroy(); } };
}

test('stopElsewhere stops the Light Runner on this data folder with its token and waits until it is gone', async () => {
  const lr = await fakeLightRunner();
  const dir = dataDirWith({ pid: process.pid, port: lr.port, token: TOKEN, startedAt: '2026-10-22T08:00:00.000Z' });
  try {
    const { sp, fake } = make({ dataDir: dir, probe: undefined });
    await sp.start({ port: 8080, testMode: false });
    assert.equal(sp.status, 'running-elsewhere');
    assert.equal(await sp.stopElsewhere(), true);
    assert.equal(sp.status, 'stopped');
    assert.deepEqual(lr.asked, [{ authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${lr.port}` }]);
    assert.equal(await probePort(lr.port), 'none');
    // The token is never written to the log.
    assert.equal(sp.lastLines.some((l) => l.includes(TOKEN)), false);
    assert.equal(fake.calls.length, 0);
  } finally {
    lr.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopElsewhere without a marker, or refused, says so and leaves it running', async () => {
  const lr = await fakeLightRunner({ token: 'cd'.repeat(32) });
  const noMarker = dataDirWith(null);
  const wrong = dataDirWith({ pid: process.pid, port: lr.port, token: TOKEN, startedAt: '2026-10-22T08:00:00.000Z' });
  try {
    const a = make({ dataDir: noMarker, probe: undefined }).sp;
    await a.start({ port: lr.port, testMode: false });
    assert.equal(a.status, 'running-elsewhere');
    assert.equal(await a.stopElsewhere(), false);
    assert.equal(a.status, 'running-elsewhere');
    assert.match(a.message, /can.t be stopped from here/);

    const b = make({ dataDir: wrong, probe: undefined }).sp;
    await b.start({ port: 8080, testMode: false });
    assert.equal(b.status, 'running-elsewhere');
    assert.equal(await b.stopElsewhere(), false);
    assert.equal(b.status, 'running-elsewhere');
    assert.match(b.message, /refused to stop/);
    assert.equal(await probePort(lr.port), 'light-runner');
  } finally {
    lr.close();
    rmSync(noMarker, { recursive: true, force: true });
    rmSync(wrong, { recursive: true, force: true });
  }
});

test('stopElsewhere gives up when the server does not go away in time', async () => {
  const lr = await fakeLightRunner({ goesQuiet: false });
  const dir = dataDirWith({ pid: process.pid, port: lr.port, token: TOKEN, startedAt: '2026-10-22T08:00:00.000Z' });
  try {
    const { sp } = make({ dataDir: dir, probe: undefined });
    await sp.start({ port: 8080, testMode: false });
    const started = Date.now();
    assert.equal(await sp.stopElsewhere({ waitMs: 300 }), false);
    assert.ok(Date.now() - started < 3000);
    assert.equal(sp.status, 'running-elsewhere');
    assert.match(sp.message, /did not stop/);
  } finally {
    lr.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a marker counts only when the Light Runner on its port has its pid', async () => {
  // process.ppid is alive (it started these tests), but the Light Runner on the port says it is process.pid.
  const lr = await fakeLightRunner();
  const dir = dataDirWith({ pid: process.ppid, port: lr.port, token: TOKEN, startedAt: '2026-10-22T08:00:00.000Z' });
  try {
    assert.equal(await probePort(lr.port, { pid: process.pid }), 'light-runner');
    assert.equal(await probePort(lr.port, { pid: process.ppid }), 'other');
    // Asked for another port, it starts its own server: the marker is someone else's left-over.
    const a = make({ dataDir: dir, probe: undefined });
    await a.sp.start({ port: await freePort(), testMode: false });
    assert.equal(a.fake.calls.length, 1);
    // Asked for that port, the Light Runner there is shown as running, but it can't be stopped from here.
    const b = make({ dataDir: dir, probe: undefined });
    await b.sp.start({ port: lr.port, testMode: false });
    assert.equal(b.sp.status, 'running-elsewhere');
    assert.equal(await b.sp.stopElsewhere(), false);
    assert.match(b.sp.message, /another data folder/);
    assert.deepEqual(lr.asked, [], 'never sent the token to it');
  } finally {
    lr.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recheck notices when the Light Runner running elsewhere has gone, or answers again', async () => {
  let answer = 'light-runner';
  const dir = dataDirWith({ pid: process.pid, port: 9123, token: TOKEN, startedAt: '2026-10-22T08:00:00.000Z' });
  try {
    const { sp, fake, seen } = make({ dataDir: dir, probe: async () => answer });
    await sp.start({ port: 8080, testMode: false });
    assert.equal(sp.status, 'running-elsewhere');
    await sp.recheck();
    assert.equal(sp.status, 'running-elsewhere');
    answer = 'none';
    await sp.recheck();
    assert.equal(sp.status, 'stopped');
    assert.equal(sp.port, 9123);
    // Stopped: nothing more is asked, and nothing was started.
    answer = 'light-runner';
    await sp.recheck();
    assert.equal(sp.status, 'stopped');
    assert.equal(fake.calls.length, 0);

    // One that isn't answering: it comes back, or goes.
    answer = 'busy';
    await sp.start({ port: 8080, testMode: false });
    assert.equal(sp.code, 'not-answering');
    await sp.recheck();
    assert.equal(sp.code, 'not-answering');
    answer = 'light-runner';
    await sp.recheck();
    assert.equal(sp.status, 'running-elsewhere');
    assert.deepEqual(seen, ['starting', 'running-elsewhere', 'stopped', 'starting', 'failed', 'running-elsewhere']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
