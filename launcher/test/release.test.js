import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The GitHub workflow that builds the downloads (.github/workflows/release.yml) can't run here, so these read it and
// check what must not change by accident: where it builds, when it releases, who may write, and that the file names
// it expects are the ones electron-builder and install-pi.sh use.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github', 'workflows', 'release.yml');
const builder = read('launcher', 'electron-builder.yml');
const piScript = read('packaging', 'pi', 'install-pi.sh');
const readme = read('launcher', 'README.md');

/** The text of one top-level job (from "  name:" to the next job or the end). */
function job(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `the workflow has no job called ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

test('the workflow runs on a v* tag and by hand', () => {
  assert.match(workflow, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:/m);
});

test('it builds on the five computers: both Macs, Windows, and Linux for arm64 and x64', () => {
  for (const os of ['macos-15', 'macos-15-intel', 'windows-latest', 'ubuntu-24.04-arm', 'ubuntu-latest']) {
    assert.match(job('build'), new RegExp(`^ +os: ${os}$`, 'm'), `no build on ${os}`);
  }
  assert.match(job('build'), /fail-fast: false/);
  assert.doesNotMatch(workflow, /macos-13|macos-14/, 'macos-13 is retired; macos-15 and macos-15-intel are used');
});

test('each build uses Node 24, runs the tests, then keeps only the production packages', () => {
  const build = job('build');
  assert.match(build, /node-version: 24/);
  const steps = ['run: npm ci\n', 'run: npm test\n', 'run: npm ci --omit=dev\n', 'npm run dist -- --publish never', 'npm run pack-linux'];
  let at = -1;
  for (const step of steps) {
    const next = build.indexOf(step);
    assert.ok(next > at, `"${step.trim()}" is missing or out of order`);
    at = next;
  }
  // typescript is a dev dependency: the checks come before --omit=dev.
  assert.ok(build.indexOf('npm run typecheck') > build.indexOf('run: npm test'));
  assert.ok(build.indexOf('npm run jump-check') < build.indexOf('npm ci --omit=dev'));
});

test('only the release job may write, and only for a v tag', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
  assert.ok(job('release').includes('contents: write'));
  assert.ok(!job('build').includes('contents: write'));
  assert.match(job('release'), /needs: build/);
  assert.match(job('release'), /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test('it uses only the four official actions and no secrets but the token', () => {
  const used = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const action of used) {
    assert.match(action, /^actions\/(checkout|setup-node|upload-artifact|download-artifact)@v\d+$/, `${action} is not one of the official actions`);
  }
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('the release is a draft with install-pi.sh and SHA256SUMS.txt, and the tag must match the version', () => {
  const release = job('release');
  assert.match(release, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(release, /--draft/);
  assert.match(release, /packaging\/pi\/install-pi\.sh/);
  assert.match(release, /SHA256SUMS\.txt/);
  assert.match(release, /sha256sum/);
  assert.match(release, /"\$GITHUB_REF_NAME" != "v\$\{version\}"/);
  assert.match(release, /press Publish/);
});

test('file names have no spaces and are the ones the workflow, the README and install-pi.sh expect', () => {
  const exe = builder.match(/^\s+artifactName: (Light\S*\.exe)$/m)?.[1];
  const dmg = builder.match(/^\s+artifactName: (Light\S*\.dmg)$/m)?.[1];
  assert.equal(exe, 'Light-Runner-Setup-${version}.exe');
  assert.equal(dmg, 'Light-Runner-${version}-${arch}.dmg');
  assert.doesNotMatch(builder, /artifactName: .* .*\.(exe|dmg)/, 'an installer name has a space');

  const release = job('release');
  assert.ok(release.includes('"Light-Runner-${VERSION}-arm64.dmg"'));
  assert.ok(release.includes('"Light-Runner-${VERSION}-x64.dmg"'));
  assert.ok(release.includes('"Light-Runner-Setup-${VERSION}.exe"'));
  assert.match(job('build'), /files: launcher\/dist\/Light-Runner-Setup-\*\.exe/);
  assert.match(job('build'), /files: launcher\/dist\/Light-Runner-\*-arm64\.dmg/);
  assert.match(job('build'), /files: launcher\/dist\/Light-Runner-\*-x64\.dmg/);

  // The Pi script downloads these two, so the workflow must publish them under exactly these names.
  assert.match(piScript, /releases\/latest\/download\/light-runner-linux-\$\{ARCH\}\.tar\.gz/);
  for (const arch of ['arm64', 'x64']) {
    assert.ok(release.includes(`light-runner-linux-${arch}.tar.gz`), `the release job does not expect light-runner-linux-${arch}.tar.gz`);
    assert.match(job('build'), new RegExp(`files: launcher/dist/light-runner-linux-${arch}\\.tar\\.gz`));
  }
  assert.match(piScript, /releases\/latest\/download\/install-pi\.sh/);

  assert.ok(readme.includes('Light-Runner-<version>-<arch>.dmg'));
  assert.ok(readme.includes('Light-Runner-Setup-<version>.exe'));
  assert.doesNotMatch(readme, /Light Runner Setup|Light Runner <version>/);
});

test('the README says how to make a release', () => {
  assert.match(readme, /^## Releases$/m);
  assert.match(readme, /git tag vX\.Y\.Z/);
  assert.match(readme, /Publish/);
});
