// Ties the server together: show and state files, the engine worker, the
// command bus, the HTTP API, static pages and WebSocket live state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BUILT_IN_PROFILES, Command, OutputSettings, applyPicks, describeMode, diffShows, ensureRunningOrder, isManualCommand, oflToProfile, parseShow,
  type OflFixture, type Pick, type Scope,
  type LiveState, type RuntimeState, type Show,
} from '../../packages/shared/src/index.ts';
import { Sessions, clearedCookie, hashPin, isValidPin, sessionCookie, sessionToken, verifyPin } from './auth.ts';
import { discoverArtNet } from './discovery.ts';
import { NodeWatch } from './nodewatch.ts';
import { OflClient } from './ofl.ts';
import { operatorLayout, type OperatorLayout } from './layout.ts';
import type { FromWorker, TimingStats, ToWorker } from './messages.ts';
import { isLocalAddress } from './net.ts';
import { RuntimeSaver, Store } from './store.ts';

export interface AppOptions {
  port: number;
  host?: string;
  dataDir: string;
  seedPath: string;
  webDir: string;
  /** Replace the show's output, e.g. `{ kind: 'none' }` in tests. */
  output?: OutputSettings;
  /** For tests: stands in for the network when talking to the Open Fixture Library. */
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export type Role = 'operator' | 'programmer';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class App {
  private readonly opts: AppOptions;
  private readonly log: (msg: string) => void;
  readonly store: Store;
  private readonly saver: RuntimeSaver;
  private show!: Show;
  private worker: Worker | null = null;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private stopping = false;
  private nextId = 1;
  private pending = new Map<number, (value: unknown) => void>();
  private layout: OperatorLayout | null = null;
  private latestState: LiveState | null = null;
  private latestRuntime: RuntimeState | null = null;
  private ready!: Promise<void>;
  private readonly sessions = new Sessions();
  private outputProblem: string | null = null;
  private readonly identifyTimers = new Map<string, NodeJS.Timeout>();
  private ofl!: OflClient;
  /** Files waiting for someone to pick what to take from them. */
  private readonly imports = new Map<string, { show: Show; scope: Scope; at: number }>();
  private readonly nodeWatch = new NodeWatch((problem) => {
    if (problem !== this.outputProblem) this.log(problem ? `DMX: ${problem}` : 'DMX: node answering again');
    this.outputProblem = problem;
    if (this.latestState) this.publishState(this.latestState);
  });

  constructor(opts: AppOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.store = new Store(opts.dataDir, opts.seedPath);
    this.saver = new RuntimeSaver(this.store);
    this.ofl = new OflClient(join(opts.dataDir, 'ofl'), opts.fetch);
  }

  get state(): LiveState | null {
    return this.latestState;
  }

  get port(): number {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : this.opts.port;
  }

  async start(): Promise<void> {
    const loaded = this.store.loadShow();
    if (loaded.problem) this.log(`WARNING: ${loaded.problem}`);
    this.log(`Loaded show "${loaded.show.name}" from ${loaded.source}`);
    const migrated = ensureRunningOrder(loaded.show);
    if (JSON.stringify(migrated) !== JSON.stringify(loaded.show)) {
      this.store.saveShow(migrated);
      this.log('Gave the show a running order');
    }
    this.show = migrated;
    this.latestRuntime = this.store.loadRuntime();
    if (this.latestRuntime) this.log(`Restoring last state: look "${this.latestRuntime.look ?? 'none'}"`);
    this.startWorker();
    await this.ready;
    this.watchNode();

    this.server = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (!isLocalAddress(req.socket.remoteAddress) || !req.url?.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      const role: Role = this.isProgrammer(req) ? 'programmer' : 'operator';
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, role));
    });
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, this.opts.host ?? '0.0.0.0', resolve));
    this.log(`Light Runner on http://localhost:${this.port}/`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.nodeWatch.stop();
    for (const t of this.identifyTimers.values()) clearTimeout(t);
    this.saver.flush();
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (this.worker) {
      const w = this.worker;
      const exited = new Promise((resolve) => w.once('exit', resolve));
      this.post({ type: 'stop' });
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
      await w.terminate();
    }
  }

  /** The show as the engine runs it: tests can force the output off. */
  private engineShow(): Show {
    const show = this.show;
    return this.opts.output ? { ...show, settings: { ...show.settings, output: this.opts.output } } : show;
  }

  /** Live state plus what the node watch knows, sent to every device. */
  private publishState(state: LiveState): void {
    const problem = state.outputProblem ?? this.outputProblem;
    const merged: LiveState = problem && state.output === 'ok' ? { ...state, output: 'lost', outputProblem: problem } : { ...state, outputProblem: problem };
    this.latestState = merged;
    this.broadcast(JSON.stringify({ type: 'state', state: merged }));
  }

  private watchNode(): void {
    const s = this.engineShow().settings;
    this.nodeWatch.watch(s.outputEnabled && s.output.kind === 'artnet' ? s.output.host : null);
  }

  // ---- Engine worker ----

  private startWorker(): void {
    let markReady!: () => void;
    this.ready = new Promise((resolve) => (markReady = resolve));
    const worker = new Worker(new URL('./worker.ts', import.meta.url));
    this.worker = worker;
    worker.on('message', (msg: FromWorker) => this.onWorker(msg, markReady));
    worker.on('error', (err) => this.log(`Engine worker error: ${err.stack ?? err.message}`));
    worker.on('exit', (code) => {
      if (this.stopping) return;
      // Keep the stage running: restart the engine from the last saved state.
      this.log(`Engine worker stopped (code ${code}); restarting`);
      for (const resolve of this.pending.values()) resolve({ error: 'engine restarted' });
      this.pending.clear();
      setTimeout(() => this.startWorker(), 200);
    });
    this.post({ type: 'init', show: this.engineShow(), runtime: this.latestRuntime });
  }

  private post(msg: ToWorker): void {
    this.worker?.postMessage(msg);
  }

  private onWorker(msg: FromWorker, markReady: () => void): void {
    switch (msg.type) {
      case 'ready':
        this.layout = operatorLayout(this.show, msg.fixtures);
        this.broadcast(JSON.stringify({ type: 'layout', layout: this.layout }));
        markReady();
        break;
      case 'result':
      case 'snapshot':
      case 'timing': {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve?.(msg);
        break;
      }
      case 'state':
        this.publishState(msg.state);
        break;
      case 'runtime':
        this.latestRuntime = msg.runtime;
        this.saver.save(msg.runtime);
        break;
      case 'visual':
        for (const ws of this.wss?.clients ?? []) {
          // A slow device skips visualiser frames rather than falling behind.
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 64 * 1024) ws.send(msg.data);
        }
        break;
    }
  }

  private request<T>(make: (id: number) => ToWorker): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: 'engine did not answer' } as T);
      }, 2000);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v as T);
      });
      this.post(make(id));
    });
  }

  // ---- Command bus: every input ends up here ----

  /** Validate, check permissions and run a command. Returns an error message or null. */
  async command(input: unknown, role: Role): Promise<string | null> {
    return (await this.run(input, role)).error;
  }

  /** Like `command`, and also says whether the command added a step to the Undo list. */
  private async run(input: unknown, role: Role): Promise<{ error: string | null; recorded: boolean }> {
    const parsed = Command.safeParse(input);
    if (!parsed.success) return { error: `invalid command: ${parsed.error.issues.map((i) => i.message).join('; ')}`, recorded: false };
    const cmd = parsed.data;
    if (isManualCommand(cmd) && role !== 'programmer' && !this.show.operator.manualForOperators) {
      return { error: 'manual control is not enabled for operators', recorded: false };
    }
    const reply = await this.request<{ error: string | null; recorded?: boolean }>((id) => ({ type: 'command', id, cmd }));
    return { error: reply.error, recorded: !!reply.recorded };
  }

  /** The engine's stage and look as they are right now, straight from the worker. */
  private async stage(): Promise<RuntimeState> {
    const reply = await this.request<{ runtime?: RuntimeState; error?: string }>((id) => ({ type: 'snapshot', id }));
    if (!reply.runtime) throw new Error(reply.error ?? 'engine did not answer');
    return reply.runtime;
  }

  async timing(reset = false): Promise<TimingStats> {
    const reply = await this.request<{ stats: TimingStats }>((id) => ({ type: 'timing', id, reset }));
    return reply.stats;
  }

  /** Replace the show (programmer edits, import). Saves it with a backup first. */
  async setShow(show: Show): Promise<void> {
    // A show that arrives without a running order (import, restore, merge) gets one, as at start.
    if (!show.operator.runningOrder.length) show = ensureRunningOrder(show);
    this.store.saveShow(show);
    this.show = show;
    this.post({ type: 'show', show: this.engineShow() });
    this.watchNode();
    this.layout = this.layout ? operatorLayout(this.show, this.layout.fixtures.map((f) => f.id)) : null;
    this.broadcast(JSON.stringify({ type: 'layout', layout: this.layout }));
  }

  // ---- WebSocket ----

  private onSocket(ws: WebSocket, role: Role): void {
    if (this.layout) ws.send(JSON.stringify({ type: 'layout', layout: this.layout }));
    if (this.latestState) ws.send(JSON.stringify({ type: 'state', state: this.latestState }));
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string; ref?: unknown; cmd?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'command') {
        const error = await this.command(msg.cmd, role);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', ref: msg.ref ?? null, error }));
      }
    });
  }

  private broadcast(text: string): void {
    for (const ws of this.wss?.clients ?? []) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  // ---- HTTP ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLocalAddress(req.socket.remoteAddress)) throw new HttpError(403, 'local network only');
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname.startsWith('/api/')) {
        if (await this.programmerApi(req, res, url)) return;
        return await this.api(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (url.pathname === '/') {
        res.writeHead(302, { location: '/operator/' }).end();
        return;
      }
      await this.serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) this.log(`HTTP error: ${(err as Error).stack}`);
      json(res, status, { error: (err as Error).message });
    }
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const root = normalize(this.opts.webDir + sep);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root)) throw new HttpError(404, 'not found');
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  }

  // ---- Programmer: settings, PIN, backups, show import/export ----

  /** Open when no PIN is set (first setup); otherwise needs a logged-in session. */
  private isProgrammer(req: IncomingMessage): boolean {
    return !this.show.settings.pinHash || this.sessions.valid(sessionToken(req));
  }

  private settingsView() {
    const s = this.show.settings;
    return {
      showName: this.show.name,
      output: s.output,
      outputEnabled: s.outputEnabled,
      forcedOff: Boolean(this.opts.output),
      outputStatus: this.latestState?.output ?? null,
      frameRate: s.frameRate,
      gamma: s.gamma,
      manualForOperators: this.show.operator.manualForOperators,
      safeLook: this.show.operator.safeLook ?? null,
      looks: this.show.looks.map((l) => ({ id: l.id, name: l.name })),
      universes: [...new Set(this.show.fixtures.map((f) => f.universe))].sort((a, b) => a - b),
      fixtures: this.show.fixtures.length,
      pinSet: Boolean(s.pinHash),
    };
  }

  /** Handles programmer routes; returns false for anything else. */
  private async programmerApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`;
    const open = route === 'GET /api/session' || route === 'POST /api/login' || route === 'POST /api/logout';
    const routes = [
      'GET /api/session', 'POST /api/login', 'POST /api/logout', 'GET /api/settings', 'PUT /api/settings',
      'POST /api/pin', 'GET /api/artnet/nodes', 'GET /api/serial-ports', 'GET /api/backups',
      'POST /api/backups/restore', 'GET /api/show', 'PUT /api/show', 'GET /api/profiles', 'POST /api/identify',
      'GET /api/ofl/search', 'GET /api/ofl/fixture', 'POST /api/ofl/profile', 'POST /api/ofl/file',
      'POST /api/import/preview', 'POST /api/import/apply',
      'GET /api/ofl/db', 'POST /api/ofl/db/download', 'POST /api/ofl/db/install', 'POST /api/ofl/db/discard',
      'GET /api/ofl/manufacturers', 'GET /api/ofl/manufacturer',
    ];
    if (!routes.includes(route)) return false;
    if (!open && !this.isProgrammer(req)) throw new HttpError(401, 'enter the programmer PIN');

    switch (route) {
      case 'GET /api/session':
        json(res, 200, { loggedIn: this.isProgrammer(req), pinSet: Boolean(this.show.settings.pinHash) });
        return true;
      case 'POST /api/login': {
        const { pin } = (await readJson(req)) as { pin?: unknown };
        if (!isValidPin(pin)) throw new HttpError(400, 'the PIN is 4–6 digits');
        const result = this.sessions.login(pin, this.show.settings.pinHash);
        if ('error' in result) throw new HttpError(401, result.error);
        res.setHeader('set-cookie', sessionCookie(result.token));
        json(res, 200, { ok: true });
        return true;
      }
      case 'POST /api/logout':
        this.sessions.end(sessionToken(req));
        res.setHeader('set-cookie', clearedCookie());
        json(res, 200, { ok: true });
        return true;
      case 'GET /api/settings':
        json(res, 200, this.settingsView());
        return true;
      case 'PUT /api/settings': {
        const body = (await readJson(req)) as Record<string, unknown>;
        await this.setShow(this.applySettings(body));
        this.log('Settings changed');
        json(res, 200, this.settingsView());
        return true;
      }
      case 'POST /api/pin': {
        const { current, next } = (await readJson(req)) as { current?: unknown; next?: unknown };
        const stored = this.show.settings.pinHash;
        if (stored && !(typeof current === 'string' && verifyPin(current, stored))) throw new HttpError(401, 'the current PIN is wrong');
        if (next !== null && !isValidPin(next)) throw new HttpError(400, 'the new PIN must be 4–6 digits');
        const settings = { ...this.show.settings, pinHash: next === null ? undefined : hashPin(next as string) };
        await this.setShow({ ...this.show, settings });
        // Everyone else is logged out; this browser stays in.
        this.sessions.clear();
        res.setHeader('set-cookie', sessionCookie(this.sessions.create()));
        this.log(next === null ? 'Programmer PIN removed' : 'Programmer PIN changed');
        json(res, 200, { pinSet: next !== null });
        return true;
      }
      case 'GET /api/artnet/nodes':
        this.nodeWatch.pause(3000);
        json(res, 200, await discoverArtNet(2000));
        return true;
      case 'GET /api/serial-ports': {
        let ports: { path: string; manufacturer?: string }[] = [];
        try {
          const { SerialPort } = await import('serialport');
          ports = (await SerialPort.list()).map((p) => ({ path: p.path, manufacturer: p.manufacturer }));
        } catch {
          // serial support not installed
        }
        json(res, 200, ports);
        return true;
      }
      case 'GET /api/backups':
        json(res, 200, this.store.backups().map((name) => {
          const st = statSync(join(this.store.dir, 'backups', name));
          return { name, savedAt: st.mtime.toISOString(), size: st.size };
        }));
        return true;
      case 'POST /api/backups/restore': {
        const { name } = (await readJson(req)) as { name?: unknown };
        if (typeof name !== 'string' || !this.store.backups().includes(name)) throw new HttpError(404, 'no such backup');
        const show = parseShow(JSON.parse(readFileSync(join(this.store.dir, 'backups', name), 'utf8')));
        await this.setShow(show);
        this.log(`Restored backup ${name}`);
        json(res, 200, this.settingsView());
        return true;
      }
      case 'GET /api/show': {
        const file = `${this.show.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'show'}.json`;
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}`,
        });
        res.end(JSON.stringify(this.show, null, 2));
        return true;
      }
      case 'PUT /api/show': {
        let show: Show;
        try {
          show = parseShow(await readJson(req, 10 * 1024 * 1024));
        } catch (err) {
          throw new HttpError(400, `not a valid show: ${(err as Error).message}`);
        }
        // Keep this installation's PIN: an imported file must not change who can log in.
        show = { ...show, settings: { ...show.settings, pinHash: this.show.settings.pinHash } };
        await this.setShow(show);
        this.log(url.searchParams.get('source') === 'patch' ? 'Patch saved' : `Imported show "${show.name}"`);
        json(res, 200, this.settingsView());
        return true;
      }
      case 'GET /api/profiles': {
        // The show's own profiles win over built-ins with the same id.
        const own = new Set(this.show.profiles.map((p) => p.id));
        const all = [...this.show.profiles, ...BUILT_IN_PROFILES.filter((p) => !own.has(p.id))];
        json(res, 200, all.map((p) => ({ id: p.id, name: p.name, channels: p.channels.length, roles: [...new Set(p.channels.map((c) => c.role))] })));
        return true;
      }
      case 'POST /api/import/preview': {
        // A Light Runner show file (JSON) or a Lightkey project (binary), compared with the live show.
        const lightkey = /\.lightkeyproj$/i.test(url.searchParams.get('name') ?? '') || req.headers['content-type'] === 'application/octet-stream';
        let incoming: Show;
        let scope: Scope = 'all';
        if (lightkey) {
          incoming = await this.fromLightkey(await readRaw(req, 50 * 1024 * 1024));
          scope = 'patch';
        } else {
          try {
            incoming = parseShow(await readJson(req, 10 * 1024 * 1024));
          } catch (err) {
            throw new HttpError(400, `That isn't a Light Runner show file: ${(err as Error).message.split('\n')[0]}`);
          }
        }
        const token = randomBytes(12).toString('base64url');
        for (const [k, v] of this.imports) if (Date.now() - v.at > 30 * 60_000) this.imports.delete(k);
        this.imports.set(token, { show: incoming, scope, at: Date.now() });
        json(res, 200, { token, scope, name: incoming.name, items: diffShows(this.show, incoming, scope) });
        return true;
      }
      case 'POST /api/import/apply': {
        const { token, picks } = (await readJson(req)) as { token?: string; picks?: Pick[] };
        const pending = token ? this.imports.get(token) : undefined;
        if (!pending) throw new HttpError(404, 'that comparison has expired; choose the file again');
        if (!Array.isArray(picks) || !picks.length) throw new HttpError(400, 'nothing was ticked');
        let merged: Show;
        try {
          merged = applyPicks(this.show, pending.show, picks);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        await this.setShow(merged);
        this.imports.delete(token!);
        this.log(`Imported ${picks.length} changes from "${pending.show.name}"`);
        json(res, 200, this.settingsView());
        return true;
      }
      case 'GET /api/ofl/db':
        json(res, 200, this.oflStatus());
        return true;
      case 'POST /api/ofl/db/download':
        // Downloads in the background; the page polls GET /api/ofl/db.
        this.ofl.startDownload();
        json(res, 200, this.oflStatus());
        return true;
      case 'POST /api/ofl/db/install':
        try {
          this.ofl.installUpdate();
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
        this.log('Fixture database updated');
        json(res, 200, this.oflStatus());
        return true;
      case 'POST /api/ofl/db/discard':
        this.ofl.discardUpdate();
        json(res, 200, this.oflStatus());
        return true;
      case 'GET /api/ofl/manufacturers':
        json(res, 200, await this.oflCall(() => this.ofl.manufacturerList()));
        return true;
      case 'GET /api/ofl/manufacturer':
        json(res, 200, await this.oflCall(() => this.ofl.manufacturerFixtures(url.searchParams.get('key') ?? '')));
        return true;
      case 'GET /api/ofl/search':
        json(res, 200, await this.oflCall(() => this.ofl.search(url.searchParams.get('q') ?? '')));
        return true;
      case 'GET /api/ofl/fixture':
        json(res, 200, await this.oflCall(() => this.ofl.modes(url.searchParams.get('key') ?? '')));
        return true;
      case 'POST /api/ofl/profile': {
        // Returns the type; the patch page adds it to the show when the patch is saved.
        const { key, mode } = (await readJson(req)) as { key?: unknown; mode?: unknown };
        if (typeof key !== 'string' || typeof mode !== 'number') throw new HttpError(400, 'which fixture and mode?');
        json(res, 200, await this.oflCall(() => this.ofl.profile(key, mode)));
        return true;
      }
      case 'POST /api/ofl/file': {
        // A fixture file saved from open-fixture-library.org, for use without internet.
        const body = (await readJson(req, 2 * 1024 * 1024)) as { fixture?: OflFixture; mode?: number; manufacturer?: string; key?: string };
        if (!body.fixture || !Array.isArray(body.fixture.modes)) throw new HttpError(400, 'not an Open Fixture Library fixture file');
        const man = slugKey(body.manufacturer ?? 'imported');
        const fix = slugKey(body.key ?? body.fixture.name ?? 'fixture');
        if (typeof body.mode !== 'number') {
          json(res, 200, { key: `${man}/${fix}`, name: body.fixture.name, manufacturer: body.manufacturer ?? '', modes: body.fixture.modes.map((m, index) => ({ index, name: m.name, shortName: m.shortName ?? null, ...describeMode(body.fixture!, m) })) });
        } else {
          try {
            json(res, 200, oflToProfile(body.fixture, body.mode, man, fix, body.manufacturer ?? ''));
          } catch (err) {
            throw new HttpError(400, (err as Error).message);
          }
        }
        return true;
      }
      case 'POST /api/identify': {
        // Flash one fixture full white for 3 s so it can be found in the room.
        const { fixture } = (await readJson(req)) as { fixture?: unknown };
        if (typeof fixture !== 'string') throw new HttpError(400, 'which fixture?');
        const error = await this.command({ type: 'manual', target: { fixture }, colour: '#ffffff', intensity: 1 }, 'programmer');
        if (error) throw new HttpError(404, error);
        clearTimeout(this.identifyTimers.get(fixture));
        this.identifyTimers.set(fixture, setTimeout(() => {
          this.identifyTimers.delete(fixture);
          void this.command({ type: 'release', target: { fixture } }, 'programmer');
        }, 3000));
        json(res, 200, { ok: true });
        return true;
      }
    }
    return false;
  }

  /** Convert a Lightkey project with the bundled importer, onto this show's node and universe. */
  private async fromLightkey(data: Buffer): Promise<Show> {
    const dir = mkdtempSync(join(tmpdir(), 'light-runner-lightkey-'));
    try {
      const project = join(dir, 'project.lightkeyproj');
      const out = join(dir, 'show.json');
      writeFileSync(project, data);
      const output = this.show.settings.output;
      const host = output.kind === 'artnet' || output.kind === 'sacn' ? output.host || '255.255.255.255' : '255.255.255.255';
      const counts = new Map<number, number>();
      for (const f of this.show.fixtures) counts.set(f.universe, (counts.get(f.universe) ?? 0) + 1);
      const universe = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
      const importer = fileURLToPath(new URL('../../tools/import-lightkey.py', import.meta.url));
      await new Promise<void>((resolve, reject) => {
        execFile('python3', ['-I', importer, project, out, '--artnet-host', host, '--universe', String(universe)], { timeout: 30_000 }, (err, _stdout, stderr) => {
          if (err) reject(new Error(stderr.trim().split('\n').at(-1) || err.message));
          else resolve();
        });
      });
      return parseShow(JSON.parse(readFileSync(out, 'utf8')));
    } catch (err) {
      throw new HttpError(400, `Couldn't read that Lightkey project: ${(err as Error).message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Database status, marking changed fixtures that this show's fixture types came from. */
  private oflStatus() {
    return this.ofl.status((key) => {
      const prefix = `${slugKey(key.replace('/', '-'))}-`;
      return this.show.profiles.some((p) => p.source?.ofl === key || p.id.startsWith(prefix));
    });
  }

  /** Open Fixture Library calls: network trouble becomes a readable 502. */
  private async oflCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message;
      if (/key|mode|modes/.test(msg)) throw new HttpError(400, msg);
      throw new HttpError(502, `Can't reach the Open Fixture Library (${msg}). Check this computer's internet connection.`);
    }
  }

  /** A copy of the show with the settings form's changes; throws 400 on bad values. */
  private applySettings(body: Record<string, unknown>): Show {
    const show: Show = structuredClone(this.show);
    try {
      if (typeof body.showName === 'string' && body.showName.trim()) show.name = body.showName.trim();
      if (body.output !== undefined) show.settings.output = OutputSettings.parse(body.output);
      if (typeof body.outputEnabled === 'boolean') show.settings.outputEnabled = body.outputEnabled;
      if (body.frameRate !== undefined) show.settings.frameRate = Number(body.frameRate);
      if (body.gamma !== undefined) show.settings.gamma = Number(body.gamma);
      if (typeof body.manualForOperators === 'boolean') show.operator.manualForOperators = body.manualForOperators;
      if (body.safeLook !== undefined) show.operator.safeLook = body.safeLook ? String(body.safeLook) : undefined;
      if (body.universe !== undefined) {
        // Move the whole rig to one universe (only for single-universe shows).
        const used = new Set(show.fixtures.map((f) => f.universe));
        if (used.size > 1) throw new Error('this show uses several universes; change them per fixture');
        const u = Number(body.universe);
        if (!Number.isInteger(u) || u < 0 || u > 32767) throw new Error('universe must be 0–32767');
        for (const f of show.fixtures) f.universe = u;
      }
      return parseShow(show);
    } catch (err) {
      throw new HttpError(400, (err as Error).message.split('\n')[0]);
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
    const route = `${req.method} /${parts.map((p, i) => (isParam(parts, i) ? ':' : p)).join('/')}`;
    const fade = url.searchParams.has('fade') ? Number(url.searchParams.get('fade')) : undefined;
    const percent = (v: string, lo: number, hi: number) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `value must be ${lo}-${hi}`);
      return n / 100;
    };

    let cmd: unknown;
    switch (route) {
      case 'GET /state':
        return json(res, 200, this.latestState);
      case 'GET /looks':
        return json(res, 200, {
          looks: this.show.looks.map((l) => ({ id: l.id, name: l.name, colour: l.swatch ?? null, section: l.section ?? null })),
          presets: this.show.presets.map((p) => ({ id: p.id, name: p.name, group: p.group, colour: p.swatch ?? null })),
        });
      case 'GET /layout':
        return json(res, 200, this.layout);
      case 'GET /timing':
        return json(res, 200, await this.timing(url.searchParams.get('reset') === '1'));
      case 'POST /look/:': cmd = { type: 'look', id: parts[1], fade }; break;
      case 'POST /group/:/preset/:': cmd = { type: 'groupPreset', group: parts[1], preset: parts[3], fade }; break;
      case 'POST /group/:/manual': {
        const body = await readJson(req) as { colour?: string; intensity?: number };
        const intensity = body.intensity === undefined ? undefined : percent(String(body.intensity), 0, 100);
        cmd = { type: 'manual', target: { group: parts[1] }, colour: body.colour, intensity };
        break;
      }
      case 'POST /group/:/release': cmd = { type: 'release', target: { group: parts[1] } }; break;
      case 'POST /group/:/level/:': cmd = { type: 'groupLevel', group: parts[1], value: percent(parts[3], 0, 100) }; break;
      case 'POST /release-all': cmd = { type: 'releaseAll' }; break;
      case 'POST /back-to-look': cmd = { type: 'backToLook' }; break;
      case 'POST /safe': cmd = { type: 'safe' }; break;
      case 'POST /blackout': cmd = { type: 'blackout' }; break;
      case 'POST /undo': cmd = { type: 'undo' }; break;
      case 'POST /fade/:': cmd = { type: 'fadeTime', value: parts[1] === 'auto' ? null : Number(parts[1]) }; break;
      case 'POST /master/:': cmd = { type: 'master', value: percent(parts[1], 0, 100) }; break;
      case 'POST /speed/:': cmd = { type: 'speed', value: percent(parts[1], 50, 200) }; break;
      default:
        throw new HttpError(404, `no such endpoint: ${req.method} ${url.pathname}`);
    }
    const error = await this.command(cmd, 'operator');
    if (error) throw new HttpError(error.startsWith('unknown') ? 404 : 400, error);
    json(res, 200, { ok: true });
  }
}

function slugKey(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** Which path segments are parameters in the API's URL patterns. */
function isParam(parts: string[], i: number): boolean {
  const [head] = parts;
  if (head === 'look' || head === 'master' || head === 'speed' || head === 'fade') return i === 1;
  if (head === 'group') return i === 1 || (i === 3 && (parts[2] === 'preset' || parts[2] === 'level'));
  return false;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'file too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}
