// The fixture library routes list the built-in real lights (the P1 Mini) under their maker, online and offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';

const P1 = 'built-in:portman-lights/p1-mini-led';

/** A stand-in for open-fixture-library.org with two makers; `online` switches the network. */
function fakeOfl() {
  const state = { online: true };
  const fetchFn = (async (input: string | URL | Request) => {
    if (!state.online) throw new TypeError('fetch failed');
    const url = String(input);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/v1/manufacturers')) return ok({ robe: { name: 'Robe', fixtureCount: 11 }, prolights: { name: 'Prolights', fixtureCount: 5 } });
    if (url.endsWith('/api/v1/get-search-results')) return ok([]);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { state, fetchFn };
}

test('Portman is in "Browse by manufacturer" and the search, with or without the internet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-builtins-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { state, fetchFn } = fakeOfl();
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath: join(root, 'server/seed/demo-show.json'), webDir: join(root, 'web'), log: () => {}, fetch: fetchFn });
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`);
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    await app.start();
    // In alphabetical order among the library's makers.
    const makers = (await get('/api/ofl/manufacturers')).body as { key: string; name: string; count: number }[];
    assert.deepEqual(makers.map((m) => [m.name, m.count]), [['Portman Lights', 1], ['Prolights', 5], ['Robe', 11]]);

    const hits = (await get('/api/ofl/manufacturer?key=portman-lights')).body as { key: string; name: string }[];
    assert.deepEqual(hits.map((h) => [h.key, h.name]), [[P1, 'P1 Mini LED']]);

    const found = (await get('/api/ofl/search?q=portman')).body as { hits: { key: string }[] };
    assert.deepEqual(found.hits.map((h) => h.key), [P1]);

    const info = (await get(`/api/ofl/fixture?key=${encodeURIComponent(P1)}`)).body as { manufacturer: string; modes: { name: string; channels: number; profile: string }[] };
    assert.equal(info.manufacturer, 'Portman Lights');
    assert.deepEqual(info.modes.map((m) => m.profile), [
      'portman-p1-mini-simple', 'portman-p1-mini-standard', 'portman-p1-mini-standard-fine', 'portman-p1-mini-pixel', 'portman-p1-mini-pixel-fine',
    ]);

    // Without the internet and no downloaded library, Portman is still there; the library's makers are not.
    state.online = false;
    const offline = new App({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'offline'), seedPath: join(root, 'server/seed/demo-show.json'), webDir: join(root, 'web'), log: () => {}, fetch: fetchFn });
    await offline.start();
    try {
      const at = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${offline.port}${path}`);
        return { status: res.status, body: (await res.json()) as any };
      };
      assert.deepEqual((await at('/api/ofl/manufacturers')).body.map((m: { name: string }) => m.name), ['Portman Lights']);
      assert.deepEqual((await at('/api/ofl/manufacturer?key=portman-lights')).body.map((h: { key: string }) => h.key), [P1]);
      assert.deepEqual((await at('/api/ofl/search?q=p1 mini')).body.hits.map((h: { key: string }) => h.key), [P1]);
      // A library-only maker still says the library can't be reached.
      assert.equal((await at('/api/ofl/manufacturer?key=robe')).status, 502);
    } finally {
      await offline.stop();
    }
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
