import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { OflClient } from '../src/ofl.ts';
import { OFL_ARCHIVE, OFL_LATEST, readTarGz } from '../src/ofldb.ts';

const sonicpulse = JSON.parse(readFileSync(new URL('../../packages/shared/test/ofl/stairville-sonicpulse-led-bar-10.json', import.meta.url), 'utf8'));
const wildwash = JSON.parse(readFileSync(new URL('../../packages/shared/test/ofl/stairville-wild-wash-132-led-rgb-dmx.json', import.meta.url), 'utf8'));

/** A minimal .tar.gz like GitHub's: a pax global header with the commit id, then files. */
function tarGz(files: Record<string, string>, sha: string): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const add = (name: string, body: Buffer, type: string) => {
    blocks.push(header(name, body.length, type), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  };
  const record = `comment=${sha}\n`;
  add('pax_global_header', Buffer.from(`${record.length + 3} ${record}`), 'g');
  for (const [name, text] of Object.entries(files)) add(`open-fixture-library-master/${name}`, Buffer.from(text), '0');
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test('the tar reader finds files and the commit id', () => {
  const { files, comment } = readTarGz(tarGz({ 'fixtures/a/b.json': '{}', 'README.md': 'x' }, 'abc123'), (n) => n.endsWith('.json'));
  assert.equal(comment, 'abc123');
  assert.deepEqual([...files.keys()], ['open-fixture-library-master/fixtures/a/b.json']);
});

test('download, browse and search the whole database, then update it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-ofldb-'));
  const manufacturers = JSON.stringify({ $schema: 'x', stairville: { name: 'Stairville' }, elation: { name: 'Elation' } });
  let archive = tarGz({
    'fixtures/manufacturers.json': manufacturers,
    'fixtures/stairville/sonicpulse-led-bar-10.json': JSON.stringify(sonicpulse),
    'fixtures/stairville/old-par.json': JSON.stringify({ ...wildwash, name: 'Old Par' }),
  }, 'sha-1');
  let latest = 'sha-1';
  let archiveDownloads = 0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === OFL_ARCHIVE) { archiveDownloads++; return new Response(new Uint8Array(archive)); }
    if (url === OFL_LATEST) return Response.json({ sha: latest });
    throw new TypeError('offline');
  }) as typeof fetch;
  const until = async (ofl: OflClient) => { while (ofl.status().downloading) await new Promise((r) => setTimeout(r, 5)); };
  try {
    const ofl = new OflClient(dir, fetchFn);
    assert.equal(ofl.status().installed, false);
    ofl.startDownload();
    await until(ofl);
    let st = ofl.status();
    assert.equal(st.installed, true);
    assert.equal(st.sha, 'sha-1');
    assert.equal(st.fixtures, 2);

    // Everything now works from this computer, even with the network gone.
    assert.deepEqual(await ofl.manufacturerList(), [{ key: 'stairville', name: 'Stairville', count: 2 }]);
    assert.deepEqual((await ofl.manufacturerFixtures('stairville')).map((f) => f.name), ['Old Par', 'SonicPulse LED Bar 10']);
    const found = await ofl.search('stairville sonic');
    assert.equal(found.local, true);
    assert.deepEqual(found.hits.map((h) => h.key), ['stairville/sonicpulse-led-bar-10']);
    assert.equal((await ofl.modes('stairville/sonicpulse-led-bar-10')).modes.length, 5);

    // Same commit on GitHub: nothing is downloaded.
    ofl.startDownload();
    await until(ofl);
    assert.equal(ofl.status().upToDate, true);
    assert.equal(archiveDownloads, 1);

    // A new commit: one fixture changed, one new, one gone. Nothing changes until installed.
    const changed = structuredClone(sonicpulse);
    changed.modes[0].name = '4-channel (fixed)';
    archive = tarGz({
      'fixtures/manufacturers.json': manufacturers,
      'fixtures/stairville/sonicpulse-led-bar-10.json': JSON.stringify(changed),
      'fixtures/elation/sixbar-500.json': JSON.stringify({ ...wildwash, name: 'SixBar 500' }),
    }, 'sha-2');
    latest = 'sha-2';
    ofl.startDownload();
    await until(ofl);
    st = ofl.status((key) => key === 'stairville/sonicpulse-led-bar-10');
    assert.deepEqual(st.update?.added.map((c) => c.name), ['SixBar 500']);
    assert.deepEqual(st.update?.changed.map((c) => [c.name, c.usedInShow]), [['SonicPulse LED Bar 10', true]]);
    assert.deepEqual(st.update?.removed.map((c) => c.name), ['Old Par']);
    assert.equal(st.sha, 'sha-1');
    ofl.installUpdate();
    st = ofl.status();
    assert.equal(st.sha, 'sha-2');
    assert.equal(st.update, null);

    // The database survives a restart.
    const again = new OflClient(dir, fetchFn);
    assert.equal(again.status().fixtures, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
