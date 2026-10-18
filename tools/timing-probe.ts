// Measures DMX frame timing on this machine: runs the real engine worker,
// keeps changing looks, and reports how far frame intervals stray from the
// target. Optionally loads the main thread to show it cannot delay frames.
//
//   node tools/timing-probe.ts [--seconds 60] [--load] [--block]
//
//   --load   fire ~100 API requests per second at the server
//   --block  freeze the main thread for 300 ms every 5 s (a pathological slow request)
//
// Target from the spec: every frame within ±3 ms of 25 ms.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { App } from '../server/src/app.ts';

const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '60' },
    load: { type: 'boolean', default: false },
    block: { type: 'boolean', default: false },
  },
});
const seconds = Number(values.seconds);
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'light-runner-probe-'));
const app = new App({
  port: 0, host: '127.0.0.1', dataDir: dir,
  seedPath: join(root, 'server/seed/demo-show.json'), webDir: join(root, 'web'),
  output: { kind: 'none' }, log: () => {},
});
await app.start();
await app.timing(true);

const looks = ['walk-in', 'worship', 'word', 'response', 'prayer'];
let n = 0;
const changer = setInterval(() => void app.command({ type: 'look', id: looks[n++ % looks.length], fade: 2 }, 'operator'), 1500);
const loader = values.load
  ? setInterval(() => {
      for (let k = 0; k < 10; k++) void fetch(`http://127.0.0.1:${app.port}/api/state`).then((r) => r.arrayBuffer()).catch(() => {});
    }, 100)
  : null;
const blocker = values.block
  ? setInterval(() => {
      const until = performance.now() + 300;
      while (performance.now() < until) { /* freeze the main thread */ }
    }, 5000)
  : null;

console.log(`Measuring for ${seconds} s${values.load ? ' with API load' : ''}${values.block ? ' with main-thread freezes' : ''}…`);
await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(changer);
if (loader) clearInterval(loader);
if (blocker) clearInterval(blocker);

const t = await app.timing();
await app.stop();
rmSync(dir, { recursive: true, force: true });

const pass = t.late === 0;
console.log(`Frames: ${t.frames} in ${t.seconds.toFixed(1)} s (target interval ${t.period.toFixed(1)} ms)`);
console.log(`Interval min ${t.minInterval.toFixed(2)} ms, max ${t.maxInterval.toFixed(2)} ms`);
console.log(`Frames more than 3 ms off: ${t.late} (${((t.late / Math.max(1, t.frames)) * 100).toFixed(3)}%)`);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
