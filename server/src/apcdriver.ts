// Runs an APC mini plugged into the server computer: looks for it every 2 s, turns what it sends into
// device actions (source 'apc'), keeps its LEDs showing the live stage, and holds Blackout for 1 s.
// What the pads and LEDs mean is in apc.ts; this file has the ports and the timers.

import { lightGroups, type DeviceAction, type LiveState } from '../../packages/shared/src/index.ts';
import { Pickup, apcAllOff, apcIntro, apcLeds, apcModel, buttonIntent, faderAction, ledChanges, parseApc, pickApcPort, type ApcLeds, type ApcModel } from './apc.ts';
import type { OperatorLayout } from './layout.ts';
import type { MidiPort, MidiPorts } from './midi.ts';

export interface ApcHooks {
  /** Run a device action on the live stage; a plain-words reason when it can't be done, else null. */
  device(action: DeviceAction): Promise<string | null>;
  /** The APC went away: put out the Flash it holds. */
  release(): void;
  log(msg: string): void;
}

export interface ApcStatus {
  /** The MIDI add-on is installed, so an APC can be used. */
  midi: boolean;
  connected: boolean;
  model: ApcModel | null;
}

/** How often (ms) to look for the APC, and how long (ms) Blackout must be held. */
const POLL_MS = 2000;
const HOLD_MS = 1000;
/** The same refusal (a pad with no song) is logged at most this often (ms). */
const LOG_EVERY_MS = 60000;

export class ApcDriver {
  private readonly ports: MidiPorts;
  private readonly hooks: ApcHooks;
  private readonly pollMs: number;
  private readonly holdMs: number;
  private port: MidiPort | null = null;
  private name = '';
  private model: ApcModel | null = null;
  /** What the LEDs were last sent; null until the first full set. */
  private leds: ApcLeds | null = null;
  private pickup = new Pickup();
  private layout: OperatorLayout | null = null;
  private state: LiveState | null = null;
  private poller: NodeJS.Timeout | null = null;
  private blackoutHold: NodeJS.Timeout | null = null;
  /** Actions run one after another, in the order the APC sent them. */
  private queue: Promise<void> = Promise.resolve();
  /** Counts each opening and closing, so actions queued for an APC that went away are dropped. */
  private turn = 0;
  /** The newest position of each fader still waiting to be sent (a fader sends far faster than needed). */
  private readonly faderWaiting = new Map<number, number>();
  /** The last problem finding or opening the APC, so it is logged once rather than every 2 s. */
  private problem: string | null = null;
  private readonly logged = new Map<string, number>();

  constructor(ports: MidiPorts, hooks: ApcHooks, opts: { pollMs?: number; holdMs?: number } = {}) {
    this.ports = ports;
    this.hooks = hooks;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.holdMs = opts.holdMs ?? HOLD_MS;
  }

  get status(): ApcStatus {
    return { midi: true, connected: this.port !== null, model: this.port ? this.model : null };
  }

  start(): void {
    this.poll();
    this.poller = setInterval(() => this.poll(), this.pollMs);
    this.poller.unref();
  }

  /** Lets go of the APC: its LEDs go out and the port closes. */
  stop(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.endHold();
    this.turn++;
    if (this.port && this.model) {
      for (const msg of apcAllOff(this.model)) {
        try {
          this.port.send(msg);
        } catch {
          break;
        }
      }
    }
    this.closePort();
  }

  /** The layout or the live stage changed: LEDs and fader pickup follow. */
  update(layout: OperatorLayout | null, state: LiveState | null): void {
    const before = this.state;
    this.layout = layout;
    this.state = state;
    if (!layout || !state) return;
    // A new look sets its own levels: no fader follows on until it reaches them again.
    if (before && (before.look !== state.look || before.lastLook !== state.lastLook)) this.pickup.rearm();
    const now = performance.now() / 1000;
    for (let f = 1; f <= 9; f++) {
      const level = this.levelOf(f);
      if (level !== null) this.pickup.level(f, level, now);
    }
    this.sendLeds();
  }

  // ---- Finding and opening the APC ----

  private poll(): void {
    let names: string[];
    try {
      names = this.ports.list();
    } catch (err) {
      this.report(`APC mini: could not list the MIDI devices (${(err as Error).message})`);
      return;
    }
    if (this.port) {
      if (!names.includes(this.name)) this.lost('unplugged');
      return;
    }
    const name = pickApcPort(names);
    if (!name) return;
    let port: MidiPort;
    try {
      port = this.ports.open(name);
    } catch (err) {
      this.report(`APC mini: could not open ${name} (${(err as Error).message})`);
      return;
    }
    this.problem = null;
    this.port = port;
    this.name = name;
    this.model = apcModel(name);
    this.leds = null;
    this.pickup = new Pickup();
    const turn = ++this.turn;
    port.onMessage((bytes) => {
      if (turn !== this.turn) return;
      // A message from the add-on's callback: a mistake here must never stop the server.
      try {
        this.input(bytes);
      } catch (err) {
        this.hooks.log(`APC mini: could not handle a message (${(err as Error)?.message ?? String(err)})`);
      }
    });
    this.hooks.log(`APC mini: connected (${this.model === 'mk2' ? 'mk2' : 'older model'}), port "${name}"`);
    this.send(apcIntro(this.model!));
    this.sendLeds();
  }

