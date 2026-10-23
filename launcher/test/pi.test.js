import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The release publishes install-pi.sh alone, so the script carries the service file inside itself; the .service file
// next to it is the readable copy. They must not drift apart.

const pi = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packaging', 'pi');
const unit = readFileSync(join(pi, 'light-runner.service'), 'utf8').replace(/\r\n/g, '\n');
const script = readFileSync(join(pi, 'install-pi.sh'), 'utf8').replace(/\r\n/g, '\n');

/** The text of the heredoc that writes the unit. */
function embeddedUnit() {
  const start = script.match(/<<'(\w+)'\n/);
  assert.ok(start, 'install-pi.sh has no heredoc for the service file');
  const from = (start.index ?? 0) + start[0].length;
  const end = script.indexOf(`\n${start[1]}\n`, from);
  assert.ok(end > 0, 'the heredoc in install-pi.sh is not closed');
  return script.slice(from, end + 1);
}

test('the service file inside install-pi.sh is the same as packaging/pi/light-runner.service', () => {
  assert.equal(embeddedUnit(), unit);
});

test('the service runs the installed server as lightrunner, stops with SIGINT and restarts on failure', () => {
  const lines = unit.split('\n');
  for (const line of [
    'ExecStart=/opt/light-runner/node /opt/light-runner/app/server/src/main.ts',
    'Environment=LIGHT_RUNNER_DATA=/var/lib/light-runner',
    'Environment=PORT=8080',
    'Restart=on-failure',
    'KillSignal=SIGINT',
    'User=lightrunner',
  ]) {
    assert.ok(lines.includes(line), `missing ${line}`);
  }
});

test('the install script is wrapped in main, called on its last line', () => {
  const lines = script.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], 'main "$@"');
  assert.ok(lines.includes('set -euo pipefail'));
});
