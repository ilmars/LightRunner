import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, type AppOptions } from '../src/app.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');

/** A small valid wav: 8 kHz, 16-bit mono, `seconds` long, a quiet tone. */
function wav(seconds = 1): Buffer {
  const rate = 8000;
  const n = rate * seconds;
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

async function withApp(fn: (c: Ctx) => Promise<void>, extra: Partial<AppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-rec-'));
  const app = new App({ port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' }, log: () => {}, ...extra });
  let cookie = '';
  const raw = (method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; session?: boolean } = {}) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method,
      headers: { ...(init.session !== false && cookie ? { cookie } : {}), ...init.headers },
      body: init.body,
    });
  const ctx: Ctx = {
    app, dir, raw,
    async json(method, path, body) {
      const res = await raw(method, path, { body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async upload(name, data, type = 'audio/wav') {
      const res = await raw('POST', `/api/recordings?name=${encodeURIComponent(name)}`, { body: new Uint8Array(data), headers: { 'content-type': type } });
      return { status: res.status, body: await res.json() as any };
    },
  };
  try {
    await app.start();
    await fn(ctx);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Ctx {
  app: App;
  dir: string;
  raw: (method: string, path: string, init?: { body?: BodyInit; headers?: Record<string, string>; session?: boolean }) => Promise<Response>;
  json: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  upload: (name: string, data: Buffer, type?: string) => Promise<{ status: number; body: any }>;
}

const files = (dir: string) => (existsSync(join(dir, 'recordings')) ? readdirSync(join(dir, 'recordings')).sort() : []);

test('a recording is uploaded, listed and read back whole', async () => {
  await withApp(async ({ json, raw, upload, dir }) => {
    const data = wav(1);
    const up = await upload('Christmas opening.wav', data);
    assert.equal(up.status, 200);
    assert.match(up.body.id, /^[0-9a-f]{16}$/);
    assert.equal(up.body.name, 'Christmas opening.wav');
    assert.equal(up.body.size, data.length);
    // Kept in the data folder, no temporary file left beside it.
    assert.ok(files(dir).includes(`${up.body.id}.wav`));
    assert.ok(files(dir).every((f) => !f.endsWith('.upload')));

    const list = await json('GET', '/api/recordings');
    assert.deepEqual(list.body, [{ id: up.body.id, name: 'Christmas opening.wav', size: data.length }]);

    const res = await raw('GET', `/api/recordings/file?id=${up.body.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('content-length'), String(data.length));
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(data));
  });
});

test('the other types are kept under their own extension and type (by name, or by type when the name has none)', async () => {
  await withApp(async ({ upload, raw, dir }) => {
    const cases: [string, string, string, string][] = [
      ['a.mp3', 'application/octet-stream', 'mp3', 'audio/mpeg'],
      ['a.M4A', 'application/octet-stream', 'm4a', 'audio/mp4'],
      ['a.aac', 'application/octet-stream', 'aac', 'audio/aac'],
      ['voice', 'audio/mpeg', 'mp3', 'audio/mpeg'],
      ['voice', 'audio/x-m4a', 'm4a', 'audio/mp4'],
    ];
    for (const [name, type, ext, mime] of cases) {
      const up = await upload(name, Buffer.from('some audio bytes'), type);
      assert.equal(up.status, 200, name);
      assert.ok(files(dir).includes(`${up.body.id}.${ext}`), `${name}: ${files(dir)}`);
      assert.equal((await raw('GET', `/api/recordings/file?id=${up.body.id}`)).headers.get('content-type'), mime);
    }
  });
});

test('a range is answered with 206 and the right bytes, an open range too', async () => {
  await withApp(async ({ upload, raw }) => {
    const data = wav(1);
    const { body } = await upload('a.wav', data);
    const url = `/api/recordings/file?id=${body.id}`;

    const first = await raw('GET', url, { headers: { range: 'bytes=0-99' } });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get('content-range'), `bytes 0-99/${data.length}`);
    assert.equal(first.headers.get('content-length'), '100');
    assert.equal(first.headers.get('accept-ranges'), 'bytes');
    const got = Buffer.from(await first.arrayBuffer());
    assert.equal(got.length, 100);
    assert.ok(got.equals(data.subarray(0, 100)));

    const rest = await raw('GET', url, { headers: { range: 'bytes=100-' } });
    assert.equal(rest.status, 206);
    assert.equal(rest.headers.get('content-range'), `bytes 100-${data.length - 1}/${data.length}`);
    assert.ok(Buffer.from(await rest.arrayBuffer()).equals(data.subarray(100)));

    // The last 50 bytes; an end past the file is cut back to it.
    const tail = await raw('GET', url, { headers: { range: 'bytes=-50' } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-range'), `bytes ${data.length - 50}-${data.length - 1}/${data.length}`);
    assert.ok(Buffer.from(await tail.arrayBuffer()).equals(data.subarray(data.length - 50)));
    const over = await raw('GET', url, { headers: { range: `bytes=${data.length - 10}-${data.length + 999}` } });
    assert.equal(over.status, 206);
    assert.equal(over.headers.get('content-range'), `bytes ${data.length - 10}-${data.length - 1}/${data.length}`);
    await over.arrayBuffer();
  });
});

test('a range that cannot be met is 416', async () => {
  await withApp(async ({ upload, raw }) => {
    const data = wav(1);
    const { body } = await upload('a.wav', data);
    const url = `/api/recordings/file?id=${body.id}`;
    for (const range of [`bytes=${data.length}-`, `bytes=${data.length + 5}-${data.length + 9}`, 'bytes=50-10', 'bytes=abc', 'bytes=-', 'bytes=0-1,5-9', 'pages=1-2']) {
      const res = await raw('GET', url, { headers: { range } });
      assert.equal(res.status, 416, range);
      assert.equal(res.headers.get('content-range'), `bytes */${data.length}`, range);
      await res.arrayBuffer();
    }
  });
});

test('a recording over the limit is refused with 413 and nothing is left half-saved', async () => {
  await withApp(async ({ upload, json, dir }) => {
    const small = await upload('ok.wav', wav(1));
    assert.equal(small.status, 200);
    const big = await upload('big.wav', Buffer.alloc(40_000, 1));
    assert.equal(big.status, 413);
    assert.match(big.body.error, /too big|up to/i);
    // Only the first recording and the index remain.
    assert.deepEqual(files(dir).filter((f) => f !== 'index.json'), [`${small.body.id}.wav`]);
    assert.deepEqual((await json('GET', '/api/recordings')).body.map((r: any) => r.id), [small.body.id]);
  }, { recordingLimit: 20_000 });
  // Exactly the limit is fine.
  await withApp(async ({ upload }) => {
    assert.equal((await upload('edge.wav', Buffer.alloc(1000, 1))).status, 200);
    assert.equal((await upload('edge.wav', Buffer.alloc(1001, 1))).status, 413);
  }, { recordingLimit: 1000 });
});

test('another kind of file is refused with 415, and an empty one with 400', async () => {
  await withApp(async ({ upload, json, dir }) => {
    for (const [name, type] of [['notes.txt', 'text/plain'], ['movie.mp4', 'video/mp4'], ['voice', 'application/octet-stream'], ['../../x.exe', 'application/octet-stream']] as const) {
      const r = await upload(name, wav(1), type);
      assert.equal(r.status, 415, name);
      assert.equal(r.body.error, 'Light Runner plays mp3, m4a, aac or wav recordings.');
    }
    const empty = await upload('empty.wav', Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /empty/i);
    assert.deepEqual(files(dir).filter((f) => f !== 'index.json'), []);
    assert.deepEqual((await json('GET', '/api/recordings')).body, []);
  });
});

test('an unused recording is deleted; one a timeline uses is kept (409)', async () => {
  await withApp(async ({ json, upload, raw, dir }) => {
    const spare = (await upload('spare.wav', wav(1))).body;
    const used = (await upload('used.wav', wav(1))).body;

    // A timeline in the show refers to `used`.
    const show = (await json('GET', '/api/show')).body;
    const timeline = {
      id: 'xmas', name: 'Christmas', markers: [], offsetMs: 0, layers: [],
      recording: { id: used.id, name: used.name, duration: 1, loudness: '', peaks: '' },
    };
    const put = await json('PUT', '/api/show', { ...show, timelines: [timeline] });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const refused = await json('DELETE', `/api/recordings?id=${used.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /timeline/i);
    assert.ok(files(dir).includes(`${used.id}.wav`));
    assert.equal((await raw('GET', `/api/recordings/file?id=${used.id}`)).status, 200);

    assert.equal((await json('DELETE', `/api/recordings?id=${spare.id}`)).status, 200);
    assert.ok(!files(dir).includes(`${spare.id}.wav`));
    assert.deepEqual((await json('GET', '/api/recordings')).body.map((r: any) => r.id), [used.id]);
    assert.equal((await raw('GET', `/api/recordings/file?id=${spare.id}`)).status, 404);
    assert.equal((await json('DELETE', `/api/recordings?id=${spare.id}`)).status, 404);

    // Once the timeline lets go of it, it can go.
    assert.equal((await json('PUT', '/api/show', { ...show, timelines: [] })).status, 200);
    assert.equal((await json('DELETE', `/api/recordings?id=${used.id}`)).status, 200);
    assert.deepEqual((await json('GET', '/api/recordings')).body, []);
  });
});

test('an id that is not one of ours never reaches another file', async () => {
  await withApp(async ({ raw, json }) => {
    for (const id of ['../show.json', '..%2Fshow.json', 'index.json', 'a.wav', '0123456789abcdef.wav', '0123456789abcdef.exe', '']) {
      assert.equal((await raw('GET', `/api/recordings/file?id=${id}`)).status, 404, id);
      assert.equal((await json('DELETE', `/api/recordings?id=${id}`)).status, 404, id);
    }
    assert.equal((await raw('GET', '/api/recordings/file')).status, 404);
  });
});

test('with a PIN set, every recordings route needs the programmer session', async () => {
  await withApp(async ({ json, upload, raw }) => {
    const { body } = await upload('a.wav', wav(1));
    assert.equal((await json('POST', '/api/pin', { next: '2468' })).status, 200);
    const url = `/api/recordings/file?id=${body.id}`;
    const none = { session: false };
    assert.equal((await raw('GET', '/api/recordings', none)).status, 401);
    assert.equal((await raw('POST', '/api/recordings?name=b.wav', { ...none, body: new Uint8Array(wav(1)) })).status, 401);
    assert.equal((await raw('GET', url, none)).status, 401);
    assert.equal((await raw('GET', url, { ...none, headers: { range: 'bytes=0-9' } })).status, 401);
    assert.equal((await raw('DELETE', `/api/recordings?id=${body.id}`, none)).status, 401);
    // The session that set the PIN stays in, so the page's audio element (same origin, with its cookie) can read.
    assert.equal((await raw('GET', url, { headers: { range: 'bytes=0-9' } })).status, 206);
    assert.equal((await json('GET', '/api/recordings')).body.length, 1);
  });
});

/** A POST by hand, for what fetch won't do: no Content-Length, a Content-Length that lies, a client that goes away. */
function post(app: App, path: string, chunks: Buffer[], headers: Record<string, string | number> = {}, { abort = false, hold = false } = {}) {
  return new Promise<{ status: number; connection: string | undefined; body: any } | 'aborted'>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: app.port, path, method: 'POST', headers: { 'content-type': 'audio/wav', ...headers } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode!, connection: res.headers.connection, body: JSON.parse(Buffer.concat(parts).toString() || 'null') });
        if (hold) req.destroy();
      });
    });
    let answered = false;
    req.on('response', () => { answered = true; });
    // The server may close on us after it has answered: that is fine.
    req.on('error', (err) => { if (abort) resolve('aborted'); else if (!answered) reject(err); });
    (async () => {
      for (const c of chunks) {
        req.write(c);
        await new Promise((r) => setTimeout(r, 5));
      }
      if (abort) req.destroy();
      else if (!hold) req.end();
    })();
  });
}

