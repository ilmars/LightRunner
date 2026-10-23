import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { chooseDataDir } from '../src/datadir.js';

// Which data folder the launcher uses: the installed app its usual one, a run from the repository the repository's own.

const repoDir = resolve('repo');

test('the installed app uses the usual folder, unless --data-dir says otherwise (LIGHT_RUNNER_DATA is ignored)', () => {
  assert.deepEqual(chooseDataDir({ argv: [], env: { LIGHT_RUNNER_DATA: 'elsewhere' }, packaged: true, repoDir }), { dir: null, fromArg: false });
  assert.deepEqual(chooseDataDir({ argv: ['--data-dir=try'], env: {}, packaged: true, repoDir }), { dir: resolve('try'), fromArg: true });
});

test('a run from the repository uses its data folder, so the installed show is never touched', () => {
  assert.deepEqual(chooseDataDir({ argv: [], env: {}, packaged: false, repoDir }), { dir: join(repoDir, 'data'), fromArg: false });
  assert.deepEqual(chooseDataDir({ argv: [], env: { LIGHT_RUNNER_DATA: '' }, packaged: false, repoDir }), { dir: join(repoDir, 'data'), fromArg: false });
});

test('a run from the repository can be pointed at another folder, and --data-dir wins over both', () => {
  assert.deepEqual(chooseDataDir({ argv: [], env: { LIGHT_RUNNER_DATA: 'other' }, packaged: false, repoDir }), { dir: resolve('other'), fromArg: false });
  assert.deepEqual(chooseDataDir({ argv: ['--data-dir=try'], env: { LIGHT_RUNNER_DATA: 'other' }, packaged: false, repoDir }), { dir: resolve('try'), fromArg: true });
});
