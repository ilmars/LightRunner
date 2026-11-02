import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningClient, PlanningError } from '../src/planning/client.ts';

// Made-up values only: nothing here is a real cookie or token.
const COOKIE = 'made-up-refresh-1';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const TYPE = '22222222-2222-4222-8222-222222222222';
const OTHER_TYPE = '33333333-3333-4333-8333-333333333333';
const SONG = '44444444-4444-4444-8444-444444444444';
const DB = 'projects/made-up-project/databases/(default)';
const FS = `https://firestore.googleapis.com/v1/${DB}/documents`;

/** Plain JSON as a Firestore REST value. */
function enc(v: any): any {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
const fsDoc = (name: string, plain: Record<string, unknown>) => ({ name: `${DB}/documents/${name}`, fields: enc(plain).mapValue.fields });

/** A cue list document the way the planning service stores one. */
function cuelist(id: string, start: string | null, type = TYPE, cues: unknown[] = []) {
  return fsDoc(`accounts/${ACCOUNT}/cuelists/${id}`, {
    name: 'Sunday',
    mod: start ?? '',
    service: { type, times: start ? [{ time: start }] : [] },
    data: { cues },
  });
}

/** A stand-in for the planning service, the sign-in and the document store, answering by URL. */
function fakePlanning(options: { cuelists?: ReturnType<typeof cuelist>[]; cues?: unknown[] } = {}) {
  const state = {
    accepted: new Set([COOKIE]),
    /** Hands out this refresh cookie in every refresh answer. */
    rotateTo: null as string | null,
    refreshes: 0,
    refreshCookies: [] as string[],
    tokens: 0,
    /** Every api answer says 401 once. */
    expireOnce: false,
    queryRefusedWhenFiltered: false,
    queries: [] as any[],
    cuelists: options.cuelists ?? [],
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url === 'https://planning.worshiptools.com/auth/refresh') {
      state.refreshes++;
      const cookie = /weAuthRefresh=([^;]*)/.exec(headers.Cookie ?? '')?.[1] ?? '';
      state.refreshCookies.push(cookie);
      if (!state.accepted.has(cookie)) return new Response(null, { status: 302, headers: { location: '/login' } });
      state.tokens++;
      const out = new Headers();
      out.append('set-cookie', `weAuthToken=made-up-token-${state.tokens}; Path=/; HttpOnly`);
      if (state.rotateTo) out.append('set-cookie', `weAuthRefresh=${state.rotateTo}; Path=/; HttpOnly`);
      return new Response(null, { status: 200, headers: out });
    }
    if (url.startsWith('https://api.worship.tools/v1/')) {
      if (!/^Bearer made-up-token-\d+$/.test(headers.Authorization ?? '')) return new Response('no', { status: 401 });
      if (state.expireOnce) {
        state.expireOnce = false;
        return new Response('expired', { status: 401 });
      }
      const path = url.slice('https://api.worship.tools/v1'.length);
      if (path === '/config/firebase') return json({ apiKey: 'made-up-key', projectId: 'made-up-project' });
      if (path === '/firebase/token') return json({ token: 'made-up-custom-token' });
      if (path === '/account') return json([{ id: ACCOUNT, name: 'Church' }]);
      if (path === `/account/${ACCOUNT}/meta/service-types`) {
        return json([
          { id: TYPE, name: 'Riga Sunday' },
          { id: OTHER_TYPE, name: 'Old type', archived: true },
        ]);
      }
      return new Response('not found', { status: 404 });
    }
    if (url.startsWith('https://identitytoolkit.googleapis.com/')) return json({ idToken: 'made-up-id-token' });
    if (url.startsWith(FS)) {
      if (headers.Authorization !== 'Bearer made-up-id-token') return new Response('no', { status: 401 });
      const path = url.slice(FS.length);
      if (path === `/accounts/${ACCOUNT}:runQuery`) {
        const query = JSON.parse(String(init?.body)).structuredQuery;
        state.queries.push(query);
        if (query.where && state.queryRefusedWhenFiltered) return new Response('{"error":{"status":"FAILED_PRECONDITION"}}', { status: 400 });
        let found = state.cuelists;
        if (query.where) found = found.filter((d) => d.fields.service.mapValue.fields.type.stringValue === query.where.fieldFilter.value.stringValue);
        if (query.limit) found = found.slice(0, query.limit);
        return json(found.length ? found.map((document) => ({ document })) : [{ readTime: 'now' }]);
      }
      if (path === ':batchGet') {
        const names: string[] = JSON.parse(String(init?.body)).documents;
        return json(
          names.map((name) =>
            name.endsWith(`/songs/${SONG}`)
              ? { found: fsDoc(`accounts/${ACCOUNT}/songs/${SONG}`, { name: 'Klints uz muziem', data: { tempo: 72 } }) }
              : { missing: name },
          ),
        );
      }
      const doc = state.cuelists.find((d) => path === `/${d.name.split('/documents/')[1]}`);
      return doc ? json(doc) : new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { state, fetchFn };
}

function withClient(run: (c: PlanningClient, loginFile: string, fake: ReturnType<typeof fakePlanning>, log: string[]) => Promise<void>, options?: Parameters<typeof fakePlanning>[0]) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'light-runner-planning-'));
    try {
      const fake = fakePlanning(options);
      const log: string[] = [];
      const loginFile = join(dir, 'data', 'planning-login.json');
      await run(new PlanningClient({ loginFile, fetch: fake.fetchFn, log: (l) => log.push(l) }), loginFile, fake, log);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('setLogin keeps the cookie owner-only and never in the show', withClient(async (client, loginFile, fake, log) => {
  assert.equal(client.loggedIn(), false);
  await client.setLogin(`weAuthRefresh=${COOKIE}`);
  assert.equal(client.loggedIn(), true);
  assert.deepEqual(fake.state.refreshCookies, [COOKIE]);
  const saved = JSON.parse(readFileSync(loginFile, 'utf8'));
  assert.equal(saved.refresh, COOKIE);
  assert.equal(saved.machineId, client.machineId());
  assert.match(saved.machineId, /^[A-Z0-9]{4,}$/);
  if (process.platform !== 'win32') assert.equal(statSync(loginFile).mode & 0o777, 0o600);
  assert.ok(!log.join('\n').includes(COOKIE));
  // The bare value works too, and a login that is refused leaves the saved one alone.
  await client.setLogin(COOKIE);
  await assert.rejects(client.setLogin('made-up-wrong'), (e) => e instanceof PlanningError && /not accepted/.test(e.message));
  assert.equal(JSON.parse(readFileSync(loginFile, 'utf8')).refresh, COOKIE);
  await assert.rejects(client.setLogin('  '), PlanningError);
}));

test('a rotated cookie from the refresh is kept', withClient(async (client, loginFile, fake) => {
  await client.setLogin(COOKIE);
  fake.state.rotateTo = 'made-up-refresh-2';
  fake.state.accepted.add('made-up-refresh-2');
  // A new token is needed only when the first one has expired; make the api say so.
  fake.state.expireOnce = true;
  assert.deepEqual(await client.accounts(), [{ id: ACCOUNT, name: 'Church' }]);
  assert.equal(JSON.parse(readFileSync(loginFile, 'utf8')).refresh, 'made-up-refresh-2');
  assert.equal(fake.state.refreshCookies.at(-1), COOKIE);
  assert.equal(fake.state.tokens, 2); // renewed once, on the 401
}));

test('a refused refresh says the login has run out', withClient(async (client, _loginFile, fake) => {
  await client.setLogin(COOKIE);
  fake.state.accepted.clear();
  fake.state.expireOnce = true;
  await assert.rejects(client.accounts(), (e) => e instanceof PlanningError && e.message === 'The planning login has run out. Paste a new one in Settings.');
}));

test('the token is reused until it is refused', withClient(async (client, _loginFile, fake) => {
  await client.setLogin(COOKIE);
  await client.accounts();
  await client.accounts();
  assert.equal(fake.state.refreshes, 1);
  // Without a login there is nothing to ask for.
  const bare = new PlanningClient({ loginFile: join(tmpdir(), 'light-runner-planning-nothing', 'x.json'), fetch: fake.fetchFn });
  await assert.rejects(bare.accounts(), /run out|Paste/);
}));

test('serviceTypes leaves archived ones out', withClient(async (client) => {
  await client.setLogin(COOKIE);
  assert.deepEqual(await client.serviceTypes(ACCOUNT), [{ id: TYPE, name: 'Riga Sunday' }]);
}));

test('service() turns the document and its songs into a planned service', withClient(async (client) => {
  await client.setLogin(COOKIE);
  const planned = await client.service(ACCOUNT, 'svc-1');
  assert.equal(planned.id, 'svc-1');
  assert.equal(planned.title, 'Riga Sunday');
  assert.equal(planned.start, '2026-10-25T08:00:00');
  assert.deepEqual(planned.items, [
    { key: 'c1', kind: 'header', name: 'Ievads' },
    { key: 'c2', kind: 'song', name: 'Klints uz muziem', songId: SONG, tempo: 72 },
    { key: 'c3', kind: 'verse', name: 'Jana 15:16' },
    { key: 'c4', kind: 'blank', name: '' },
  ]);
}, {
  cuelists: [
    cuelist('svc-1', '2026-10-25T08:00:00', TYPE, [
      { cue_id: 'c1', cue_type: 'g', cue_name: 'Ievads' },
      { cue_id: 'c2', cue_type: 'c', cue_foreground: { type: 'text', text: SONG } },
      { cue_id: 'c3', cue_type: 'c', displayName: 'Jana 15:16', cue_foreground: { type: 'bible' } },
      { cue_id: 'c4', cue_type: 'c', cue_foreground: { type: 'text', text: '' } },
    ]),
  ],
}));

/** The date n days after 26 Oct 2026. */
const day = (n: number) => new Date(Date.UTC(2026, 9, 26 + n)).toISOString().slice(0, 10);
const song = (n: number) => ({ cue_id: `s${n}`, cue_foreground: { type: 'text', text: SONG } });

test('services() lists coming ones nearest first, then the last past one, at most 8', withClient(async (client, _loginFile, fake) => {
  await client.setLogin(COOKIE);
  const now = new Date('2026-10-26T12:00:00');
  const list = await client.services(ACCOUNT, TYPE, now);
  assert.deepEqual(list.map((s) => s.id), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'p2']);
  assert.deepEqual(list[0], { id: 'f1', start: `${day(1)}T08:00:00`, items: 3, songs: 1, songIds: [SONG] });
  assert.deepEqual(list.at(-1), { id: 'p2', start: '2026-10-25T08:00:00', items: 0, songs: 0, songIds: [] });
  // Asked for the type only, with an equality filter on the service type.
  assert.equal(fake.state.queries[0].where.fieldFilter.field.fieldPath, 'service.type');
  // Few services: just what there is, the past one last.
  const few = await client.services(ACCOUNT, OTHER_TYPE, now);
  assert.deepEqual(few.map((s) => s.id), ['x1', 'o2', 'o1']);
}, {
  cuelists: [
    cuelist('p1', '2026-10-18T08:00:00'),
    cuelist('p2', '2026-10-25T08:00:00'),
    // Nine coming ones, in no order; f1 is the nearest.
    ...[7, 5, 3, 1, 2, 4, 6, 8, 9].map((n) =>
      cuelist(`f${n}`, `${day(n)}T08:00:00`, TYPE, n === 1 ? [{ cue_id: 'h', cue_type: 'g', cue_name: 'Ievads' }, song(1), { cue_id: 'sl', cue_foreground: { type: 'slides' }, displayName: 'News' }] : []),
    ),
    cuelist('x1', '2026-10-27T09:00:00', OTHER_TYPE),
    cuelist('o1', '2026-10-20T08:00:00', OTHER_TYPE),
    cuelist('o2', '2026-10-28T08:00:00', OTHER_TYPE),
  ],
}));

test('services() falls back when the filtered query is refused', withClient(async (client, _loginFile, fake) => {
  await client.setLogin(COOKIE);
  fake.state.queryRefusedWhenFiltered = true;
  const list = await client.services(ACCOUNT, TYPE, new Date('2026-10-26T12:00:00'));
  assert.deepEqual(list.map((s) => s.id), ['f1', 'p1']);
  assert.equal(fake.state.queries.length, 2);
  assert.equal(fake.state.queries[1].where, undefined);
  assert.equal(fake.state.queries[1].limit, 100);
  assert.deepEqual(fake.state.queries[1].orderBy, [{ field: { fieldPath: 'mod' }, direction: 'DESCENDING' }]);
}, {
  cuelists: [
    cuelist('f1', '2026-10-27T08:00:00', TYPE, [song(1)]),
    cuelist('p1', '2026-10-25T08:00:00'),
    cuelist('x1', '2026-10-28T08:00:00', OTHER_TYPE),
  ],
}));
