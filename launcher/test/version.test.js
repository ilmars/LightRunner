import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDue, fetchLatestTag, latestTag, newerVersion } from '../src/version.js';

test('a newer release on GitHub is reported without its v', () => {
  assert.equal(newerVersion('0.2.1', 'v0.3.0'), '0.3.0');
  assert.equal(newerVersion('0.2.1', '0.2.2'), '0.2.2');
  assert.equal(newerVersion('0.9.9', 'v1.0.0'), '1.0.0');
  assert.equal(newerVersion('v0.2.9', 'v0.2.10'), '0.2.10');
});

test('the same or an older release is not reported', () => {
  assert.equal(newerVersion('0.3.0', 'v0.3.0'), null);
  assert.equal(newerVersion('0.3.0', 'v0.2.9'), null);
  assert.equal(newerVersion('1.0.0', 'v0.10.0'), null);
});

test('a tag or version that is not a plain version is not reported', () => {
  for (const tag of ['', 'latest', 'v1', 'v1.2', 'v1.2.3.4', 'v1.2.3-beta.1', 'release-1.2.3', ' v1.2.3x', undefined, null, 3]) {
    assert.equal(newerVersion('0.1.0', /** @type {any} */ (tag)), null, `tag ${JSON.stringify(tag)}`);
  }
  assert.equal(newerVersion('garbage', 'v9.0.0'), null);
});

// Asking GitHub at most once a day.

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-22T10:00:00Z');

function cacheDir() {
  return mkdtempSync(join(tmpdir(), 'lr-launcher-update-'));
}

test('a check is due with no earlier one, a day after the last, or when the clock has gone back', () => {
  assert.equal(checkDue(undefined, T0), true);
  assert.equal(checkDue('yesterday', T0), true);
  assert.equal(checkDue(T0, T0 + DAY_MS - 1), false);
  assert.equal(checkDue(T0, T0 + DAY_MS), true);
  assert.equal(checkDue(T0, T0 - 60_000), true, 'clock gone back');
});

test('the latest tag is asked once a day and kept between starts', async () => {
  const dir = cacheDir();
  const cacheFile = join(dir, 'sub', 'update-check.json');
  try {
    let asked = 0;
    let now = T0;
    const o = { cacheFile, now: () => now, fetchLatest: async () => { asked++; return 'v0.3.0'; } };
    assert.equal(await latestTag(o), 'v0.3.0');
    assert.equal(asked, 1);
    now += DAY_MS - 1000;
    assert.equal(await latestTag(o), 'v0.3.0', 'from the cache');
    assert.equal(asked, 1);
    now += 1000;
    assert.equal(await latestTag(o), 'v0.3.0');
    assert.equal(asked, 2);
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')), { checkedAt: now, latest: 'v0.3.0' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline, the last known tag is kept and the attempt counts as the day\u2019s check', async () => {
  const dir = cacheDir();
  const cacheFile = join(dir, 'update-check.json');
  try {
    writeFileSync(cacheFile, JSON.stringify({ checkedAt: T0, latest: 'v0.2.0' }));
    let asked = 0;
    const offline = { cacheFile, now: () => T0 + DAY_MS, fetchLatest: async () => { asked++; throw new Error('getaddrinfo ENOTFOUND'); } };
    assert.equal(await latestTag(offline), 'v0.2.0');
    assert.equal(await latestTag(offline), 'v0.2.0');
    assert.equal(asked, 1, 'not asked again the same day');
    // A broken cache file is a check that is due.
    writeFileSync(cacheFile, '{ broken');
    assert.equal(await latestTag({ cacheFile, now: () => T0, fetchLatest: async () => null }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the latest release from GitHub: its tag, null when there is none, an error otherwise', async () => {
  /** @param {number} status @param {unknown} body */
  const answer = (status, body) => async (/** @type {string} */ url, /** @type {any} */ init) => {
    assert.equal(url, 'https://api.example/releases/latest');
    assert.match(init.headers['user-agent'], /Light Runner/);
    return new Response(JSON.stringify(body), { status });
  };
  assert.equal(await fetchLatestTag(answer(200, { tag_name: 'v0.4.1' }), 'https://api.example/releases/latest', 'Light Runner launcher 0.1.0'), 'v0.4.1');
  assert.equal(await fetchLatestTag(answer(200, { nothing: true }), 'https://api.example/releases/latest', 'Light Runner launcher'), null);
  assert.equal(await fetchLatestTag(answer(404, { message: 'Not Found' }), 'https://api.example/releases/latest', 'Light Runner launcher'), null);
  await assert.rejects(fetchLatestTag(answer(403, { message: 'rate limit' }), 'https://api.example/releases/latest', 'Light Runner launcher'));
});
