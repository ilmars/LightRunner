// Messages between the main thread and the engine worker.

import type { Command, LiveState, RuntimeState, Show } from '../../packages/shared/src/index.ts';

export type ToWorker =
  | { type: 'init'; show: Show; runtime: RuntimeState | null }
  | { type: 'show'; show: Show }
  | { type: 'command'; id: number; cmd: Command }
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
  | { type: 'result'; id: number; error: string | null }
  | { type: 'state'; state: LiveState }
  | { type: 'runtime'; runtime: RuntimeState }
  | { type: 'visual'; data: Uint8Array }
  | { type: 'timing'; id: number; stats: TimingStats };
