// MIDI controllers plugged into the server computer: every one is looked for every 2 s and listened to
// (unless Settings says not to). A key assigned in Settings, a song or a quick look (the show's controller
// keys) does its job; on an APC mini, keys that aren't assigned follow its standard layout (apc.ts) when that
// is on. Learn takes the next key pressed. The APC's LEDs show the live stage. Everything a key does is a
// device action (source "midi:<port>"), so it runs through App.device as the iPad's buttons do.

import {
  FADE_STEPS, deviceName, fadeStepAt, fadeStepIndex, isLevelTarget, lightGroups,
  type ControlKey, type DeviceAction, type KeyBinding, type KeyTarget, type LiveState,
} from '../../packages/shared/src/index.ts';
import { Pickup, apcAllOff, apcFaderCc, apcIntro, apcLeds, apcModel, buttonIntent, faderAction, ledChanges, parseApc, pickApcPort, type ApcLeds, type ApcModel } from './apc.ts';
import { keyId, parseMidi, type MidiMessage } from './keynames.ts';
import type { OperatorLayout } from './layout.ts';
import type { MidiPort, MidiPorts } from './midi.ts';

export interface MidiHooks {
  /** Run a device action on the live stage; a plain-words reason when it can't be done, else null. */
  device(action: DeviceAction, source: string): Promise<string | null>;
  /** A controller went away: put out the Flash it holds. */
  release(source: string): void;
  /** A controller was opened or let go of (the pages show Key chips while one is listened to). */
  changed?(): void;
  log(msg: string): void;
}

/** The show's controller settings, defaults filled in (controllerOf). */
export interface ControllerConfig {
  keys: KeyBinding[];
  apcLayout: boolean;
  ignored: string[];
}

export interface ApcStatus {
  /** The MIDI add-on is installed, so controllers can be used. */
  midi: boolean;
  connected: boolean;
  model: ApcModel | null;
}

/** A controller the computer has, as Settings lists it. */
export interface MidiDeviceStatus {
  name: string;
  listening: boolean;
  model: ApcModel | null;
}

/** How often (ms) to look for controllers, and how long (ms) Blackout must be held. */
const POLL_MS = 2000;
const HOLD_MS = 1000;
/** An APC's whole LED set is sent again every this many polls (10 s): one that was unplugged and plugged back in within one poll has forgotten them. */
const RESEND_POLLS = 5;
/** The same refusal (a pad with no song) is logged at most this often (ms). */
const LOG_EVERY_MS = 60000;
/** A fader or knob that was just learned is ignored this long (ms), or until its new job is known. */
const LEARNED_CC_MS = 1000;
/** A note that was just learned is ignored until it is let go, or this long (ms) at most. */
const LEARNED_NOTE_MS = 2000;
/** A control change at or above this (0 to 1) is a button held down. */
const CC_DOWN = 0.5;

/** What a fader or knob controls. */
type Level = { kind: 'master' } | { kind: 'group'; group: number | string } | { kind: 'fade' };

/** One open port. */
interface Conn {
  name: string;
  device: string;
  model: ApcModel | null;
  port: MidiPort;
  source: string;
  alive: boolean;
  polls: number;
  /** What the LEDs were last sent (an APC only); null until the first full set. */
  leds: ApcLeds | null;
  pickup: Pickup;
  /** The fade knob's pickup, on the knob's steps (0, 1/6, … 1). */
  fadePickup: Pickup;
  /** The step each fade knob last sent, while it follows. */
  fadeSent: Map<string, number | null>;
  /** What each fader or knob last controlled (as JSON), by key id. */
  controls: Map<string, string>;
  /** Blackout holds, by key id. */
  holds: Map<string, NodeJS.Timeout>;
  /** Control changes used as buttons that are held down now. */
  ccDown: Set<string>;
  /** Keys just learned, ignored until let go (a note) or for a moment (a fader). */
  swallow: Map<string, number>;
  /** The newest move of each fader waiting to be sent (a fader sends far faster than needed). */
  waiting: Map<string, () => DeviceAction>;
}