const waitUntil = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), 'timed out');
};

test('a write error (disk full) answers 507 at once and leaves nothing behind', async () => {
  const logs: string[] = [];
  await withApp(async ({ upload, json, dir }) => {
    const r = await Promise.race([
      upload('big.wav', Buffer.alloc(300_000, 1)),
      new Promise<never>((_, no) => setTimeout(() => no(new Error('the upload hung')), 5000)),
    ]);
    assert.equal(r.status, 507);
    assert.match(r.body.error, /disk is full/);
    assert.deepEqual(files(dir).filter((f) => f !== 'index.json'), []);
    assert.deepEqual((await json('GET', '/api/recordings')).body, []);
    assert.ok(!logs.some((l) => /HTTP error/.test(l)), logs.join('\n'));
  }, {
    log: (m) => logs.push(m),
    // The file exists (it is made when the upload starts) and the second write fails.
    recordingWriter: (path) => {
      writeFileSync(path, '');
      let writes = 0;
      return new Writable({
        write(_chunk, _enc, cb) {
          cb(++writes > 1 ? Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) : null);
        },
      });
    },
  });
});

test('the recordings folder has a total cap, counted before the upload is taken', async () => {
  await withApp(async ({ upload, json, dir, app }) => {
    const a = await upload('a.wav', Buffer.alloc(15_000, 1));
    const b = await upload('b.wav', Buffer.alloc(15_000, 1));
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    // Full to the brim: even one more byte (said up front by Content-Length) is refused.
    const c1 = await upload('c.wav', Buffer.alloc(1, 1));
    assert.equal(c1.status, 413);
    assert.match(c1.body.error, /Recordings take more than .* on the Mac: delete one first/);
    // Without a Content-Length it is found while it comes in, and nothing is kept.
    const chunked = await post(app, '/api/recordings?name=d.wav', [Buffer.alloc(5000, 1), Buffer.alloc(5000, 1)]);
    assert.ok(chunked !== 'aborted');
    assert.equal(chunked.status, 413);
    assert.match(chunked.body.error, /delete one first/);
    assert.deepEqual(files(dir).filter((f) => f !== 'index.json').sort(), [`${a.body.id}.wav`, `${b.body.id}.wav`].sort());
    // Deleting one makes room.
    assert.equal((await json('DELETE', `/api/recordings?id=${a.body.id}`)).status, 200);
    assert.equal((await upload('e.wav', Buffer.alloc(15_000, 1))).status, 200);
  }, { recordingLimit: 20_000, recordingsTotal: 30_000 });
});

