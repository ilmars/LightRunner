// The Timeline page saves one timeline at a time: PUT /api/timeline and DELETE /api/timeline?id=.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';
import { STAGE_LAYER } from '../../packages/shared/src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');

interface Ctx {
  app: App;
  dir: string;
  json: (method: string, path: string, body?: unknown, opts?: { session?: boolean }) => Promise<{ status: number; body: any }>;
}

async function withApp(fn: (c: Ctx) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-tl-'));
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} });
  let cookie = '';
  const json: Ctx['json'] = async (method, path, body, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
      method,
      headers: { ...(opts.session !== false && cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    await app.start();
    await fn({ app, dir, json });
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const intro = (extra: Record<string, unknown> = {}) => ({
  id: 'intro',
  name: 'Christmas intro',
  layers: [{ group: STAGE_LAYER, blocks: [{ id: 'b1', start: 0, rise: 0, what: { kind: 'dark' } }] }],
  markers: [{ t: 12.5, text: 'In the beginning' }],
  ...extra,
});

test('PUT /api/timeline adds a timeline, then replaces it by id; the rest of the show stays', async () => {
  await withApp(async ({ json }) => {
    const before = (await json('GET', '/api/show')).body;
    assert.deepEqual(before.timelines, []);

    const added = await json('PUT', '/api/timeline', intro());
    assert.equal(added.status, 200);
    // The saved timeline comes back as the show keeps it (defaults filled in).
    assert.equal(added.body.id, 'intro');
    assert.equal(added.body.offsetMs, 0);
    assert.deepEqual(added.body.markers, [{ t: 12.5, text: 'In the beginning' }]);

    await json('PUT', '/api/timeline', { ...intro(), id: 'second', name: 'Second' });
    const renamed = await json('PUT', '/api/timeline', intro({ name: 'Opening', offsetMs: 120 }));
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Opening');

    const after = (await json('GET', '/api/show')).body;
    // Replaced in place: the order stays.
    assert.deepEqual(after.timelines.map((t: any) => [t.id, t.name, t.offsetMs]), [['intro', 'Opening', 120], ['second', 'Second', 0]]);
    // Nothing else in the show changed.
    const { timelines: _a, ...restBefore } = before;
    const { timelines: _b, ...restAfter } = after;
    assert.deepEqual(restAfter, restBefore);
  });
});

test('PUT /api/timeline refuses what is not a timeline, in plain words, and changes nothing', async () => {
  await withApp(async ({ json }) => {
    await json('PUT', '/api/timeline', intro());
    const twoSame = intro({
      layers: [{ group: STAGE_LAYER, blocks: [
        { id: 'b1', start: 0, rise: 0, what: { kind: 'dark' } },
        { id: 'b1', start: 5, rise: 0, what: { kind: 'full' } },
      ] }],
    });
    for (const bad of [twoSame, { ...intro(), id: 'Not An Id' }, { name: 'no id' }, intro({ offsetMs: 9000 }), [1, 2]]) {
      const res = await json('PUT', '/api/timeline', bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.match(res.body.error, /^That isn't a timeline/);
    }
    assert.equal((await json('PUT', '/api/timeline', '{not json')).status, 400);
    const show = (await json('GET', '/api/show')).body;
    assert.deepEqual(show.timelines.map((t: any) => [t.id, t.layers[0].blocks.length]), [['intro', 1]]);
  });
});

test('DELETE /api/timeline removes it; its recording can then be removed too', async () => {
  await withApp(async ({ json, app }) => {
    const rec = await fetch(`http://127.0.0.1:${app.port}/api/recordings?name=a.wav`, { method: 'POST', body: new Uint8Array(wav()), headers: { 'content-type': 'audio/wav' } });
    const { id } = await rec.json() as { id: string };
    const recording = { id, name: 'a.wav', duration: 1, loudness: '', peaks: '' };
    assert.equal((await json('PUT', '/api/timeline', intro({ recording }))).status, 200);
    // In use: the recording stays.
    assert.equal((await json('DELETE', `/api/recordings?id=${id}`)).status, 409);
    assert.equal((await json('DELETE', '/api/timeline?id=intro')).status, 200);
    assert.deepEqual((await json('GET', '/api/show')).body.timelines, []);
    assert.equal((await json('DELETE', '/api/timeline?id=intro')).status, 404);
    assert.equal((await json('DELETE', `/api/recordings?id=${id}`)).status, 200);
  });
});

test('timeline saves need the programmer PIN when one is set', async () => {
  await withApp(async ({ json }) => {
    assert.equal((await json('POST', '/api/pin', { next: '2468' })).status, 200);
    const none = { session: false };
    assert.equal((await json('PUT', '/api/timeline', intro(), none)).status, 401);
    assert.equal((await json('DELETE', '/api/timeline?id=intro', undefined, none)).status, 401);
    assert.equal((await json('PUT', '/api/timeline', intro())).status, 200);
    assert.equal((await json('DELETE', '/api/timeline?id=intro', undefined, none)).status, 401);
    assert.equal((await json('GET', '/api/show')).body.timelines.length, 1);
  });
});

test('saving timelines adds no Undo step and keeps one backup, not one per edit', async () => {
  await withApp(async ({ json, dir }) => {
    const backups = () => (existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')).length : 0);
    const first = backups();
    for (let i = 0; i < 5; i++) assert.equal((await json('PUT', '/api/timeline', intro({ name: `Edit ${i}` }))).status, 200);
    assert.ok(backups() <= first + 1, `${backups() - first} backups for five edits`);
    const state = (await json('GET', '/api/state')).body;
    assert.equal(state.canUndo, false);
  });
});

/** A small valid wav: 8 kHz, 16-bit mono, 1 s, a quiet tone. */
function wav(): Buffer {
  const rate = 8000, n = rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 3000), 44 + i * 2);
  return b;
}
