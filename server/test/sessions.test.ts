// Programmer sessions are kept in the data folder, so the Mac restarting doesn't log the Timeline page out in the
// middle of a service: only a hash of each token is stored, the file is the user's own, and a PIN change ends them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';
import { Sessions, hashPin } from '../src/auth.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');

const tempDir = () => mkdtempSync(join(tmpdir(), 'light-runner-sessions-'));

test('Sessions: kept in their file as hashes only, read back by a new Sessions, and they expire as before', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'sessions.json');
    let now = 1_000_000;
    const pin = hashPin('2468');
    const a = new Sessions({ file, pin: () => pin, now: () => now });
    const token = a.create();
    const other = a.create();
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(token) && !text.includes(other), 'no token in the file');
    assert.ok(!text.includes(pin), 'nor the PIN hash');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${file}.tmp`), 'written atomically');
    // After a restart.
    const b = new Sessions({ file, pin: () => pin, now: () => now });
    assert.equal(b.valid(token), true);
    assert.equal(b.valid('not-a-token'), false);
    assert.equal(b.valid(undefined), false);
    // Logging out ends that one, for the next start too.
    b.end(other);
    assert.equal(new Sessions({ file, pin: () => pin, now: () => now }).valid(other), false);
    // 12 hours, as before.
    now += 12 * 3600_000 - 1000;
    assert.equal(new Sessions({ file, pin: () => pin, now: () => now }).valid(token), true);
    now += 2000;
    assert.equal(new Sessions({ file, pin: () => pin, now: () => now }).valid(token), false);
    // A file that can't be read is no sessions, never a crash.
    writeFileSync(file, '{ not json');
    assert.equal(new Sessions({ file, pin: () => pin, now: () => now }).valid(token), false);
    // Without a file they live in memory only, as before.
    const mem = new Sessions();
    assert.equal(mem.valid(mem.create()), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Sessions: a PIN change (whatever made it) ends them; clear() ends them in the file too', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'sessions.json');
    let pin: string | undefined = hashPin('2468');
    const a = new Sessions({ file, pin: () => pin });
    const token = a.create();
    pin = hashPin('1357');
    assert.equal(a.valid(token), false, 'made under another PIN');
    assert.equal(new Sessions({ file, pin: () => pin }).valid(token), false);
    const next = a.create();
    a.clear();
    assert.equal(new Sessions({ file, pin: () => pin }).valid(next), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function json(app: App, method: string, path: string, body?: unknown, cookie = '') {
  const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: set ? set.split(';')[0]! : cookie };
}

test('server: the programmer stays logged in when the server starts again; a PIN change logs the others out', async () => {
  const dir = tempDir();
  let running: App | null = null;
  const make = () => (running = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} }));
  try {
    let app = make();
    await app.start();
    const first = await json(app, 'POST', '/api/pin', { next: '2468' });
    assert.equal(first.status, 200);
    const laptop = (await json(app, 'POST', '/api/login', { pin: '2468' })).cookie;
    assert.equal((await json(app, 'GET', '/api/session', undefined, laptop)).body.loggedIn, true);
    await app.stop();
    running = null;

    app = make();
    await app.start();
    assert.equal((await json(app, 'GET', '/api/session', undefined, laptop)).body.loggedIn, true, 'still in after the restart');
    assert.equal((await json(app, 'GET', '/api/recordings', undefined, laptop)).status, 200);
    assert.equal((await json(app, 'GET', '/api/session')).body.loggedIn, false, 'no cookie, no session');
    // The PIN changes on the Mac: the laptop is logged out, now and after the next start.
    const mac = (await json(app, 'POST', '/api/pin', { current: '2468', next: '1357' }, first.cookie)).cookie;
    assert.equal((await json(app, 'GET', '/api/session', undefined, laptop)).body.loggedIn, false);
    await app.stop();
    running = null;

    app = make();
    await app.start();
    assert.equal((await json(app, 'GET', '/api/session', undefined, laptop)).body.loggedIn, false);
    assert.equal((await json(app, 'GET', '/api/session', undefined, mac)).body.loggedIn, true, 'the browser that changed it stays in');
  } finally {
    await (running as App | null)?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
