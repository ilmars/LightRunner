// The engine worker: owns the frame clock, the engine and DMX output. Nothing
// else writes DMX, and a slow web request on the main thread can never delay
// a frame.

import { parentPort } from 'node:worker_threads';
import { Engine } from '../../packages/engine/src/index.ts';
import type { LiveState, Show } from '../../packages/shared/src/index.ts';
import type { FromWorker, TimingStats, ToWorker } from './messages.ts';
import { createOutput, type DmxOutput } from './output/index.ts';

if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;
const post = (msg: FromWorker, transfer?: ArrayBuffer[]) => port.postMessage(msg, transfer ?? []);

/** Live state goes out at most this often while fades run (plus at once after any command). */
const STATE_EVERY = 100;
/** Visualiser frames go out at this rate; the engine itself runs at the show's frame rate. */
const VISUAL_EVERY = 50;

let engine: Engine | null = null;
let show: Show | null = null;
let output: DmxOutput | null = null;
let period = 25;
let running = false;
let lastStateJson = '';
let lastStateAt = 0;
let stateDue = false;
let lastRuntimeJson = '';
let lastVisualAt = 0;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

const clock = () => performance.now();

let timing = freshTiming();
let lastFrameAt = 0;
function freshTiming(): TimingStats & { startedAt: number } {
  return { frames: 0, period, minInterval: Infinity, maxInterval: 0, late: 0, seconds: 0, startedAt: clock() };
}

function applyShow(next: Show): void {
  const outputKey = (s: Show) => JSON.stringify([s.settings.output, s.settings.outputEnabled]);
  const outputChanged = !show || outputKey(show) !== outputKey(next);
  show = next;
  period = 1000 / next.settings.frameRate;
  if (!engine) engine = new Engine(next, clock() / 1000);
  else engine.setShow(next, clock() / 1000);
  if (outputChanged) {
    output?.close();
    output = createOutput(next.settings.output, next.settings.outputEnabled);
  }
}

function render(): void {
  if (!engine || !output) return;
  const ms = clock();
  const frame = engine.frame(ms / 1000);
  output.send(frame.universes);

  if (lastFrameAt) {
    const interval = ms - lastFrameAt;
    timing.frames++;
    timing.minInterval = Math.min(timing.minInterval, interval);
    timing.maxInterval = Math.max(timing.maxInterval, interval);
    if (Math.abs(interval - period) > 3) timing.late++;
  }
  lastFrameAt = ms;

  if (ms - lastVisualAt >= VISUAL_EVERY) {
    lastVisualAt = ms;
    const copy = frame.visual.slice();
    post({ type: 'visual', data: copy }, [copy.buffer]);
  }
  if (stateDue || ms - lastStateAt >= STATE_EVERY) publishState(ms);
}

function publishState(ms: number): void {
  if (!engine || !output) return;
  stateDue = false;
  lastStateAt = ms;
  const state: LiveState = engine.liveState(ms / 1000, output.status);
  const json = JSON.stringify(state);
  if (json !== lastStateJson) {
    lastStateJson = json;
    post({ type: 'state', state });
  }
  const runtime = engine.runtime();
  const rjson = JSON.stringify(runtime);
  if (rjson !== lastRuntimeJson) {
    lastRuntimeJson = rjson;
    post({ type: 'runtime', runtime });
  }
}

/**
 * Drift-free frame loop. Each frame's target time comes from the previous
 * target, not from when the frame ran. The loop yields to the event loop (so
 * commands arrive) until a few ms before the frame, then sleeps precisely:
 * timers can wake several ms late (macOS coalesces them), Atomics.wait does not.
 */
const WAKE_EARLY = 6;
let next = 0;
function loop(): void {
  if (!running) return;
  render();
  next += period;
  const now = clock();
  // After a long stall (laptop sleep, debugger), start again from now instead of racing to catch up.
  if (now - next > period * 4) next = now + period;
  const wait = next - now;
  setTimeout(() => {
    const rest = next - clock();
    if (rest > 0) Atomics.wait(sleeper, 0, 0, rest);
    loop();
  }, Math.max(0, wait - WAKE_EARLY));
}

port.on('message', (msg: ToWorker) => {
  switch (msg.type) {
    case 'init': {
      applyShow(msg.show);
      if (msg.runtime) engine!.restore(msg.runtime, clock() / 1000);
      post({ type: 'ready', fixtures: engine!.fixtureIds() });
      running = true;
      next = clock();
      timing = freshTiming();
      loop();
      break;
    }
    case 'show':
      applyShow(msg.show);
      stateDue = true;
      break;
    case 'command': {
      const error = engine ? engine.apply(msg.cmd, clock() / 1000) : 'engine not started';
      post({ type: 'result', id: msg.id, error, recorded: !!engine?.recorded });
      stateDue = true;
      break;
    }
    case 'snapshot':
      if (engine) post({ type: 'snapshot', id: msg.id, runtime: engine.runtime() });
      break;
    case 'timing': {
      const { startedAt, ...stats } = timing;
      post({ type: 'timing', id: msg.id, stats: { ...stats, period, seconds: (clock() - startedAt) / 1000 } });
      if (msg.reset) {
        timing = freshTiming();
        lastFrameAt = 0;
      }
      break;
    }
    case 'stop':
      running = false;
      output?.close();
      port.close();
      break;
  }
});
