// Watches the Art-Net node DMX is sent to. UDP can't confirm delivery, but a
// node answers an ArtPoll and says whether it is outputting and whether it is
// merging another source (another desk sending at the same time).

import { createSocket } from 'node:dgram';
import { ARTNET_PORT } from './output/artnet.ts';

const POLL = Buffer.concat([Buffer.from('Art-Net\0', 'ascii'), Buffer.from([0x00, 0x20, 0, 14, 0, 0])]);
const OP_POLL_REPLY = 0x2100;
const GOOD_OUTPUT_MERGING = 0x08;

export interface NodeHealth {
  /** The node answered recently. */
  seen: boolean;
  /** The node is merging DMX from another source on one of its outputs. */
  merging: boolean;
  /** The node's name, when known. */
  name: string | null;
}

/** Poll one node and collect its replies (one per port) for `waitMs`. */
export function pollNode(host: string, waitMs = 1500): Promise<NodeHealth> {
  return new Promise((resolve) => {
    const health: NodeHealth = { seen: false, merging: false, name: null };
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(health);
    };
    socket.on('message', (m, from) => {
      if (from.address !== host || m.length < 186 || m.subarray(0, 8).toString('latin1') !== 'Art-Net\0') return;
      if (m.readUInt16LE(8) !== OP_POLL_REPLY) return;
      health.seen = true;
      health.name = m.subarray(44, 108).toString('utf8').replace(/\0.*$/s, '') || health.name;
      const ports = Math.min(4, m.readUInt16BE(172));
      for (let k = 0; k < ports; k++) if (m[182 + k] & GOOD_OUTPUT_MERGING) health.merging = true;
    });
    socket.on('error', done);
    socket.bind(ARTNET_PORT, () => {
      socket.send(POLL, ARTNET_PORT, host, () => {});
      setTimeout(done, waitMs);
    });
  });
}

export function isBroadcast(host: string): boolean {
  return host === '255.255.255.255' || host.endsWith('.255') || host.startsWith('2.') || host.startsWith('10.255');
}

/**
 * Polls the target every few seconds. Reports a problem after three missed
 * polls in a row (a single lost UDP reply is normal), or when the node says
 * it is merging another source.
 */
export class NodeWatch {
  private host: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private misses = 0;
  private busy = false;
  private paused = 0;
  private problem: string | null = null;
  private readonly onChange: (problem: string | null) => void;
  private readonly everyMs: number;

  constructor(onChange: (problem: string | null) => void, everyMs = 4000) {
    this.onChange = onChange;
    this.everyMs = everyMs;
  }

  /** Watch this unicast host, or nothing (null, broadcast, other output types). */
  watch(host: string | null): void {
    const next = host && !isBroadcast(host) ? host : null;
    if (next === this.host) return;
    this.host = next;
    this.misses = 0;
    this.set(null);
    if (this.timer) clearInterval(this.timer);
    this.timer = next ? setInterval(() => void this.check(), this.everyMs) : null;
    if (next) void this.check();
  }

  /** Skip checks for a moment, e.g. while node discovery has port 6454. */
  pause(ms: number): void {
    this.paused = Date.now() + ms;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host = null;
  }

  private async check(): Promise<void> {
    const host = this.host;
    if (!host || this.busy || Date.now() < this.paused) return;
    this.busy = true;
    try {
      const h = await pollNode(host);
      if (host !== this.host) return;
      if (h.seen) {
        this.misses = 0;
        this.set(h.merging ? `Another desk is also sending to ${h.name ?? host}` : null);
      } else if (++this.misses >= 3) {
        this.set(`Art-Net node ${host} is not answering`);
      }
    } finally {
      this.busy = false;
    }
  }

  private set(problem: string | null): void {
    if (problem === this.problem) return;
    this.problem = problem;
    this.onChange(problem);
  }
}
