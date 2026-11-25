// The effect library: the Effects page saves and deletes one effect at a time; the operator page's layout lists them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');

interface Ctx {
  app: App;
  dir: string;
  json: (method: string, path: string, body?: unknown, opts?: { session?: boolean }) => Promise<{ status: number; body: any }>;
}

async function withApp(fn: (c: Ctx) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-fx-'));
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

const wave = (extra: Record<string, unknown> = {}) => ({
  id: 'slow-tide', name: 'Slow tide', favourite: true, songColours: false,
  layer: { kind: 'effect', effect: 'wave', colours: [{ hex: '#2b4dff' }, { hex: '#8f4dff' }], speed: { beats: 8 }, direction: 'ltr' },
  ...extra,
});

test('PUT /api/effect adds an effect, replaces it by id, refuses a second of the same name; DELETE takes it away', async () => {
  await withApp(async ({ app, json }) => {
    const added = await json('PUT', '/api/effect', wave());
    assert.equal(added.status, 200);
    assert.equal(added.body.name, 'Slow tide');
    // Filled in from the schema's defaults.
    assert.equal(added.body.layer.waves, 1);
    let show = (await json('GET', '/api/show')).body;
    assert.deepEqual(show.effects.map((e: any) => e.id), ['slow-tide']);
    const layout = (app as any).layout;
    assert.equal(layout.effects[0].favourite, true);
    assert.deepEqual(layout.effects[0].layer.colours, [{ hex: '#2b4dff' }, { hex: '#8f4dff' }]);

    await json('PUT', '/api/effect', wave({ name: '  Slow tide 2 ', favourite: false }));
    show = (await json('GET', '/api/show')).body;
    assert.deepEqual(show.effects.map((e: any) => [e.id, e.name, e.favourite]), [['slow-tide', 'Slow tide 2', false]]);

    await json('PUT', '/api/effect', wave({ id: 'other', name: 'Other' }));
    const clash = await json('PUT', '/api/effect', wave({ id: 'third', name: 'slow TIDE 2' }));
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /already an effect called/);
    assert.equal((await json('PUT', '/api/effect', wave({ name: '   ' }))).status, 400);
    assert.equal((await json('PUT', '/api/effect', { ...wave(), layer: { kind: 'effect' } })).status, 400);

    assert.equal((await json('DELETE', '/api/effect?id=slow-tide')).status, 200);
    show = (await json('GET', '/api/show')).body;
    assert.deepEqual(show.effects.map((e: any) => e.id), ['other']);
    assert.equal((await json('DELETE', '/api/effect?id=slow-tide')).status, 404);
  });
});