export class MidiDriver {
  private readonly ports: MidiPorts;
  private readonly hooks: MidiHooks;
  private readonly pollMs: number;
  private readonly holdMs: number;
  private readonly resendPolls: number;
  private poller: NodeJS.Timeout | null = null;
  private config: ControllerConfig = { keys: [], apcLayout: true, ignored: [] };
  /** The keys of each device, by key id. */
  private bindings = new Map<string, Map<string, KeyBinding>>();
  private readonly conns = new Map<string, Conn>();
  /** The port names the computer had at the last look. */
  private names: string[] = [];
  private layout: OperatorLayout | null = null;
  private state: LiveState | null = null;
  /** Actions run one after another, in the order they came. */
  private queue: Promise<void> = Promise.resolve();
  private learning: { resolve: (key: ControlKey | null) => void; timer: NodeJS.Timeout; levels: boolean } | null = null;
  /** The last problem with each port (or listing them), so it is logged once rather than every 2 s. */
  private readonly problems = new Map<string, string>();
  private readonly logged = new Map<string, number>();

  constructor(ports: MidiPorts, hooks: MidiHooks, opts: { pollMs?: number; holdMs?: number; resendPolls?: number } = {}) {
    this.ports = ports;
    this.hooks = hooks;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.holdMs = opts.holdMs ?? HOLD_MS;
    this.resendPolls = opts.resendPolls ?? RESEND_POLLS;
  }

  /** The APC mini, for Settings and `GET /api/apc`. */
  get status(): ApcStatus {
    const apc = [...this.conns.values()].find((c) => c.model);
    return { midi: true, connected: !!apc, model: apc?.model ?? null };
  }

  /** Every controller the computer has now, listened to or not (an APC mini's second port is left out). */
  get devices(): MidiDeviceStatus[] {
    const out: MidiDeviceStatus[] = [];
    for (const name of this.wanted(this.names, true)) {
      const device = deviceName(name);
      if (out.some((d) => d.name === device)) continue;
      out.push({ name: device, listening: !this.config.ignored.includes(device), model: apcModel(name) });
    }
    return out;
  }

  /** How many controllers are listened to now. */
  get listening(): number {
    return this.conns.size;
  }

  get isLearning(): boolean {
    return this.learning !== null;
  }

  start(): void {
    this.poll();
    this.poller = setInterval(() => this.poll(), this.pollMs);
    this.poller.unref();
  }

  /** Lets go of every controller: an APC's LEDs go out and every port closes. */
  stop(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.cancelLearn();
    for (const conn of [...this.conns.values()]) this.close(conn, true);
  }

  /** The show's keys and switches changed. */
  configure(config: ControllerConfig): void {
    const relisten = JSON.stringify(config.ignored) !== JSON.stringify(this.config.ignored);
    this.config = config;
    this.bindings = new Map();
    for (const b of config.keys) {
      let keys = this.bindings.get(b.key.device);
      if (!keys) this.bindings.set(b.key.device, (keys = new Map()));
      keys.set(keyId(b.key), b);
    }
    for (const conn of this.conns.values()) {
      // A fader that was just learned now has its job: it works at once.
      for (const id of conn.swallow.keys()) if (id.startsWith('cc:')) conn.swallow.delete(id);
      this.sendLeds(conn);
    }
    // A device switched off or on in Settings is let go of or opened now, not at the next look.
    if (relisten && this.poller) this.poll();
  }

  /** The layout or the live stage changed: LEDs and fader pickup follow. */
  update(layout: OperatorLayout | null, state: LiveState | null): void {
    const before = this.state;
    this.layout = layout;
    this.state = state;
    if (!layout || !state) return;
    // A new look sets its own levels: no fader follows on until it reaches them again.
    const newLook = before && (before.look !== state.look || before.lastLook !== state.lastLook);
    const now = performance.now() / 1000;
    for (const conn of this.conns.values()) {
      if (newLook) conn.pickup.rearm();
      for (const [id, tag] of conn.controls) {
        const level = JSON.parse(tag) as Level;
        const value = this.levelOf(level);
        if (value === null) continue;
        if (level.kind === 'fade') conn.fadePickup.level(id, value, now);
        else conn.pickup.level(id, value, now);
      }
      this.sendLeds(conn);
    }
  }

