import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { PassThrough } from 'node:stream';
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

test('a program on the port that never answers is left to the server to report', async () => {
  const sockets = [];
  const tcp = createTcpServer((s) => sockets.push(s));
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {any} */ (tcp.address());
  try {
    const started = Date.now();
    assert.equal(await probePort(port, { timeoutMs: 100 }), 'none');
    assert.ok(Date.now() - started < 2000);
  } finally {
    for (const s of sockets) s.destroy();
    tcp.close();
  }
});
