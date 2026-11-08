// The online planning service (WorshipTools Planning), as the tools/worshiptools-*.ts scripts use it. It has
// no public API; these are the calls its own web apps make. The weAuthRefresh cookie (pasted by the programmer)
// gets a one-hour token from planning.worshiptools.com, and that token signs api.worship.tools requests. The
// services themselves are Firestore documents; api.worship.tools hands out the Firebase login for them.
//
// The cookie and the tokens are secrets: the login file is owner-only, and nothing here logs or returns them.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { toPlannedService, type PlannedService } from '../../../packages/shared/src/index.ts';
import { writeAtomic } from '../store.ts';
import { fromFirestore } from './firestore.ts';

const PLANNING = 'https://planning.worshiptools.com';
const API = 'https://api.worship.tools/v1';
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken';
/** Tokens last an hour; renewed a little early. */
const TOKEN_MS = 50 * 60_000;
const MAX_SERVICES = 8;
const FALLBACK_SCAN = 100;
const BATCH = 100;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** What a cookie value may hold: printable characters, no spaces or semicolons. */
const COOKIE_VALUE = /^[\x21-\x3a\x3c-\x7e]+$/;

const RUN_OUT = 'The planning login has run out. Paste a new one in Settings.';
const NOT_LOGGED_IN = 'Not logged in yet. Paste a login in Settings.';
const UNEXPECTED = 'The planning service sent something unexpected.';
/** How long one call may take before it counts as not reachable. */
const TIMEOUT_MS = 20_000;

const UNREACHABLE = "Can't reach the planning service. Check the internet connection.";

/** An error whose message is fit to show to people as it is. */
export class PlanningError extends Error {
  /** The HTTP status the planning service answered with, when it did. */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PlanningError';
    if (status !== undefined) this.status = status;
  }
}

export type ServiceSummary = { id: string; start: string; items: number; songs: number; songIds: string[] };

type Login = { refresh?: string; machineId?: string };
type Firestore = { database: string; idToken: string };

export class PlanningClient {
  private readonly loginFile: string;
  private readonly fetchFn: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  private token: Promise<string> | undefined;
  private tokenExpires = 0;
  private firestoreSession: Promise<Firestore> | undefined;
  private firestoreExpires = 0;

  constructor({ loginFile, fetch: fetchFn = fetch, log = () => {}, timeoutMs = TIMEOUT_MS }: { loginFile: string; fetch?: typeof fetch; log?: (line: string) => void; timeoutMs?: number }) {
    this.loginFile = loginFile;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
    this.log = log;
  }

  /** Save a pasted weAuthRefresh cookie (the bare value or `weAuthRefresh=...`), once it has proved itself with a token. */
  async setLogin(cookie: string): Promise<void> {
    const refresh = cookie.trim().replace(/^weAuthRefresh=/, '').replace(/;$/, '');
    if (!refresh) throw new PlanningError('Nothing was pasted.');
    if (!COOKIE_VALUE.test(refresh)) throw new PlanningError('That does not look like the weAuthRefresh value. Copy it again from the browser.');
    const got = await this.renew(refresh);
    if (!got) throw new PlanningError('That login was not accepted. Sign in again at the planning service and copy the weAuthRefresh value again.');
    const login = this.readLogin();
    this.writeLogin({ ...login, refresh: got.rotated ?? refresh, machineId: login.machineId || newMachineId() });
    this.token = Promise.resolve(got.token);
    this.tokenExpires = Date.now() + TOKEN_MS;
    this.firestoreSession = undefined;
    this.log('Planning login saved.');
  }

  loggedIn(): boolean {
    return !!this.readLogin().refresh;
  }

  /** A stable id for this computer, the way the planning service's own apps keep one. */
  machineId(): string {
    const login = this.readLogin();
    if (login.machineId) return login.machineId;
    const machineId = newMachineId();
    this.writeLogin({ ...login, machineId });
    return machineId;
  }