  // ---- Learn ----

  /**
   * The next key pressed on a controller listened to, or null after `ms` or when `cancel` is called: a fresh press
   * (a note on, or a control change above 0; releases are passed over), and with `levels` only a fader or knob moved.
   * One at a time: throws while another is waiting.
   */
  learn(ms: number, opts: { levels?: boolean } = {}): { key: Promise<ControlKey | null>; cancel: () => void } {
    if (this.learning) throw new Error('Another page is waiting for a key. Try again in a moment.');
    let entry!: NonNullable<MidiDriver['learning']>;
    const key = new Promise<ControlKey | null>((resolve) => {
      const timer = setTimeout(() => this.endLearn(entry), ms);
      timer.unref();
      entry = { resolve, timer, levels: !!opts.levels };
    });
    this.learning = entry;
    return { key, cancel: () => this.endLearn(entry) };
  }

  /** Stop whatever learn is waiting. */
  cancelLearn(): void {
    if (this.learning) this.endLearn(this.learning);
  }

  /** This learn ends with no key (only if it is still the one waiting). */
  private endLearn(entry: NonNullable<MidiDriver['learning']>): void {
    if (this.learning !== entry) return;
    this.learning = null;
    clearTimeout(entry.timer);
    entry.resolve(null);
  }

  // ---- Finding and opening controllers ----

  /** The ports to open: every one but an APC mini's second (notes) port; with `all`, ignored ones too. */
  private wanted(names: string[], all = false): string[] {
    const apcs = names.filter((n) => apcModel(n));
    const apc = pickApcPort(apcs);
    return names.filter((n) => (apcModel(n) ? n === apc : true) && (all || !this.config.ignored.includes(deviceName(n))));
  }

  private poll(): void {
    let names: string[];
    try {
      names = this.ports.list();
    } catch (err) {
      this.report('list', `MIDI: could not list the MIDI devices (${(err as Error).message})`);
      return;
    }
    this.problems.delete('list');
    this.names = names;
    const wanted = this.wanted(names);
    for (const conn of [...this.conns.values()]) {
      if (!names.includes(conn.name)) this.lost(conn, 'unplugged');
      else if (!wanted.includes(conn.name)) {
        this.close(conn, true);
        this.hooks.release(conn.source);
        this.hooks.log(`${prefix(conn)}: not listened to (Settings)`);
      } else if (conn.model && ++conn.polls % this.resendPolls === 0) {
        // Unplugged and plugged back in between two polls: the port still looks the same, but the device has
        // reset its LEDs. Now and then everything is sent again, so the pads recover.
        conn.leds = null;
        this.sendLeds(conn);
      }
    }
    for (const name of wanted) if (!this.conns.has(name)) this.open(name);
  }

  private open(name: string): void {
    const model = apcModel(name);
    let port: MidiPort;
    try {
      port = this.ports.open(name, { output: model !== null });
    } catch (err) {
      this.report(name, `${model ? 'APC mini' : 'MIDI'}: could not open ${name} (${(err as Error).message})`);
      return;
    }
    this.problems.delete(name);
    const conn: Conn = {
      name, device: deviceName(name), model, port, source: `midi:${name}`, alive: true, polls: 0, leds: null,
      pickup: new Pickup(), fadePickup: new Pickup(), fadeSent: new Map(), controls: new Map(), holds: new Map(),
      ccDown: new Set(), swallow: new Map(), waiting: new Map(),
    };
    this.conns.set(name, conn);
    port.onMessage((bytes) => {
      if (!conn.alive) return;
      // A message from the add-on's callback: a mistake here must never stop the server.
      try {
        this.input(conn, bytes);
      } catch (err) {
        this.hooks.log(`${prefix(conn)}: could not handle a message (${(err as Error)?.message ?? String(err)})`);
      }
    });
    if (model) {
      this.hooks.log(`APC mini: connected (${model === 'mk2' ? 'mk2' : 'older model'}), port "${name}"`);
      this.send(conn, apcIntro(model));
      this.sendLeds(conn);
    } else {
      this.hooks.log(`MIDI: connected "${name}"`);
    }
    this.hooks.changed?.();
  }

