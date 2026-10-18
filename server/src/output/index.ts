import type { OutputSettings, OutputStatus } from '../../../packages/shared/src/index.ts';
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
