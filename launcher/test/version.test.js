import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newerVersion } from '../src/version.js';

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