  /** The controller went away (unplugged, or it stopped taking messages): its Flash goes out. */
  private lost(conn: Conn, why: string): void {
    this.close(conn, false);
    this.hooks.release(conn.source);
    this.hooks.log(`${prefix(conn)}: ${why}`);
  }

  /** Close the port; `dark`: turn an APC's LEDs off first (it is still there). */
  private close(conn: Conn, dark: boolean): void {
    if (dark && conn.alive && conn.model) {
      for (const msg of apcAllOff(conn.model)) {
        try {
          conn.port.send(msg);
        } catch {
          break;
        }
      }
    }
    conn.alive = false;
    for (const t of conn.holds.values()) clearTimeout(t);
    conn.holds.clear();
    conn.waiting.clear();
    this.conns.delete(conn.name);
    try {
      conn.port.close();
    } catch {
      // already gone
    }
    if (this.poller) this.hooks.changed?.();
  }

  private report(what: string, problem: string): void {
    if (this.problems.get(what) === problem) return;
    this.problems.set(what, problem);
    this.hooks.log(problem);
  }

  // ---- What comes in ----

  private input(conn: Conn, bytes: number[]): void {
    const msg = parseMidi(bytes);
    if (msg) {
      const id = keyId(msg);
      const learning = this.learning;
      // Only a fresh press is learned (never a release, which may be another controller's Flash let go of).
      const fresh = msg.type === 'cc' ? msg.value > 0 : msg.on;
      if (learning && fresh) {
        // Waiting for a fader or knob: a pad or button pressed meanwhile does nothing.
        if (msg.type === 'cc' || !learning.levels) this.learned(conn, msg, id);
        return;
      }
      const until = conn.swallow.get(id);
      if (until !== undefined) {
        // The key just learned: its release (or the rest of its move) isn't a press, for a moment.
        const over = performance.now() >= until;
        if (msg.type === 'note' && !msg.on) conn.swallow.delete(id);
        if (!over) return;
        conn.swallow.delete(id);
      }
      const binding = this.bindings.get(conn.device)?.get(id);
      if (binding) {
        this.runKey(conn, id, binding.does, msg);
        return;
      }
    }
    if (conn.model) this.apcInput(conn, conn.model, bytes);
  }

  private learned(conn: Conn, msg: MidiMessage, id: string): void {
    const l = this.learning!;
    this.learning = null;
    clearTimeout(l.timer);
    conn.swallow.set(id, performance.now() + (msg.type === 'note' ? LEARNED_NOTE_MS : LEARNED_CC_MS));
    l.resolve({ device: conn.device, type: msg.type, channel: msg.channel, number: msg.number });
  }

