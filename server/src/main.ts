// Start Light Runner. Settings come from the environment:
//   PORT               HTTP port (default 8080)
//   LIGHT_RUNNER_DATA  folder for show.json, runtime.json and backups (default ./data)
//   LIGHT_RUNNER_OUTPUT=none   run without sending DMX (for testing away from the rig)
//   LIGHT_RUNNER_FAKE_MIDI=1   test only: simulated controllers (an APC mini mk2 and a nanoKONTROL2) instead of
//                              the real ones, pressed through POST /api/test/midi (for checking the pages)

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { App } from './app.ts';
import { FakeMidi, loadMidi } from './midi.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

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
  midi: fakeMidi ? async () => fakeMidi : loadMidi,
  fakeMidi,
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

await app.start();
