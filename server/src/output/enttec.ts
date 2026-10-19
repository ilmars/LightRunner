// ENTTEC DMX USB Pro output over serial: "Output Only Send DMX Packet" (label 6).
// The serial port is retried every second while unplugged.

import type { DmxOutput } from './index.ts';

const START = 0x7e;
const END = 0xe7;
const SEND_DMX = 6;

export function enttecPacket(data: Uint8Array): Buffer {
  const length = data.length + 1; // DMX start code + channels
  const p = Buffer.alloc(length + 5);
  p[0] = START;
  p[1] = SEND_DMX;
  p[2] = length & 255;
  p[3] = length >> 8;
  p[4] = 0; // start code
  p.set(data, 5);
  p[p.length - 1] = END;
  return p;
}

export interface SerialLike {
  write(data: Buffer): boolean;
  close(cb?: (err: Error | null) => void): void;
  on(event: 'close' | 'error', fn: (...args: unknown[]) => void): void;
  isOpen: boolean;
}

async function openSerial(path: string): Promise<SerialLike> {
  const { SerialPort } = await import('serialport');
  return new Promise<SerialLike>((resolve, reject) => {
    const p = new SerialPort({ path, baudRate: 250000 }, (err) => (err ? reject(err) : resolve(p as unknown as SerialLike)));
  });
}

export class EnttecOutput implements DmxOutput {
  private port: SerialLike | null = null;
  private opening = false;
  private lastTry = 0;
  private closed = false;
  private path: string;
  private readonly openPort: (path: string) => Promise<SerialLike>;

  /** `openPort` stands in for the serial port in tests. */
  constructor(path: string, openPort: (path: string) => Promise<SerialLike> = openSerial) {
    this.path = path;
    this.openPort = openPort;
    void this.open();
  }

  get status(): 'ok' | 'lost' {
    return this.port?.isOpen ? 'ok' : 'lost';
  }

  private async open(): Promise<void> {
    if (this.opening || this.closed) return;
    this.opening = true;
    this.lastTry = Date.now();
    try {
      const port = await this.openPort(this.path);
      // Closed while the port was opening (routes changed): let it go, or it stays open and busy.
      if (this.closed) {
        port.close();
        return;
      }
      port.on('close', () => (this.port = null));
      port.on('error', () => (this.port = null));
      this.port = port;
    } catch {
      this.port = null;
    } finally {
      this.opening = false;
    }
  }

  send(universes: Map<number, Uint8Array>): void {
    if (!this.port?.isOpen) {
      if (Date.now() - this.lastTry >= 1000) void this.open();
      return;
    }
    // A DMX USB Pro has one output: the lowest universe in the show.
    const first = [...universes.keys()].sort((a, b) => a - b)[0];
    const data = first === undefined ? undefined : universes.get(first);
    if (data) this.port.write(enttecPacket(data));
  }

  close(): void {
    this.closed = true;
    this.port?.close();
  }
}
