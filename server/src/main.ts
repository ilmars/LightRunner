// Start Light Runner. Settings come from the environment:
//   PORT               HTTP port (default 8080)
//   LIGHT_RUNNER_DATA  folder for show.json, runtime.json and backups (default ./data)
//   LIGHT_RUNNER_OUTPUT=none   run without sending DMX (for testing away from the rig)
//   LIGHT_RUNNER_FAKE_MIDI=1   test only: simulated controllers (an APC mini mk2 and a nanoKONTROL2) instead of
//                              the real ones, pressed through POST /api/test/midi (for checking the pages);
//                              LIGHT_RUNNER_FAKE_MIDI=missing runs as if the MIDI add-on weren't installed

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { App } from './app.ts';
import { AlreadyRunning } from './marker.ts';
import { FakeMidi, loadMidi } from './midi.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
function readVersion(): string {
  try {
    const v = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : 'dev';
  } catch {
    return 'dev';
  }
}
const version = readVersion();

let fakeMidi: FakeMidi | undefined;
if (process.env.LIGHT_RUNNER_FAKE_MIDI === '1') {
  fakeMidi = new FakeMidi();
  fakeMidi.plug('APC mini mk2');
  fakeMidi.plug('nanoKONTROL2');
  console.log('TEST ONLY: simulated MIDI controllers (LIGHT_RUNNER_FAKE_MIDI=1); no real controller is used');
}

const app = new App({
  port: Number(process.env.PORT ?? 8080),
  dataDir: resolve(process.env.LIGHT_RUNNER_DATA ?? resolve(root, 'data')),
  seedPath: resolve(root, 'server/seed/demo-show.json'),
  webDir: resolve(root, 'web'),
  output: process.env.LIGHT_RUNNER_OUTPUT === 'none' ? { kind: 'none' } : undefined,
  // MIDI controllers (the APC mini and others), when the MIDI add-on is installed.
  midi: fakeMidi ? async () => fakeMidi
    : process.env.LIGHT_RUNNER_FAKE_MIDI === 'missing' ? (log) => loadMidi(log, async () => { throw new Error('test only: left out'); })
    : loadMidi,
  fakeMidi,
  // One server per data folder (server.json), and the launcher's stop for one it didn't start.
  claimData: true,
  onStopRequest: () => void shutdown('stop asked by the launcher'),
  version,
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${new Date().toISOString()} ${signal}: saving state and stopping`);
  await app.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Started by a launcher (an IPC channel): it can ask for a clean stop, and hears when we are listening or can't start.
// On Windows a child's kill() is forceful, so the message is how the stage gets saved.
// A callback, so a channel that has closed (the launcher is gone) can't stop the server with an error.
const send = process.send ? (message: object, then: () => void = () => {}) => void process.send!(message, undefined, {}, then) : undefined;
if (send) process.on('message', (message) => {
  if ((message as { type?: unknown } | null)?.type === 'shutdown') void shutdown('shutdown message');
});
// If the launcher goes away without stopping us (it crashed), the lights keep running and the next launcher finds
// this server. The launcher was reading our log, so a log line then fails to write: that must not stop the server.
if (send) for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

try {
  await app.start();
  send?.({ type: 'ready', port: app.port });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  const code = e instanceof AlreadyRunning ? 'already-running' : err.code === 'EADDRINUSE' ? 'port-in-use' : 'start-failed';
  const message = code === 'port-in-use' ? `Port ${process.env.PORT ?? 8080} is already in use` : String(err.message ?? err);
  console.error(`${new Date().toISOString()} could not start: ${message}`);
  // Exit at once, without saving: a second copy that failed must not write over the one that is running.
  if (send) {
    send(e instanceof AlreadyRunning ? { type: 'error', code, port: e.port, message } : { type: 'error', code, message }, () => process.exit(2));
    setTimeout(() => process.exit(2), 2000).unref();
  } else {
    process.exit(2);
  }
}
