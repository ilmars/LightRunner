// Listens to the presentation app (WorshipTools Presenter) over the planning service's live connection, so the
// lights can follow its slides. It is the protocol of tools/worshiptools-live.ts, as a class with no timers or
// sockets of its own beyond the ones it is given, so tests need no network.
//
// Presenter joins the Pusher channel "presence-{account}" as a member with client "weDesktop". On its
// "private-{account}.{id}" channel we send client-command {action: "activate"} and it answers with client-event
// messages (current_cue, current_slide, cuelist), each split into chunks {id, i, total, chunk}.
//
// Nothing here logs the login or the machine id, and nothing throws out of a socket handler.

import { parseSlideId, type LiveSlide, type LiveStatus } from '../../../packages/shared/src/index.ts';
import { PlanningError, type Planning } from './index.ts';

/** The small part of the global WebSocket this uses. */
export interface WebSocketLike {
  send(text: string): void;
  close(): void;
  onopen: ((ev?: any) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: any) => void) | null;
  onerror: ((ev?: any) => void) | null;
}

export type { LiveStatus };

type Options = {
  planning: Planning;
  account: string;
  open?: (url: string) => WebSocketLike;
  onSlide: (s: LiveSlide) => void;
  onStatus: (s: LiveStatus) => void;
  log: (line: string) => void;
};

const MAX_WAIT_S = 60;
/** Unfinished messages kept at most; the oldest go first. */
const MAX_PENDING_CHUNKS = 50;
const DEFAULT_ACTIVITY_S = 120;
/** How long a connection must stay up (account channel joined) before the retry wait starts over. */
const STABLE_MS = 60_000;
/** How long after a ping anything may take to arrive before the connection counts as dead. */
const PONG_MS = 30_000;
const NO_CONNECTION = 'No internet connection.';
const FAILED = 'The connection to the presentation app failed.';

export class PresenterLive {
  private readonly opts: Options;
  private readonly openSocket: (url: string) => WebSocketLike;
  private socket: WebSocketLike | undefined;
  private stopped = true;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts starts, so a connect that was still pending when stop() came cannot open a socket. */
  private generation = 0;
  private machineId: string | undefined;
  private socketId = '';
  private presenter: { id: string; name: string } | undefined;
  private lastSlide: string | undefined;
  private readonly chunks = new Map<string, string[]>();
  private status: LiveStatus | undefined;

