// Art-Net node discovery: broadcast an ArtPoll and collect ArtPollReply
// packets for a moment. Lists each node's IP, name and output universes.

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { ARTNET_PORT } from './output/artnet.ts';

export interface ArtNetNode {
  ip: string;
  shortName: string;
  longName: string;
  /** Art-Net port-addresses (universes) of its DMX outputs. */
  universes: number[];
  /** Runs on this computer (e.g. another lighting app's built-in node), not a real box. */
  thisMachine?: boolean;
}

const POLL = Buffer.concat([Buffer.from('Art-Net\0', 'ascii'), Buffer.from([0x00, 0x20, 0, 14, 0, 0])]);
const OP_POLL_REPLY = 0x2100;
const PORT_TYPE_OUTPUT = 0x80;

export function parsePollReply(m: Buffer): ArtNetNode | null {
  if (m.length < 197 || m.subarray(0, 8).toString('latin1') !== 'Art-Net\0' || m.readUInt16LE(8) !== OP_POLL_REPLY) return null;
  const text = (a: number, b: number) => m.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
  const net = m[18] & 0x7f, sub = m[19] & 0x0f;
  const ports = Math.min(4, m.readUInt16BE(172));
  const universes: number[] = [];
  for (let k = 0; k < ports; k++) {
    if (m[174 + k] & PORT_TYPE_OUTPUT) universes.push((net << 8) | (sub << 4) | (m[190 + k] & 0x0f));
  }
  return { ip: [...m.subarray(10, 14)].join('.'), shortName: text(26, 44), longName: text(44, 108), universes };
}

/** Directed broadcast addresses of this machine's IPv4 networks. */
function broadcastAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.add(ip.map((v, k) => (v & mask[k]) | (~mask[k] & 255)).join('.'));
    }
  }
  return [...out];
}

export function discoverArtNet(waitMs = 2000): Promise<ArtNetNode[]> {
  return new Promise((resolve) => {
    const found = new Map<string, ArtNetNode>();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (m) => {
      const node = parsePollReply(m);
      if (!node) return;
      // Multi-port nodes answer once per port: merge them.
      const key = `${node.ip}|${node.longName}`;
      const known = found.get(key);
      if (known) known.universes = [...new Set([...known.universes, ...node.universes])].sort((a, b) => a - b);
      else found.set(key, node);
    });
    socket.on('error', () => {
      socket.close();
      resolve([...found.values()]);
    });
    socket.bind(ARTNET_PORT, () => {
      socket.setBroadcast(true);
      for (const to of [...broadcastAddresses(), '255.255.255.255']) socket.send(POLL, ARTNET_PORT, to, () => {});
      setTimeout(() => {
        socket.close();
        // Other lighting apps on this computer (e.g. Lightkey) answer too; mark them.
        const own = new Set(Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address)));
        resolve([...found.values()].map((n) => (own.has(n.ip) ? { ...n, thisMachine: true } : n)).sort((a, b) => Number(a.thisMachine ?? false) - Number(b.thisMachine ?? false)));
      }, waitMs);
    });
  });
}
