// Art-Net output: one ArtDmx packet per universe per frame over UDP 6454.

import { createSocket, type Socket } from 'node:dgram';
import type { DmxOutput } from './index.ts';

export const ARTNET_PORT = 6454;
const HEADER = Buffer.from('Art-Net\0', 'ascii');
const OP_DMX = 0x5000;
const PROTOCOL = 14;

/** Build an ArtDmx packet. `universe` is the 15-bit Port-Address (net, sub-net, universe). */
export function artDmx(universe: number, data: Uint8Array, sequence: number): Buffer {
  const length = Math.max(2, data.length + (data.length & 1));
  const p = Buffer.alloc(18 + length);
  HEADER.copy(p, 0);
  p.writeUInt16LE(OP_DMX, 8);
  p.writeUInt16BE(PROTOCOL, 10);
  p[12] = sequence & 255;
  p[13] = 0; // physical port
  p[14] = universe & 0xff; // SubUni
  p[15] = (universe >> 8) & 0x7f; // Net
  p.writeUInt16BE(length, 16);
  p.set(data, 18);
  return p;
}

export class ArtNetOutput implements DmxOutput {
  private socket: Socket;
  private sequence = 0;
  private lastError = 0;
  private host: string;
  private port: number;

  constructor(host: string, port = ARTNET_PORT) {
    this.host = host;
    this.port = port;
    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', () => (this.lastError = Date.now()));
    this.socket.bind(() => {
      try {
        this.socket.setBroadcast(true);
      } catch {
        this.lastError = Date.now();
      }
    });
  }

  /** "lost" if a send failed in the last 2 s (no route, interface down). */
  get status(): 'ok' | 'lost' {
    return Date.now() - this.lastError < 2000 ? 'lost' : 'ok';
  }

  send(universes: Map<number, Uint8Array>): void {
    // Sequence 0 means "not used"; cycle 1..255.
    this.sequence = (this.sequence % 255) + 1;
    for (const [universe, data] of universes) {
      this.socket.send(artDmx(universe, data, this.sequence), this.port, this.host, (err) => {
        if (err) this.lastError = Date.now();
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}
