// Messages between the main thread and the engine worker.

import type { StageClock } from '../../packages/engine/src/index.ts';
import type { LiveState, PresetPin, RuntimeState, Show, StageCommand } from '../../packages/shared/src/index.ts';

/** Visualiser frames go out this often (ms), the live ones and a Blind draft's alike; the engine itself runs at the show's frame rate. */
export const VISUAL_EVERY = 50;

export type ToWorker =
  /** `artnetRedirect`: test hook, send Art-Net for a host to another address and port. */
  | { type: 'init'; show: Show; runtime: RuntimeState | null; artnetRedirect?: Record<string, { host: string; port: number }> }
  /** `keep`: an edit from Prepare (or its Undo), which never moves the lights; its pins (see Engine.setShow). */
  | { type: 'show'; show: Show; keep?: { pins: PresetPin[] } }
  /** `quiet`: the timeline's own change, which adds no Undo step. */
  | { type: 'command'; id: number; cmd: StageCommand; quiet?: boolean }
  /** What a light group's level follows (a voice, 0–1), or null for nothing; the engine smooths it. */
  | { type: 'follow'; group: string; value: number | null }
  /** A live timeline starts: Blackout (if on) ends without a light moving (Engine.leaveBlackout). */
  | { type: 'leaveBlackout' }
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
  /** `clock`: the stage clocks at the same moment, for a Blind draft to adopt. */
  | { type: 'snapshot'; id: number; runtime: RuntimeState; clock: StageClock }
  | { type: 'state'; state: LiveState }
  | { type: 'runtime'; runtime: RuntimeState }
  | { type: 'visual'; data: Uint8Array }
  | { type: 'timing'; id: number; stats: TimingStats };
