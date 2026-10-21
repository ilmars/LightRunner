// Controller keys: learning a key, what it does on stage, and how explicit keys and the APC mini's standard
// layout share a controller. Simulated MIDI ports only: no test opens a real device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { apcLeds, type ApcLayout, type ApcState } from '../src/apc.ts';
import { keyLabel, keyPlace, keyShort, parseMidi } from '../src/keynames.ts';
import { FakeMidi, loadMidi, type FakeMidiPort, type MidiPorts } from '../src/midi.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const seedPath = join(root, 'server/seed/demo-show.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(get: () => T | null | undefined | false, ms = 2000, what = 'a condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ---- Names and messages ----

test('MIDI messages: notes on and off, control changes, on any channel', () => {
  assert.deepEqual(parseMidi([0x90, 36, 100]), { type: 'note', channel: 1, number: 36, on: true });
  assert.deepEqual(parseMidi([0x91, 36, 0]), { type: 'note', channel: 2, number: 36, on: false });
  assert.deepEqual(parseMidi([0x8f, 36, 64]), { type: 'note', channel: 16, number: 36, on: false });
  assert.deepEqual(parseMidi([0xb0, 7, 127]), { type: 'cc', channel: 1, number: 7, value: 1 });
  assert.equal(parseMidi([0xf8]), null);
  assert.equal(parseMidi([0xc0, 5]), null);
  assert.equal(parseMidi([0xf0, 0x47, 0xf7]), null);
});

test('a key is named by its device and its place', () => {
  const k = (device: string, type: 'note' | 'cc', number: number, channel = 1) => ({ device, type, channel, number });
  assert.equal(keyPlace(k('APC mini mk2', 'note', 56)), 'pad 1,1');
  assert.equal(keyPlace(k('APC mini mk2', 'note', 0)), 'pad 8,1');
  assert.equal(keyPlace(k('APC mini mk2', 'note', 50)), 'pad 2,3');
  assert.equal(keyPlace(k('APC mini mk2', 'note', 101)), 'lower button 2');
  assert.equal(keyPlace(k('APC mini mk2', 'note', 112)), 'side button 1');
  assert.equal(keyPlace(k('APC MINI', 'note', 82)), 'side button 1');
  assert.equal(keyPlace(k('APC MINI', 'note', 64)), 'lower button 1');
  assert.equal(keyPlace(k('APC mini mk2', 'cc', 56)), 'fader 9');
  assert.equal(keyPlace(k('nanoKONTROL2', 'cc', 16)), 'control 16');
  assert.equal(keyPlace(k('nanoKONTROL2', 'note', 36, 10)), 'button 36 (channel 10)');
  assert.equal(keyLabel(k('APC mini mk2', 'note', 56)), 'APC mini mk2 · pad 1,1');
  assert.equal(keyShort(k('APC mini mk2', 'note', 50)), '2,3');
  assert.equal(keyShort(k('APC mini mk2', 'note', 112)), 'side 1');
  assert.equal(keyShort(k('APC mini mk2', 'cc', 56)), 'fader 9');
  assert.equal(keyShort(k('nanoKONTROL2', 'note', 36, 10)), '36/10');
});

// ---- Pad lights ----

const leds: ApcLayout = {
  basicLights: 'basic', basicSwatch: '#ffd2a0',
  runningOrder: [{ id: 'basic', swatch: null }, { id: 'one', swatch: '#ff0000' }, { id: 'two', swatch: '#0000ff' }],
  quickLooks: [{ id: 'blue', swatch: '#0000ff', groups: ['front'], entries: [{ preset: 'f-blue' }] }],
  groups: [{ id: 'front', kind: 'light', presets: [{ id: 'f-warm', swatch: '#ffb46b' }, { id: 'f-blue', swatch: '#0000ff' }] }],
};
const ledState = (look: string | null, preset: string | null = null): ApcState => ({
  look, lastLook: look, lookChanged: false, canUndo: false, master: 1, groups: { front: { preset, level: 1 } }, flashing: [],
});

test('pads assigned to songs light like the running order; quick looks when the stage matches them', () => {
  const keys = [{ number: 10, does: { kind: 'song' as const, id: 'two' } }, { number: 11, does: { kind: 'quickLook' as const, id: 'blue' } }];
  // Older model: on stage green, next yellow; a quick look green when the stage matches it.
  let l = apcLeds('mk1', leds, ledState('one'), { keys });
  assert.deepEqual(l.get(10), [0x90, 10, 5]);
  assert.deepEqual(l.get(11), [0x90, 11, 0]);
  l = apcLeds('mk1', leds, ledState('two', 'f-blue'), { keys });
  assert.deepEqual(l.get(10), [0x90, 10, 1]);
  assert.deepEqual(l.get(11), [0x90, 11, 1]);
  // mk2: the song's own colour, full on stage, dim otherwise.
  l = apcLeds('mk2', leds, ledState('two'), { keys });
  assert.deepEqual(l.get(10)!.slice(9, 15), [0, 0, 0, 0, 1, 127]);
  l = apcLeds('mk2', leds, ledState('basic'), { keys });
  assert.ok(Math.max(...l.get(10)!.slice(9, 15)) < 40, 'dim while it is not on stage or next');
});

test('without the standard layout, pads that are not assigned stay dark', () => {
  const l = apcLeds('mk1', leds, ledState('one', 'f-warm'), { standard: false, keys: [] });
  for (const [, msg] of l) assert.equal(msg[2], 0);
  const std = apcLeds('mk1', leds, ledState('one', 'f-warm'));
  assert.equal(std.get(57)![2], 1, 'song one is lit in the standard layout');
});

// ---- Through the app, with simulated controllers ----

interface Rig {
  app: App;
  midi: FakeMidi;
  lines: string[];
  layout: any;
  url: string;
}

async function withKeys(fn: (rig: Rig) => Promise<void>, opts: { midi?: (log: (m: string) => void) => Promise<MidiPorts | null> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'light-runner-'));
  const midi = new FakeMidi();
  const lines: string[] = [];
  const app = new App({
    port: 0, host: '127.0.0.1', dataDir: dir, seedPath, webDir: join(root, 'web'), output: { kind: 'none' },
    log: (m) => lines.push(m), midi: opts.midi ?? (async () => midi), apcPollMs: 20, apcHoldMs: 150, apcResendPolls: 1e9, learnMs: 400,
  });
  try {
    await app.start();
    const url = `http://127.0.0.1:${app.port}`;
    const layout = await (await fetch(`${url}/api/layout`)).json();
    await fn({ app, midi, lines, layout, url });
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = async (url: string, method: string, path: string, body?: unknown, cookie?: string) => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const portNamed = (midi: FakeMidi, name: string) => waitFor(() => midi.opened.find((p) => p.name === name && !p.closed), 1000, `${name} to be opened`);

/** Starts a learn, presses the key once the server is waiting, and gives the answer. */
async function learn(rig: Rig, does: unknown, press: (() => void) | null, cookie?: string): Promise<{ status: number; body: any }> {
  const answer = call(rig.url, 'POST', '/api/keys/learn', { does }, cookie);
  if (press) {
    await waitFor(() => rig.app.learning, 1000, 'the server to wait for a key');
    press();
  }
  return answer;
}
const tap = (port: FakeMidiPort, note: number, channel = 1) => {
  port.receive([0x90 + channel - 1, note, 127]);
  port.receive([0x80 + channel - 1, note, 0]);
};

test('learn: the next key pressed is taken, and then it starts the song', () => withKeys(async (rig) => {
  const { app, midi, layout, url } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const song = layout.runningOrder[3];
  const r = await learn(rig, { kind: 'song', id: song.id }, () => tap(port, 41));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, key: 'nanoKONTROL2 · button 41', place: 'button 41', note: null });
  // The press that was learned didn't do anything else.
  assert.notEqual(app.state?.look, song.id);
  const fresh = await (await fetch(`${url}/api/layout`)).json();
  assert.deepEqual(fresh.keys.songs[song.id], { place: 'button 41', short: '41', name: 'nanoKONTROL2 · button 41' });
  assert.equal(fresh.keys.connected, 1);
  tap(port, 41);
  await waitFor(() => app.state?.look === song.id, 2000, 'the song to start from its key');
  // The show file keeps it.
  const show = await (await fetch(`${url}/api/show`)).json();
  assert.deepEqual(show.operator.controller.keys, [{ key: { device: 'nanoKONTROL2', type: 'note', channel: 1, number: 41 }, does: { kind: 'song', id: song.id } }]);
}));

