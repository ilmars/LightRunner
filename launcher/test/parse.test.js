import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// main.js and preload.js need Electron, so no test imports them; this at least catches a mistake that stops them
// loading at all (a name declared twice once made the built app fail before its window opened).
const launcher = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['main.js', 'preload.js', 'ui/launcher.js']) {
  test(`${file} parses`, () => {
    const result = spawnSync(process.execPath, ['--check', join(launcher, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
}