  constructor(opts: Options) {
    this.opts = opts;
    this.openSocket = opts.open ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.retries = 0;
    this.generation++;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.reset();
    if (socket) {
      detach(socket);
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    this.setStatus({ state: 'closed', problem: null, presenter: null });
  }

  // ---- Connecting ----

  private connect(): void {
    this.retryTimer = undefined;
    this.setStatus({ state: 'connecting', problem: null, presenter: null });
    const generation = this.generation;
    this.opts.planning
      .liveKeys(this.opts.account)
      .then(({ key, cluster }) => {
        if (this.stopped || generation !== this.generation) return;
        const socket = this.openSocket(`wss://ws-${cluster}.pusher.com/app/${key}?protocol=7&client=js&version=8.4.0&flash=false`);
        this.socket = socket;
        socket.onopen = () => {};
        socket.onmessage = (msg) => this.safely(() => this.onMessage(socket, msg.data));
        socket.onerror = () => this.safely(() => this.opts.log('Live connection: a socket error.'));
        socket.onclose = () => this.safely(() => this.closed(socket));
      })
      .catch((err) => this.safely(() => (generation === this.generation ? this.failed(err) : undefined)));
  }

  /** A connection that could not be made: say why and try again later. */
  private failed(err: unknown): void {
    if (this.stopped) return;
    this.opts.log(`Live connection: ${problemOf(err)}`);
    this.reset();
    this.setStatus({ state: 'closed', problem: problemOf(err), presenter: null });
    this.scheduleRetry();
  }

  /** The socket has gone (it dropped, or we gave it up): say so and try again later. */
  private closed(socket: WebSocketLike, problem: string | null = null): void {
    if (socket !== this.socket) return;
    this.reset();
    detach(socket);
    this.setStatus({ state: 'closed', problem, presenter: null });
    if (!this.stopped) this.scheduleRetry();
  }

  /** Give up on this socket after something went wrong with it. */
  private drop(socket: WebSocketLike, err: unknown): void {
    this.opts.log(`Live connection: ${problemOf(err)}`);
    try {
      socket.close();
    } catch {
      // already closed
    }
    this.closed(socket, problemOf(err));
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    const wait = Math.min(MAX_WAIT_S, 2 ** this.retries);
    this.retries++;
    this.opts.log(`Live connection closed, trying again in ${wait} s.`);
    this.retryTimer = setTimeout(() => this.safely(() => this.connect()), wait * 1000);
    this.retryTimer.unref?.();
  }

  /** Forget what belongs to one connection. */
  private reset(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    clearTimeout(this.stableTimer);
    this.pingTimer = this.pongTimer = this.stableTimer = undefined;
    this.socket = undefined;
    this.socketId = '';
    this.presenter = undefined;
    this.lastSlide = undefined;
    this.chunks.clear();
  }

  // ---- Messages ----

  private onMessage(socket: WebSocketLike, raw: unknown): void {
    if (socket !== this.socket) return;
    // Anything that arrives shows the connection is alive.
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    const m = parseJson(raw);
    if (!isRecord(m) || typeof m.event !== 'string') return;
    const event = m.event;
    const channel = typeof m.channel === 'string' ? m.channel : '';
    const data = typeof m.data === 'string' ? (tryJson(m.data) ?? m.data) : m.data;
    const account = this.opts.account;

    switch (event) {
      case 'pusher:connection_established': {
        if (!isRecord(data) || typeof data.socket_id !== 'string') return;
        this.socketId = data.socket_id;
        const seconds = typeof data.activity_timeout === 'number' && data.activity_timeout > 0 ? data.activity_timeout : DEFAULT_ACTIVITY_S;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.safely(() => this.ping(socket)), seconds * 1000);
        this.pingTimer.unref?.();
        this.subscribe(socket, `presence-${account}`);
        return;
      }
      case 'pusher:ping':
        this.send(socket, 'pusher:pong', {});
        return;
      case 'pusher:error':
        this.opts.log(`Live connection: Pusher error ${isRecord(data) ? `${data.code ?? ''} ${data.message ?? ''}` : ''}`.trim());
        return;
      case 'pusher_internal:subscription_succeeded':
        if (channel === `presence-${account}`) {
          const hash = isRecord(data) && isRecord(data.presence) && isRecord(data.presence.hash) ? data.presence.hash : {};
          for (const [id, info] of Object.entries(hash)) this.joined(socket, id, info);
          // The wait starts over only for a connection that has stayed up, so a fault right after the handshake backs off.
          clearTimeout(this.stableTimer);
          this.stableTimer = setTimeout(() => this.safely(() => (this.retries = 0)), STABLE_MS);
          this.stableTimer.unref?.();
          if (!this.presenter) this.setStatus({ state: 'waiting', problem: null, presenter: null });
        } else if (this.presenter && channel === `private-${this.channelOf(this.presenter.id)}`) {
          this.setStatus({ state: 'open', problem: null, presenter: this.presenter.name });
          this.send(socket, 'client-command', { action: 'activate', machineId: this.machineIdOnce() }, channel);
        }
        return;
      case 'pusher:subscription_error':
        this.opts.log(`Live connection: could not join ${channel || 'a channel'}.`);
        if (this.presenter) this.setStatus({ state: 'waiting', problem: "Can't join the presentation app's channel.", presenter: null });
        return;
      case 'pusher_internal:member_added':
        if (channel === `presence-${account}` && isRecord(data) && typeof data.user_id === 'string') this.joined(socket, data.user_id, data.user_info);
        return;
      case 'pusher_internal:member_removed':
        if (channel === `presence-${account}` && isRecord(data) && this.presenter?.id === data.user_id) this.left(socket);
        return;
    }

    if (!this.presenter || !event.startsWith('client-') || channel.replace(/^(private|presence)-/, '') !== this.channelOf(this.presenter.id)) return;
    const message = this.unchunk(event, data);
    if (message !== undefined && event === 'client-event') this.slideEvent(message);
  }

  /** A presentation computer joined. The first one is followed; any other is only logged. */
  private joined(socket: WebSocketLike, id: string, info: unknown): void {
    if (!isRecord(info) || info.client !== 'weDesktop') return;
    const name = String(info.machineName || info.name || id.split('.')[1] || id);
    if (this.presenter) {
      if (this.presenter.id !== id) this.opts.log(`Another presentation app is open on ${name}; following ${this.presenter.name}.`);
      return;
    }
    this.presenter = { id, name };
    this.opts.log(`Presentation app open on ${name}.`);
    this.setStatus({ state: 'waiting', problem: null, presenter: null });
    // Its channels are named "{account}.{id}", whichever shape the member id has.
    this.subscribe(socket, `presence-${this.channelOf(id)}`);
    this.subscribe(socket, `private-${this.channelOf(id)}`);
  }

