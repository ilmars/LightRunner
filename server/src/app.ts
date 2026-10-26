// Ties the server together: show and state files, the engine worker, the
// command bus, the HTTP API, static pages and WebSocket live state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { WebSocketServer, type WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import {
  BUILT_IN_PROFILES, Command, OscSettings, contactOf, OutputRoute, OutputSettings, addColour, addEffect, addSong, deleteColour, editColour, editEffect, keepLitPresets, applyPicks, deleteItem, describeMode, diffShows, ensureBasicLights, ensureEffects, ensureGroupColours, ensureRunningOrder, isManualCommand,
  applyQuickLookToItem, deleteQuickLook, editQuickLook, isBlindCommand, isEffectPreset, isShowEdit, moveItem, moveQuickLook, oflToProfile, outputAddressProblem, parseShow, planRoutes, profileSegments, renameItem, saveItem, saveQuickLook, setItemGroup, setItemTempo,  type OflFixture, type Pick, type Scope,
  BLACKOUT, LiveEffectLayer, commandFor, lightGroups, nextItemId, stageIndexOf, type BlindCommand, type DeviceAction, type LiveState, type PresetPin, type RuntimeState, type Show, type ShowEdit, type StageCommand,
  FADE_STEPS, KeyTarget, TapTempo, assignKey, bindingOf, clearKey, controllerOf, isApcMini, isLevelTarget, isOperatorKeyTarget, keepControllerKeys, keyOf, keyTargetProblem,
  pruneKeys, resetApcKeys, sameTarget, targetName, type ControlKey,
} from '../../packages/shared/src/index.ts';
import { effectFrames, settledVisual, type StageClock } from '../../packages/engine/src/index.ts';
import { Sessions, clearedCookie, hashPin, isValidPin, sessionCookie, sessionToken, verifyPin } from './auth.ts';
import { BLIND_OFF, BLIND_PROBLEM, BlindSession, MAX_DRAFTS, TOO_MANY_DRAFTS } from './blind.ts';
import { discoverArtNet } from './discovery.ts';
import { NodeWatch } from './nodewatch.ts';
import { OflClient } from './ofl.ts';
import { listenOsc, type OscServer } from './osc.ts';
import { MidiDriver, type ApcStatus } from './controllers.ts';
import { keyLabel, keyPlace } from './keynames.ts';
import type { FakeMidi, MidiPorts } from './midi.ts';
import { operatorLayout, type OperatorLayout } from './layout.ts';
import { VISUAL_EVERY, type FromWorker, type TimingStats, type ToWorker } from './messages.ts';
import { isLocalAddress, isThisComputer } from './net.ts';
import { AlreadyRunning, liveMarker, removeMarker, writeMarker } from './marker.ts';
import { RuntimeSaver, Store } from './store.ts';

