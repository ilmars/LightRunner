// Test helper: a "launcher" that starts the real server and then goes away without stopping it, as a crashed
// launcher would. Prints the server's pid as JSON. Arguments: appDir dataDir port.

import { ServerProcess } from '../../src/server-process.js';

const [appDir, dataDir, port] = process.argv.slice(2);
const sp = new ServerProcess({
  nodePath: process.execPath, appDir, dataDir,
  env: { ...process.env, LIGHT_RUNNER_FAKE_MIDI: 'missing' },
});
sp.onChange((s) => {
  if (s.status === 'running') {
    process.stdout.write(`${JSON.stringify({ pid: sp.child?.pid })}\n`, () => process.exit(0));
  } else if (s.status === 'failed') {
    process.stdout.write(`${JSON.stringify({ failed: s, lines: sp.lastLines })}\n`, () => process.exit(1));
  }
});
await sp.start({ port: Number(port), testMode: true });