  /** A key with a job of its own. */
  private runKey(conn: Conn, id: string, does: KeyTarget, msg: MidiMessage): void {
    if (isLevelTarget(does)) {
      if (msg.type !== 'cc') return;
      const level: Level = does.kind === 'master' ? { kind: 'master' } : does.kind === 'groupLevel' ? { kind: 'group', group: does.group } : { kind: 'fade' };
      this.moveLevel(conn, id, level, msg.value);
      return;
    }
    let on: boolean;
    if (msg.type === 'note') on = msg.on;
    else {
      // A button that sends a control change: down at the top half, up at the bottom half.
      on = msg.value >= CC_DOWN;
      if (on === conn.ccDown.has(id)) return;
      if (on) conn.ccDown.add(id);
      else conn.ccDown.delete(id);
    }
    switch (does.kind) {
      case 'blackout':
        if (on) this.startHold(conn, id);
        else this.endHold(conn, id);
        return;
      case 'flashAll': return this.run(conn, { kind: 'flash', group: 'all', on });
      case 'flash': return this.run(conn, { kind: 'flash', group: does.group, on });
    }
    if (!on) return;
    switch (does.kind) {
      case 'song': return this.run(conn, { kind: 'song', id: does.id });
      case 'quickLook': return this.run(conn, { kind: 'quickLook', id: does.id });
      case 'next':
      case 'backToLook':
      case 'undo':
      case 'basic':
      case 'tap':
        return this.run(conn, { kind: does.kind });
      case 'fadeTime': return this.run(conn, { kind: 'fadeTime', value: does.value });
      case 'tempoStep': return this.run(conn, { kind: 'tempoStep', times: does.times });
    }
  }

  /** The APC mini's standard layout (apc.ts), for its keys that have no job of their own. */
  private apcInput(conn: Conn, model: ApcModel, bytes: number[]): void {
    const msg = parseApc(model, bytes);
    if (!msg) return;
    // Where the faders are counts whatever they do.
    if (msg.kind === 'faders') {
      msg.values.forEach((v, k) => conn.pickup.place(faderKey(k + 1), v));
      return;
    }
    if (!this.config.apcLayout) return;
    switch (msg.kind) {
      case 'fader':
        this.moveLevel(conn, faderKey(msg.fader), msg.fader === 9 ? { kind: 'master' } : { kind: 'group', group: msg.fader }, msg.value);
        return;
      case 'press':
      case 'release': {
        const intent = buttonIntent(msg.control, msg.kind === 'press');
        if (!intent) return;
        if ('blackoutHold' in intent) {
          if (intent.blackoutHold) this.startHold(conn, 'apc:blackout');
          else this.endHold(conn, 'apc:blackout');
        } else {
          this.run(conn, intent.action);
        }
      }
    }
  }

  /** A fader or knob moved to `value` (0 to 1): with pickup, it takes over only once it reaches the level. */
  private moveLevel(conn: Conn, id: string, level: Level, value: number): void {
    const tag = JSON.stringify(level);
    if (conn.controls.get(id) !== tag) {
      // It controls something else now: it waits to reach that level.
      conn.pickup.forget(id);
      conn.fadePickup.forget(id);
      conn.fadeSent.delete(id);
      conn.controls.set(id, tag);
    }
    const now = performance.now() / 1000;
    const current = this.levelOf(level);
    if (level.kind === 'fade') {
      // On the knob's steps, so the fade time coming back is known as its own.
      const steps = FADE_STEPS.length - 1;
      const at = Math.round(value * steps) / steps;
      if (current === null) {
        conn.fadePickup.place(id, at);
        return;
      }
      const taken = conn.fadePickup.move(id, at, current, now);
      if (taken === null) {
        conn.fadeSent.delete(id);
        return;
      }
      const step = fadeStepAt(taken);
      if (!conn.fadeSent.has(id)) {
        // Just caught: it is already where the fade time is.
        conn.fadeSent.set(id, FADE_STEPS[fadeStepIndex(this.state?.fadeTime ?? null)]!);
      }
      if (conn.fadeSent.get(id) === step) return;
      conn.fadeSent.set(id, step);
      this.sendLevel(conn, id, () => ({ kind: 'fadeTime', value: step }));
      return;
    }
    // A fader without a group in this show does nothing, but where it is is kept, so a later crossing is real.
    if (current === null) {
      conn.pickup.place(id, value);
      return;
    }
    const taken = conn.pickup.move(id, value, current, now);
    if (taken === null) return;
    if (level.kind === 'master') this.sendLevel(conn, id, () => ({ kind: 'master', value: taken }));
    else if (typeof level.group === 'number') this.sendLevel(conn, id, () => faderAction(level.group as number, taken));
    else this.sendLevel(conn, id, () => ({ kind: 'groupLevel', group: level.group, value: taken }));
  }

