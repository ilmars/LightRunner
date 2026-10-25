// Keeps Light Runner running: starts the server and starts it again within a
// second whenever it stops. The system service (launchd, systemd, Windows
// Task Scheduler) only has to start this at boot, which works the same on
// every platform.
//
//   node server/src/supervise.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const RESTART_DELAY = 1000;
/** A crash loop backs off so a broken show file doesn't spin the CPU. */
const MAX_DELAY = 30_000;

let child: ChildProcess | null = null;
let stopping = false;
let delay = RESTART_DELAY;
let startedAt = 0;

const log = (msg: string) => console.log(`${new Date().toISOString()} [supervisor] ${msg}`);

function start(): void {
  startedAt = Date.now();
  child = spawn(process.execPath, [main], { stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    // Ran for a while: a one-off crash, restart at once. Died quickly again: back off.
    delay = Date.now() - startedAt > 60_000 ? RESTART_DELAY : Math.min(MAX_DELAY, delay * 2);
    log(`server stopped (${signal ?? `code ${code}`}); starting again in ${delay / 1000} s`);
    setTimeout(start, delay);
  });
}

function stop(signal: NodeJS.Signals): void {
  stopping = true;
  log(`${signal}: stopping`);
  if (!child) process.exit(0);
  child.kill('SIGTERM');
  // The server saves state and exits; force it if it hangs.
  setTimeout(() => child?.kill('SIGKILL'), 5000).unref();
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

log(`starting Light Runner (node ${process.version})`);
start();