  private left(socket: WebSocketLike): void {
    const gone = this.presenter;
    if (!gone) return;
    this.presenter = undefined;
    this.lastSlide = undefined;
    this.chunks.clear();
    this.send(socket, 'pusher:unsubscribe', { channel: `presence-${this.channelOf(gone.id)}` });
    this.send(socket, 'pusher:unsubscribe', { channel: `private-${this.channelOf(gone.id)}` });
    this.opts.log(`Presentation app closed on ${gone.name}.`);
    this.setStatus({ state: 'waiting', problem: null, presenter: null });
  }

  /** The follow-up of Presenter's client-event: a slide, told to onSlide when it changed and is understood. */
  private slideEvent(data: unknown): void {
    if (!isRecord(data)) return;
    const id = isRecord(data.current_slide) ? data.current_slide.id : undefined;
    const service = isRecord(data.cuelist) ? data.cuelist.id : undefined;
    if (typeof id !== 'string' || typeof service !== 'string' || id === this.lastSlide) return;
    const parsed = parseSlideId(id);
    if (!parsed) return;
    this.lastSlide = id;
    const name = isRecord(data.current_cue) && typeof data.current_cue.name === 'string' ? data.current_cue.name : '';
    try {
      this.opts.onSlide({ service, cue: parsed.cue, slide: parsed.slide, name });
    } catch (err) {
      this.opts.log(`Live connection: following a slide failed (${(err as Error)?.message ?? 'unknown'}).`);
    }
  }

  /** Big messages come in pieces {id, i, total, chunk}; the whole message once all have come, else undefined. */
  private unchunk(event: string, data: unknown): unknown {
    if (!isRecord(data) || !('chunk' in data) || !('total' in data)) return data;
    const { id, i, total, chunk } = data;
    if (typeof i !== 'number' || typeof total !== 'number' || typeof chunk !== 'string' || !Number.isInteger(i) || i < 0 || total < 1 || i >= total || total > 1000) return undefined;
    const key = `${event} ${String(id)}`;
    const parts = this.chunks.get(key) ?? [];
    parts[i] = chunk;
    this.chunks.delete(key);
    this.chunks.set(key, parts); // newest last
    while (this.chunks.size > MAX_PENDING_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    let have = 0;
    for (let n = 0; n < total; n++) if (parts[n] !== undefined) have++;
    if (have < total) return undefined;
    this.chunks.delete(key);
    return tryJson(parts.slice(0, total).join(''));
  }

  // ---- Sending ----

  /** A presentation computer's channel name: its member id, with the account in front when the id doesn't carry it. */
  private channelOf(id: string): string {
    return id.includes('.') ? id : `${this.opts.account}.${id}`;
  }

  /** Asks the other end for a sign of life; if nothing at all comes back soon, the connection is given up. */
  private ping(socket: WebSocketLike): void {
    this.send(socket, 'pusher:ping', {});
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => this.safely(() => this.drop(socket, new TypeError('no answer'))), PONG_MS);
    this.pongTimer.unref?.();
  }

  /** The id is asked for once per PresenterLive: it is kept in a file that should not be read again and again. */
  private machineIdOnce(): string {
    this.machineId ??= this.opts.planning.machineId();
    return this.machineId;
  }

  private send(socket: WebSocketLike, event: string, data: unknown, channel?: string): void {
    if (socket !== this.socket) return;
    socket.send(JSON.stringify(channel ? { event, channel, data } : { event, data }));
  }

  /** Asks the planning service to vouch for the channel, then joins it. */
  private subscribe(socket: WebSocketLike, channel: string): void {
    const socketId = this.socketId;
    this.opts.planning
      .liveAuth(this.opts.account, socketId, channel)
      .then((auth) => {
        if (socket !== this.socket) return;
        this.send(socket, 'pusher:subscribe', { channel, ...auth });
      })
      .catch((err) => this.safely(() => this.drop(socket, err)));
  }

  private setStatus(status: LiveStatus): void {
    if (this.status && this.status.state === status.state && this.status.problem === status.problem && this.status.presenter === status.presenter) return;
    this.status = status;
    try {
      this.opts.onStatus({ ...status });
    } catch {
      // the listener's trouble is not the connection's
    }
  }

  /** Runs a handler so that nothing it does can throw out of a socket or timer. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      try {
        this.opts.log(`Live connection: unexpected trouble (${(err as Error)?.message ?? 'unknown'}).`);
      } catch {
        // nothing more to do
      }
    }
  }
}

function detach(socket: WebSocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}

/** What to tell a person: a PlanningError's own words, else a plain line. */
function problemOf(err: unknown): string {
  if (err instanceof PlanningError) return err.message;
  return err instanceof TypeError ? NO_CONNECTION : FAILED;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJson(raw: unknown): unknown {
  return typeof raw === 'string' ? tryJson(raw) : undefined;
}