  /** The level a fader or knob controls now (0 to 1), or null when there is none. */
  private levelOf(level: Level): number | null {
    if (!this.layout || !this.state) return null;
    switch (level.kind) {
      case 'master': return this.state.master;
      case 'fade': return fadeStepIndex(this.state.fadeTime) / (FADE_STEPS.length - 1);
      case 'group': {
        const groups = lightGroups(this.layout);
        const group = typeof level.group === 'number' ? groups[level.group - 1] : groups.find((g) => g.id === level.group);
        return group ? this.state.groups[group.id]?.level ?? null : null;
      }
    }
  }

  /** Blackout, like the iPad's, needs a hold: it goes when the key has been down for 1 s. */
  private startHold(conn: Conn, id: string): void {
    if (conn.holds.has(id)) return;
    const timer = setTimeout(() => {
      conn.holds.delete(id);
      this.run(conn, { kind: 'blackout' });
    }, this.holdMs);
    timer.unref();
    conn.holds.set(id, timer);
  }

  private endHold(conn: Conn, id: string): void {
    clearTimeout(conn.holds.get(id));
    conn.holds.delete(id);
  }

  private run(conn: Conn, action: DeviceAction): void {
    this.enqueue(conn, async () => {
      const error = await this.hooks.device(action, conn.source);
      if (error) this.refused(conn, error);
    });
  }

  /** Only the newest position of a fader is sent, once the action before it is done. */
  private sendLevel(conn: Conn, id: string, make: () => DeviceAction): void {
    const queued = conn.waiting.has(id);
    conn.waiting.set(id, make);
    if (queued) return;
    this.enqueue(conn, async () => {
      const latest = conn.waiting.get(id);
      conn.waiting.delete(id);
      if (!latest) return;
      const error = await this.hooks.device(latest(), conn.source);
      if (error) this.refused(conn, error);
    });
  }

  /** Jobs for a controller that went away are dropped. */
  private enqueue(conn: Conn, job: () => Promise<void>): void {
    this.queue = this.queue
      .then(() => (conn.alive ? job() : undefined))
      .catch((err) => this.hooks.log(`${prefix(conn)}: ${(err as Error)?.message ?? String(err)}`));
  }

  /** A key with nothing behind it (a pad with no song): said in the log, at most once a minute for the same reason. */
  private refused(conn: Conn, error: string): void {
    const now = Date.now();
    const what = `${prefix(conn)}: ${error}`;
    if (now - (this.logged.get(what) ?? -Infinity) < LOG_EVERY_MS) return;
    if (this.logged.size > 200) this.logged.clear();
    this.logged.set(what, now);
    this.hooks.log(what);
  }

  // ---- What goes out ----

  private sendLeds(conn: Conn): void {
    if (!conn.alive || !conn.model || !this.layout || !this.state) return;
    const keys = [...(this.bindings.get(conn.device)?.values() ?? [])]
      .filter((b) => b.key.type === 'note' && b.key.channel === 1)
      .map((b) => ({ number: b.key.number, does: b.does }));
    const next = apcLeds(conn.model, this.layout, this.state, { standard: this.config.apcLayout, keys });
    const changes = ledChanges(conn.leds, next);
    conn.leds = next;
    this.send(conn, changes);
  }

  private send(conn: Conn, messages: number[][]): void {
    for (const msg of messages) {
      if (!conn.alive) return;
      try {
        conn.port.send(msg);
      } catch (err) {
        this.lost(conn, `stopped answering (${(err as Error).message})`);
        return;
      }
    }
  }
}

/** The key id of APC fader 1-9 (control changes 48-56 on channel 1). */
const faderKey = (fader: number) => keyId({ type: 'cc', channel: 1, number: apcFaderCc(fader) });

/** How the log names a controller. */
const prefix = (conn: Conn) => (conn.model ? 'APC mini' : `MIDI ${conn.device}`);