test('a Content-Length over the limit is refused before the body comes, and the connection is closed', async () => {
  await withApp(async ({ app, dir }) => {
    // Says 5 MB, sends 100 bytes, and waits: the answer must not wait for the rest.
    const r = await Promise.race([
      post(app, '/api/recordings?name=a.wav', [Buffer.alloc(100, 1)], { 'content-length': 5_000_000 }, { hold: true }),
      new Promise<never>((_, no) => setTimeout(() => no(new Error('no answer')), 3000)),
    ]);
    assert.ok(r !== 'aborted');
    assert.equal(r.status, 413);
    assert.equal(r.connection, 'close');
    assert.deepEqual(files(dir).filter((f) => f !== 'index.json'), []);
  }, { recordingLimit: 20_000 });
});

test('an upload far over the limit is cut off with 413 and the connection closed', async () => {
  await withApp(async ({ app, dir }) => {
    // No Content-Length (chunked): 5 x the limit is more than the 2 x the server is willing to read.
    const chunks = Array.from({ length: 50 }, () => Buffer.alloc(2000, 1));
    const r = await post(app, '/api/recordings?name=a.wav', chunks);
    assert.ok(r !== 'aborted');
    assert.equal(r.status, 413);
    assert.equal(r.connection, 'close');
    assert.deepEqual(files(dir).filter((f) => f !== 'index.json'), []);
  }, { recordingLimit: 20_000 });
});

