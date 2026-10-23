// Makes the Linux download for the Raspberry Pi install: launcher/dist/light-runner-linux-<arch>.tar.gz.
// It stages the app (stage-app.mjs: the server, packages, web pages, shows, production node_modules and this
// machine's Node 24) and lays it out the way install-pi.sh puts it on the Pi:
//
//   node               -> /opt/light-runner/node
//   app/server/src/... -> /opt/light-runner/app/server/src/...
//   VERSION            -> the version of the root package.json
//
// Run it on Linux of the same kind as the target (arm64 for a Pi, x64 for a mini PC): the Node and the MIDI and
// serial add-ons in node_modules are built for the machine that packs. GitHub does it on both (after
// `npm ci --omit=dev` at the root).
//
//   node scripts/pack-linux.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(launcher, '..');

/** @param {string} message */
function fail(message) {
  console.error(`pack-linux: ${message}`);
  process.exit(1);
}

if (process.platform !== 'linux') {
  fail(`this makes the Raspberry Pi download and only works on Linux (this is ${process.platform}); GitHub runs it on Linux when a release is made`);
}
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
if (!arch) fail(`this is a ${process.arch} computer; the download is made for arm64 (Raspberry Pi) or x64`);

const staged = spawnSync(process.execPath, [join(launcher, 'scripts', 'stage-app.mjs')], { cwd: launcher, stdio: 'inherit' });
if (staged.status !== 0) fail('staging the app failed (see above)');

const app = join(launcher, 'build', 'app');
const pkg = join(launcher, 'build', 'linux');
const out = join(launcher, 'dist');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const tarball = join(out, `light-runner-linux-${arch}.tar.gz`);

rmSync(pkg, { recursive: true, force: true });
mkdirSync(join(pkg, 'app'), { recursive: true });
// Everything staged except the Node, which goes beside app/ (the unit starts /opt/light-runner/node).
cpSync(app, join(pkg, 'app'), { recursive: true, verbatimSymlinks: true, filter: (src) => src !== join(app, 'node') });
cpSync(join(app, 'node'), join(pkg, 'node'));
writeFileSync(join(pkg, 'VERSION'), `${version}\n`);

if (!existsSync(join(pkg, 'app', 'server', 'src', 'main.ts'))) fail('the staged app has no server/src/main.ts');
mkdirSync(out, { recursive: true });
rmSync(tarball, { force: true });
// root owns everything, so it unpacks the same whoever packs it; the system tar (GNU tar on Linux) does the work.
execFileSync('tar', ['-czf', tarball, '--owner=0', '--group=0', '--numeric-owner', '-C', pkg, '.'], { stdio: 'inherit' });

console.log(`pack-linux: Light Runner ${version} for ${arch}: ${relative(root, tarball)} (${(statSync(tarball).size / 1e6).toFixed(1)} MB)`);
