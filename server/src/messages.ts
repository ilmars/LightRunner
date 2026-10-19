// Messages between the main thread and the engine worker.

import type { LiveState, RuntimeState, Show, StageCommand } from '../../packages/shared/src/index.ts';

export type ToWorker =
  /** `artnetPorts`: test hook, the UDP port to send Art-Net to per host. */
  | { type: 'init'; show: Show; runtime: RuntimeState | null; artnetPorts?: Record<string, number> }
  | { type: 'show'; show: Show }
  | { type: 'command'; id: number; cmd: StageCommand }
  | { type: 'snapshot'; id: number }
  | { type: 'timing'; id: number; reset?: boolean }
  | { type: 'stop' };

export interface TimingStats {
  frames: number;
  /** Target frame interval, ms. */
  period: number;
  minInterval: number;
  maxInterval: number;
  /** Frames more than 3 ms off the target interval. */
  late: number;
  /** Seconds measured. */
  seconds: number;
}

export type FromWorker =
  | { type: 'ready'; fixtures: string[] }
  /** `recorded`: the command added a step to the Undo list. */
  | { type: 'result'; id: number; error: string | null; recorded: boolean }
  | { type: 'snapshot'; id: number; runtime: RuntimeState }
  | { type: 'state'; state: LiveState }
  | { type: 'runtime'; runtime: RuntimeState }
  | { type: 'visual'; data: Uint8Array }
  | { type: 'timing'; id: number; stats: TimingStats };
