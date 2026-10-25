// A Patch page left open while the show changes somewhere else (an import, the iPad) must not put back its old copy
// when it saves. Seen on 2026-10-25: a Patch save after an import took away 22 looks and 58 presets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';
import { parseShow, type Show } from '../../packages/shared/src/index.ts';
import { rebasePatch } from '../../web/patch/rebase.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const seed = (): Show => parseShow(JSON.parse(readFileSync(seedPath, 'utf8')));

type Call = (method: string, path: string, body?: unknown, revision?: string) => Promise<{ status: number; body: any; revision?: string }>;

async function withApp(fn: (call: Call, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-patch-save-'));
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {} });
  const call: Call = async (method, path, body, revision) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(revision !== undefined ? { 'x-show-revision': revision } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), revision: res.headers.get('x-show-revision') ?? undefined };
  };
  try {
    await app.start();
    await fn(call, dir);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compare with a file, taking one new look (and its new preset) from it, as Settings does. */
async function importLook(call: Call): Promise<void> {
  const incoming = structuredClone((await call('GET', '/api/show')).body);
  incoming.presets.push({ id: 'front-imported', name: 'Imported', group: 'front-wash', fade: 2, swatch: '#00ff00', layers: [{ kind: 'static', colour: { hex: '#00ff00' }, intensity: 1 }] });
  incoming.looks.push({ id: 'imported', name: 'Imported look', swatch: '#00ff00', groups: [{ group: 'front-wash', preset: 'front-imported' }] });
  const preview = await call('POST', '/api/import/preview', incoming);
  assert.equal(preview.status, 200);
  const picks = preview.body.items.filter((i: any) => i.change === 'added');
  assert.deepEqual(picks.map((i: any) => i.id).sort(), ['front-imported', 'imported']);
  assert.equal((await call('POST', '/api/import/apply', { token: preview.body.token, picks })).status, 200);
}

const backups = async (call: Call): Promise<string[]> => (await call('GET', '/api/backups')).body.map((b: any) => b.name);

test('a Patch save from a copy older than an import is refused, and nothing is lost', async () => {
  await withApp(async (call) => {
    // The Patch page opens.
    const opened = await call('GET', '/api/show');
    assert.ok(opened.revision, 'GET /api/show says which revision it is');
    const base = opened.body;
    // Meanwhile, Settings › Compare with a file takes a new look.
    await importLook(call);
    // The page moves one fixture and saves its old copy.
    const mine = structuredClone(base);
    mine.fixtures[0].x = 0.123;
    const refused = await call('PUT', '/api/show?source=patch', mine, opened.revision);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /changed somewhere else/);
    let live = (await call('GET', '/api/show')).body;
    assert.ok(live.looks.some((l: any) => l.id === 'imported'), 'the imported look is still there');
    assert.ok(live.presets.some((p: any) => p.id === 'front-imported'), 'and its preset');
    assert.notEqual(live.fixtures[0].x, 0.123);

    // The page loads the show again with its change on top, and saves that.
    const fresh = await call('GET', '/api/show');
    const saved = await call('PUT', '/api/show?source=patch', rebasePatch(base, mine, fresh.body), fresh.revision);
    assert.equal(saved.status, 200);
    live = (await call('GET', '/api/show')).body;
    assert.equal(live.fixtures[0].x, 0.123);
    assert.ok(live.looks.some((l: any) => l.id === 'imported'));
    assert.ok(live.presets.some((p: any) => p.id === 'front-imported'));
    assert.equal(saved.revision, (await call('GET', '/api/show')).revision, 'the save says the new revision');
  });
});

test('a Patch save with no revision (a page from an older version) is refused', async () => {
  await withApp(async (call) => {
    const show = (await call('GET', '/api/show')).body;
    assert.equal((await call('PUT', '/api/show?source=patch', show)).status, 409);
    assert.equal((await call('PUT', '/api/show?source=patch', show, 'not-a-revision')).status, 409);
  });
});

test('Settings and controller changes leave the revision as it is: Patch keeps the live ones anyway', async () => {
  await withApp(async (call) => {
    const opened = await call('GET', '/api/show');
    assert.equal((await call('PUT', '/api/settings', { contact: { name: 'Jānis', phone: '' } })).status, 200);
    assert.equal((await call('PUT', '/api/controller', { apcLayout: false })).status, 200);
    assert.equal((await call('GET', '/api/show')).revision, opened.revision);
    // A look edited elsewhere does change it.
    await importLook(call);
    assert.notEqual((await call('GET', '/api/show')).revision, opened.revision);
  });
});

test('opening a show file replaces the show without a revision, and checks one that is sent', async () => {
  await withApp(async (call) => {
    const opened = await call('GET', '/api/show');
    await importLook(call);
    const file = { ...opened.body, name: 'From a file' };
    assert.equal((await call('PUT', '/api/show', file, opened.revision)).status, 409);
    assert.equal((await call('PUT', '/api/show', file)).status, 200);
    assert.equal((await call('GET', '/api/settings')).body.showName, 'From a file');
  });
});