  /** api.worship.tools: the token is kept for 50 minutes and renewed once if the service says it has expired. */
  async api(path: string, init: RequestInit = {}): Promise<any> {
    const send = async (token: string) => {
      const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` };
      return { token, res: await this.send(API + path, { ...init, headers }) };
    };
    let sent = await send(await this.getToken());
    if (sent.res.status === 401) sent = await send(await this.getToken(sent.token));
    return this.read(sent.res);
  }

  async accounts(): Promise<{ id: string; name: string }[]> {
    const list: any[] = await this.api('/account');
    return (Array.isArray(list) ? list : []).map((a) => ({ id: String(a.id), name: String(a.name ?? '') }));
  }

  /** The account's service types, the archived ones left out. */
  async serviceTypes(account: string): Promise<{ id: string; name: string }[]> {
    const list: any[] = await this.api(`/account/${check(account)}/meta/service-types`);
    return (Array.isArray(list) ? list : []).filter((t) => !t.archived).map((t) => ({ id: String(t.id), name: String(t.name ?? '') }));
  }

  /** The coming services of a type, nearest first, then the most recent past one; at most 8. */
  async services(account: string, type: string, now: Date): Promise<ServiceSummary[]> {
    const parent = `/accounts/${check(account)}`;
    let docs: any[];
    try {
      docs = await this.query(parent, {
        from: [{ collectionId: 'cuelists' }],
        where: { fieldFilter: { field: { fieldPath: 'service.type' }, op: 'EQUAL', value: { stringValue: type } } },
      });
    } catch (e) {
      // Only a 400 or 412 says the index is missing; a run-out login or a dead network would fail the second query too.
      if (!(e instanceof PlanningError) || (e.status !== 400 && e.status !== 412)) throw e;
      // Take the newest ones and pick the type here.
      docs = (
        await this.query(parent, {
          from: [{ collectionId: 'cuelists' }],
          orderBy: [{ field: { fieldPath: 'mod' }, direction: 'DESCENDING' }],
          limit: FALLBACK_SCAN,
        })
      ).filter((d) => d.service?.type === type);
    }
    const all: (ServiceSummary & { at: number })[] = [];
    for (const doc of docs) {
      const at = Date.parse(doc.service?.times?.[0]?.time ?? '');
      if (Number.isNaN(at)) continue;
      try {
        const planned = toPlannedService(doc.id, doc, new Map(), '');
        const songIds = [...new Set(planned.items.flatMap((i) => (i.songId ? [i.songId] : [])))];
        all.push({ id: planned.id, start: planned.start, items: planned.items.length, songs: planned.items.filter((i) => i.kind === 'song').length, songIds, at });
      } catch {
        // a document that is not a service is passed over
      }
    }
    const coming = all.filter((s) => s.at >= now.getTime()).sort((a, b) => a.at - b.at);
    const past = all.filter((s) => s.at < now.getTime()).sort((a, b) => b.at - a.at)[0];
    const shown = past ? [...coming.slice(0, MAX_SERVICES - 1), past] : coming.slice(0, MAX_SERVICES);
    return shown.map(({ at: _at, ...summary }) => summary);
  }

  /** One service with its songs' tempos. */
  async service(account: string, id: string): Promise<PlannedService> {
    const accountId = check(account);
    const [doc, types] = await Promise.all([this.firestore(`/accounts/${accountId}/cuelists/${check(id)}`), this.serviceTypes(accountId)]);
    const plain = fromFirestore(doc);
    const typeName = types.find((t) => t.id === plain.service?.type)?.name ?? '';
    // Song items only hold the song's id; fetch all the songs together.
    const songIds = [...new Set(toPlannedService(id, plain, new Map(), '').items.flatMap((i) => (i.songId ? [i.songId] : [])))];
    const songs = new Map<string, unknown>();
    const { database } = songIds.length ? await this.firestoreAuth() : { database: '' };
    for (let from = 0; from < songIds.length; from += BATCH) {
      const found: any[] = await this.firestore(':batchGet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: songIds.slice(from, from + BATCH).map((s) => `${database}/documents/accounts/${accountId}/songs/${s}`) }),
      });
      for (const r of found) if (r.found) songs.set(String(r.found.name).split('/').pop()!, fromFirestore(r.found));
    }
    return toPlannedService(id, plain, songs, typeName);
  }

  // ---- Login file ----

  private readLogin(): Login {
    try {
      const login = JSON.parse(readFileSync(this.loginFile, 'utf8'));
      return login && typeof login === 'object' ? login : {};
    } catch {
      return {};
    }
  }

  private writeLogin(login: Login): void {
    mkdirSync(dirname(this.loginFile), { recursive: true });
    writeAtomic(this.loginFile, JSON.stringify(login) + '\n', { mode: 0o600 });
  }

  // ---- Tokens ----

  /**
   * The api token, renewed when it is old. `refused` is a token the service just answered 401 to: it is renewed
   * unless someone else already has, so calls that fail together renew once.
   */
  private async getToken(refused?: string): Promise<string> {
    if (this.token && Date.now() < this.tokenExpires) {
      const existing = this.token;
      const current = await existing;
      if (refused === undefined || current !== refused) return current;
      if (this.token !== existing) return this.getToken(refused); // someone renewed while we waited
    }
    const token = this.renewFromFile();
    this.token = token;
    this.tokenExpires = Date.now() + TOKEN_MS;
    token.catch(() => {
      if (this.token === token) this.token = undefined;
    });
    return token;
  }

  private async renewFromFile(): Promise<string> {
    const refresh = this.readLogin().refresh;
    if (!refresh) throw new PlanningError(NOT_LOGGED_IN);
    const got = await this.renew(refresh);
    if (!got) throw new PlanningError(RUN_OUT);
    // The service may hand out a new refresh cookie; keep it so the login does not wear out.
    if (got.rotated && got.rotated !== refresh) this.writeLogin({ ...this.readLogin(), refresh: got.rotated });
    return got.token;
  }

  /** Trade a refresh cookie for a token; null when the planning service refuses it. */
  private async renew(refresh: string): Promise<{ token: string; rotated?: string } | null> {
    const res = await this.send(`${PLANNING}/auth/refresh`, { headers: { Cookie: `weAuthRefresh=${refresh}` }, redirect: 'manual' });
    const cookies: Record<string, string> = {};
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      if (at > 0) cookies[pair.slice(0, at).trim()] = safeDecode(pair.slice(at + 1));
    }
    // Only an answer that turns the cookie down means the login has run out; a failing service says nothing about it.
    if (res.status >= 500) throw new PlanningError(`The planning service isn't answering right now (HTTP ${res.status}). Try again in a minute.`, res.status);
    if (!cookies.weAuthToken) return null;
    return { token: cookies.weAuthToken, ...(cookies.weAuthRefresh ? { rotated: cookies.weAuthRefresh } : {}) };
  }

  // ---- The document store ----

  /** Firebase's id token for the document store: asked for through the api, then kept like the api token. */
  private async firestoreAuth(refused?: Firestore): Promise<Firestore> {
    if (this.firestoreSession && Date.now() < this.firestoreExpires) {
      const existing = this.firestoreSession;
      const current = await existing;
      if (!refused || current.idToken !== refused.idToken) return current;
      if (this.firestoreSession !== existing) return this.firestoreAuth(refused); // someone renewed while we waited
    }
    const session = (async (): Promise<Firestore> => {
      const [firebase, custom] = await Promise.all([this.api('/config/firebase'), this.api('/firebase/token')]);
      if (typeof firebase?.apiKey !== 'string' || typeof firebase.projectId !== 'string' || typeof custom?.token !== 'string') {
        throw new PlanningError(UNEXPECTED);
      }
      const res = await this.send(`${IDENTITY}?key=${encodeURIComponent(firebase.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom.token, returnSecureToken: true }),
      });
      const signedIn = await this.read(res);
      if (typeof signedIn?.idToken !== 'string') throw new PlanningError(UNEXPECTED);
      return { database: `projects/${firebase.projectId}/databases/(default)`, idToken: signedIn.idToken };
    })();
    this.firestoreSession = session;
    this.firestoreExpires = Date.now() + TOKEN_MS;
    session.catch(() => {
      if (this.firestoreSession === session) this.firestoreSession = undefined;
    });
    return session;
  }

  /** A Firestore call under .../documents; the id token is renewed once if it is refused. */
  private async firestore(path: string, init: RequestInit = {}): Promise<any> {
    const send = async (session: Firestore) => {
      const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${session.idToken}` };
      return { session, res: await this.send(`https://firestore.googleapis.com/v1/${session.database}/documents${path}`, { ...init, headers }) };
    };
    let sent = await send(await this.firestoreAuth());
    if (sent.res.status === 401) sent = await send(await this.firestoreAuth(sent.session));
    if (sent.res.status === 404) throw new PlanningError('That service was not found in the planning service.', 404);
    return this.read(sent.res);
  }

  /** Run a structured query under a document; the documents it finds, decoded, each with its `id`. */
  private async query(parent: string, structuredQuery: object): Promise<any[]> {
    const rows: any[] = await this.firestore(`${parent}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }),
    });
    return (Array.isArray(rows) ? rows : []).flatMap((r) => (r.document ? [{ ...fromFirestore(r.document), id: String(r.document.name).split('/').pop() }] : []));
  }

  // ---- HTTP ----

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new PlanningError(UNREACHABLE);
    }
  }

  private async read(res: Response): Promise<any> {
    if (!res.ok) throw new PlanningError(`The planning service refused the request (HTTP ${res.status}).`, res.status);
    const body = await res.text();
    try {
      return body ? JSON.parse(body) : null;
    } catch {
      throw new PlanningError(UNEXPECTED);
    }
  }
}

function newMachineId(): string {
  return Math.random().toString(36).slice(2, 11).toUpperCase().padEnd(9, '0');
}

function check(id: string): string {
  if (!ID.test(id)) throw new PlanningError('That is not a planning service id.');
  return encodeURIComponent(id);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
