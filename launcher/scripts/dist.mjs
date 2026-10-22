// Builds the installer for this system: stages the app (stage-app.mjs), then runs electron-builder with the
// version of the root package.json. Arguments go to electron-builder: `npm run dist -- --win --dir` makes an
// unpacked Windows app only.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(launcher, '..', 'package.json'), 'utf8')).version;

/** @param {string[]} args */
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: launcher, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run([join(launcher, 'scripts', 'stage-app.mjs')]);
run([
  join(launcher, 'node_modules', 'electron-builder', 'cli.js'),
  '--config', 'electron-builder.yml',
  `-c.extraMetadata.version=${version}`,
  ...process.argv.slice(2),
]);