test('every save that replaces the show keeps a backup of the show before it', async () => {
  await withApp(async (call, dir) => {
    const backedUp = async (save: () => Promise<number>, what: string) => {
      const before = await backups(call);
      const showBefore = readFileSync(join(dir, 'show.json'), 'utf8');
      assert.equal(await save(), 200, what);
      const after = await backups(call);
      assert.equal(after.length, before.length + 1, `${what} keeps a backup`);
      assert.equal(readFileSync(join(dir, 'backups', after[0]), 'utf8'), showBefore, `${what}: the backup is the show before it`);
    };
    await backedUp(async () => {
      const preview = await call('POST', '/api/import/preview', { ...seed(), looks: [...seed().looks, { id: 'extra', name: 'Extra', groups: [] }] });
      return (await call('POST', '/api/import/apply', { token: preview.body.token, picks: [{ kind: 'look', id: 'extra', change: 'added' }] })).status;
    }, 'Compare with a file');
    await backedUp(async () => {
      const { body, revision } = await call('GET', '/api/show');
      body.fixtures[0].name = 'Moved';
      return (await call('PUT', '/api/show?source=patch', body, revision)).status;
    }, 'a Patch save');
    await backedUp(async () => (await call('PUT', '/api/show', { ...seed(), name: 'Opened' })).status, 'opening a show file');
    const [newest] = await backups(call);
    await backedUp(async () => (await call('POST', '/api/backups/restore', { name: newest })).status, 'restoring a backup');
  });
});

// ---- Doing the page's changes again on a newer show (web/patch/rebase.js) ----

test('rebasePatch keeps the newer show and does again what the page changed', () => {
  const base = seed();
  const fresh = structuredClone(base);
  fresh.looks.push({ id: 'new-look', name: 'New look', groups: [{ group: 'pulpit', preset: 'pulpit-on' }] });
  fresh.operator.quickLooks = [{ look: 'new-look', tab: 'plain' }];
  fresh.fixtures.find((f) => f.id === 'pulpit')!.name = 'Pulpit (renamed elsewhere)';

  const mine = structuredClone(base);
  mine.fixtures.find((f) => f.id === 'back-1')!.address = 400;
  mine.profiles.push({ id: 'my-type', name: 'My type', channels: [{ role: 'dimmer' }] });
  mine.fixtures.push({ id: 'smoke-1', name: 'Smoke', profile: 'my-type', universe: 0, address: 500, x: 0.5, y: 0.5 });
  mine.groups.push({ id: 'smoke', name: 'Smoke', kind: 'smoke', fixtures: ['smoke-1'] });
  mine.operator.groups.push('smoke');

  const out = rebasePatch(base, mine, fresh);
  assert.ok(out.looks.some((l) => l.id === 'new-look'), "the newer show's look stays");
  assert.deepEqual(out.operator.quickLooks, fresh.operator.quickLooks);
  assert.equal(out.fixtures.find((f) => f.id === 'pulpit')!.name, 'Pulpit (renamed elsewhere)', 'a fixture this page left alone is the newer one');
  assert.equal(out.fixtures.find((f) => f.id === 'back-1')!.address, 400);
  assert.ok(out.profiles.some((p) => p.id === 'my-type'));
  assert.deepEqual(out.groups.find((g) => g.id === 'smoke')?.fixtures, ['smoke-1']);
  assert.ok(out.operator.groups.includes('smoke'));
  parseShow(out);
});

test('rebasePatch: a group or fixture deleted on the page goes from the newer show, with what depends on it', () => {
  const base = seed();
  const fresh = structuredClone(base);
  // Elsewhere: a look that uses the pulpit, and a new group with back-1 in it.
  fresh.looks.push({ id: 'pulpit-look', name: 'Pulpit look', groups: [{ group: 'pulpit', preset: 'pulpit-on' }, { group: 'back-wall', preset: 'back-amber' }] });
  fresh.groups.push({ id: 'back-left', name: 'Back left', kind: 'light', fixtures: ['back-1', 'back-2'] });

  const mine = structuredClone(base);
  // On the page: the pulpit group deleted (as the Delete group button does), and fixture back-1 deleted.
  mine.groups = mine.groups.filter((g) => g.id !== 'pulpit');
  mine.presets = mine.presets.filter((p) => p.group !== 'pulpit');
  for (const l of mine.looks) l.groups = l.groups.filter((e) => e.group !== 'pulpit');
  mine.operator.groups = mine.operator.groups.filter((id) => id !== 'pulpit');
  mine.fixtures = mine.fixtures.filter((f) => f.id !== 'back-1');
  for (const g of mine.groups) g.fixtures = g.fixtures.filter((id) => id !== 'back-1');

  const out = rebasePatch(base, mine, fresh);
  assert.ok(!out.groups.some((g) => g.id === 'pulpit'));
  assert.ok(!out.presets.some((p) => p.group === 'pulpit'));
  assert.deepEqual(out.looks.find((l) => l.id === 'pulpit-look')?.groups, [{ group: 'back-wall', preset: 'back-amber' }], "the newer show's look keeps its other groups");
  assert.ok(!out.operator.groups.includes('pulpit'));
  assert.ok(!out.fixtures.some((f) => f.id === 'back-1'));
  assert.deepEqual(out.groups.find((g) => g.id === 'back-left')?.fixtures, ['back-2'], "the newer show's group loses the deleted fixture");
  parseShow(out);
});

test('rebasePatch keeps a type deleted on the page that a fixture in the newer show uses', () => {
  const base = seed();
  base.profiles.push({ id: 'spare', name: 'Spare', channels: [{ role: 'dimmer' }] });
  const fresh = structuredClone(base);
  fresh.fixtures.push({ id: 'imported', name: 'Imported', profile: 'spare', universe: 0, address: 510, x: 0.5, y: 0.5 });
  const mine = structuredClone(base);
  mine.profiles = mine.profiles.filter((p) => p.id !== 'spare');
  const out = rebasePatch(base, mine, fresh);
  assert.ok(out.profiles.some((p) => p.id === 'spare'));
  parseShow(out);
});
