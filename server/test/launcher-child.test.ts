import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The server as a launcher (the Electron app) runs it: a child process with an IPC channel.

const root = fileURLToPath(new URL('../../', import.meta.url));

type Message = { type: string; [key: string]: unknown };

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

/** Start `node server/src/main.ts` the way a launcher does, and collect what it sends and when it exits. */
function startChild(dataDir: string, port: number) {
  const child: ChildProcess = spawn(process.execPath, ['server/src/main.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), LIGHT_RUNNER_DATA: dataDir, LIGHT_RUNNER_OUTPUT: 'none' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  const messages: Message[] = [];
  const waiting: Array<{ type: string; resolve: (m: Message) => void }> = [];
  child.on('message', (m) => {
    messages.push(m as Message);
    for (const w of [...waiting]) if (w.type === (m as Message).type) { waiting.splice(waiting.indexOf(w), 1); w.resolve(m as Message); }
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const message = (type: string, ms = 15000) =>
    new Promise<Message>((resolve, reject) => {
      const seen = messages.find((m) => m.type === type);
      if (seen) return resolve(seen);
      const timer = setTimeout(() => reject(new Error(`no '${type}' message in ${ms} ms. Child output:\n${log}`)), ms);
      waiting.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  return { child, exited, message, messages, log: () => log };
}

test('a launcher can start the server, hear that it is ready, and stop it so the stage is saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-launcher-'));
  const port = await freePort();
  const run = startChild(dir, port);
  try {
    const ready = await run.message('ready');
    assert.equal(ready.port, port);

    const res = await fetch(`http://127.0.0.1:${port}/api/look/word`, { method: 'POST' });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 100));

    run.child.send({ type: 'shutdown' });
    assert.equal(await run.exited, 0, run.log());
    const saved = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
    assert.equal(saved.look, 'word');
  } finally {
    run.child.kill();
    await run.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a server that finds its port taken says so over IPC and exits with code 2', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'lr-launcher-'));
  const dirB = mkdtempSync(join(tmpdir(), 'lr-launcher-'));
  const port = await freePort();
  const first = startChild(dirA, port);
  let second: ReturnType<typeof startChild> | undefined;
  try {
    await first.message('ready');
    second = startChild(dirB, port);
    const error = await second.message('error');
    assert.equal(error.code, 'port-in-use');
    assert.equal(typeof error.message, 'string');
    assert.equal(await second.exited, 2, second.log());
    assert.equal(second.messages.some((m) => m.type === 'ready'), false);

    // The first one is untouched.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 200);
  } finally {
    first.child.send({ type: 'shutdown' });
    await first.exited;
    second?.child.kill();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('a second server on the same data folder says Light Runner is already running, before it starts its engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-launcher-'));
  const portA = await freePort();
  const portB = await freePort();
  const first = startChild(dir, portA);
  let second: ReturnType<typeof startChild> | undefined;
  try {
    await first.message('ready');
    const marker = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'));
    assert.equal(marker.port, portA);
    second = startChild(dir, portB);
    const error = await second.message('error');
    assert.equal(error.code, 'already-running');
    assert.equal(error.port, portA);
    assert.equal(await second.exited, 2, second.log());
    // It never loaded the show (that comes before the engine starts).
    assert.doesNotMatch(second.log(), /Loaded show/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')), marker);

    first.child.send({ type: 'shutdown' });
    assert.equal(await first.exited, 0, first.log());
    assert.equal(existsSync(join(dir, 'server.json')), false, 'a clean stop removes the marker');
  } finally {
    first.child.kill();
    second?.child.kill();
    await first.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
