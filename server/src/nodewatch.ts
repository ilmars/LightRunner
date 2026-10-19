// Watches the Art-Net nodes DMX is sent to. UDP can't confirm delivery, but a
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

/** Poll these nodes from one socket and collect their replies (one per port) for `waitMs`. */
export function pollNodes(hosts: string[], waitMs = 1500): Promise<Map<string, NodeHealth>> {
  return new Promise((resolve) => {
    const health = new Map<string, NodeHealth>(hosts.map((h) => [h, { seen: false, merging: false, name: null }]));
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
      const h = health.get(from.address);
      if (!h || m.length < 186 || m.subarray(0, 8).toString('latin1') !== 'Art-Net\0') return;
      if (m.readUInt16LE(8) !== OP_POLL_REPLY) return;
      h.seen = true;
      h.name = m.subarray(44, 108).toString('utf8').replace(/\0.*$/s, '') || h.name;
      const ports = Math.min(4, m.readUInt16BE(172));
      for (let k = 0; k < ports; k++) if (m[182 + k] & GOOD_OUTPUT_MERGING) h.merging = true;
    });
    socket.on('error', done);
    socket.bind(ARTNET_PORT, () => {
      for (const host of hosts) socket.send(POLL, ARTNET_PORT, host, () => {});
      setTimeout(done, waitMs);
    });
  });
}

/** Poll one node. */
export async function pollNode(host: string, waitMs = 1500): Promise<NodeHealth> {
  return (await pollNodes([host], waitMs)).get(host)!;
}

export function isBroadcast(host: string): boolean {
  return host === '255.255.255.255' || host.endsWith('.255') || host.startsWith('2.') || host.startsWith('10.255');
}

type Poll = (hosts: string[]) => Promise<Map<string, NodeHealth>>;

/**
 * Polls every node DMX goes to unicast, every few seconds. Reports a problem
 * after three missed polls in a row (a single lost UDP reply is normal), or
 * when a node says it is merging another source. With several nodes their
 * problems are joined into one message, each naming its node.
 */
export class NodeWatch {
  private readonly nodes = new Map<string, { misses: number; problem: string | null }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private paused = 0;
  private problem: string | null = null;
  private readonly onChange: (problem: string | null) => void;
  private readonly everyMs: number;
  private readonly poll: Poll;

  constructor(onChange: (problem: string | null) => void, everyMs = 4000, poll: Poll = (hosts) => pollNodes(hosts)) {
    this.onChange = onChange;
    this.everyMs = everyMs;
    this.poll = poll;
  }

  /** Watch these unicast hosts; broadcast addresses and null are skipped. */
  watch(hosts: string | null | (string | null)[]): void {
    const list = Array.isArray(hosts) ? hosts : [hosts];
    const next = [...new Set(list.filter((h): h is string => Boolean(h) && !isBroadcast(h!)))];
    const same = next.length === this.nodes.size && next.every((h) => this.nodes.has(h));
    if (same) return;
    for (const h of [...this.nodes.keys()]) if (!next.includes(h)) this.nodes.delete(h);
    const added = next.filter((h) => !this.nodes.has(h));
    for (const h of added) this.nodes.set(h, { misses: 0, problem: null });
    this.report();
    if (!this.nodes.size) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (!this.timer) this.timer = setInterval(() => void this.check(), this.everyMs);
    if (added.length) void this.check();
  }

  /** Skip checks for a moment, e.g. while node discovery has port 6454. */
  pause(ms: number): void {
    this.paused = Date.now() + ms;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nodes.clear();
  }

  private async check(): Promise<void> {
    if (!this.nodes.size || this.busy || Date.now() < this.paused) return;
    this.busy = true;
    try {
      const results = await this.poll([...this.nodes.keys()]);
      for (const [host, h] of results) {
        const node = this.nodes.get(host);
        if (!node) continue; // no longer watched
        if (h.seen) {
          node.misses = 0;
          node.problem = h.merging ? `Another desk is also sending to ${h.name ?? host}` : null;
        } else if (++node.misses >= 3) {
          node.problem = `Art-Net node ${host} is not answering`;
        }
      }
      this.report();
    } finally {
      this.busy = false;
    }
  }

  private report(): void {
    const problems = [...this.nodes.values()].map((n) => n.problem).filter(Boolean);
    const problem = problems.length ? problems.join('. ') : null;
    if (problem === this.problem) return;
    this.problem = problem;
    this.onChange(problem);
  }
}
