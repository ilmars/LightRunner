import type { Destination, OutputSettings, OutputStatus } from '../../../packages/shared/src/index.ts';
import { ArtNetOutput } from './artnet.ts';
import { EnttecOutput } from './enttec.ts';
import { SacnOutput } from './sacn.ts';

export interface DmxOutput {
  send(universes: Map<number, Uint8Array>): void;
  readonly status: OutputStatus;
  close(): void;
}

class NoOutput implements DmxOutput {
  readonly status = 'off' as const;
  send(): void {}
  close(): void {}
}

export function createOutput(settings: OutputSettings, enabled = true): DmxOutput {
  if (!enabled) return new NoOutput();
  switch (settings.kind) {
    case 'artnet': return new ArtNetOutput(settings.host);
    case 'sacn': return new SacnOutput(settings.host, settings.priority);
    case 'enttec': return new EnttecOutput(settings.port);
    case 'none': return new NoOutput();
  }
}

/** The box an output sends to, for messages. */
function describe(o: OutputSettings): string {
  switch (o.kind) {
    case 'artnet': return `Can't send to Art-Net node ${o.host}`;
    case 'sacn': return o.host ? `Can't send sACN to ${o.host}` : "Can't send sACN";
    case 'enttec': return `The USB interface on ${o.port} is not connected`;
    case 'none': return '';
  }
}

interface Open {
  output: DmxOutput;
  settings: OutputSettings;
  universes: number[];
  /** Reused every frame: the engine's buffers for this output's universes. */
  frame: Map<number, Uint8Array>;
}

/**
 * Every output the show sends to, one per box (see planRoutes). Updating keeps
 * the outputs whose box didn't change, so re-routing one universe never
 * interrupts the others.
 */
export class OutputSet {
  private open = new Map<string, Open>();
  private readonly create: (settings: OutputSettings) => DmxOutput;

  constructor(create: (settings: OutputSettings) => DmxOutput = (s) => createOutput(s)) {
    this.create = create;
  }

  update(destinations: Destination[]): void {
    const next = new Map<string, Open>();
    for (const d of destinations) {
      const kept = this.open.get(d.key);
      next.set(d.key, kept
        ? { ...kept, universes: d.universes }
        : { output: this.create(d.output), settings: d.output, universes: d.universes, frame: new Map() });
    }
    for (const [key, o] of this.open) if (!next.has(key)) o.output.close();
    this.open = next;
  }

  send(universes: Map<number, Uint8Array>): void {
    for (const o of this.open.values()) {
      o.frame.clear();
      for (const u of o.universes) {
        const data = universes.get(u);
        if (data) o.frame.set(u, data);
      }
      o.output.send(o.frame);
    }
  }

  /** "off" when nothing is sent, "lost" when any output is lost. */
  get status(): OutputStatus {
    let status: OutputStatus = 'off';
    for (const o of this.open.values()) {
      if (o.output.status === 'lost') return 'lost';
      if (o.output.status === 'ok') status = 'ok';
    }
    return status;
  }

  /** With several outputs, which ones are lost, in plain words. Null with one, so its usual message stays. */
  get problem(): string | null {
    if (this.open.size < 2) return null;
    const lost = [...this.open.values()].filter((o) => o.output.status === 'lost').map((o) => describe(o.settings));
    return lost.length ? lost.join('. ') : null;
  }

  close(): void {
    for (const o of this.open.values()) o.output.close();
    this.open.clear();
  }
}
