// sACN (E1.31) output: one data packet per universe per frame over UDP 5568,
// multicast to 239.255.<universe> by default, or unicast to one receiver.

import { createHash } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { hostname } from 'node:os';
import type { DmxOutput } from './index.ts';

export const SACN_PORT = 5568;
const ACN_ID = Buffer.from('ASC-E1.17\0\0\0', 'ascii');
const SOURCE_NAME = 'Light Runner';

/** A stable component id for this machine, so receivers see the same source after a restart. */
const CID = createHash('md5').update(`light-runner:${hostname()}`).digest();

export function multicastAddress(universe: number): string {
  return `239.255.${(universe >> 8) & 255}.${universe & 255}`;
}

/** Build an E1.31 data packet. sACN universes run 1–63999. */
export function sacnPacket(universe: number, data: Uint8Array, sequence: number, priority = 100): Buffer {
  const slots = data.length;
  const total = 126 + slots;
  const p = Buffer.alloc(total);
  // Root layer
  p.writeUInt16BE(0x0010, 0);
  p.writeUInt16BE(0x0000, 2);
  ACN_ID.copy(p, 4);
  p.writeUInt16BE(0x7000 | (total - 16), 16);
  p.writeUInt32BE(0x00000004, 18);
  CID.copy(p, 22);
  // Framing layer
  p.writeUInt16BE(0x7000 | (total - 38), 38);
  p.writeUInt32BE(0x00000002, 40);
  p.write(SOURCE_NAME, 44, 63, 'utf8');
  p[108] = priority;
  p.writeUInt16BE(0, 109); // no synchronisation
  p[111] = sequence & 255;
  p[112] = 0; // options
  p.writeUInt16BE(universe, 113);
  // DMP layer
  p.writeUInt16BE(0x7000 | (total - 115), 115);
  p[117] = 0x02;
  p[118] = 0xa1;
  p.writeUInt16BE(0x0000, 119);
  p.writeUInt16BE(0x0001, 121);
  p.writeUInt16BE(slots + 1, 123);
  p[125] = 0; // DMX start code
  p.set(data, 126);
  return p;
}

export class SacnOutput implements DmxOutput {
  private socket: Socket;
  private sequence = 0;
  private lastError = 0;
  private readonly host: string;
  private readonly priority: number;
  private readonly port: number;

  /** `host` empty = multicast per universe; otherwise unicast to that receiver. */
  constructor(host: string, priority = 100, port = SACN_PORT) {
    this.host = host.trim();
    this.priority = priority;
    this.port = port;
    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', () => (this.lastError = Date.now()));
    this.socket.bind(() => {
      try {
        this.socket.setMulticastTTL(8);
      } catch {
        this.lastError = Date.now();
      }
    });
  }

  get status(): 'ok' | 'lost' {
    return Date.now() - this.lastError < 2000 ? 'lost' : 'ok';
  }

  send(universes: Map<number, Uint8Array>): void {
    this.sequence = (this.sequence + 1) & 255;
    for (const [u, data] of universes) {
      // sACN has no universe 0; a show patched on universe 0 goes out on 1.
      const universe = Math.max(1, u);
      const to = this.host || multicastAddress(universe);
      this.socket.send(sacnPacket(universe, data, this.sequence, this.priority), this.port, to, (err) => {
        if (err) this.lastError = Date.now();
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}