test('learn: nothing pressed in time, one learn at a time, and plain words without a controller', () => withKeys(async (rig) => {
  const { midi, url } = rig;
  const none = await call(url, 'POST', '/api/keys/learn', { does: { kind: 'next' } });
  assert.equal(none.status, 409);
  assert.equal(none.body.error, 'No controller is connected. Plug one in, then try again.');
  midi.plug('nanoKONTROL2');
  await portNamed(midi, 'nanoKONTROL2');
  const first = call(url, 'POST', '/api/keys/learn', { does: { kind: 'next' } });
  await waitFor(() => rig.app.learning, 1000, 'the first learn');
  const second = await call(url, 'POST', '/api/keys/learn', { does: { kind: 'undo' } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'Another page is waiting for a key. Try again in a moment.');
  const timedOut = await first;
  assert.deepEqual(timedOut.body, { ok: false, message: 'No key was pressed. Try again.' });
  // A page that stops waiting (it went away, or Cancel) frees the learn at once.
  const ctl = new AbortController();
  const gone = fetch(`${url}/api/keys/learn`, { method: 'POST', body: JSON.stringify({ does: { kind: 'next' } }), signal: ctl.signal }).catch(() => null);
  await waitFor(() => rig.app.learning, 1000, 'the learn to start');
  ctl.abort();
  await gone;
  await waitFor(() => !rig.app.learning, 1000, 'the learn to stop when the page went');
  // A target that doesn't exist is refused before waiting.
  const bad = await call(url, 'POST', '/api/keys/learn', { does: { kind: 'song', id: 'not-there' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'That song is no longer in the running order.');
}));

test('learn without the MIDI add-on says so plainly, and the layout says there are no keys', () => withKeys(async ({ url }) => {
  const r = await call(url, 'POST', '/api/keys/learn', { does: { kind: 'next' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "MIDI support isn't installed on this computer, so controller keys can't be used.");
  const view = await call(url, 'GET', '/api/controller');
  assert.equal(view.body.midi, false);
  assert.deepEqual(view.body.devices, []);
  const layout = await (await fetch(`${url}/api/layout`)).json();
  assert.equal(layout.keys.midi, false);
}, { midi: (log) => loadMidi(log, async () => { throw new Error('missing'); }) }));

test('a key already used moves, with a quiet note; a level waits for a fader or a knob', () => withKeys(async (rig) => {
  const { midi, layout } = rig;
  midi.plug('APC mini mk2');
  const port = await portNamed(midi, 'APC mini mk2');
  const [a, b] = [layout.runningOrder[4], layout.runningOrder[5]];
  await learn(rig, { kind: 'song', id: a.id }, () => tap(port, 50));
  const r = await learn(rig, { kind: 'song', id: b.id }, () => tap(port, 50));
  assert.equal(r.body.note, `Pad 2,3 was ${a.name}; it is now ${b.name}.`);
  const view = (await call(rig.url, 'GET', '/api/controller')).body;
  assert.equal(view.keys.length, 1);
  // Master: a pad pressed meanwhile is passed over, and the fader moved next is taken.
  const lvl = learn(rig, { kind: 'master' }, () => tap(port, 51));
  await sleep(50);
  assert.ok(rig.app.learning, 'still waiting after a pad');
  port.receive([0xb0, 56, 20]);
  assert.deepEqual((await lvl).body, { ok: true, key: 'APC mini mk2 · fader 9', place: 'fader 9', note: null });
}));

test('an explicit key on the APC mini wins over the standard layout for that key only', () => withKeys(async (rig) => {
  const { app, midi, layout } = rig;
  midi.plug('APC mini mk2');
  const port = await portNamed(midi, 'APC mini mk2');
  const order: string[] = layout.runningOrder.map((l: any) => l.id);
  // Pad 1,2 is song 1 in the standard layout; give it song 4.
  await learn(rig, { kind: 'song', id: order[4] }, () => tap(port, 57));
  tap(port, 57);
  await waitFor(() => app.state?.look === order[4], 2000, 'song 4 from pad 1,2');
  // Pad 1,3 still follows the standard layout (item 3).
  tap(port, 58);
  await waitFor(() => app.state?.look === order[2], 2000, 'item 3 from pad 1,3');
  // The pad of song 4 shows it on stage (full colour) when it is.
  port.sent.length = 0;
  tap(port, 57);
  await waitFor(() => app.state?.look === order[4], 2000, 'song 4 again');
  await waitFor(() => port.sent.some((m) => m[0] === 0xf0 && m[7] === 57), 1000, 'the pad of song 4 to light');
  // Standard layout off: the other pads do nothing; the assigned one still works.
  assert.equal((await call(rig.url, 'PUT', '/api/controller', { apcLayout: false })).status, 200);
  tap(port, 56);
  await sleep(100);
  assert.equal(app.state?.look, order[4]);
  port.receive([0x90, 112, 127]); // Next, in the standard layout
  await sleep(100);
  assert.equal(app.state?.look, order[4]);
  // Reset to the APC mini layout: the pad is item 2 again, and Next works.
  assert.equal((await call(rig.url, 'POST', '/api/keys/reset')).status, 200);
  const view = (await call(rig.url, 'GET', '/api/controller')).body;
  assert.equal(view.apcLayout, true);
  assert.equal(view.keys.length, 0);
  tap(port, 57);
  await waitFor(() => app.state?.look === order[1], 2000, 'item 2 from pad 1,2 again');
}));

test('a song keeps its key when the running order changes; a deleted song frees it', () => withKeys(async (rig) => {
  const { app, midi, layout, url } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const song = layout.runningOrder[5];
  await learn(rig, { kind: 'song', id: song.id }, () => tap(port, 44));
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
  await new Promise((r) => ws.once('open', r));
  const command = (cmd: unknown) => new Promise<any>((resolve) => {
    const ref = Math.random();
    ws.on('message', function on(data) {
      const msg = JSON.parse(String(data));
      if (msg.type === 'result' && msg.ref === ref) {
        ws.off('message', on);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({ type: 'command', ref, cmd }));
  });
  try {
    assert.equal((await command({ type: 'moveItem', id: song.id, to: 1 })).error, null);
    tap(port, 44);
    await waitFor(() => app.state?.look === song.id, 2000, 'the moved song from its key');
    // The standard layout's places stay by place: an APC isn't involved here, so only the key matters.
    assert.equal((await command({ type: 'deleteItem', id: song.id })).error, null);
    const view = (await call(url, 'GET', '/api/controller')).body;
    assert.equal(view.keys.length, 0);
    // Undo brings the song back, and its key with it.
    assert.equal((await command({ type: 'undo' })).error, null);
    assert.equal((await call(url, 'GET', '/api/controller')).body.keys.length, 1);
  } finally {
    ws.close();
  }
}));

test('the fade knob sweeps the fade times, with pickup; and a key per fade time', () => withKeys(async (rig) => {
  const { app, midi } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  await learn(rig, { kind: 'fadeKnob' }, () => port.receive([0xb0, 16, 120]));
  assert.equal(app.state?.fadeTime, null);
  // The knob is far from Auto (fully left): it waits.
  port.receive([0xb0, 16, 110]);
  await sleep(100);
  assert.equal(app.state?.fadeTime, null);
  // Down to Auto: it takes over, and then sweeps up through the times.
  port.receive([0xb0, 16, 3]);
  const seen: (number | null)[] = [];
  for (let v = 0; v <= 127; v += 4) {
    port.receive([0xb0, 16, v]);
    await sleep(8);
    const f = app.state?.fadeTime;
    if (f !== undefined && seen.at(-1) !== f) seen.push(f);
  }
  port.receive([0xb0, 16, 127]);
  await waitFor(() => app.state?.fadeTime === 10, 2000, 'the knob at 10 s');
  assert.deepEqual(seen.filter((f) => f !== null), [...new Set(seen.filter((f) => f !== null))], 'only upward');
  // A fade key: Fade 2 s.
  await learn(rig, { kind: 'fadeTime', value: 2 }, () => tap(port, 60));
  tap(port, 60);
  await waitFor(() => app.state?.fadeTime === 2, 2000, 'Fade 2 s from its key');
  // The knob was let go of by the change: a small move near 10 s does nothing.
  port.receive([0xb0, 16, 125]);
  await sleep(100);
  assert.equal(app.state?.fadeTime, 2);
}));

test('Master on a knob picks up; tempo keys; Blackout held 1 s; Flash while held', () => withKeys(async (rig) => {
  const { app, midi, layout } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  await learn(rig, { kind: 'master' }, () => port.receive([0xb0, 7, 5]));
  port.receive([0xb0, 7, 30]);
  await sleep(100);
  assert.equal(app.state?.master, 1, 'the knob waits until it reaches Master');
  port.receive([0xb0, 7, 127]);
  port.receive([0xb0, 7, 64]);
  await waitFor(() => Math.abs(app.state!.master - 64 / 127) < 0.001, 2000, 'Master to follow the knob');

  await learn(rig, { kind: 'tempoStep', times: 0.5 }, () => tap(port, 30));
  tap(port, 30);
  await waitFor(() => app.state?.tempo === 60, 2000, 'tempo ÷2');
  await learn(rig, { kind: 'tap' }, () => tap(port, 31));
  for (let i = 0; i < 3; i++) {
    tap(port, 31);
    await sleep(300);
  }
  await waitFor(() => app.state!.tempo > 150 && app.state!.tempo < 250, 2000, 'the tapped tempo');

  const g2 = layout.groups[1].id;
  await learn(rig, { kind: 'flash', group: g2 }, () => tap(port, 32));
  port.receive([0x90, 32, 127]);
  await waitFor(() => app.state?.flashing.includes(g2), 2000, 'group 2 to flash while held');
  port.receive([0x80, 32, 0]);
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the flash to stop when let go');

  await learn(rig, { kind: 'blackout' }, () => tap(port, 33));
  tap(port, 33);
  await sleep(250);
  assert.notEqual(app.state?.look, 'blackout', 'a short press does nothing');
  port.receive([0x90, 33, 127]);
  await waitFor(() => app.state?.look === 'blackout', 2000, 'Blackout after the hold');
  port.receive([0x80, 33, 0]);
}));

test('a button that sends a control change works as a key too', () => withKeys(async (rig) => {
  const { app, midi, layout } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const order: string[] = layout.runningOrder.map((l: any) => l.id);
  await learn(rig, { kind: 'next' }, () => port.receive([0xb0, 43, 127]));
  port.receive([0xb0, 43, 0]);
  port.receive([0xb0, 43, 127]);
  port.receive([0xb0, 43, 127]); // held: still one press
  port.receive([0xb0, 43, 0]);
  await waitFor(() => app.state?.look === order[1], 2000, 'Next from the button');
  await sleep(100);
  assert.equal(app.state?.look, order[1]);
}));

test('devices: each one listed, and one not listened to is let go of', () => withKeys(async (rig) => {
  const { app, midi, url } = rig;
  midi.plug('APC mini mk2');
  midi.plug('MIDIIN2 (APC mini mk2)');
  midi.plug('nanoKONTROL2');
  const nano = await portNamed(midi, 'nanoKONTROL2');
  await portNamed(midi, 'APC mini mk2');
  let view = (await call(url, 'GET', '/api/controller')).body;
  assert.equal(view.midi, true);
  assert.deepEqual(view.devices, [
    { name: 'APC mini mk2', listening: true, model: 'mk2' },
    { name: 'nanoKONTROL2', listening: true, model: null },
  ]);
  const order: string[] = rig.layout.runningOrder.map((l: any) => l.id);
  await learn(rig, { kind: 'song', id: order[2] }, () => tap(nano, 20));
  assert.equal((await call(url, 'PUT', '/api/controller', { ignored: ['nanoKONTROL2'] })).status, 200);
  await waitFor(() => nano.closed, 1000, 'the port to be let go of');
  view = (await call(url, 'GET', '/api/controller')).body;
  assert.deepEqual(view.devices[1], { name: 'nanoKONTROL2', listening: false, model: null });
  // Back on: opened again, and its keys still work.
  assert.equal((await call(url, 'PUT', '/api/controller', { ignored: [] })).status, 200);
  const again = await waitFor(() => midi.opened.find((p) => p.name === 'nanoKONTROL2' && !p.closed), 1000, 'the port again');
  tap(again, 20);
  await waitFor(() => app.state?.look === order[2], 2000, 'the key after listening again');
}));

test('Settings lists the actions with their keys, and the APC mini layout where it applies', () => withKeys(async (rig) => {
  const { midi, url, layout } = rig;
  midi.plug('APC mini mk2');
  const port = await portNamed(midi, 'APC mini mk2');
  let view = (await call(url, 'GET', '/api/controller')).body;
  const row = (v: any, label: string) => v.actions.find((a: any) => a.label === label);
  assert.deepEqual(row(view, 'Next'), { section: 'Running the service', label: 'Next', hold: null, does: { kind: 'next' }, key: null, standard: 'side button 1' });
  assert.equal(row(view, 'Blackout').hold, 'hold 1 s');
  assert.equal(row(view, 'Master').standard, 'fader 9');
  assert.equal(row(view, `${layout.groups[0].name} level`).standard, 'fader 1');
  assert.ok(row(view, 'Fade 2 s'));
  assert.ok(row(view, 'Tempo ×2'));
  // Assign side button 1 to Undo: Next loses its standard key, Undo has it explicitly (and side button 3 still).
  await learn(rig, { kind: 'undo' }, () => tap(port, 112));
  view = (await call(url, 'GET', '/api/controller')).body;
  assert.equal(row(view, 'Undo').key, 'APC mini mk2 · side button 1');
  assert.equal(row(view, 'Undo').standard, 'side button 3');
  assert.equal(row(view, 'Next').standard, null);
  // A key on another controller: the APC mini layout still does it too.
  midi.plug('nanoKONTROL2');
  const nano = await portNamed(midi, 'nanoKONTROL2');
  await learn(rig, { kind: 'basic' }, () => tap(nano, 12));
  view = (await call(url, 'GET', '/api/controller')).body;
  assert.equal(row(view, 'Basic lights').key, 'nanoKONTROL2 · button 12');
  assert.equal(row(view, 'Basic lights').standard, 'side button 4');
  // Clear puts it back.
  assert.equal((await call(url, 'POST', '/api/keys/clear', { does: { kind: 'undo' } })).status, 200);
  view = (await call(url, 'GET', '/api/controller')).body;
  assert.equal(row(view, 'Undo').key, null);
  assert.equal(row(view, 'Next').standard, 'side button 1');
}));

test('Patch saving an old copy of the show keeps the keys', () => withKeys(async (rig) => {
  const { midi, url, layout } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const old = await (await fetch(`${url}/api/show`)).json();
  await learn(rig, { kind: 'song', id: layout.runningOrder[1].id }, () => tap(port, 9));
  const res = await fetch(`${url}/api/show?source=patch`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(old) });
  assert.equal(res.status, 200);
  assert.equal((await call(url, 'GET', '/api/controller')).body.keys.length, 1);
}));

// ---- Fix round 1 ----

/** A WebSocket to the app (with the programmer's cookie, or none) that sends commands and gives each answer. */
async function tablet(url: string, cookie?: string) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, cookie ? { headers: { cookie } } : {});
  await new Promise((r) => ws.once('open', r));
  let ref = 0;
  const command = (cmd: unknown) => new Promise<string | null>((resolve) => {
    const mine = ++ref;
    ws.on('message', function on(data) {
      const msg = JSON.parse(String(data));
      if (msg.type === 'result' && msg.ref === mine) {
        ws.off('message', on);
        resolve(msg.error);
      }
    });
    ws.send(JSON.stringify({ type: 'command', ref: mine, cmd }));
  });
  return { command, close: () => ws.close() };
}

async function waitForAsync(get: () => Promise<boolean>, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await get()) return true;
    await sleep(20);
  }
  return false;
}

const PROGRAMMER_ONLY = 'Only the programmer can change that key. Enter the PIN in Settings.';

test('with a PIN, operators give keys to songs and quick looks only; the programmer to everything', () => withKeys(async (rig) => {
  const { midi, url, layout } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const pin = await fetch(`${url}/api/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ next: '2468' }) });
  assert.equal(pin.status, 200);
  const cookie = pin.headers.get('set-cookie')!.split(';')[0]!;
  const key = { device: 'nanoKONTROL2', type: 'note', channel: 1, number: 70 };
  const song = { kind: 'song', id: layout.runningOrder[2].id };

  // Over HTTP: a fixed action is refused before any waiting; a song is fine.
  const refused = await call(url, 'POST', '/api/keys/learn', { does: { kind: 'blackout' } });
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, PROGRAMMER_ONLY);
  assert.equal(rig.app.learning, false);
  assert.equal((await learn(rig, song, () => tap(port, 71))).body.ok, true);
  // The switches and Reset need the PIN.
  assert.equal((await call(url, 'PUT', '/api/controller', { apcLayout: false })).status, 401);
  assert.equal((await call(url, 'POST', '/api/keys/reset')).status, 401);

  // Over the WebSocket, as an operator.
  const op = await tablet(url);
  try {
    assert.equal(await op.command({ type: 'setKey', key, does: { kind: 'blackout' } }), PROGRAMMER_ONLY);
    assert.equal(await op.command({ type: 'resetKeys' }), PROGRAMMER_ONLY);
    assert.equal(await op.command({ type: 'setKey', key, does: { kind: 'quickLook', id: layout.quickLooks[0].id } }), null);
    assert.equal(await op.command({ type: 'clearKey', does: song }), null);
  } finally {
    op.close();
  }

  // The programmer (with the PIN's cookie) can do all of it.
  const prog = await tablet(url, cookie);
  try {
    assert.equal(await prog.command({ type: 'setKey', key, does: { kind: 'blackout' } }), null);
    // An operator can't clear it.
    assert.equal((await call(url, 'POST', '/api/keys/clear', { does: { kind: 'blackout' } })).status, 401);
    assert.equal((await call(url, 'POST', '/api/keys/clear', { does: { kind: 'blackout' } }, cookie)).status, 200);
    assert.equal((await learn(rig, { kind: 'next' }, () => tap(port, 72), cookie)).body.ok, true);
    assert.equal(await prog.command({ type: 'resetKeys' }), null);
    assert.equal((await call(url, 'PUT', '/api/controller', { apcLayout: false }, cookie)).status, 200);
  } finally {
    prog.close();
  }
}));

test('keys from Settings are no Undo steps; song keys are; the switches keep Undo and write no backup each time', () => withKeys(async (rig) => {
  const { midi, url, layout } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const op = await tablet(url);
  try {
    const song = layout.runningOrder[3];
    assert.equal(await op.command({ type: 'renameItem', id: song.id, name: 'Psalm' }), null);
    await learn(rig, { kind: 'next' }, () => tap(port, 50));
    const backups = (await call(url, 'GET', '/api/backups')).body.length;
    for (const on of [false, true, false]) assert.equal((await call(url, 'PUT', '/api/controller', { apcLayout: on })).status, 200);
    assert.equal((await call(url, 'PUT', '/api/controller', { ignored: ['Nothing here'] })).status, 200);
    assert.ok((await call(url, 'GET', '/api/backups')).body.length <= backups + 1, 'at most one backup for the switches');
    // Undo takes back the rename, not the Next key or the switches.
    assert.equal(await op.command({ type: 'undo' }), null);
    let view = (await call(url, 'GET', '/api/controller')).body;
    assert.equal(view.actions.find((a: any) => a.label === 'Next').key, 'nanoKONTROL2 · button 50');
    assert.equal(view.apcLayout, false);
    const name = (await (await fetch(`${url}/api/layout`)).json()).runningOrder[3].name;
    assert.equal(name, song.name);
    // A song's key is an Undo step.
    await learn(rig, { kind: 'song', id: song.id }, () => tap(port, 51));
    assert.equal(await op.command({ type: 'undo' }), null);
    view = (await call(url, 'GET', '/api/controller')).body;
    assert.equal(view.keys.some((k: any) => k.does.kind === 'song'), false);
    assert.equal(view.actions.find((a: any) => a.label === 'Next').key, 'nanoKONTROL2 · button 50');
  } finally {
    op.close();
  }
}));

test('a learn takes only a fresh press: releases and controls at zero are passed over', () => withKeys(async (rig) => {
  const { midi } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const answer = learn(rig, { kind: 'next' }, () => {
    port.receive([0x80, 40, 0]);
    port.receive([0x90, 41, 0]);
    port.receive([0xb0, 42, 0]);
  });
  await sleep(50);
  assert.ok(rig.app.learning, 'still waiting');
  port.receive([0x90, 43, 100]);
  assert.equal((await answer).body.key, 'nanoKONTROL2 · button 43');
}));

test('the release of a learned key is passed over for at most 2 s', () => withKeys(async (rig) => {
  const { app, midi, layout } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const order: string[] = layout.runningOrder.map((l: any) => l.id);
  // Held down while it is learned, and its release never comes.
  await learn(rig, { kind: 'song', id: order[2] }, () => port.receive([0x90, 44, 127]));
  await sleep(2100);
  port.receive([0x90, 44, 127]);
  await waitFor(() => app.state?.look === order[2], 2000, 'the key to work after 2 s');
}));

test('learn when every device is switched off says so; the layout counts the controllers listened to', () => withKeys(async (rig) => {
  const { midi, url } = rig;
  const connected = async () => (await (await fetch(`${url}/api/layout`)).json()).keys.connected;
  assert.equal(await connected(), 0);
  midi.plug('nanoKONTROL2');
  await portNamed(midi, 'nanoKONTROL2');
  assert.ok(await waitForAsync(async () => (await connected()) === 1), 'one controller connected');
  assert.equal((await call(url, 'PUT', '/api/controller', { ignored: ['nanoKONTROL2'] })).status, 200);
  const r = await call(url, 'POST', '/api/keys/learn', { does: { kind: 'next' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'No controller is being listened to.');
  assert.ok(await waitForAsync(async () => (await connected()) === 0), 'none listened to');
}));

test("unplugging a controller that isn't an APC puts out the Flash it holds", () => withKeys(async (rig) => {
  const { app, midi, layout } = rig;
  midi.plug('nanoKONTROL2');
  const port = await portNamed(midi, 'nanoKONTROL2');
  const g = layout.groups[0].id;
  await learn(rig, { kind: 'flash', group: g }, () => tap(port, 45));
  port.receive([0x90, 45, 127]);
  await waitFor(() => app.state?.flashing.includes(g), 2000, 'the flash');
  midi.unplug('nanoKONTROL2');
  await waitFor(() => port.closed, 1000, 'the port to close');
  await waitFor(() => app.state?.flashing.length === 0, 2000, 'the flash to go out');
}));
