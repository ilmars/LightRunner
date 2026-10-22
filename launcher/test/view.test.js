import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPort, describe } from '../src/view.js';

// The launcher window's words and its port check.

const snap = (status, extra = {}) => ({ status, code: null, message: null, port: 8080, ...extra });

test('a port is a whole number from 1024 to 65535', () => {
  for (const ok of ['1024', '8080', ' 8081 ', '65535', 9000]) assert.deepEqual(checkPort(ok), { port: Number(String(ok).trim()) }, String(ok));
  for (const bad of ['', '80', '1023', '65536', '8080.5', '8o80', '-8080', '0x1f90', '99999999', null, undefined]) {
    assert.match(checkPort(bad).error ?? '', /from 1024 to 65535/, String(bad));
  }
});

test('running, starting and stopped', () => {
  assert.deepEqual(describe(snap('running'), { platform: 'win32' }), {
    headline: 'Running', notice: null, showLines: false, button: 'stop', canStart: true, stopElsewhere: false, canChange: true,
  });
  assert.equal(describe(snap('running'), { platform: 'win32', answering: false }).notice?.tone, 'warn');
  assert.equal(describe(snap('starting'), { platform: 'win32' }).button, 'stop');
  const stopped = describe(snap('stopped'), { platform: 'darwin' });
  assert.equal(stopped.button, 'start');
  assert.match(stopped.notice?.text ?? '', /until you start it/);
});

test('a Light Runner running elsewhere: its port, Stop it, and no changes until it is stopped', () => {
  const w = describe(snap('running-elsewhere', { port: 8085 }), { platform: 'win32' });
  assert.equal(w.notice?.text, 'Light Runner is already running on this computer (port 8085).');
  assert.equal(w.stopElsewhere, true);
  assert.equal(w.canChange, false);
  assert.equal(w.button, null);
  // Why Stop it didn't work, when it didn't.
  const refused = describe(snap('running-elsewhere', { message: 'Light Runner on port 8085 refused to stop' }), { platform: 'win32' });
  assert.equal(refused.notice?.detail, 'Light Runner on port 8085 refused to stop');
});

test('a port in use offers another port; a Light Runner that is not answering must be ended by hand', () => {
  const inUse = describe(snap('failed', { code: 'port-in-use', message: 'Port 8080 is already in use by another program' }), { platform: 'win32' });
  assert.equal(inUse.notice?.text, 'Port 8080 is already in use by another program.');
  assert.match(inUse.notice?.detail ?? '', /for example 8081/);
  assert.equal(inUse.canChange, true);

  for (const [platform, where] of [['win32', /open Task Manager .*end node\.exe with the PID 4321\./], ['darwin', /open Activity Monitor and quit "node" with the PID 4321\./]]) {
    const hung = describe(snap('failed', { code: 'not-answering', port: 9123 }), { platform, pid: 4321 });
    assert.match(hung.notice?.text ?? '', /port 9123\) but isn't answering/);
    assert.match(hung.notice?.detail ?? '', where);
    assert.equal(hung.stopElsewhere, false, 'no Stop button');
    assert.equal(hung.canStart, false);
    assert.equal(hung.canChange, false);
  }
});

test('a crash or a failed start shows the last lines of the log', () => {
  const crashed = describe(snap('failed', { code: 'crashed', message: 'Light Runner stopped unexpectedly (exit code 1)' }), { platform: 'win32' });
  assert.equal(crashed.showLines, true);
  assert.equal(crashed.button, 'start');
  const failed = describe(snap('failed', { code: 'start-failed', message: 'the show file is broken' }), { platform: 'win32' });
  assert.equal(failed.notice?.text, "Light Runner couldn't start: the show file is broken.");
  assert.equal(failed.showLines, true);
});
