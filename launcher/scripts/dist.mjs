// Builds the installer for this system: stages the app (stage-app.mjs), then runs electron-builder with the
// version of the root package.json. Arguments go to electron-builder: `npm run dist -- --win --dir` makes an
// unpacked Windows app only.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

// The server needs its packages inside the app: an unpacked app built inside the repository would still find the
// repository's own node_modules and hide their absence, so check every built app's resources here.
/** @param {string} dir @param {number} depth @returns {string[]} */
function findServers(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === 'lightrunner' && existsSync(join(path, 'server'))) found.push(path);
    else found.push(...findServers(path, depth - 1));
  }
  return found;
}
const servers = findServers(join(launcher, 'dist'), 5);
const staged = readdirSync(join(launcher, 'build', 'app', 'node_modules'));
for (const server of servers) {
  const missing = staged.filter((name) => !existsSync(join(server, 'node_modules', name)));
  if (missing.length) {
    console.error(`dist: ${server} is missing node_modules/${missing.join(', node_modules/')}`);
    process.exit(1);
  }
}
console.log(`dist: the server's packages are in ${servers.length} built app(s)`);