export interface AppOptions {
  port: number;
  host?: string;
  dataDir: string;
  seedPath: string;
  webDir: string;
  /** Replace the show's output, e.g. `{ kind: 'none' }` in tests. Routes are ignored then. */
  output?: OutputSettings;
  /** For tests: send Art-Net for these hosts to another address and UDP port instead (normally the host, port 6454). */
  artnetRedirect?: Record<string, { host: string; port: number }>;
  /** For tests: stands in for the network when talking to the Open Fixture Library. */
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  /** How often each tablet is checked (ms); one that misses two checks is dropped. Tests make it short. */
  heartbeatMs?: number;
  /** How long a Flash held by a device (APC, OSC, HTTP) may last before it is put out (ms); 15 s. Tests make it short. */
  deviceFlashMs?: number;
  /**
   * Opens the computer's MIDI ports, for the APC mini: main.ts passes `loadMidi` (the MIDI add-on, when installed),
   * tests pass simulated ones. Without it there is no APC, so tests and tools never touch a real one.
   */
  midi?: (log: (msg: string) => void) => Promise<MidiPorts | null>;
  /** How often to look for the APC mini (ms; 2 s) and how long its Blackout must be held (ms; 1 s). Tests make them short. */
  apcPollMs?: number;
  apcHoldMs?: number;
  /** Every this many polls the APC gets its whole LED set again (default 5). Tests set it very high or low. */
  apcResendPolls?: number;
  /** How long a learn waits for a key (ms); 10 s. Tests make it short. */
  learnMs?: number;
  /** How long after a controller comes or goes the pages hear of it (ms); 1 s, so one that comes and goes at once (a flaky hub) is passed over. */
  keysChangedMs?: number;
  /**
   * Test only (`LIGHT_RUNNER_FAKE_MIDI=1`, for checking the pages without a controller): the simulated ports `midi`
   * gives, and `POST /api/test/midi` to press their keys. Never set otherwise.
   */
  fakeMidi?: FakeMidi;
  /**
   * One server per data folder (main.ts): refuse to start while another server answers for this folder, and keep
   * `server.json` (pid, port, token) there while running. Tests and tools leave it off.
   */
  claimData?: boolean;
  /** The launcher's stop (`POST /api/launcher/stop` with the marker's token): main.ts runs its clean shutdown. */
  onStopRequest?: () => void;
  /** This Light Runner's version, sent as the `x-light-runner` header of `GET /api/state`. */
  version?: string;
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
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Steps the Undo list keeps, as the engine does. */
const UNDO_KEPT = 20;
/** A Flash a device holds this long (ms) is put out, in case its "off" never comes. */
const DEVICE_FLASH_MS = 15000;
/** Preview tempo edits of one song this close together (ms) are one Undo step. */
const TEMPO_RUN_MS = 3000;

/** A Master step this soon (ms) after another carries on from it instead of from the state. */
const DEVICE_MASTER_MS = 300;
/** What an operator is told for a key only the programmer may change (Settings, behind the PIN). */
const PROGRAMMER_KEYS = 'Only the programmer can change that key. Enter the PIN in Settings.';
/** The key of a device Flash's time limit. */
const flashKey = (source: string, group: string) => JSON.stringify([source, group]);

/** What the effect editor sends for its moving strip: the group and the effect as it is being edited. */
// The tempo and speed dial the page shows (a Blind draft's, say); the stage's when left out. Limits as the tempo and speed commands.
const EffectPreviewBody = z.object({
  group: z.string().min(1).max(64), effect: LiveEffectLayer,
  tempo: z.number().min(40).max(240).optional(), speed: z.number().min(0.5).max(2).optional(),
});

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
  /** The token in this server's server.json (claimData), the key to the launcher's stop. */
  private markerToken: string | null = null;
  /** Pages open on other computers (iPads, phones): the launcher's note about the firewall goes once one has come. */
  private remotePages = new Set<WebSocket>();
  private nextId = 1;
  private pending = new Map<number, (value: unknown) => void>();
  private layout: OperatorLayout | null = null;
  /** The state as the worker last sent it, before node-watch news and show Undo steps are added. */
  private engineState: LiveState | null = null;
  /** What every device was last sent. */
  private latestState: LiveState | null = null;
  /**
   * One Undo list for the stage and the show, newest last: the show as it was
   * before an operator edit, or 'stage' for a step the engine keeps itself.
   */
  private undoLog: (Show | 'stage')[] = [];
  /** The last itemTempo edit, so a run of them joins one Undo step: its song, when, and the Undo entry it made. */
  private tempoEdit: { item: string; at: number; step: Show | 'stage' } | null = null;
  /**
   * For an Undo step of an edit made in Prepare: the pins that put the groups it moved onto copies of their colours
   * (keepLitPresets) back on their own colours. Its Undo never moves the lights either.
   */
  private readonly undoKeep = new WeakMap<Show, PresetPin[]>();
  /**
   * The first operator edit after start or after a programmer save keeps a
   * backup; the rest of a rehearsal's edits don't, so they can't push the
   * programmer's backups out.
   */
  private operatorBackedUp = false;
  private keysTimer: NodeJS.Timeout | undefined;
  /** Groups each tablet is holding a Flash on, so they go out if it disconnects. */
  private readonly flashes = new Map<WebSocket, Set<string>>();
  /** Groups each device source ('http', 'osc', 'midi:<port>') is holding a Flash on, so they go out when it goes away. */
  private readonly deviceFlashes = new Map<string, Set<string>>();
  /** The OSC listener while it is switched on in Settings, and why it isn't listening when it should be. */
  private osc: OscServer | null = null;
  private oscProblem: string | null = null;
  /** Starts and stops of the OSC listener, one after another. */
  private oscBusy: Promise<void> = Promise.resolve();
  /** Runs the MIDI controllers (the APC mini and any other); null when the MIDI add-on isn't installed. */
  private midi: MidiDriver | null = null;
  /** Tap tempo of each device source. */
  private readonly taps = new Map<string, TapTempo>();
  /** The last Master a device sent, for steps pressed faster than the state arrives. */
  private deviceMaster: { value: number; at: number } | null = null;
  /** The time limit on each device Flash, by source and group. */
  private readonly deviceFlashTimers = new Map<string, NodeJS.Timeout>();
  /** Checks each tablet missed in a row; reset when it answers. */
  private readonly missedPongs = new Map<WebSocket, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  /** Each tablet in Blind and its draft of the stage. */
  private readonly blind = new Map<WebSocket, BlindSession>();
  /**
   * Counts each tablet's Blind starts and ends, so a start still waiting for the stage when an end
   * (or a newer start) came makes no draft.
   */
  private readonly blindTurn = new Map<WebSocket, number>();
  /** Frames the drafts and sends each its tablet's picture and state; runs while any tablet is in Blind. */
  private blindTimer: NodeJS.Timeout | null = null;
  private latestRuntime: RuntimeState | null = null;
  private ready!: Promise<void>;
  private readonly sessions = new Sessions();
  private outputProblem: string | null = null;
  /** Every node-watch problem is another desk sending (no node missing). */
  private otherDeskOnly = false;
  private readonly identifyTimers = new Map<string, NodeJS.Timeout>();
  private ofl!: OflClient;
  /** Files waiting for someone to pick what to take from them. */
  private readonly imports = new Map<string, { show: Show; scope: Scope; at: number }>();
  private readonly nodeWatch = new NodeWatch((problem, otherDesk) => {
    if (problem !== this.outputProblem) this.log(problem ? `DMX: ${problem}` : 'DMX: node answering again');
    this.outputProblem = problem;
    this.otherDeskOnly = otherDesk;
    this.publishState();
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

  /** How many tablets are in Blind now. */
  get drafts(): number {
    return this.blind.size;
  }

  get port(): number {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : this.opts.port;
  }

  async start(): Promise<void> {
    // Before anything is loaded or the engine starts: a second engine on the same show must never send.
    if (this.opts.claimData) {
      const other = await liveMarker(this.opts.dataDir);
      if (other) throw new AlreadyRunning(other.port);
    }
    const loaded = this.store.loadShow();
    if (loaded.problem) this.log(`WARNING: ${loaded.problem}`);
    this.log(`Loaded show "${loaded.show.name}" from ${loaded.source}`);
    const migrated = ensureShow(loaded.show);
    if (JSON.stringify(migrated) !== JSON.stringify(loaded.show)) {
      this.store.saveShow(migrated);
      this.log('Gave the show a running order, ready-made effects and starter colours where they were missing');
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
      const remote = !isThisComputer(req.socket.remoteAddress);
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        if (remote) {
          this.remotePages.add(ws);
          ws.on('close', () => this.remotePages.delete(ws));
        }
        this.onSocket(ws, role);
      });
    });
    // A tablet that drops off the network never closes its socket; ping each one and drop it
    // after two missed answers, so its Flash goes out like on a clean close.
    this.heartbeat = setInterval(() => this.checkTablets(), this.opts.heartbeatMs ?? 2000);
    this.heartbeat.unref();
    // A port that is taken rejects, so the caller can say so (a launcher shows it in plain words).
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.log(`Light Runner on http://localhost:${this.port}/`);
    if (this.opts.claimData) {
      this.markerToken = randomBytes(32).toString('hex');
      writeMarker(this.opts.dataDir, { pid: process.pid, port: this.port, token: this.markerToken, startedAt: new Date().toISOString() });
    }
    await this.syncOsc();
    await this.startMidi();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // The APC mini's LEDs go out and every controller's port closes.
    this.midi?.stop();
    this.midi = null;
    clearTimeout(this.keysTimer);
    this.nodeWatch.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.blind.clear();
    this.blindTurn.clear();
    this.blindTimerFits();
    for (const t of this.identifyTimers.values()) clearTimeout(t);
    for (const t of this.deviceFlashTimers.values()) clearTimeout(t);
    this.deviceFlashTimers.clear();
    this.deviceFlashes.clear();
    // Stopping is set, so a start still in line does nothing; the listener running now closes here.
    await this.syncOsc();
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
    // Last, so a state the worker sent while stopping is saved now rather than after the app is gone.
    this.saver.flush();
    if (this.markerToken) {
      removeMarker(this.opts.dataDir, this.markerToken);
      this.markerToken = null;
    }
  }

  /** The show as the engine runs it: tests (and LIGHT_RUNNER_OUTPUT=none) can force the output, routes included. */
  private engineShow(): Show {
    const show = this.show;
    return this.opts.output ? { ...show, settings: { ...show.settings, output: this.opts.output, routes: undefined } } : show;
  }

  /** The engine's live state plus what the node watch and the Undo list know, sent to every device. */
  private publishState(): void {
    const state = this.engineState;
    if (!state) return;
    // The worker names outputs it can't send to; the node watch names nodes that don't answer.
    const problem = [state.outputProblem, this.outputProblem].filter(Boolean).join('. ') || null;
    const canUndo = state.canUndo || this.undoLog.some((step) => step !== 'stage');
    const output = problem && state.output === 'ok' ? 'lost' : state.output;
    // A worker problem (an output it can't send to) is never another desk.
    const kind = output !== 'lost' ? null : !state.outputProblem && this.outputProblem && this.otherDeskOnly ? 'other-desk' : 'not-answering';
    const merged: LiveState = { ...state, canUndo, output, outputProblem: problem, outputProblemKind: kind };
    this.latestState = merged;
    this.broadcast(JSON.stringify({ type: 'state', state: merged }));
    this.midi?.update(this.layout, merged);
  }

  /** Watch every Art-Net node the show sends to (the default output's and each route's). */
  private watchNode(): void {
    const show = this.engineShow();
    const plan = planRoutes(show.settings, show.fixtures.map((f) => f.universe));
    this.nodeWatch.watch(plan.destinations.map((d) => (d.output.kind === 'artnet' ? d.output.host : null)));
  }

  // ---- OSC ----

  /** Make the OSC listener match Settings: open, closed, or moved to another port. Never throws. */
  private syncOsc(): Promise<void> {
    this.oscBusy = this.oscBusy.then(() => this.applyOsc());
    return this.oscBusy;
  }

  private async applyOsc(): Promise<void> {
    const o = this.show.settings.osc;
    const port = o?.enabled && !this.stopping ? o.port : null;
    if (this.osc && this.osc.port === port) return;
    if (this.osc) {
      const old = this.osc;
      this.osc = null;
      await old.close();
      // A Flash it was holding goes out with it.
      this.releaseDevice('osc');
      this.log('OSC: stopped listening');
    }
    this.oscProblem = null;
    if (port === null) return;
    try {
      this.osc = await listenOsc(port, (action) => this.device(action, 'osc'), (m) => this.log(m));
      this.log(`OSC: listening on UDP port ${port}`);
    } catch (err) {
      this.oscProblem = (err as Error).message;
      this.log(`OSC: ${this.oscProblem}`);
    }
  }

  // ---- MIDI controllers: the APC mini and any other ----

  /** Start looking for controllers, when MIDI ports were given and are there (`loadMidi` logs one line when they aren't). */
  private async startMidi(): Promise<void> {
    if (!this.opts.midi) return;
    const ports = await this.opts.midi(this.log);
    if (!ports || this.stopping) return;
    this.midi = new MidiDriver(ports, {
      device: (action, source) => this.device(action, source),
      release: (source) => this.releaseDevice(source),
      // The pages show Key chips while a controller is listened to.
      changed: () => this.controllersChanged(),
      log: this.log,
    }, { pollMs: this.opts.apcPollMs, holdMs: this.opts.apcHoldMs, resendPolls: this.opts.apcResendPolls });
    this.midi.configure(controllerOf(this.show));
    // The pages learn that keys can be assigned.
    if (this.layout) this.refreshLayout();
    this.midi.update(this.layout, this.latestState);
    this.midi.start();
  }

  /**
   * A controller was opened or let go of: a moment later (so one that comes and goes at once is passed over), the
   * layout counts the controllers again. The pages are sent it only when Key chips come or go (none listened to, or
   * some); otherwise the count changes in place, for `GET /api/layout`.
   */
  private controllersChanged(): void {
    clearTimeout(this.keysTimer);
    this.keysTimer = setTimeout(() => {
      if (!this.layout || this.stopping) return;
      const listening = this.midi?.listening ?? 0;
      const was = this.layout.keys.connected;
      if (listening === was) return;
      if ((listening > 0) === (was > 0)) this.layout.keys.connected = listening;
      else this.refreshLayout();
    }, this.opts.keysChangedMs ?? 1000);
    this.keysTimer.unref();
  }

  private apcStatus(): ApcStatus {
    return this.midi?.status ?? { midi: false, connected: false, model: null };
  }

  /** A learn is waiting for a key. */
  get learning(): boolean {
    return this.midi?.isLearning ?? false;
  }

  /** The operator layout for the show as it is now, sent to every page. */
  private refreshLayout(fixtures = this.show.fixtures.map((f) => f.id)): void {
    this.layout = operatorLayout(this.show, fixtures, this.midi !== null, this.midi?.listening ?? 0);
    this.broadcast(JSON.stringify({ type: 'layout', layout: this.layout }));
  }

  /**
   * Wait for the next key pressed on a controller and give it to `does` (through the setKey command). Throws an
   * HttpError in plain words when it can't start; `stop` is handed the way to stop waiting (the page went away).
   */
  private async learnKey(does: KeyTarget, role: Role, stop: (cancel: () => void) => void): Promise<{ ok: true; key: string; place: string; note: string | null } | { ok: false; message: string }> {
    // Refused before any waiting: an operator gives keys to songs and quick looks only.
    if (role !== 'programmer' && !isOperatorKeyTarget(does)) throw new HttpError(401, PROGRAMMER_KEYS);
    const problem = keyTargetProblem(this.show, does);
    if (problem) throw new HttpError(400, problem);
    if (!this.midi) throw new HttpError(409, "MIDI support isn't installed on this computer, so controller keys can't be used.");
    if (!this.midi.listening) {
      throw new HttpError(409, this.midi.devices.length ? 'No controller is being listened to.' : 'No controller is connected. Plug one in, then try again.');
    }
    let learn: ReturnType<MidiDriver['learn']>;
    try {
      // Master, a group's level and the fade knob wait for a fader or a knob.
      learn = this.midi.learn(this.opts.learnMs ?? 10000, { levels: isLevelTarget(does) });
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    stop(learn.cancel);
    const key = await learn.key;
    if (!key) return { ok: false, message: 'No key was pressed. Try again.' };
    const before = this.show;
    const was = bindingOf(before, key);
    const error = await this.command({ type: 'setKey', key, does }, role);
    if (error) return { ok: false, message: error };
    const place = keyPlace(key);
    const note = was && !sameTarget(was.does, does)
      ? `${place[0]!.toUpperCase()}${place.slice(1)} was ${targetName(before, was.does)}; it is now ${targetName(this.show, does)}.`
      : null;
    this.log(`Controller key: ${keyLabel(key)} is now ${targetName(this.show, does)}`);
    return { ok: true, key: keyLabel(key), place, note };
  }

  /** Settings › Controller keys: the devices, the switches, and every fixed action with its key. */
  private controllerView() {
    const c = controllerOf(this.show);
    const groups = this.layout ? lightGroups(this.layout) : [];
    // A place on the APC mini that has a key of its own no longer does its standard job.
    const taken = new Set(c.keys.filter((b) => isApcMini(b.key.device)).map((b) => keyPlace(b.key)));
    const standard = (place: string | null) => (place && c.apcLayout && !taken.has(place) ? place : null);
    const actions: { section: string; label: string; hold: string | null; does: KeyTarget; key: string | null; standard: string | null }[] = [];
    const add = (section: string, does: KeyTarget, hold: string | null, place: string | null) => {
      const key = keyOf(this.show, does);
      actions.push({ section, label: targetName(this.show, does), hold, does, key: key ? keyLabel(key) : null, standard: standard(place) });
    };
    const run = 'Running the service';
    add(run, { kind: 'next' }, null, 'side button 1');
    add(run, { kind: 'backToLook' }, null, 'side button 2');
    add(run, { kind: 'undo' }, null, 'side button 3');
    add(run, { kind: 'basic' }, null, 'side button 4');
    add(run, { kind: 'blackout' }, 'hold 1 s', 'side button 6');
    add(run, { kind: 'flashAll' }, 'hold', 'side button 5');
    groups.forEach((g, k) => add(run, { kind: 'flash', group: g.id }, 'hold', k < 8 ? `lower button ${k + 1}` : null));
    add('Levels', { kind: 'master' }, null, 'fader 9');
    groups.forEach((g, k) => add('Levels', { kind: 'groupLevel', group: g.id }, null, k < 8 ? `fader ${k + 1}` : null));
    add('Levels', { kind: 'fadeKnob' }, null, null);
    for (const value of [...FADE_STEPS.slice(1), null]) add('Levels', { kind: 'fadeTime', value }, null, null);
    add('Tempo', { kind: 'tap' }, null, null);
    add('Tempo', { kind: 'tempoStep', times: 2 }, null, null);
    add('Tempo', { kind: 'tempoStep', times: 0.5 }, null, null);
    return {
      midi: this.midi !== null,
      devices: this.midi?.devices ?? [],
      apcLayout: c.apcLayout,
      learning: this.learning,
      keys: c.keys.map((b) => ({ does: b.does, label: targetName(this.show, b.does), key: keyLabel(b.key) })),
      actions,
    };
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
      // The new engine starts with no Undo steps of its own; the show's are kept.
      this.undoLog = this.undoLog.filter((step) => step !== 'stage');
      setTimeout(() => this.startWorker(), 200);
    });
    this.post({ type: 'init', show: this.engineShow(), runtime: this.latestRuntime, artnetRedirect: this.opts.artnetRedirect });
  }

  private post(msg: ToWorker): void {
    this.worker?.postMessage(msg);
  }

  private onWorker(msg: FromWorker, markReady: () => void): void {
    switch (msg.type) {
      case 'ready':
        this.refreshLayout(msg.fixtures);
        this.midi?.update(this.layout, this.latestState);
        // Ready once commands work: the layout and the engine's first state (it may come just before or after).
        if (this.latestState) markReady();
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
        this.engineState = msg.state;
        this.publishState();
        if (this.layout) markReady();
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

  /**
   * Validate, check permissions and run a command. Returns an error message or null.
   * `tablet`: the WebSocket it came from, for Blind's commands and the show edits that save its draft.
   */
  async command(input: unknown, role: Role, tablet?: WebSocket): Promise<string | null> {
    return (await this.run(input, role, tablet)).error;
  }

  /** A stage command from the timeline runner: runs on the live stage and adds no Undo step. Returns an error message or null. */
  async quietStageCommand(cmd: StageCommand): Promise<string | null> {
    return (await this.stageCommand(cmd, { quiet: true })).error;
  }

  /** What a live light group's level follows (a voice, 0–1), or null for nothing; the engine smooths it. */
  followLevel(group: string, value: number | null): void {
    this.post({ type: 'follow', group, value });
  }

  /** Like `command`, and also says whether the command added a step to the Undo list. */
  private async run(input: unknown, role: Role, tablet?: WebSocket): Promise<{ error: string | null; recorded: boolean }> {
    const parsed = Command.safeParse(input);
    if (!parsed.success) return { error: `invalid command: ${parsed.error.issues.map((i) => i.message).join('; ')}`, recorded: false };
    const cmd = parsed.data;
    if (isManualCommand(cmd) && role !== 'programmer' && !this.show.operator.manualForOperators) {
      return { error: 'manual control is not enabled for operators', recorded: false };
    }
    if (isBlindCommand(cmd)) return this.blindCommand(cmd, tablet);
    if (cmd.type === 'setKey' || cmd.type === 'clearKey' || cmd.type === 'resetKeys') return this.keyCommand(cmd, role, tablet);
    // Only Go sends a whole stage, from a tablet's draft.
    if (cmd.type === 'applyStage') return { error: 'Use Prepare and Go to send a whole stage.', recorded: false };
    if (isShowEdit(cmd)) {
      try {
        await this.editShow(cmd, tablet ? this.blind.get(tablet) : undefined);
      } catch (err) {
        return { error: (err as Error).message, recorded: false };
      }
      return { error: null, recorded: true };
    }
    return this.stageCommand(cmd);
  }

  /** Run a command on the live stage (Undo of a show edit puts the show back instead). */
  private async stageCommand(cmd: StageCommand, opts?: { quiet?: boolean }): Promise<{ error: string | null; recorded: boolean }> {
    if (cmd.type === 'undo') {
      const last = this.undoLog.at(-1);
      if (last && last !== 'stage') {
        // Undo of a show edit puts the show back and leaves the stage as it is.
        this.undoLog.pop();
        try {
          // The stage may be running a hidden preset that Save made; keep it, or the
          // next Save or a restart would find it gone.
          // Groups an edit in Prepare moved onto copies go back onto their own colours, which look the same again.
          const pins = this.undoKeep.get(last);
          // The programmer's keys and the controller switches aren't Undo steps: they stay as they are.
          await this.operatorSave(keepControllerKeys(keepCustomPresets(last, this.show), this.show), pins && { pins });
        } catch (err) {
          this.undoLog.push(last); // still there to try again
          return { error: (err as Error).message, recorded: false };
        }
        this.publishState();
        return { error: null, recorded: false };
      }
      // A stage step (or an empty list, after a restart) is the engine's to undo.
      if (last) this.undoLog.pop();
    }
    const reply = await this.request<{ error: string | null; recorded?: boolean }>((id) => ({ type: 'command', id, cmd, ...(opts?.quiet ? { quiet: true } : {}) }));
    if (reply.recorded) this.remember('stage');
    return { error: reply.error, recorded: !!reply.recorded };
  }

  /**
   * Controller keys. Songs' and quick looks' keys are operator edits and Undo steps, like a rename. Every other key,
   * a key that does another of those now, and Reset are the programmer's (Settings) and no Undo steps.
   */
  private async keyCommand(cmd: Extract<Command, { type: 'setKey' | 'clearKey' | 'resetKeys' }>, role: Role, tablet?: WebSocket): Promise<{ error: string | null; recorded: boolean }> {
    const was = cmd.type === 'setKey' ? bindingOf(this.show, cmd.key) : null;
    const operators = cmd.type !== 'resetKeys' && isOperatorKeyTarget(cmd.does) && (!was || isOperatorKeyTarget(was.does));
    // On the APC mini a fader or button the standard layout uses (Master, Next, a group's Flash) is a fixed job too.
    const standard = operators && role !== 'programmer' && cmd.type === 'setKey' && !was ? this.standardJob(cmd.key) : null;
    if (standard) {
      return { error: `That ${standard.what} is ${standard.job} on the APC mini. Only the programmer can give it another job: enter the PIN in Settings.`, recorded: false };
    }
    if (!operators && role !== 'programmer') {
      // A song's key that is another job's key now: say which.
      if (cmd.type === 'setKey' && was && isOperatorKeyTarget(cmd.does)) {
        return { error: `That key is ${targetName(this.show, was.does)}. Only the programmer can give it another job: enter the PIN in Settings.`, recorded: false };
      }
      return { error: PROGRAMMER_KEYS, recorded: false };
    }
    if (operators) {
      try {
        await this.editShow(cmd, tablet ? this.blind.get(tablet) : undefined);
      } catch (err) {
        return { error: (err as Error).message, recorded: false };
      }
      return { error: null, recorded: true };
    }
    try {
      const next = cmd.type === 'setKey' ? assignKey(this.show, cmd.key, cmd.does).show : cmd.type === 'clearKey' ? clearKey(this.show, cmd.does) : resetApcKeys(this.show);
      // Reset (it takes every key on the APC mini, songs' too) and Clear can't be undone: the show before them is kept
      // as a backup (Settings › Backups) each time.
      await this.controllerSave(next, cmd.type !== 'setKey');
    } catch (err) {
      return { error: (err as Error).message, recorded: false };
    }
    return { error: null, recorded: false };
  }

  /**
   * What a key does in the APC mini's standard layout while it is on: a fader (a group's level, Master), a side button
   * (Next, Back to saved, Undo, Basic lights, Flash all, Blackout) or a button under the pads (a group's Flash). Null
   * for anything else: a pad (songs and colours, which operators may give to songs), another controller, layout off.
   */
  private standardJob(key: ControlKey): { what: 'fader' | 'button'; job: string } | null {
    if (!controllerOf(this.show).apcLayout || !isApcMini(key.device) || key.channel !== 1) return null;
    const groups = this.layout ? lightGroups(this.layout) : [];
    const m = /^(fader|side button|lower button) (\d)$/.exec(keyPlace(key));
    if (!m) return null;
    const n = Number(m[2]);
    const group = groups[n - 1];
    if (m[1] === 'fader') {
      const job = n === 9 ? 'Master' : group ? targetName(this.show, { kind: 'groupLevel', group: group.id }) : `the level of group ${n}`;
      return { what: 'fader', job };
    }
    if (m[1] === 'lower button') {
      return { what: 'button', job: group ? targetName(this.show, { kind: 'flash', group: group.id }) : `Flash for group ${n}` };
    }
    const side: KeyTarget[] = [{ kind: 'next' }, { kind: 'backToLook' }, { kind: 'undo' }, { kind: 'basic' }, { kind: 'flashAll' }, { kind: 'blackout' }];
    const does = side[n - 1];
    return does ? { what: 'button', job: targetName(this.show, does) } : null;
  }

  /**
   * A change to the controller settings that isn't an Undo step (Settings' keys and switches): saved like an operator
   * edit, so the Undo list stays and only the first one after a programmer save keeps a backup (or each, with `backup`).
   */
  private async controllerSave(show: Show, backup = false): Promise<void> {
    await this.putShow(show, backup || !this.operatorBackedUp);
    this.operatorBackedUp = true;
  }

  private remember(step: Show | 'stage'): void {
    this.undoLog.push(step);
    if (this.undoLog.length > UNDO_KEPT) this.undoLog.shift();
  }

  // ---- Blind: a draft of the stage per tablet ----

  private async blindCommand(cmd: BlindCommand, tablet: WebSocket | undefined): Promise<{ error: string | null; recorded: boolean }> {
    const done = (error: string | null, recorded = false) => ({ error, recorded });
    if (!tablet) return done('Prepare works on a tablet only.');
    const session = this.blind.get(tablet);
    switch (cmd.type) {
      case 'blindStart': {
        const turn = this.nextBlindTurn(tablet);
        // A tablet already in Blind gets a fresh draft in place of its own, so it doesn't count.
        const full = () => this.blind.size - (this.blind.has(tablet) ? 1 : 0) >= MAX_DRAFTS;
        if (full()) return done(TOO_MANY_DRAFTS);
        // The runtime and the stage clocks of the same moment, so the draft's effects run in step.
        let live: { runtime: RuntimeState; clock: StageClock };
        try {
          live = await this.liveStage();
        } catch (err) {
          return done((err as Error).message);
        }
        // A tablet that went away, left Blind or started it again while the stage was on its way
        // gets no draft from this start.
        if (tablet.readyState !== tablet.OPEN || this.blindTurn.get(tablet) !== turn) return done(null);
        // Other tablets may have started Blind meanwhile.
        if (full()) return done(TOO_MANY_DRAFTS);
        let fresh: BlindSession;
        try {
          fresh = new BlindSession(this.engineShow(), live.runtime, live.clock, performance.now() / 1000);
        } catch (err) {
          return done(this.draftProblem(tablet, err));
        }
        this.blind.set(tablet, fresh);
        this.blindTimerFits();
        this.sendDraft(tablet);
        return done(this.blind.get(tablet) === fresh ? null : BLIND_PROBLEM);
      }
      case 'blindEnd':
        this.nextBlindTurn(tablet);
        this.dropDraft(tablet);
        return done(null);
      case 'draft': {
        if (!session) return done(BLIND_OFF);
        let error: string | null;
        try {
          error = session.apply(cmd.cmd, performance.now() / 1000, (g) => this.isSmokeGroup(g));
        } catch (err) {
          return done(this.draftProblem(tablet, err));
        }
        this.sendDraft(tablet);
        return done(this.blind.get(tablet) === session ? error : BLIND_PROBLEM);
      }
      case 'blindGo': {
        if (!session) return done(BLIND_OFF);
        let stage: RuntimeState;
        try {
          stage = session.engine.runtime();
        } catch (err) {
          return done(this.draftProblem(tablet, err));
        }
        // The live engine fades with its own Fade setting (each look's own when it is Auto), as for looks.
        const reply = await this.stageCommand({ type: 'applyStage', stage });
        if (!reply.error && this.blind.get(tablet) === session) this.dropDraft(tablet);
        return reply;
      }
    }
  }

  /** A new turn for this tablet's Blind: a start that was still waiting for the stage makes no draft now. */
  private nextBlindTurn(tablet: WebSocket): number {
    const turn = (this.blindTurn.get(tablet) ?? 0) + 1;
    this.blindTurn.set(tablet, turn);
    return turn;
  }

  private dropDraft(tablet: WebSocket): void {
    this.blind.delete(tablet);
    this.blindTimerFits();
  }

  /**
   * A tablet's draft threw. Only that draft ends, never the service, and the lights are not touched:
   * the tablet is sent `draftEnded` with the reason, and the command that met the problem (if any)
   * is answered with the same reason. Returns the reason.
   */
  private draftProblem(tablet: WebSocket, err: unknown): string {
    this.log(`Blind: a tablet's draft stopped: ${(err as Error)?.stack ?? String(err)}`);
    this.nextBlindTurn(tablet);
    this.dropDraft(tablet);
    if (tablet.readyState === tablet.OPEN) tablet.send(JSON.stringify({ type: 'draftEnded', reason: BLIND_PROBLEM }));
    return BLIND_PROBLEM;
  }

  /** The draft timer runs while any tablet is in Blind. */
  private blindTimerFits(): void {
    if (this.blind.size && !this.blindTimer) {
      this.blindTimer = setInterval(() => this.frameDrafts(), VISUAL_EVERY);
      this.blindTimer.unref();
    } else if (!this.blind.size && this.blindTimer) {
      clearInterval(this.blindTimer);
      this.blindTimer = null;
    }
  }

  /** Each draft's picture and (when it changed) state, to its own tablet only. */
  private frameDrafts(): void {
    const now = performance.now() / 1000;
    for (const [tablet, session] of this.blind) {
      let visual: Uint8Array;
      try {
        if (this.latestState) session.follow(this.latestState, now);
        visual = session.visual(now);
      } catch (err) {
        this.draftProblem(tablet, err);
        continue;
      }
      // A slow device skips frames rather than falling behind, as with the live picture.
      if (tablet.readyState === tablet.OPEN && tablet.bufferedAmount < 64 * 1024) {
        tablet.send(JSON.stringify({ type: 'draftVisual', data: Buffer.from(visual.buffer, visual.byteOffset, visual.byteLength).toString('base64') }));
      }
      this.sendDraft(tablet, now);
    }
  }

  /** The tablet's draft state, when it changed since the last one it was sent. */
  private sendDraft(tablet: WebSocket, now = performance.now() / 1000): void {
    let state: LiveState | null | undefined;
    try {
      state = this.blind.get(tablet)?.state(now, this.latestState, (g) => this.isSmokeGroup(g));
    } catch (err) {
      this.draftProblem(tablet, err);
      return;
    }
    if (state && tablet.readyState === tablet.OPEN) tablet.send(JSON.stringify({ type: 'draftState', state }));
  }

  /**
   * Operator edits to the running order and quick looks. Throws with a plain message when refused.
   * `draft`: the tablet is in Blind, so Save, Add song and Save as quick look (and a quick look's Update from the stage) store its draft instead of the stage.
   */
  private async editShow(cmd: ShowEdit, draft?: BlindSession): Promise<void> {
    const usesStage = cmd.type === 'saveItem' || cmd.type === 'addSong' || cmd.type === 'saveQuickLook' || (cmd.type === 'editQuickLook' && !!cmd.fromStage);
    // Deleting a colour only looks at the stage to keep a lit colour; it is fine during Blackout.
    const stage = usesStage && draft ? draft.engine.runtime() : usesStage || cmd.type === 'deleteColour' ? await this.stage() : null;
    // In Prepare an edit never changes the lights: what the stage shows now (each group, and Blackout's memory), taken
    // with the show it runs. A snapshot taken while another edit was on its way to the engine is taken again; the
    // engine also refuses a pin for a group that moved on meanwhile.
    let live: RuntimeState | null = null;
    for (let tries = 0; draft && tries < 3; tries++) {
      const shown = this.show;
      live = await this.stage();
      if (this.show === shown) break;
    }
    // A draft made during Blackout is still saved: the groups it lit keep their colours, the rest are stored as Off,
    // which is what its picture shows.
    if (usesStage && !draft && stage?.look === BLACKOUT) throw new Error('Blackout is on. Bring the lights back, then save.');
    // Nothing below waits until the show is replaced, so no other edit can slip in between.
    const before = this.show;
    let next: Show;
    switch (cmd.type) {
      case 'saveItem':
        // Quick looks are made with Save stage as quick look, never overwritten by Save.
        if (!before.operator.runningOrder.includes(cmd.id)) throw new Error('only running-order items can be saved');
        next = saveItem(before, cmd.id, stage!);
        break;
      case 'addSong': next = addSong(before, cmd.after, stage!).show; break;
      case 'renameItem': next = renameItem(before, cmd.id, cmd.name); break;
      case 'deleteItem': next = deleteItem(before, cmd.id); break;
      case 'moveItem': next = moveItem(before, cmd.id, cmd.to); break;
      case 'saveQuickLook': next = saveQuickLook(before, { name: cmd.name, tab: cmd.tab, groups: cmd.groups }, stage!).show; break;
      // Rename, tab, groups, delete and move never look at the stage, so they are fine during Blackout; only Update from the stage does.
      case 'editQuickLook': next = editQuickLook(before, cmd, usesStage ? stage! : undefined); break;
      case 'deleteQuickLook': next = deleteQuickLook(before, cmd.look); break;
      case 'moveQuickLook': next = moveQuickLook(before, cmd.look, cmd.to); break;
      // Preview edits never look at the stage, so they are fine during Blackout.
      case 'itemGroup': next = setItemGroup(before, cmd.item, cmd); break;
      case 'itemTempo': next = setItemTempo(before, cmd.item, cmd.bpm); break;
      case 'itemQuickLook': next = applyQuickLookToItem(before, cmd.item, cmd.look); break;
      // A colour doesn't depend on the stage, so it is fine during Blackout.
      case 'addColour': next = addColour(before, cmd).show; break;
      case 'editColour': next = editColour(before, cmd).show; break;
      // Effects are edited like colours: never from the stage, fine during Blackout.
      case 'addEffect': next = addEffect(before, cmd).show; break;
      case 'editEffect': next = editEffect(before, cmd); break;
      // Controller keys don't look at the stage either.
      case 'setKey': next = assignKey(before, cmd.key, cmd.does).show; break;
      case 'clearKey': next = clearKey(before, cmd.does); break;
      case 'resetKeys': next = resetApcKeys(before); break;
      case 'deleteColour': {
        // A colour that is lit (or was, before Blackout) stays: the group would name a preset that is gone.
        next = deleteColour(before, cmd.preset); // refuses while a look uses it
        const found = before.presets.find((p) => p.id === cmd.preset)!;
        const group = found.group;
        // In Blind, a colour the tablet's draft runs stays too, so Save and Go can still use it.
        const lit = (s: RuntimeState) => s.groups[group] === cmd.preset || s.beforeBlackout?.[group] === cmd.preset;
        if (lit(stage!) || (draft && lit(draft.engine.runtime()))) {
          if (isEffectPreset(found)) throw new Error('That effect is on stage now. Pick something else for the group first.');
          throw new Error('That colour is on stage now. Pick another colour for the group first.');
        }
        break;
      }
    }
    // Groups on stage showing a colour or effect the edit changes carry on as a hidden copy of it, with no fade.
    const kept = live ? keepLitPresets(before, next, live) : null;
    await this.operatorSave(kept?.show ?? next, kept ? { pins: kept.pins } : undefined);
    // Tempo edits of one song within 3 s of each other (tapping along, a held + or −) are one Undo step.
    const at = Date.now();
    const joins = cmd.type === 'itemTempo' && this.tempoEdit !== null && this.tempoEdit.item === cmd.item
      && at - this.tempoEdit.at <= TEMPO_RUN_MS && this.undoLog.at(-1) === this.tempoEdit.step;
    if (!joins) this.remember(before);
    if (kept) this.undoKeep.set(before, kept.pins.map((p) => ({ group: p.group, from: p.to, to: p.from })));
    this.tempoEdit = cmd.type === 'itemTempo' ? { item: cmd.item, at, step: this.undoLog.at(-1)! } : null;
    // Undo lights up at once, without waiting for the engine's next state.
    this.publishState();
  }

  /**
   * The engine's stage and look as they are right now, straight from the worker, with the live
   * effects the groups run and the stage tempo, so Save keeps both.
   */
  private async stage(): Promise<RuntimeState> {
    return (await this.liveStage()).runtime;
  }

  /** The stage as stage() gives it, and the live stage clocks at the same moment (for a Blind draft). */
  private async liveStage(): Promise<{ runtime: RuntimeState; clock: StageClock }> {
    const reply = await this.request<{ runtime?: RuntimeState; clock?: StageClock; error?: string }>((id) => ({ type: 'snapshot', id }));
    if (!reply.runtime || !reply.clock) throw new Error(reply.error ?? 'engine did not answer');
    return { runtime: reply.runtime, clock: reply.clock };
  }

  async timing(reset = false): Promise<TimingStats> {
    const reply = await this.request<{ stats: TimingStats }>((id) => ({ type: 'timing', id, reset }));
    return reply.stats;
  }

  /**
   * Replace the show (programmer edits, import). Saves it with a backup first.
   * Undo can no longer take the show back past this, as that would throw these changes away too.
   */
  async setShow(show: Show): Promise<void> {
    const hadShowSteps = this.undoLog.some((step) => step !== 'stage');
    this.undoLog = this.undoLog.filter((step) => step === 'stage');
    await this.putShow(show);
    this.operatorBackedUp = false;
    if (hadShowSteps) this.publishState();
  }

  /** An operator edit or its Undo: saved like any change, but only the first one keeps a backup. */
  private async operatorSave(show: Show, keep?: { pins: PresetPin[] }): Promise<void> {
    await this.putShow(show, !this.operatorBackedUp, keep);
    this.operatorBackedUp = true;
  }

  /** Save the show, hand it to the engine and send every device the new layout. */
  private async putShow(show: Show, backup = true, keep?: { pins: PresetPin[] }): Promise<void> {
    // A show that arrives without a running order (import, restore, merge) gets one, as at start,
    // and Basic lights always exists and comes first, whatever Compare with a file took away.
    show = ensureShow(show);
    this.store.saveShow(show, { backup });
    this.show = show;
    // Only the live engine takes the pins: the drafts show the edit.
    this.post({ type: 'show', show: this.engineShow(), keep });
    // Drafts run the edited show too, so a colour added in Blind can be used there.
    const now = performance.now() / 1000;
    for (const [tablet, session] of this.blind) {
      try {
        session.setShow(this.engineShow(), now);
      } catch (err) {
        // The edit still goes through (saved, and the engine has it); only this draft ends.
        this.draftProblem(tablet, err);
      }
    }
    this.watchNode();
    await this.syncOsc();
    // The fixtures come from the new show, in its order (as the engine takes them): a show with other
    // fixtures (an import) must not be drawn from the old ones, which would leave the stage view empty.
    if (this.layout) this.refreshLayout();
    else this.broadcast(JSON.stringify({ type: 'layout', layout: null }));
    this.midi?.configure(controllerOf(this.show));
    this.midi?.update(this.layout, this.latestState);
  }

  // ---- WebSocket ----

  private onSocket(ws: WebSocket, role: Role): void {
    if (this.layout) ws.send(JSON.stringify({ type: 'layout', layout: this.layout }));
    if (this.latestState) ws.send(JSON.stringify({ type: 'state', state: this.latestState }));
    const held = new Set<string>();
    this.flashes.set(ws, held);
    let closed = false;
    // A tablet that drops off (closed, asleep, out of Wi-Fi) must not leave its Flash on.
    // Groups another tablet or a device is still holding stay on.
    const release = (groups: Iterable<string>) => this.releaseFlash(groups);
    this.missedPongs.set(ws, 0);
    ws.on('pong', () => this.missedPongs.set(ws, 0));
    ws.on('close', () => {
      closed = true;
      this.missedPongs.delete(ws);
      this.flashes.delete(ws);
      release(held);
      // Its Blind draft goes with it; nothing reaches the stage.
      this.blindTurn.delete(ws);
      this.dropDraft(ws);
    });
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string; ref?: unknown; cmd?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      // Valid JSON that isn't an object ("null", a number) is ignored, never thrown on.
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'command') {
        let error: string | null;
        try {
          error = await this.command(msg.cmd, role, ws);
        } catch (err) {
          // Never left to reject unhandled, which would stop the service.
          this.log(`Command failed: ${(err as Error)?.stack ?? String(err)}`);
          error = 'That did not work. The lights were not changed.';
        }
        const cmd = Command.safeParse(msg.cmd);
        if (!error && cmd.success && cmd.data.type === 'flash') {
          if (closed) {
            // The tablet went away while its Flash was on its way.
            if (cmd.data.on) release(cmd.data.groups);
          } else {
            // The engine leaves smoke groups out of a flash of several groups (only a Puff runs them),
            // so this tablet doesn't hold them; counting them would keep another tablet's Puff on.
            const several = cmd.data.groups.length > 1;
            for (const g of cmd.data.groups) {
              if (cmd.data.on && several && this.isSmokeGroup(g)) continue;
              if (cmd.data.on) held.add(g);
              else held.delete(g);
            }
          }
        }
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', ref: msg.ref ?? null, error }));
      }
    });
  }

  /** Put out the Flash on these groups, except those a tablet or a device still holds. */
  private releaseFlash(groups: Iterable<string>): void {
    const free = this.freeOfFlash(groups);
    if (free.length && !this.stopping) void this.run({ type: 'flash', groups: free, on: false }, 'operator');
  }

  /** The groups no tablet and no device is holding a Flash on. */
  private freeOfFlash(groups: Iterable<string>): string[] {
    const holders = [...this.flashes.values(), ...this.deviceFlashes.values()];
    return [...groups].filter((g) => !holders.some((set) => set.has(g)));
  }

  // ---- Devices (APC mini, OSC, HTTP for Companion) ----

  /**
   * Run what a device asked for as the operator would, against the live stage. `source` names the device
   * ('http', 'osc', 'midi:<port>'): a Flash it holds is put out when `releaseDevice(source)` is called, and after 15 s.
   * Returns a plain-words reason when it can't be done, else null.
   */
  async device(action: DeviceAction, source: string): Promise<string | null> {
    if (!this.layout || !this.latestState) return 'Light Runner is still starting.';
    // Tap tempo: each device counts its own taps; the second tap on sets the tempo.
    if (action.kind === 'tap') {
      let taps = this.taps.get(source);
      if (!taps) this.taps.set(source, (taps = new TapTempo()));
      const bpm = taps.tap(Date.now());
      if (bpm === null) return null;
      action = { kind: 'tempo', bpm };
    }
    // Master up and down pressed faster than the state arrives step from the last Master a device sent.
    const now = Date.now();
    const recent = this.deviceMaster && now - this.deviceMaster.at < DEVICE_MASTER_MS ? this.deviceMaster.value : null;
    const state = recent === null ? this.latestState : { ...this.latestState, master: recent };
    const cmd = commandFor(action, this.layout, state);
    if ('error' in cmd) return cmd.error;
    if (cmd.type === 'master') this.deviceMaster = { value: cmd.value, at: now };
    if (cmd.type === 'flash' && !cmd.on) {
      // Letting go puts out only the groups no tablet or other device still holds.
      this.holdDeviceFlash(source, cmd.groups, false);
      const free = this.freeOfFlash(cmd.groups);
      return free.length ? this.command({ ...cmd, groups: free }, 'operator') : null;
    }
    // A Flash is held before it is sent: a quick tap's "off" can arrive while the "on" is on its way, and
    // must find it held (or the late "on" would leave a hold behind). Taken back if the "on" fails.
    const added = cmd.type === 'flash' ? this.holdDeviceFlash(source, cmd.groups, true) : [];
    const error = await this.command(cmd, 'operator');
    if (error && added.length) this.holdDeviceFlash(source, added, false);
    return error;
  }

  /** A device went away (unplugged, port closed): its held Flash goes out. */
  releaseDevice(source: string): void {
    const held = this.deviceFlashes.get(source);
    this.deviceFlashes.delete(source);
    for (const g of held ?? []) this.clearFlashTimer(source, g);
    if (held?.size) this.releaseFlash(held);
  }

  /** Holds (or lets go of) a device's Flash on these groups. Returns the groups it newly holds. */
  private holdDeviceFlash(source: string, groups: string[], on: boolean): string[] {
    let held = this.deviceFlashes.get(source);
    if (!held) this.deviceFlashes.set(source, (held = new Set()));
    const added: string[] = [];
    // The engine leaves smoke out of a Flash of several groups (only a Puff runs it), so it isn't held then.
    const several = groups.length > 1;
    for (const g of groups) {
      if (on && several && this.isSmokeGroup(g)) continue;
      if (!on) {
        held.delete(g);
        this.clearFlashTimer(source, g);
      } else if (!held.has(g)) {
        held.add(g);
        added.push(g);
        const timer = setTimeout(() => {
          this.deviceFlashTimers.delete(flashKey(source, g));
          this.deviceFlashes.get(source)?.delete(g);
          this.releaseFlash([g]);
        }, this.opts.deviceFlashMs ?? DEVICE_FLASH_MS);
        timer.unref();
        this.deviceFlashTimers.set(flashKey(source, g), timer);
      }
    }
    return added;
  }

  private clearFlashTimer(source: string, group: string): void {
    const key = flashKey(source, group);
    clearTimeout(this.deviceFlashTimers.get(key));
    this.deviceFlashTimers.delete(key);
  }

  /** What Companion polls: the stage in a flat shape for its variables. */
  private companion(): unknown {
    const layout = this.layout;
    const state = this.latestState;
    if (!layout || !state) throw new HttpError(503, 'Light Runner is still starting.');
    const order = layout.runningOrder;
    const nameOf = (id: string | null) => {
      if (id === null) return '';
      if (id === 'blackout') return 'Blackout';
      if (id === 'safe') return order.find((i) => i.id === layout.basicLights)?.name ?? 'Basic lights';
      return order.find((i) => i.id === id)?.name ?? layout.looks.find((l) => l.id === id)?.name ?? '';
    };
    const next = nextItemId(layout, state);
    const onStage = stageIndexOf(layout, state);
    const blackedOut = state.look === BLACKOUT;
    const colourName = (group: OperatorLayout['groups'][number], preset: string | null | undefined) => {
      if (preset === null || preset === undefined || preset === '__blackout') return 'Off';
      if (preset === '__safe') return 'Basic light';
      return group.presets.find((p) => p.id === preset)?.name ?? 'Custom';
    };
    return {
      look: state.look,
      lookName: nameOf(state.look),
      next,
      nextName: nameOf(next),
      changed: state.lookChanged,
      blackout: blackedOut,
      // Flash does nothing during Blackout, so it isn't reported then (the iPad does the same).
      flashing: !blackedOut && state.flashing.length > 0,
      master: Math.round(state.master * 100),
      tempo: state.tempo,
      groups: lightGroups(layout).map((g, k) => ({
        n: k + 1,
        name: g.name,
        colour: colourName(g, state.groups[g.id]?.preset),
        level: Math.round((state.groups[g.id]?.level ?? 0) * 100),
      })),
      items: order.map((item, k) => ({ n: k + 1, name: item.name, onStage: k === onStage })),
    };
  }

  private isSmokeGroup(id: string): boolean {
    return this.show.groups.some((g) => g.id === id && g.kind === 'smoke');
  }

  /** Pings every tablet; one that missed the last two pings is dropped, which ends its Flash. */
  private checkTablets(): void {
    for (const ws of this.wss?.clients ?? []) {
      const missed = this.missedPongs.get(ws) ?? 0;
      if (missed >= 2) {
        this.log('A tablet stopped answering; dropped it');
        ws.terminate();
        continue;
      }
      this.missedPongs.set(ws, missed + 1);
      ws.ping();
    }
  }

  private broadcast(text: string): void {
    for (const ws of this.wss?.clients ?? []) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  // ---- HTTP ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLocalAddress(req.socket.remoteAddress)) throw new HttpError(403, 'local network only');
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/api/launcher/stop') return this.launcherStop(req, res);
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

  /**
   * The launcher stops a server it didn't start (one left running, or started before it): only from this computer
   * (a loopback connection, addressed to localhost: no page in a browser can make it) and only with the token from
   * server.json, which only this computer's user can read.
   */
  private launcherStop(req: IncomingMessage, res: ServerResponse): void {
    const token = this.markerToken;
    if (!token || !this.opts.onStopRequest) throw new HttpError(404, 'no such endpoint');
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const from = req.socket.remoteAddress;
    if (from !== '127.0.0.1' && from !== '::1' && from !== '::ffff:127.0.0.1') throw new HttpError(403, 'only from this computer');
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') throw new HttpError(403, 'only from this computer');
    if (req.headers.origin !== undefined) throw new HttpError(403, 'not from a web page');
    const given = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) throw new HttpError(401, 'wrong token');
    const stop = this.opts.onStopRequest;
    res.once('finish', () => {
      this.log('Stopping: asked by the Light Runner launcher');
      stop();
    });
    json(res, 202, { stopping: true });
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
    const perUniverse: Record<number, number> = {};
    for (const f of this.show.fixtures) perUniverse[f.universe] = (perUniverse[f.universe] ?? 0) + 1;
    return {
      showName: this.show.name,
      output: s.output,
      routes: s.routes ?? [],
      /** Fixtures patched on each universe. */
      fixturesPerUniverse: perUniverse,
      /** Universes in the patch that no output sends (a USB interface sends one). */
      unsent: planRoutes(s, this.show.fixtures.map((f) => f.universe)).unsent,
      outputEnabled: s.outputEnabled,
      forcedOff: Boolean(this.opts.output),
      outputStatus: this.latestState?.output ?? null,
      frameRate: s.frameRate,
      gamma: s.gamma,
      manualForOperators: this.show.operator.manualForOperators,
      /** Who to call: the Settings page edits two plain fields, so an absent one is empty here. */
      contact: { name: s.contact?.name ?? '', phone: s.contact?.phone ?? '' },
      looks: this.show.looks.map((l) => ({ id: l.id, name: l.name })),
      universes: [...new Set(this.show.fixtures.map((f) => f.universe))].sort((a, b) => a - b),
      fixtures: this.show.fixtures.length,
      pinSet: Boolean(s.pinHash),
      osc: { enabled: s.osc?.enabled ?? false, port: s.osc?.port ?? 8000 },
      oscProblem: this.oscProblem,
      apc: this.apcStatus(),
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
      'PUT /api/controller', 'POST /api/keys/reset',
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
        // A show file is shared and kept: it never carries this installation's PIN hash (a 4 to 6 digit PIN is easy
        // to work out from its hash). Opening a file keeps the PIN here, so a file without one loses nothing.
        const { pinHash: _pin, ...settings } = this.show.settings;
        res.end(JSON.stringify({ ...this.show, settings }, null, 2));
        return true;
      }
      case 'PUT /api/show': {
        let show: Show;
        try {
          show = parseShow(await readJson(req, 10 * 1024 * 1024));
        } catch (err) {
          // Too large (413) and not JSON keep their own words; anything else is not a show.
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, `not a valid show: ${(err as Error).message}`);
        }
        const fromPatch = url.searchParams.get('source') === 'patch';
        // Patch never edits settings, and a Patch page left open holds an old copy of them: keep the live ones
        // (Send DMX, output, routes), or saving the patch could start sending DMX again.
        // An imported file keeps this installation's PIN: it must not change who can log in. It keeps this computer's
        // Listen switches too (they name the controllers plugged in here); its keys and APC mini layout switch are taken.
        // It keeps this installation's Send DMX switch as well, so opening a file never starts sending to the lights by
        // itself; the file's output settings (the node's address and so on) are taken.
        // Controller keys are assigned while Patch may be open, so its copy keeps the live ones too, and so do the timelines
        // (they are made on the Timeline page).
        show = fromPatch
          ? { ...show, operator: { ...show.operator, controller: this.show.operator.controller }, settings: this.show.settings, timelines: this.show.timelines }
          : withIgnored({ ...show, settings: { ...show.settings, pinHash: this.show.settings.pinHash, outputEnabled: this.show.settings.outputEnabled } }, this.show.operator.controller?.ignored);
        await this.setShow(show);
        this.log(fromPatch ? 'Patch saved' : `Imported show "${show.name}"`);
        json(res, 200, this.settingsView());
        return true;
      }
      case 'GET /api/profiles': {
        // The show's own profiles win over built-ins with the same id.
        const own = new Set(this.show.profiles.map((p) => p.id));
        const all = [...this.show.profiles, ...BUILT_IN_PROFILES.filter((p) => !own.has(p.id))];
        // `defs` is the full channel list (Patch shows it and compares two types). Types that came from the Open Fixture
        // Library or a fixture file, and the built-in ones, can't be changed: `readOnly`.
        const builtIn = new Set(BUILT_IN_PROFILES.map((p) => p.id));
        json(res, 200, all.map((p) => ({
          id: p.id, name: p.name, channels: p.channels.length, segments: profileSegments(p), roles: [...new Set(p.channels.map((c) => c.role))],
          defs: p.channels, readOnly: Boolean(p.source?.ofl) || builtIn.has(p.id), builtIn: builtIn.has(p.id),
        })));
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
      case 'PUT /api/controller': {
        // Settings › Controller keys: the standard APC mini layout, and which devices are listened to. At once, like Send DMX.
        const body = (await readJson(req)) as { apcLayout?: unknown; ignored?: unknown };
        const show: Show = structuredClone(this.show);
        const c = (show.operator.controller ??= { keys: [] });
        if (typeof body.apcLayout === 'boolean') {
          if (body.apcLayout) delete c.apcLayout;
          else c.apcLayout = false;
        }
        if (body.ignored !== undefined) {
          const list = body.ignored;
          if (!Array.isArray(list) || list.length > 64 || list.some((d) => typeof d !== 'string' || !d || d.length > 120)) {
            throw new HttpError(400, 'which devices?');
          }
          if (list.length) c.ignored = [...new Set(list as string[])];
          else delete c.ignored;
        }
        // Not an Undo step, and the show's Undo list stays.
        await this.controllerSave(parseShow(show));
        json(res, 200, this.controllerView());
        return true;
      }
      case 'POST /api/keys/reset': {
        const error = await this.command({ type: 'resetKeys' }, 'programmer');
        if (error) throw new HttpError(400, error);
        json(res, 200, this.controllerView());
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
      if (body.output !== undefined) {
        show.settings.output = OutputSettings.parse(body.output);
        const problem = outputAddressProblem(show.settings.output);
        if (problem) throw new Error(problem);
      }
      if (body.routes !== undefined) {
        const routes = OutputRoute.array().parse(body.routes);
        show.settings.routes = routes.length ? routes.sort((a, b) => a.universe - b.universe) : undefined;
      }
      if (typeof body.outputEnabled === 'boolean') show.settings.outputEnabled = body.outputEnabled;
      if (body.frameRate !== undefined) show.settings.frameRate = Number(body.frameRate);
      if (body.gamma !== undefined) show.settings.gamma = Number(body.gamma);
      if (body.osc !== undefined) show.settings.osc = OscSettings.parse(body.osc);
      if (body.contact !== undefined) show.settings.contact = contactOf(body.contact);
      if (typeof body.manualForOperators === 'boolean') show.operator.manualForOperators = body.manualForOperators;
      if (body.universe !== undefined) {
        // Move the whole rig to one universe (only for single-universe shows).
        const used = new Set(show.fixtures.map((f) => f.universe));
        if (used.size > 1) throw new Error('this show uses several universes; change them per fixture');
        const u = Number(body.universe);
        if (!Number.isInteger(u) || u < 0 || u > 32767) throw new Error('universe must be 0–32767');
        const [from] = used;
        for (const f of show.fixtures) f.universe = u;
        // A route for the rig's universe moves with it.
        const routes = show.settings.routes;
        if (routes && from !== u && !routes.some((r) => r.universe === u)) for (const r of routes) if (r.universe === from) r.universe = u;
      }
      return parseShow(show);
    } catch (err) {
      if (err instanceof ZodError) {
        const issue = err.issues[0];
        throw new HttpError(400, issue.code === 'custom' ? issue.message : `${issue.path.join('.') || 'settings'}: ${issue.message}`);
      }
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

    // What a device's button does: through `device`, so positions, Next and Flash work as on any device.
    const device = async (action: DeviceAction) => {
      const error = await this.device(action, 'http');
      if (error) throw new HttpError(400, error);
      json(res, 200, { ok: true });
    };
    /** A whole number in the address (a position), or the plain message. */
    const position = (value: string, message: string) => {
      if (!/^\d{1,6}$/.test(value)) throw new HttpError(400, message);
      return Number(value);
    };
    /** Flash's group: `all`, a position, or a light group's id. */
    const flashGroup = (value: string): number | 'all' => {
      if (value === 'all') return 'all';
      if (/^\d{1,6}$/.test(value)) return Number(value);
      const k = this.layout ? lightGroups(this.layout).findIndex((g) => g.id === value) : -1;
      if (k < 0) throw new HttpError(400, `There is no group ${value}.`);
      return k + 1;
    };

    let cmd: unknown;
    switch (route) {
      case 'GET /controller':
        return json(res, 200, this.controllerView());
      case 'POST /keys/learn': {
        const body = (await readJson(req)) as { does?: unknown };
        const does = KeyTarget.safeParse(body.does);
        if (!does.success) throw new HttpError(400, 'What should the key do?');
        // A page that stops waiting (Cancel, or it went away) ends the learn at once; watched before the learn
        // starts, so a page that went away in between is noticed too.
        let gone = false;
        let cancel: (() => void) | null = null;
        res.on('close', () => {
          if (res.writableEnded) return;
          gone = true;
          cancel?.();
        });
        const answer = await this.learnKey(does.data, this.isProgrammer(req) ? 'programmer' : 'operator', (stop) => {
          if (gone) stop();
          else cancel = stop;
        });
        return json(res, 200, answer);
      }
      case 'POST /keys/clear': {
        const body = (await readJson(req)) as { does?: unknown };
        const does = KeyTarget.safeParse(body.does);
        if (!does.success) throw new HttpError(400, 'Which key?');
        const error = await this.command({ type: 'clearKey', does: does.data }, this.isProgrammer(req) ? 'programmer' : 'operator');
        if (error) throw new HttpError(error === PROGRAMMER_KEYS ? 401 : 400, error);
        return json(res, 200, { ok: true });
      }
      case 'POST /test/midi': {
        // Test only: press keys on the simulated controllers (LIGHT_RUNNER_FAKE_MIDI=1). Never there otherwise.
        const fake = this.opts.fakeMidi;
        if (!fake) throw new HttpError(404, `no such endpoint: ${req.method} ${url.pathname}`);
        const body = (await readJson(req)) as { port?: unknown; bytes?: unknown; plug?: unknown; unplug?: unknown };
        if (typeof body.plug === 'string') fake.plug(body.plug);
        if (typeof body.unplug === 'string') fake.unplug(body.unplug);
        if (typeof body.port === 'string' && Array.isArray(body.bytes)) {
          const port = fake.opened.find((p) => p.name === body.port && !p.closed);
          if (!port) throw new HttpError(404, `${body.port} isn't open`);
          port.receive(body.bytes.map(Number));
        }
        return json(res, 200, { ok: true, ports: fake.list(), open: fake.opened.filter((p) => !p.closed).map((p) => p.name) });
      }
      case 'GET /companion':
        return json(res, 200, this.companion());
      case 'GET /state':
        res.setHeader('x-light-runner', this.opts.version ?? 'dev');
        // Its pid, so a launcher (and a second server) knows it is the one in server.json.
        res.setHeader('x-light-runner-pid', String(process.pid));
        // How many pages are open on other computers, so the launcher knows an iPad has reached it.
        res.setHeader('x-light-runner-remote-pages', String(this.remotePages.size));
        return json(res, 200, this.latestState);
      case 'GET /apc':
        return json(res, 200, this.apcStatus());
      case 'GET /looks':
        return json(res, 200, {
          looks: this.show.looks.map((l) => ({ id: l.id, name: l.name, colour: l.swatch ?? null, section: l.section ?? null })),
          presets: this.show.presets.map((p) => ({ id: p.id, name: p.name, group: p.group, colour: p.swatch ?? null })),
        });
      case 'GET /layout':
        return json(res, 200, this.layout);
      case 'GET /looks/:/visual': {
        // From this.show, so it always shows the latest edit.
        if (!this.show.looks.some((l) => l.id === parts[1])) throw new HttpError(404, `unknown look: ${parts[1]}`);
        return json(res, 200, { visual: Array.from(settledVisual(this.show, parts[1])) });
      }
      case 'POST /effect-preview': {
        // The effect editor's moving strip: the effect as it is being edited, on the group's line, at the tempo
        // and speed the page shows (the stage's when it sends none). Rendered here with the pure engine; nothing
        // goes to the lights.
        const body = EffectPreviewBody.safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, `not an effect: ${body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
        const tempo = body.data.tempo ?? this.latestState?.tempo ?? 120, speed = body.data.speed ?? this.latestState?.speed ?? 1;
        if (!this.show.groups.some((g) => g.id === body.data.group)) throw new HttpError(404, `unknown group "${body.data.group}"`);
        const out = effectFrames(this.show, body.data.group, body.data.effect, { bpm: tempo, speed });
        if (typeof out === 'string') throw new HttpError(400, out);
        const { frames, ...rest } = out;
        return json(res, 200, { ...rest, tempo, speed, frames: Buffer.from(frames.buffer, frames.byteOffset, frames.byteLength).toString('base64') });
      }
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
      case 'POST /group/:/level/:': {
        const value = percent(parts[3], 0, 100);
        // A number is a position among the light groups; anything else is a group id.
        if (/^\d+$/.test(parts[1])) return device({ kind: 'groupLevel', group: Number(parts[1]), value });
        cmd = { type: 'groupLevel', group: parts[1], value };
        break;
      }
      case 'POST /group/:/colour/:':
        return device({ kind: 'groupColour', group: position(parts[1], `There is no group ${parts[1]}.`), colour: position(parts[3], `Group ${parts[1]} has no colour ${parts[3]}.`) });
      case 'POST /item/:': return device({ kind: 'item', n: position(parts[1], `There is no song ${parts[1]}.`) });
      case 'POST /next': return device({ kind: 'next' });
      case 'POST /flash/:/on': return device({ kind: 'flash', group: flashGroup(parts[1]), on: true });
      case 'POST /flash/:/off': return device({ kind: 'flash', group: flashGroup(parts[1]), on: false });
      case 'POST /release-all': cmd = { type: 'releaseAll' }; break;
      case 'POST /back-to-look': cmd = { type: 'backToLook' }; break;
      case 'POST /safe': cmd = { type: 'safe' }; break;
      case 'POST /blackout': cmd = { type: 'blackout' }; break;
      case 'POST /undo': cmd = { type: 'undo' }; break;
      case 'POST /fade/:': cmd = { type: 'fadeTime', value: parts[1] === 'auto' ? null : Number(parts[1]) }; break;
      case 'POST /master/:':
        if (parts[1] === 'up' || parts[1] === 'down') return device({ kind: 'masterStep', by: parts[1] === 'up' ? 0.1 : -0.1 });
        cmd = { type: 'master', value: percent(parts[1], 0, 100) };
        break;
      case 'POST /speed/:': cmd = { type: 'speed', value: percent(parts[1], 50, 200) }; break;
      default:
        throw new HttpError(404, `no such endpoint: ${req.method} ${url.pathname}`);
    }
    const error = await this.command(cmd, 'operator');
    if (error) throw new HttpError(error.startsWith('unknown') ? 404 : 400, error);
    json(res, 200, { ok: true });
  }
}

/** The show with these controllers not listened to (Settings › Controller keys › Devices), and only these. */
function withIgnored(show: Show, ignored: string[] | undefined): Show {
  const c = show.operator.controller;
  if (!c && !ignored?.length) return show;
  const controller = { ...c, keys: c?.keys ?? [] };
  if (ignored?.length) controller.ignored = [...ignored];
  else delete controller.ignored;
  return { ...show, operator: { ...show.operator, controller } };
}

/**
 * What every show gets on its way in (at start, import, restore, merge, a Patch save): a running order with
 * Basic lights first, the ready-made effects the first time, and Warm white and Off for a group with no colours.
 */
function ensureShow(show: Show): Show {
  // A key for a song, quick look or group that is gone is freed.
  return pruneKeys(ensureGroupColours(ensureEffects(ensureBasicLights(ensureRunningOrder(show)))));
}

/**
 * The show an Undo goes back to, plus the hidden custom presets (Any colour, Basic light,
 * Off, Custom effect) that the current show has and it lacks: the stage may be running one of them.
 */
function keepCustomPresets(restored: Show, current: Show): Show {
  const have = new Set(restored.presets.map((p) => p.id));
  const groups = new Set(restored.groups.map((g) => g.id));
  const kept = current.presets.filter((p) => p.custom && !have.has(p.id) && groups.has(p.group));
  return kept.length ? { ...restored, presets: [...restored.presets, ...structuredClone(kept)] } : restored;
}

function slugKey(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** Which path segments are parameters in the API's URL patterns. */
function isParam(parts: string[], i: number): boolean {
  const [head] = parts;
  if (head === 'look' || head === 'looks' || head === 'master' || head === 'speed' || head === 'fade' || head === 'item' || head === 'flash') return i === 1;
  if (head === 'group') return i === 1 || (i === 3 && (parts[2] === 'preset' || parts[2] === 'level' || parts[2] === 'colour'));
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
