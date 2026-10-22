import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerProcess } from '../src/server-process.js';

// The real server, on this Node, in test mode (never sends DMX), on a free port with a temp data folder.

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env, LIGHT_RUNNER_FAKE_MIDI: 'missing' };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {any} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

function until(sp, status, ms = 20000) {
  return new Promise((resolve, reject) => {
    if (sp.status === status) return resolve(undefined);
    const timer = setTimeout(() => { off(); reject(new Error(`still '${sp.status}', not '${status}':\n${sp.lastLines.join('\n')}`)); }, ms);
    const off = sp.onChange((s) => {
      if (s.status === status) { clearTimeout(timer); off(); resolve(undefined); }
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeDir(dir) {
  // Windows may hold the folder for a moment after the server ends.
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await tick(250);
    }
  }
}

test('the real server starts, says it is ready, and stops cleanly when asked', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-launcher-real-'));
  const port = await freePort();
  const sp = new ServerProcess({ nodePath: process.execPath, appDir: root, dataDir: dir, env });
  try {
    await sp.start({ port, testMode: true });
    await until(sp, 'running');
    assert.equal(sp.port, port);
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.status, 200);
    const started = Date.now();
    await sp.stop();
    assert.equal(sp.status, 'stopped');
    assert.ok(Date.now() - started < 5000, 'stopped by itself, not ended after the wait');
    assert.ok(sp.lastLines.some((l) => /saving state and stopping/.test(l)), sp.lastLines.join('\n'));
  } finally {
    if (sp.child) sp.child.kill();
    await removeDir(dir);
  }
});

test('the server keeps running when the launcher goes away, and the next launcher finds it', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-launcher-left-'));
  const port = await freePort();
  const helper = spawn(process.execPath, [join(root, 'launcher', 'test', 'helpers', 'start-and-leave.js'), root, dir, String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  helper.stdout.on('data', (d) => (out += d));
  const helperCode = await new Promise((resolve) => helper.once('close', resolve));
  const report = JSON.parse(out.trim() || '{}');
  assert.equal(helperCode, 0, out);
  const pid = report.pid;
  assert.equal(typeof pid, 'number');
  try {
    await tick(300);
    assert.ok(alive(pid), 'still running after the launcher went away');
    // It writes to its log after the launcher, which read the log, has gone: that must not stop it.
    for (const name of ['Left running', 'Left running again']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ showName: name }),
      });
      assert.equal(res.status, 200);
    }
    await tick(500);
    assert.ok(alive(pid), 'still running after writing to its log');
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.status, 200);

    // The next launcher finds it and leaves it alone.
    const next = new ServerProcess({
      nodePath: process.execPath, appDir: root, dataDir: dir, env,
      spawn: () => { throw new Error('a second server must not be started'); },
    });
    await next.start({ port, testMode: true });
    assert.equal(next.status, 'running-elsewhere');
    assert.equal(next.port, port);
  } finally {
    try {
      process.kill(pid);
    } catch {}
    for (let i = 0; i < 40 && alive(pid); i++) await tick(250);
    await removeDir(dir);
  }
});