test('a client that goes away mid-upload leaves nothing behind and nothing in the log', async () => {
  const logs: string[] = [];
  await withApp(async ({ app, dir, upload }) => {
    // Promises 1 MB, sends some, and is gone.
    const r = await post(app, '/api/recordings?name=a.wav', [Buffer.alloc(8000, 1), Buffer.alloc(8000, 1)], { 'content-length': 1_000_000 }, { abort: true });
    assert.equal(r, 'aborted');
    await waitUntil(() => files(dir).filter((f) => f !== 'index.json').length === 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!logs.some((l) => /HTTP error/.test(l)), logs.join('\n'));
    // The server is fine.
    assert.equal((await upload('b.wav', wav(1))).status, 200);
  }, { log: (m) => logs.push(m) });
});

test('the file route says nosniff and has an ETag', async () => {
  await withApp(async ({ upload, raw }) => {
    const { body } = await upload('a.wav', wav(1));
    for (const range of [undefined, 'bytes=0-9']) {
      const res = await raw('GET', `/api/recordings/file?id=${body.id}`, { headers: range ? { range } : {} });
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('etag'), `"${body.id}"`);
      await res.arrayBuffer();
    }
    // A player that already has it is told so.
    const again = await raw('GET', `/api/recordings/file?id=${body.id}`, { headers: { 'if-none-match': `"${body.id}"` } });
    assert.equal(again.status, 304);
  });
});
