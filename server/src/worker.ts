// The engine worker: owns the frame clock, the engine and DMX output. Nothing
// else writes DMX, and a slow web request on the main thread can never delay
// a frame.

import { parentPort } from 'node:worker_threads';
import { Engine } from '../../packages/engine/src/index.ts';
import { planRoutes, type LiveState, type Show } from '../../packages/shared/src/index.ts';
import type { FromWorker, TimingStats, ToWorker } from './messages.ts';
import { ArtNetOutput, ARTNET_PORT } from './output/artnet.ts';
import { createOutput, OutputSet } from './output/index.ts';

if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;
const post = (msg: FromWorker, transfer?: ArrayBuffer[]) => port.postMessage(msg, transfer ?? []);

/** Live state goes out at most this often while fades run (plus at once after any command). */
const STATE_EVERY = 100;
/** Visualiser frames go out at this rate; the engine itself runs at the show's frame rate. */
const VISUAL_EVERY = 50;

let engine: Engine | null = null;
/** Test hook: the UDP port to send Art-Net to, per host (normally 6454 for all). */
let artnetPorts: Record<string, number> = {};
const outputs = new OutputSet((o) =>
  o.kind === 'artnet' ? new ArtNetOutput(o.host, artnetPorts[o.host] ?? ARTNET_PORT) : createOutput(o));
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
  period = 1000 / next.settings.frameRate;
  if (!engine) engine = new Engine(next, clock() / 1000);
  else engine.setShow(next, clock() / 1000);
  // One output per box; outputs whose box didn't change keep running untouched.
  outputs.update(planRoutes(next.settings, next.fixtures.map((f) => f.universe)).destinations);
}

function render(): void {
  if (!engine) return;
  const ms = clock();
  const frame = engine.frame(ms / 1000);
  outputs.send(frame.universes);

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
  if (!engine) return;
  stateDue = false;
  lastStateAt = ms;
  const state: LiveState = { ...engine.liveState(ms / 1000, outputs.status), outputProblem: outputs.problem };
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
      artnetPorts = msg.artnetPorts ?? {};
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
      outputs.close();
      port.close();
      break;
  }
});
