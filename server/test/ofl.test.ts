import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OflClient } from '../src/ofl.ts';

const sonicpulse = readFileSync(new URL('../../packages/shared/test/ofl/stairville-sonicpulse-led-bar-10.json', import.meta.url), 'utf8');

/** A stand-in for open-fixture-library.org; `online` switches the network on and off. */
function fakeOfl() {
  const state = { online: true, calls: 0 };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    state.calls++;
    if (!state.online) throw new TypeError('fetch failed');
    const url = String(input);
    const ok = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/v1/manufacturers')) return ok(JSON.stringify({ stairville: { name: 'Stairville' } }));
    if (url.endsWith('/api/v1/get-search-results')) {
      const { searchQuery } = JSON.parse(String(init?.body));
      return ok(JSON.stringify(/sonic/i.test(searchQuery) ? ['stairville/sonicpulse-led-bar-10'] : []));
    }
    if (url.endsWith('/stairville/sonicpulse-led-bar-10.json')) return ok(sonicpulse);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { state, fetchFn };
}

test('search, modes and types from the Open Fixture Library, cached for offline use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-ofl-'));
  try {
    const { state, fetchFn } = fakeOfl();
    const ofl = new OflClient(dir, fetchFn);
    const found = await ofl.search('sonic');
    assert.equal(found.offline, false);
    assert.deepEqual(found.hits.map((h) => [h.key, h.manufacturer]), [['stairville/sonicpulse-led-bar-10', 'Stairville']]);

    const info = await ofl.modes('stairville/sonicpulse-led-bar-10');
    assert.equal(info.name, 'SonicPulse LED Bar 10');
    const k = info.modes.find((m) => m.shortName === '39ch')!;
    assert.equal(k.channels, 39);
    assert.deepEqual(k.roles, ['dimmer', 'red', 'green', 'blue', 'white']);

    const profile = await ofl.profile('stairville/sonicpulse-led-bar-10', k.index);
    assert.equal(profile.name, 'Stairville SonicPulse LED Bar 10 (39-channel)');

    // Offline: the downloaded fixture still works, and search falls back to it.
    state.online = false;
    const offline = new OflClient(dir, fetchFn);
    assert.equal((await offline.profile('stairville/sonicpulse-led-bar-10', k.index)).channels.length, 39);
    const again = await offline.search('sonicpulse');
    assert.equal(again.offline, true);
    assert.equal(again.hits[0]?.key, 'stairville/sonicpulse-led-bar-10');
    assert.equal(again.hits[0]?.manufacturer, 'Stairville');

    await assert.rejects(offline.fixture('../etc/passwd'), /not an Open Fixture Library key/);
    await assert.rejects(offline.fixture('stairville/never-downloaded'), /fetch failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
