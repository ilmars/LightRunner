// Gathers what the installed Light Runner runs into launcher/build/app: the server, the shared packages, the web
// pages, the show files, the root package.json, the production node_modules (with the MIDI and serial add-ons
// built for this machine) and this machine's own Node 24 (process.execPath). electron-builder puts that folder in
// the app as resources/lightrunner (outside the asar, so the bundled Node can read it).
// It also copies the design system (theme.css, its fonts, the icon) into launcher/ui/shared for the window.
//
//   node scripts/stage-app.mjs        everything
//   node scripts/stage-app.mjs --ui   only the window's shared files (enough for `npm start` while developing)
//
// Nothing is downloaded: node_modules are copied from the repository's own, which `npm install` (or, for a
// release, `npm ci --omit=dev`) has filled.

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(launcher, '..');
const out = join(launcher, 'build', 'app');
const uiShared = join(launcher, 'ui', 'shared');

/** @param {string} message */
function fail(message) {
  console.error(`stage-app: ${message}`);
  process.exit(1);
}

function stageUi() {
  rmSync(uiShared, { recursive: true, force: true });
  mkdirSync(uiShared, { recursive: true });
  for (const file of ['theme.css', 'icon.svg', 'appbar.js']) cpSync(join(root, 'web', 'shared', file), join(uiShared, file));
  cpSync(join(root, 'web', 'shared', 'fonts'), join(uiShared, 'fonts'), { recursive: true });
}

/** Tests and the like are left out of the app. @param {string} src */
const keep = (src) => {
  const rel = relative(root, src).split(sep);
  return !rel.includes('test') && !rel.includes('.DS_Store');
};

/**
 * The production packages the server needs, as folders directly under root/node_modules (a package nested in
 * another's node_modules comes with that folder): the root's dependencies and optional dependencies, and theirs,
 * found the way Node finds them. An optional one that isn't installed is skipped, as npm does.
 */
function productionPackages() {
  const top = join(root, 'node_modules');
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} name @param {string} from @param {boolean} optional */
  const visit = (name, from, optional) => {
    // As Node looks: the package's own node_modules, then each folder above it up to the root.
    let pkgDir = null;
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) {
        pkgDir = candidate;
        break;
      }
      if (dir === root || dirname(dir) === dir) break;
    }
    if (!pkgDir) {
      if (optional) return;
      fail(`${name} (needed by ${relative(root, from) || 'Light Runner'}) is not installed: run npm install in ${root}`);
    }
    if (seen.has(pkgDir)) return;
    seen.add(pkgDir);
    const rel = relative(top, pkgDir).split(sep);
    const first = rel[0].startsWith('@') ? join(rel[0], rel[1]) : rel[0];
    found.add(join(top, first));
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, pkgDir, false);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, pkgDir, true);
  };
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, root, false);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, root, true);
  return [...found].sort();
}

/** The bundled Node must run on another computer: an official build, not one linked to Homebrew's libraries. */
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) fail(`this is Node ${process.versions.node}; Light Runner needs Node 24 or newer (run this with it)`);
  if (process.platform === 'darwin') {
    let libs = '';
    try {
      libs = execFileSync('otool', ['-L', process.execPath], { encoding: 'utf8' });
    } catch {
      fail('could not check the Node binary with otool (install the Xcode command line tools)');
    }
    if (/\/(opt\/homebrew|usr\/local\/(opt|Cellar))\//.test(libs)) {
      fail(`${process.execPath} is Homebrew's Node, which needs Homebrew's libraries; build with the official Node 24 from nodejs.org (or actions/setup-node)`);
    }
  }
}

/** @param {string} dir */
function size(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

stageUi();
if (!process.argv.includes('--ui')) {
  checkNode();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const dir of ['server', 'packages', 'web', 'shows']) cpSync(join(root, dir), join(out, dir), { recursive: true, filter: keep });
  // The Lightkey importer, for Settings > Compare with a file (it runs with the computer's python3).
  mkdirSync(join(out, 'tools'));
  cpSync(join(root, 'tools', 'import-lightkey.py'), join(out, 'tools', 'import-lightkey.py'));
  for (const file of ['package.json', 'LICENSE']) if (existsSync(join(root, file))) cpSync(join(root, file), join(out, file));
  const packages = productionPackages();
  for (const dir of packages) cpSync(dir, join(out, 'node_modules', relative(join(root, 'node_modules'), dir)), { recursive: true, dereference: true });
  const node = join(out, process.platform === 'win32' ? 'node.exe' : 'node');
  cpSync(process.execPath, node);
  if (process.platform !== 'win32') chmodSync(node, 0o755);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  console.log(`stage-app: Light Runner ${version} with Node ${process.versions.node} (${process.platform}-${process.arch}) in ${relative(root, out)}`);
  console.log(`stage-app: ${packages.length} packages: ${packages.map((p) => relative(join(root, 'node_modules'), p)).join(', ')}`);
  console.log(`stage-app: ${(size(out) / 1e6).toFixed(1)} MB`);
}
