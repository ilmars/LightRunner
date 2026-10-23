import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The GitHub workflow that builds the downloads (.github/workflows/release.yml) can't run here, so these read it and
// check what must not change by accident: where it builds, when it releases, who may write, and that the file names
// it expects are the ones electron-builder and install-pi.sh use. The patterns allow for quotes and spacing.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github', 'workflows', 'release.yml');
const builder = read('launcher', 'electron-builder.yml');
const piScript = read('packaging', 'pi', 'install-pi.sh');

/** The text of one job: from its "  name:" line to the next line indented by two spaces (or the end). */
function job(name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${name}:\\s*$`).test(line));
  assert.ok(start >= 0, `the workflow has no job called ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

test('the workflow runs on a v* tag and by hand', () => {
  assert.match(workflow, /^on:\s*\n\s+push:\s*\n\s+tags:\s*\[\s*['"]?v\*['"]?\s*\]/m);
  assert.match(workflow, /^\s+workflow_dispatch:/m);
});

test('it builds on the five computers: both Macs, Windows, and Linux for arm64 and x64', () => {
  const build = job('build');
  for (const os of ['macos-15', 'macos-15-intel', 'windows-latest', 'ubuntu-24.04-arm', 'ubuntu-latest']) {
    assert.match(build, new RegExp(`os:\\s*['"]?${os}['"]?\\s*$`, 'm'), `no build on ${os}`);
  }
  assert.match(build, /fail-fast:\s*false/);
  assert.doesNotMatch(workflow, /macos-13|macos-14/, 'macos-13 is retired; macos-15 and macos-15-intel are used');
});

test('each build uses Node 24, runs the tests, then keeps only the production packages', () => {
  const build = job('build');
  assert.match(build, /node-version:\s*['"]?24['"]?/);
  const steps = [/run:\s*npm ci\s*$/m, /run:\s*npm test\s*$/m, /run:\s*npm ci --omit=dev\s*$/m, /npm run dist -- --publish never/, /npm run pack-linux/];
  let at = -1;
  for (const step of steps) {
    const next = build.search(step);
    assert.ok(next > at, `${step} is missing or out of order`);
    at = next;
  }
  // typescript is a dev dependency: the checks come before --omit=dev.
  assert.ok(build.indexOf('npm run typecheck') > build.search(/run:\s*npm test\s*$/m));
  assert.ok(build.indexOf('npm run jump-check') < build.indexOf('npm ci --omit=dev'));
  // An optional package npm silently dropped would leave the app without MIDI or USB DMX.
  assert.ok(build.indexOf('@julusian/midi serialport') > build.indexOf('npm ci --omit=dev'));
});

test('a tag is checked against the version first in every build, and again in the release job', () => {
  const build = job('build');
  assert.match(build, /github\.ref_type\s*==\s*['"]tag['"]/);
  assert.ok(build.indexOf('check-tag.mjs') > 0 && build.indexOf('check-tag.mjs') < build.indexOf('npm ci'));
  assert.ok(job('release').includes('check-tag.mjs'));
  const script = read('.github', 'scripts', 'check-tag.mjs');
  assert.match(script, /GITHUB_REF_NAME/);
  assert.match(script, /process\.exit\(1\)/);
});

test('only the release job may write, and only for a tag push', () => {
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.equal(workflow.match(/contents:\s*write/g)?.length, 1);
  assert.match(job('release'), /contents:\s*write/);
  assert.doesNotMatch(job('build'), /contents:\s*write/);
  assert.match(job('release'), /needs:\s*build/);
  const condition = job('release').match(/^\s+if:\s*(.+)$/m)?.[1] ?? '';
  assert.match(condition, /github\.event_name\s*==\s*['"]push['"]/, 'a manual run on a tag must not make a release');
  assert.match(condition, /startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\/v['"]\s*\)/);
});

test('it uses only the four official actions and no secrets but the token', () => {
  const used = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const action of used) {
    assert.match(action, /^actions\/(checkout|setup-node|upload-artifact|download-artifact)@v\d+$/, `${action} is not one of the official actions`);
  }
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
});

test('the release is a draft with install-pi.sh and SHA256SUMS.txt, and stops if one exists already', () => {
  const release = job('release');
  assert.match(release, /gh release create/);
  assert.match(release, /--draft/);
  assert.match(release, /packaging\/pi\/install-pi\.sh/);
  assert.match(release, /SHA256SUMS\.txt/);
  assert.match(release, /sha256sum/);
  const view = release.indexOf('gh release view');
  assert.ok(view > 0 && view < release.indexOf('gh release create'), 'it must look for an existing release before it makes one');
});

test('file names have no spaces and are the ones the workflow and install-pi.sh expect', () => {
  const exe = builder.match(/^\s+artifactName:\s*(\S*\.exe)\s*$/m)?.[1];
  const dmg = builder.match(/^\s+artifactName:\s*(\S*\.dmg)\s*$/m)?.[1];
  assert.equal(exe, 'Light-Runner-Setup-${version}.exe');
  assert.equal(dmg, 'Light-Runner-${version}-${arch}.dmg');

  // electron-builder's names, as the release job and the upload globs spell them.
  const release = job('release');
  const build = job('build');
  for (const arch of ['arm64', 'x64']) {
    assert.ok(release.includes(`Light-Runner-\${VERSION}-${arch}.dmg`), `the release job does not expect the ${arch} dmg`);
    assert.match(build, new RegExp(`files:\\s*launcher/dist/Light-Runner-\\*-${arch}\\.dmg`));
  }
  assert.ok(release.includes('Light-Runner-Setup-${VERSION}.exe'));
  assert.match(build, /files:\s*launcher\/dist\/Light-Runner-Setup-\*\.exe/);

  // The Pi script downloads these, so the workflow must publish them under exactly these names.
  assert.match(piScript, /releases\/latest\/download\/light-runner-linux-\$\{ARCH\}\.tar\.gz/);
  assert.match(piScript, /releases\/latest\/download\/install-pi\.sh/);
  for (const arch of ['arm64', 'x64']) {
    assert.ok(release.includes(`light-runner-linux-${arch}.tar.gz`), `the release job does not expect light-runner-linux-${arch}.tar.gz`);
    assert.match(build, new RegExp(`files:\\s*launcher/dist/light-runner-linux-${arch}\\.tar\\.gz`));
  }
});
