// OSC input: other programs (ProPresenter, TouchOSC, a script) control the lights over UDP.
// A small OSC 1.0 reader (messages and bundles; types i f s T F), the address to DeviceAction mapping,
// and the UDP listener. Input only: nothing is sent back.

import { createSocket } from 'node:dgram';
import type { DeviceAction } from '../../packages/shared/src/devices.ts';
import { isLocalAddress } from './net.ts';

/** One OSC argument. `b` is a True or False tag. */
export type OscArg =
  | { type: 'i' | 'f'; value: number }
  | { type: 's'; value: string }
  | { type: 'b'; value: boolean };

export interface OscMessage {
  address: string;
  args: OscArg[];
}

/** How deep bundles may sit inside bundles. */
const MAX_DEPTH = 8;

/** An OSC string (NUL-ended, padded to 4 bytes) at `at`: its text and where the next field starts. Null if cut short. */
function readString(buf: Buffer, at: number): { text: string; next: number } | null {
  const end = buf.indexOf(0, at);
  if (end < 0) return null;
  const next = at + Math.ceil((end - at + 1) / 4) * 4;
  if (next > buf.length) return null;
  return { text: buf.toString('latin1', at, end), next };
}

function readMessage(buf: Buffer): OscMessage | null {
  const address = readString(buf, 0);
  if (!address || !address.text.startsWith('/')) return null;
  // Very old senders leave out the type tags when there are no arguments.
  if (address.next === buf.length) return { address: address.text, args: [] };
  const tags = readString(buf, address.next);
  if (!tags || !tags.text.startsWith(',')) return null;
  const args: OscArg[] = [];
  let at = tags.next;
  for (const tag of tags.text.slice(1)) {
    switch (tag) {
      case 'i':
      case 'f':
        if (at + 4 > buf.length) return null;
        args.push({ type: tag, value: tag === 'i' ? buf.readInt32BE(at) : buf.readFloatBE(at) });
        at += 4;
        break;
      case 's': {
        const s = readString(buf, at);
        if (!s) return null;
        args.push({ type: 's', value: s.text });
        at = s.next;
        break;
      }
      case 'T':
      case 'F':
        args.push({ type: 'b', value: tag === 'T' });
        break;
      default:
        // A type this reader can't size: the rest of the packet can't be read.
        return null;
    }
  }
  return { address: address.text, args };
}

function readPacket(buf: Buffer, depth: number): OscMessage[] | null {
  if (buf.length === 0) return null;
  if (buf[0] !== 0x23) {
    const m = readMessage(buf);
    return m ? [m] : null;
  }
  // "#bundle", a time tag (ignored: messages run as they arrive), then size-prefixed elements.
  if (depth >= MAX_DEPTH || buf.length < 16 || buf.toString('latin1', 0, 8) !== '#bundle\0') return null;
  const out: OscMessage[] = [];
  let at = 16;
  while (at < buf.length) {
    if (at + 4 > buf.length) return null;
    const size = buf.readInt32BE(at);
    at += 4;
    if (size <= 0 || at + size > buf.length) return null;
    const inner = readPacket(buf.subarray(at, at + size), depth + 1);
    if (!inner) return null;
    out.push(...inner);
    at += size;
  }
  return out;
}

/** The messages in an OSC packet, in order, or null when it is cut short or not OSC. */
export function parseOsc(buf: Buffer): OscMessage[] | null {
  return readPacket(buf, 0);
}

/** 0 to 1; a 32-bit float like 0.7 arrives as 0.699999988, so it is rounded to 4 places. */
const clamp01 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
const POSITION = /^\d+$/;

/**
 * The device action an OSC message asks for, or null for an address or argument that isn't understood.
 * Addresses start with /lightrunner (any case). Levels are a float 0 to 1 or an integer 0 to 100.
 */
