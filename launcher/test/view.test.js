import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPort, describe, firewallNote, pageUrl } from '../src/view.js';

// The launcher window's status line, its one sentence and its Fix it, and the port check.

const snap = (status, extra = {}) => ({ status, code: null, message: null, port: 8080, ...extra });
const win = { platform: 'win32' };
const NOT_SENDING = { long: 'Not sending to the lights', title: 'Nothing is sent to the lights: Send DMX is off in Settings, or Test mode is on.' };
const NOT_ANSWERING = { long: 'Lights not answering', title: 'The lighting network box at 192.168.0.114 is not answering.' };

test('a port is a whole number from 1024 to 65535', () => {
  for (const ok of ['1024', '8080', ' 8081 ', '65535', 9000]) assert.deepEqual(checkPort(ok), { port: Number(String(ok).trim()) }, String(ok));
  for (const bad of ['', '80', '1023', '65536', '8080.5', '8o80', '-8080', '0x1f90', '99999999', null, undefined]) {
    assert.match(checkPort(bad).error ?? '', /from 1024 to 65535/, String(bad));
  }
});

test('running with nothing wrong: a green line and nothing else', () => {
  assert.deepEqual(describe(snap('running'), win), {
    tone: 'ok', line: 'Running', sentence: null, detail: null, fix: null, retry: false, showLines: false, bottom: 'stop', canChange: true,
  });
});

test('running but not sending: amber, the operator page’s words, Fix it opens Settings at Send DMX', () => {
  const w = describe(snap('running'), { ...win, output: 'off', outputWords: NOT_SENDING });
  assert.equal(w.tone, 'warn');
  assert.equal(w.line, 'Running · not sending to the lights');
  assert.match(w.sentence ?? '', /Send DMX is off or no output is chosen/);
  assert.deepEqual(w.fix, { kind: 'settings', label: 'Fix it' });
  // In Test mode not sending is what was asked for.
  assert.deepEqual(describe(snap('running'), { ...win, output: 'off', outputWords: NOT_SENDING, testMode: true }).tone, 'ok');
  // Lights not answering: its own words.
  const lost = describe(snap('running'), { ...win, output: 'lost', outputWords: NOT_ANSWERING });
  assert.equal(lost.line, 'Running · lights not answering');
  assert.equal(lost.sentence, NOT_ANSWERING.title);
  assert.equal(lost.fix?.kind, 'settings');
});

test('Windows on a Public network: amber, and Fix it shows the steps', () => {
  const w = describe(snap('running'), { ...win, publicNetwork: true });
  assert.equal(w.tone, 'warn');
  assert.equal(w.sentence, "Windows blocks the iPads on this network (it's set to Public).");
  assert.deepEqual(w.fix, { kind: 'network', label: 'Fix it' });
  // Not sending to the lights comes first: that is the lights.
  assert.equal(describe(snap('running'), { ...win, publicNetwork: true, output: 'off', outputWords: NOT_SENDING }).fix?.kind, 'settings');
  // Not on a Mac, and not while it isn't running.
  assert.equal(describe(snap('running'), { platform: 'darwin', publicNetwork: true }).fix, null);
  assert.equal(describe(snap('stopped'), { ...win, publicNetwork: true }).fix?.kind, 'start');
});

test('a running server that stops answering the window', () => {
  const w = describe(snap('running'), { ...win, answering: false });
  assert.equal(w.tone, 'warn');
  assert.equal(w.line, 'Running · not answering');
});

test('starting, stopped and a Light Runner started outside this window', () => {
  assert.equal(describe(snap('starting'), win).line, 'Starting…');
  assert.equal(describe(snap('starting'), win).bottom, 'stop');
  const stopped = describe(snap('stopped'), win);
  assert.equal(stopped.tone, 'bad');
  assert.equal(stopped.line, 'Stopped');
  assert.match(stopped.sentence ?? '', /until you start it/);
  assert.deepEqual(stopped.fix, { kind: 'start', label: 'Start' });
  assert.equal(stopped.bottom, null);

  const elsewhere = describe(snap('running-elsewhere', { port: 8085 }), win);
  assert.equal(elsewhere.tone, 'ok');
  assert.equal(elsewhere.line, 'Running');
  assert.equal(elsewhere.sentence, 'It was started outside this window (port 8085).');
  assert.match(elsewhere.detail ?? '', /stop it first/);
  assert.equal(elsewhere.bottom, 'stop-elsewhere');
  assert.equal(elsewhere.canChange, false);
  const refused = describe(snap('running-elsewhere', { message: 'Light Runner on port 8085 refused to stop' }), win);
  assert.equal(refused.detail, 'Light Runner on port 8085 refused to stop');
});