  /** The APC went away (unplugged, or it stopped taking messages): its Flash goes out. */
  private lost(why: string): void {
    this.endHold();
    this.turn++;
    this.closePort();
    this.hooks.release();
    this.hooks.log(`APC mini: ${why}`);
  }

  private closePort(): void {
    const port = this.port;
    this.port = null;
    this.leds = null;
    this.faderWaiting.clear();
    try {
      port?.close();
    } catch {
      // already gone
    }
  }

  private report(problem: string): void {
    if (problem === this.problem) return;
    this.problem = problem;
    this.hooks.log(problem);
  }

  // ---- What comes in ----

  private input(bytes: number[]): void {
    const model = this.model;
    if (!model) return;
    const msg = parseApc(model, bytes);
    if (!msg) return;
    switch (msg.kind) {
      case 'faders':
        msg.values.forEach((v, k) => this.pickup.place(k + 1, v));
        return;
      case 'fader': {
        const level = this.levelOf(msg.fader);
        // A fader without a group in this show does nothing.
        if (level === null) return;
        const value = this.pickup.move(msg.fader, msg.value, level, performance.now() / 1000);
        if (value !== null) this.sendFader(msg.fader, value);
        return;
      }
      case 'press':
      case 'release': {
        const intent = buttonIntent(msg.control, msg.kind === 'press');
        if (!intent) return;
        if ('blackoutHold' in intent) {
          if (intent.blackoutHold) this.startHold();
          else this.endHold();
        } else {
          this.run(intent.action);
        }
      }
    }
  }

  /** The level a fader controls now: group N's (light groups, as on the iPad) or Master; null if there is none. */
  private levelOf(fader: number): number | null {
    if (!this.layout || !this.state) return null;
    if (fader === 9) return this.state.master;
    const group = lightGroups(this.layout)[fader - 1];
    return group ? this.state.groups[group.id]?.level ?? null : null;
  }

  /** Blackout, like the iPad's, needs a hold: it goes when the button has been down for 1 s. */
  private startHold(): void {
    if (this.blackoutHold) return;
    this.blackoutHold = setTimeout(() => {
      this.blackoutHold = null;
      this.run({ kind: 'blackout' });
    }, this.holdMs);
    this.blackoutHold.unref();
  }

  private endHold(): void {
    if (this.blackoutHold) clearTimeout(this.blackoutHold);
    this.blackoutHold = null;
  }

  private run(action: DeviceAction): void {
    this.enqueue(async () => {
      const error = await this.hooks.device(action);
      if (error) this.refused(error);
    });
  }

  /** Only the newest position of a fader is sent, once the action before it is done. */
  private sendFader(fader: number, value: number): void {
    const queued = this.faderWaiting.has(fader);
    this.faderWaiting.set(fader, value);
    if (queued) return;
    this.enqueue(async () => {
      const latest = this.faderWaiting.get(fader);
      this.faderWaiting.delete(fader);
      if (latest === undefined) return;
      const error = await this.hooks.device(faderAction(fader, latest));
      if (error) this.refused(error);
    });
  }

  private enqueue(job: () => Promise<void>): void {
    const turn = this.turn;
    this.queue = this.queue
      .then(() => (turn === this.turn ? job() : undefined))
      .catch((err) => this.hooks.log(`APC mini: ${(err as Error)?.message ?? String(err)}`));
  }

  /** A pad with no song or colour behind it: said in the log, at most once a minute for the same reason. */
  private refused(error: string): void {
    const now = Date.now();
    if (now - (this.logged.get(error) ?? -Infinity) < LOG_EVERY_MS) return;
    if (this.logged.size > 200) this.logged.clear();
    this.logged.set(error, now);
    this.hooks.log(`APC mini: ${error}`);
  }

  // ---- What goes out ----

  private sendLeds(): void {
    if (!this.port || !this.model || !this.layout || !this.state) return;
    const next = apcLeds(this.model, this.layout, this.state);
    const changes = ledChanges(this.leds, next);
    this.leds = next;
    this.send(changes);
  }

  private send(messages: number[][]): void {
    for (const msg of messages) {
      if (!this.port) return;
      try {
        this.port.send(msg);
      } catch (err) {
        this.lost(`stopped answering (${(err as Error).message})`);
        return;
      }
    }
  }
}