export function oscAction(msg: OscMessage): DeviceAction | null {
  const path = msg.address.toLowerCase().split('/');
  if (path.at(-1) === '') path.pop(); // a trailing slash
  if (path[0] !== '' || path[1] !== 'lightrunner') return null;
  const rest = path.slice(2);
  const [arg] = msg.args;
  const number = arg && arg.type !== 's' && arg.type !== 'b' && Number.isFinite(arg.value) ? arg.value : null;
  /** A level: an integer is a percentage, a float is already 0 to 1. */
  const level = arg && (arg.type === 'i' || arg.type === 'f') && Number.isFinite(arg.value) ? clamp01(arg.type === 'i' ? arg.value / 100 : arg.value) : null;

  // A button that sends 1 on press and 0 on release (TouchOSC, bridges, desks) must act once: the release does nothing.
  // A bare message with no argument still acts.
  const release = arg !== undefined && ((arg.type === 'b' && !arg.value) || ((arg.type === 'i' || arg.type === 'f') && arg.value === 0));
  const trigger = <A extends DeviceAction>(action: A): A | null => (release ? null : action);

  switch (rest[0]) {
    case 'item':
      return rest.length === 1 && number !== null ? { kind: 'item', n: number } : null;
    case 'next': return rest.length === 1 ? trigger({ kind: 'next' }) : null;
    case 'back': return rest.length === 1 ? trigger({ kind: 'backToLook' }) : null;
    case 'undo': return rest.length === 1 ? trigger({ kind: 'undo' }) : null;
    case 'basic': return rest.length === 1 ? trigger({ kind: 'basic' }) : null;
    case 'blackout': return rest.length === 1 ? trigger({ kind: 'blackout' }) : null;
    case 'group': {
      if (rest.length !== 3 || !POSITION.test(rest[1])) return null;
      const group = Number(rest[1]);
      if (rest[2] === 'level') return level === null ? null : { kind: 'groupLevel', group, value: level };
      if (rest[2] === 'colour') return number === null ? null : { kind: 'groupColour', group, colour: number };
      return null;
    }
    case 'flash': {
      if (rest.length !== 2 || !arg) return null;
      const on = arg.type === 'b' ? arg.value : number !== null ? number > 0 : null;
      if (on === null) return null;
      if (rest[1] === 'all') return { kind: 'flash', group: 'all', on };
      return POSITION.test(rest[1]) ? { kind: 'flash', group: Number(rest[1]), on } : null;
    }
    case 'master':
      if (rest.length === 1) return level === null ? null : { kind: 'master', value: level };
      if (rest.length === 2 && rest[1] === 'up') return trigger({ kind: 'masterStep', by: 0.1 });
      if (rest.length === 2 && rest[1] === 'down') return trigger({ kind: 'masterStep', by: -0.1 });
      return null;
    default:
      return null;
  }
}

export interface OscServer {
  port: number;
  /** Stop listening; messages still waiting are dropped. */
  close(): Promise<void>;
}

/** The same complaint is logged at most this often. */
const LOG_EVERY_MS = 60_000;
const MAX_LOGGED = 200;

/** An address made safe to put in a log line. */
const printable = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);

/**
 * Listen for OSC on a UDP port (this computer's network, local addresses only). Each message runs through
 * `run` in the order it arrived; what can't be understood or done is logged, once per address per minute.
 * Rejects with plain words when the port can't be used.
 */
export function listenOsc(
  port: number,
  run: (action: DeviceAction) => Promise<string | null>,
  log: (message: string) => void,
  host = '0.0.0.0',
): Promise<OscServer> {
  const socket = createSocket({ type: 'udp4' });
  const logged = new Map<string, number>();
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const note = (key: string, text: string) => {
    const now = Date.now();
    const last = logged.get(key);
    if (last !== undefined && now - last < LOG_EVERY_MS) return;
    // Garbage with a new address each time must not grow this without end.
    if (logged.size >= MAX_LOGGED) logged.clear();
    logged.set(key, now);
    log(text);
  };

  socket.on('message', (data, from) => {
    if (closed || !isLocalAddress(from.address)) return;
    const messages = parseOsc(data);
    if (!messages) return note('', 'OSC: ignored a packet that is not OSC');
    for (const m of messages) {
      const action = oscAction(m);
      const name = printable(m.address);
      if (!action) {
        note(m.address, `OSC: ignored ${name}`);
        continue;
      }
      queue = queue
        .then(() => (closed ? null : run(action)))
        .then((problem) => { if (problem) note(m.address, `OSC: ${name}: ${problem}`); })
        .catch((err) => note(m.address, `OSC: ${name} failed: ${(err as Error).message}`));
    }
  });

  return new Promise((resolve, reject) => {
    const failed = (err: NodeJS.ErrnoException) => {
      socket.close();
      reject(new Error(
        err.code === 'EADDRINUSE' ? `Port ${port} is already in use by another program.`
          : err.code === 'EACCES' ? `Light Runner is not allowed to use port ${port}.`
          : `Can't listen on port ${port} (${err.message}).`));
    };
    socket.once('error', failed);
    socket.bind(port, host, () => {
      socket.off('error', failed);
      // Once listening, a socket error is only logged: it must not take the app down.
      socket.on('error', (err) => note('socket', `OSC: ${err.message}`));
      resolve({
        port: socket.address().port,
        close: () => new Promise<void>((done) => {
          closed = true;
          // A socket that is already closed throws; closing twice must still finish.
          try {
            socket.close(() => done());
          } catch {
            done();
          }
        }),
      });
    });
  });
}