test('the port taken: red, and Fix it opens the Options at the port', () => {
  const w = describe(snap('failed', { code: 'port-in-use', message: 'Port 8080 is already in use by another program' }), win);
  assert.equal(w.tone, 'bad');
  assert.equal(w.line, 'Stopped · port 8080 is taken');
  assert.equal(w.sentence, 'Port 8080 is already in use by another program.');
  assert.match(w.detail ?? '', /for example 8081/);
  assert.deepEqual(w.fix, { kind: 'port', label: 'Fix it' });
  assert.equal(w.canChange, true);
  // The program holding the port may only have had it for a moment: Try again, on the same port.
  assert.equal(w.retry, true);
  for (const other of [snap('running'), snap('stopped'), snap('failed', { code: 'crashed' }), snap('failed', { code: 'not-answering' })]) {
    assert.equal(describe(other, win).retry, false, `${other.status} ${other.code}`);
  }
});

test('a Light Runner that is not answering must be ended by hand: no Fix it, no changes', () => {
  for (const [platform, where] of [['win32', /open Task Manager .*end node\.exe with the PID 4321\./], ['darwin', /open Activity Monitor and quit "node" with the PID 4321\./]]) {
    const w = describe(snap('failed', { code: 'not-answering', port: 9123 }), { platform, pid: 4321 });
    assert.equal(w.tone, 'bad');
    assert.equal(w.line, 'Not answering');
    assert.match(w.sentence ?? '', /port 9123\) but isn't answering/);
    assert.match(w.detail ?? '', where);
    assert.equal(w.fix, null);
    assert.equal(w.bottom, null);
    assert.equal(w.canChange, false);
  }
});

test('a crash or a failed start shows the last lines of the log and Start', () => {
  const crashed = describe(snap('failed', { code: 'crashed', message: 'Light Runner stopped unexpectedly (exit code 1)' }), win);
  assert.equal(crashed.line, 'Stopped · it stopped unexpectedly');
  assert.equal(crashed.showLines, true);
  assert.equal(crashed.fix?.kind, 'start');
  const failed = describe(snap('failed', { code: 'start-failed', message: 'the show file is broken' }), win);
  assert.equal(failed.line, "Stopped · it couldn't start");
  assert.equal(failed.sentence, "Light Runner couldn't start: the show file is broken.");
  assert.equal(failed.showLines, true);
  const stuck = describe(snap('failed', { code: 'stop-failed', message: 'Light Runner could not be stopped (process 77)' }), win);
  assert.equal(stuck.line, 'Not stopped');
  assert.match(stuck.detail ?? '', /Task Manager/);
});

test('where an iPad is added: on Windows, the Public network warning, or the gentle note until an iPad has come', () => {
  assert.equal(firewallNote({ platform: 'win32', publicNetwork: true, ipadSeen: true }), 'public');
  assert.equal(firewallNote({ platform: 'win32', publicNetwork: false, ipadSeen: false }), 'ask');
  assert.equal(firewallNote({ platform: 'win32', publicNetwork: false, ipadSeen: true }), null);
  assert.equal(firewallNote({ platform: 'darwin', publicNetwork: true, ipadSeen: false }), null);
});

test('the Open buttons use 127.0.0.1, never localhost, so a program on [::1] cannot answer', () => {
  assert.equal(pageUrl(8080, 'operator'), 'http://127.0.0.1:8080/operator/');
  assert.equal(pageUrl(8123, 'settings', 'dmx'), 'http://127.0.0.1:8123/settings/#dmx');
});
